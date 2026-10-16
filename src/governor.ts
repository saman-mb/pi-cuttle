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

import type { LocalHost } from "./host.ts";
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

/** Earliest TTL among a model's instances; models without a TTL sort last. */
function minTtl(model: { instances: { remaining_ttl_seconds?: number }[] }): number {
	return Math.min(...model.instances.map((i) => i.remaining_ttl_seconds ?? Number.POSITIVE_INFINITY));
}

export class LocalGovernor {
	/** Reservations this process holds, grouped by model. */
	private readonly held = new Map<string, Reservation[]>();
	private readonly cfg: LocalConfig;
	private readonly host: LocalHost;
	/** Models the ceiling must never evict (e.g. the local classifier, #44). */
	private readonly pinned = new Set<string>();

	constructor(cfg: LocalConfig, host: LocalHost) {
		this.cfg = cfg;
		this.host = host;
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
		if (!this.host.capabilities.canListLoaded) return new Set();
		try {
			return new Set((await this.host.loaded()).map((m) => m.key));
		} catch {
			// Host unreachable: fall back to slot accounting alone.
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

	/** Protect a model key from ceiling eviction (#44). */
	pin(modelKey: string): void {
		if (modelKey) this.pinned.add(modelKey);
	}

	unpin(modelKey: string): void {
		this.pinned.delete(modelKey);
	}

	isPinned(modelKey: string): boolean {
		return this.pinned.has(modelKey);
	}

	/** Release everything this process holds. Call on shutdown. */
	releaseAll(): void {
		for (const list of this.held.values()) for (const res of list) safeUnlink(res.file);
		this.held.clear();
	}

	async status(): Promise<GovernorStatus> {
		let loadedModels: GovernorStatus["loadedModels"] = [];
		try {
			loadedModels = this.host.capabilities.canListLoaded ? await this.host.loaded() : [];
		} catch {
			/* offline is a valid status */
		}
		return {
			slots: this.live(),
			localMax: this.cfg.maxConcurrent,
			loadedModels,
			capabilities: this.host.capabilities,
			pinnedKeys: [...this.pinned],
		};
	}

	/**
	 * Bring LM Studio back under `maxLoadedModels` by unloading the instances closest to
	 * TTL expiry, never the model we are about to use (#14). TTL itself is server-side (#27).
	 */
	async enforceLoadedCeiling(keepKey?: string): Promise<string[]> {
		if (this.cfg.maxLoadedModels <= 0) return [];
		if (!this.host.capabilities.canLoadUnload) return [];
		let loaded: { key: string; instances: { id: string; remaining_ttl_seconds?: number }[] }[];
		try {
			loaded = await this.host.loaded();
		} catch {
			return [];
		}
		// Pinned models (the classifier) are never victims; the ceiling is best-effort
		// around them, because evicting the classifier just forces a reload next turn.
		const others = loaded.filter((m) => m.key !== keepKey && !this.pinned.has(m.key));
		// The target needs a slot of its own, so leave room for it whether or not it is
		// currently loaded. Without keepKey this is a plain ceiling on everything loaded.
		const allowedOthers = keepKey ? Math.max(0, this.cfg.maxLoadedModels - 1) : this.cfg.maxLoadedModels;
		if (others.length <= allowedOthers) return [];
		// Evict whole models, closest to TTL first. A model may have several instances
		// (LM Studio JIT-loads one per concurrent request); unloading one instance does not
		// free the model, so every instance of a chosen victim must go.
		const ordered = [...others].sort((a, b) => minTtl(a) - minTtl(b));
		const unloaded: string[] = [];
		let remaining = others.length;
		for (const victim of ordered) {
			if (remaining <= allowedOthers) break;
			for (const instance of victim.instances) {
				try {
					await this.host.unload(instance.id);
				} catch {
					/* keep going; a failed unload is caught by the acquire() ceiling check */
				}
			}
			unloaded.push(victim.key);
			remaining -= 1;
		}
		return unloaded;
	}
}
