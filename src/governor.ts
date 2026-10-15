/**
 * Cross-process local-model slot broker.
 *
 * Async subagent children run in their own detached runner processes, so an
 * in-memory counter caps nothing. The cap therefore lives on the filesystem:
 * every reservation is a small JSON file under `local.slotDir`, and liveness is
 * judged by pid + age.
 *
 * Release is deliberately approximate: `route()` cannot hold a lock across the
 * whole model stream, so slots are freed on message end, on process exit, and by
 * stale reaping at every acquire. Correctness rests on reaping, not on exact counts.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { LmStudioClient } from "./lmstudio.ts";
import type { GovernorStatus, LocalConfig, Reservation } from "./types.ts";

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function safeUnlink(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		/* already gone */
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LocalGovernor {
	/** Reservations this process holds, grouped by model. */
	private readonly held = new Map<string, Reservation[]>();
	private readonly cfg: LocalConfig;
	private readonly lm: LmStudioClient;

	constructor(cfg: LocalConfig, lm: LmStudioClient) {
		this.cfg = cfg;
		this.lm = lm;
		try {
			mkdirSync(cfg.slotDir, { recursive: true });
		} catch {
			/* best effort; acquire() degrades to in-process accounting */
		}
	}

	private fileFor(id: string): string {
		return join(this.cfg.slotDir, `slot-${id}.json`);
	}

	/** Every live reservation across all pi processes; abandoned files are deleted. */
	live(): Reservation[] {
		let names: string[];
		try {
			names = readdirSync(this.cfg.slotDir);
		} catch {
			return [];
		}
		const now = Date.now();
		const live: Reservation[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = join(this.cfg.slotDir, name);
			let res: Reservation;
			try {
				res = JSON.parse(readFileSync(file, "utf8")) as Reservation;
			} catch {
				safeUnlink(file);
				continue;
			}
			if (now - res.startedAt > this.cfg.staleSlotMs || !pidAlive(res.pid)) {
				safeUnlink(file);
				continue;
			}
			live.push(res);
		}
		return live;
	}

	/**
	 * Reserve a slot for `modelKey`, or return null when the local side is saturated
	 * and `onFull` is `spill`. When `onFull` is `wait`, polls until `waitMs` elapses.
	 */
	async acquire(modelKey: string, opts: { waitMs?: number; sessionId?: string; flavor?: string } = {}): Promise<Reservation | null> {
		const waitMs = opts.waitMs ?? (this.cfg.onFull === "wait" ? this.cfg.waitMs : 0);
		const deadline = Date.now() + waitMs;
		for (;;) {
			const slots = this.live();
			const perModel = slots.filter((s) => s.modelKey === modelKey).length;
			const flavorCap = opts.flavor ? this.cfg.maxConcurrentByFlavor?.[opts.flavor] : undefined;
			const byFlavor = opts.flavor ? slots.filter((s) => s.flavor === opts.flavor).length : 0;
			const overFlavor = flavorCap !== undefined && byFlavor >= flavorCap;
			const overConcurrency =
				overFlavor || perModel >= this.cfg.maxConcurrentPerModel || slots.length >= this.cfg.maxConcurrent;

			const loaded = await this.loadedKeys();
			const overLoaded =
				this.cfg.maxLoadedModels > 0 && !loaded.has(modelKey) && loaded.size >= this.cfg.maxLoadedModels;

			if (!overConcurrency && !overLoaded) return this.reserve(modelKey, opts.sessionId, opts.flavor);
			if (Date.now() >= deadline) return null;
			await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
		}
	}

	private async loadedKeys(): Promise<Set<string>> {
		try {
			return new Set((await this.lm.loaded()).map((m) => m.key));
		} catch {
			// LM Studio unreachable: fall back to slot accounting alone.
			return new Set();
		}
	}

	private reserve(modelKey: string, sessionId?: string, flavor?: string): Reservation {
		const res: Reservation = {
			id: randomUUID(),
			modelKey,
			pid: process.pid,
			startedAt: Date.now(),
			file: "",
			...(sessionId ? { sessionId } : {}),
			...(flavor ? { flavor } : {}),
		};
		res.file = this.fileFor(res.id);
		try {
			writeFileSync(res.file, JSON.stringify(res), { flag: "wx" });
		} catch {
			/* another process raced us; keep the in-process reservation anyway */
		}
		const list = this.held.get(modelKey) ?? [];
		list.push(res);
		this.held.set(modelKey, list);
		return res;
	}

	/** Release the oldest in-process reservation for a model. Returns whether one was freed. */
	releaseOne(modelKey: string): boolean {
		const list = this.held.get(modelKey);
		const res = list?.shift();
		if (!res) return false;
		safeUnlink(res.file);
		return true;
	}

	release(res: Reservation): void {
		safeUnlink(res.file);
		const list = this.held.get(res.modelKey);
		if (!list) return;
		const index = list.findIndex((r) => r.id === res.id);
		if (index >= 0) list.splice(index, 1);
	}

	/** Release everything this process holds. Call on shutdown. */
	releaseAll(): void {
		for (const list of this.held.values()) for (const res of list) safeUnlink(res.file);
		this.held.clear();
	}

	async status(): Promise<GovernorStatus> {
		let loadedModels: GovernorStatus["loadedModels"] = [];
		try {
			loadedModels = await this.lm.loaded();
		} catch {
			/* offline is a valid status */
		}
		return { slots: this.live(), localMax: this.cfg.maxConcurrent, loadedModels };
	}

	/**
	 * Bring LM Studio back under `maxLoadedModels` by unloading the instances closest to
	 * TTL expiry, never the model we are about to use (#14). TTL itself is server-side (#27).
	 */
	async enforceLoadedCeiling(keepKey?: string): Promise<string[]> {
		if (this.cfg.maxLoadedModels <= 0) return [];
		let loaded: { key: string; instances: { id: string; remaining_ttl_seconds?: number }[] }[];
		try {
			loaded = await this.lm.loaded();
		} catch {
			return [];
		}
		const candidates = loaded
			.filter((m) => m.key !== keepKey)
			.flatMap((m) => m.instances.map((i) => ({ key: m.key, id: i.id, ttl: i.remaining_ttl_seconds ?? Number.POSITIVE_INFINITY })))
			.sort((a, b) => a.ttl - b.ttl);
		const unloaded: string[] = [];
		let count = loaded.length;
		while (count > this.cfg.maxLoadedModels && candidates.length > 0) {
			const victim = candidates.shift();
			if (!victim) break;
			try {
				await this.lm.unload(victim.id);
				unloaded.push(victim.key);
				count -= 1;
			} catch {
				break;
			}
		}
		return unloaded;
	}
}
