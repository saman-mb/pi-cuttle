/**
 * Offline routing evaluation (#43).
 *
 * The heuristic is the plugin's zero-cost floor, and its error rate was unknown.
 * `eval/corpus.jsonl` holds labeled prompts; this module scores a decision function
 * against them so a change can be defended with a number instead of a vibe.
 *
 * The corpus is ground truth about *which tier should serve the work*, independent
 * of which model is configured.
 */
import type { Tier } from "../src/types.ts";

export interface EvalEntry {
	prompt: string;
	label: Tier;
	note?: string;
}

export interface Confusion {
	/** Local prompts correctly routed local. */
	localLocal: number;
	/** Local prompts wrongly routed cloud (burned money). */
	localCloud: number;
	/** Cloud prompts wrongly routed local (risked quality). */
	cloudLocal: number;
	/** Cloud prompts correctly routed cloud. */
	cloudCloud: number;
}

export interface EvalResult {
	total: number;
	accuracy: number;
	confusion: Confusion;
	misses: { prompt: string; label: Tier; got: Tier; score: number }[];
}

/** Parse JSONL corpus text. Exported for tests. */
export function parseCorpus(text: string): EvalEntry[] {
	const entries: EvalEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line) as EvalEntry;
		if ((parsed.label === "local" || parsed.label === "cloud") && typeof parsed.prompt === "string") {
			entries.push(parsed);
		}
	}
	return entries;
}

/**
 * Score a per-prompt decision against the corpus.
 * `decide` returns the tier and the underlying score (for the miss report).
 */
export function scoreCorpus(
	entries: readonly EvalEntry[],
	decide: (prompt: string) => { tier: Tier; score: number },
): EvalResult {
	const confusion: Confusion = { localLocal: 0, localCloud: 0, cloudLocal: 0, cloudCloud: 0 };
	const misses: EvalResult["misses"] = [];
	for (const entry of entries) {
		const got = decide(entry.prompt);
		if (entry.label === "local" && got.tier === "local") confusion.localLocal += 1;
		else if (entry.label === "local" && got.tier === "cloud") confusion.localCloud += 1;
		else if (entry.label === "cloud" && got.tier === "local") confusion.cloudLocal += 1;
		else confusion.cloudCloud += 1;
		if (got.tier !== entry.label) misses.push({ prompt: entry.prompt, label: entry.label, got: got.tier, score: got.score });
	}
	const correct = confusion.localLocal + confusion.cloudCloud;
	return {
		total: entries.length,
		accuracy: entries.length === 0 ? 0 : correct / entries.length,
		confusion,
		misses,
	};
}

/** Human-readable report. */
export function formatResult(result: EvalResult): string {
	const c = result.confusion;
	const lines = [
		`corpus: ${result.total} prompts`,
		`accuracy: ${(result.accuracy * 100).toFixed(1)}%`,
		`  local -> local : ${c.localLocal}`,
		`  local -> cloud : ${c.localCloud}  (money spent unnecessarily)`,
		`  cloud -> local : ${c.cloudLocal}  (quality risked)`,
		`  cloud -> cloud : ${c.cloudCloud}`,
	];
	if (result.misses.length > 0) {
		lines.push("misses:");
		for (const miss of result.misses.slice(0, 15)) {
			lines.push(`  [${miss.label} -> ${miss.got}] score=${miss.score.toFixed(2)} ${miss.prompt}`);
		}
	}
	return lines.join("\n");
}
