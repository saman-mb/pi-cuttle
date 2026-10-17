/**
 * Decision ledger and savings receipt (#42).
 *
 * Every assistant turn appends one JSONL line: which side served it, which model,
 * and the token usage pi reports. `/cuttle stats` aggregates it into the number the
 * whole plugin exists to produce: how much was saved by not sending those turns to
 * the cloud.
 *
 * The ledger records metadata only — never prompt or response content. Appends are
 * best-effort and never throw: telemetry must not be able to break a turn.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TelemetryConfig, Tier } from "./types.ts";
import { VIRTUAL_PROVIDER } from "./types.ts";

/**
 * Whether a completed assistant message describes a turn that reached a physical model.
 *
 * pi reports the virtual provider on a message when routing never resolved a target — a
 * mistyped `catalog.local`, an unreachable provider, no candidate at all (#62). Those turns
 * ran nothing and spent nothing, and recording them would count a phantom turn as cloud
 * spend: exactly the number this module exists to avoid overstating.
 */
export function isPhysicalTurn(message: { provider?: string; model?: string }): boolean {
	return message.provider !== undefined && message.provider !== "" && message.provider !== VIRTUAL_PROVIDER;
}

export interface DecisionRecord {
	ts: number;
	sessionId?: string;
	provider: string;
	model: string;
	tier: Tier;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface Stats {
	days: number;
	turns: number;
	localTurns: number;
	cloudTurns: number;
	localTokens: number;
	cloudTokens: number;
	/** Estimated USD spent on cloud turns over the window. */
	spent: number;
	/** Estimated USD those same turns would have cost on the baseline cloud model. */
	baselineCost: number;
	/** baselineCost - spent; the savings receipt. */
	saved: number;
	/** True when every cloud-model price needed for the window was configured. */
	pricingComplete: boolean;
	perModel: { model: string; turns: number; tokens: number }[];
}

interface Price {
	input: number;
	output: number;
}

const PER_MTOK = 1_000_000;

function costOf(price: Price | undefined, input: number, output: number): number | undefined {
	if (!price) return undefined;
	return (input * price.input + output * price.output) / PER_MTOK;
}

export class Telemetry {
	private readonly cfg: TelemetryConfig;
	/** Full `provider/model` refs configured as local candidates. */
	private readonly localRefs: Set<string>;

	constructor(cfg: TelemetryConfig, localRefs: readonly string[]) {
		this.cfg = cfg;
		this.localRefs = new Set(localRefs);
	}

	get enabled(): boolean {
		return this.cfg.enabled;
	}

	/** True when `provider/model` is one of the configured local candidates. */
	isLocalModel(model: string): boolean {
		return this.localRefs.has(model);
	}

	/** Append one record. Never throws. */
	record(rec: DecisionRecord): void {
		if (!this.cfg.enabled) return;
		try {
			mkdirSync(dirname(this.cfg.path), { recursive: true });
			appendFileSync(this.cfg.path, JSON.stringify(rec) + "\n");
		} catch {
			/* telemetry must never break a turn */
		}
	}

	/** Read the ledger and aggregate the last `days`. Missing prices degrade to counts. */
	stats(days = 7): Stats {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const records: DecisionRecord[] = [];
		try {
			for (const line of readFileSync(this.cfg.path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as DecisionRecord;
					if (parsed.ts >= cutoff) records.push(parsed);
				} catch {
					/* skip a corrupt line rather than losing the window */
				}
			}
		} catch {
			/* no ledger yet */
		}

		const baselineRef = this.cfg.baseline;
		const baselinePrice = baselineRef ? this.priceFor(baselineRef) : undefined;
		const stats: Stats = {
			days,
			turns: records.length,
			localTurns: 0,
			cloudTurns: 0,
			localTokens: 0,
			cloudTokens: 0,
			spent: 0,
			baselineCost: 0,
			saved: 0,
			pricingComplete: true,
			perModel: [],
		};
		const byModel = new Map<string, { turns: number; tokens: number }>();
		for (const rec of records) {
			const tokens = rec.inputTokens + rec.outputTokens;
			if (rec.tier === "local") {
				stats.localTurns += 1;
				stats.localTokens += tokens;
			} else {
				stats.cloudTurns += 1;
				stats.cloudTokens += tokens;
			}
			const prev = byModel.get(rec.model) ?? { turns: 0, tokens: 0 };
			byModel.set(rec.model, { turns: prev.turns + 1, tokens: prev.tokens + tokens });

			// "Saved vs all-cloud": what this turn would have cost on the baseline model.
			const baseline = costOf(baselinePrice, rec.inputTokens, rec.outputTokens);
			if (baseline === undefined) stats.pricingComplete = false;
			else stats.baselineCost += baseline;

			if (rec.tier === "cloud") {
				const actual = costOf(this.priceFor(`${rec.provider}/${rec.model}`), rec.inputTokens, rec.outputTokens);
				if (actual === undefined) stats.pricingComplete = false;
				else stats.spent += actual;
			}
		}
		stats.perModel = [...byModel.entries()]
			.map(([model, v]) => ({ model, ...v }))
			.sort((a, b) => b.turns - a.turns);
		stats.saved = stats.baselineCost - stats.spent;
		return stats;
	}

	private priceFor(ref: string): Price | undefined {
		return this.cfg.pricing[ref];
	}
}

/** Format a stats window for `/cuttle stats`. */
export function formatStats(stats: Stats, baseline?: string): string {
	if (stats.turns === 0) return `no decisions recorded in the last ${stats.days} day(s)`;
	const pct = Math.round((stats.localTurns / stats.turns) * 100);
	const lines = [
		`last ${stats.days} day(s): ${stats.turns} turns, ${pct}% local (${stats.localTurns} local / ${stats.cloudTurns} cloud)`,
		`tokens: ${stats.localTokens.toLocaleString()} local, ${stats.cloudTokens.toLocaleString()} cloud`,
	];
	if (stats.pricingComplete && baseline) {
		lines.push(`spent ~$${stats.spent.toFixed(2)} · baseline all-${baseline} ~$${stats.baselineCost.toFixed(2)} · saved ~$${stats.saved.toFixed(2)}`);
	} else {
		lines.push(`set telemetry.pricing (per Mtok) and telemetry.baseline to see a savings estimate`);
	}
	const top = stats.perModel.slice(0, 4).map((m) => `${m.model} (${m.turns})`).join(", ");
	if (top) lines.push(`models: ${top}`);
	return lines.join("\n");
}
