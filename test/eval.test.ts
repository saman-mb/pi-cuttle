import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { heuristicScore } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import { parseCorpus, scoreCorpus } from "../eval/score.ts";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "eval", "corpus.jsonl"), "utf8");
const corpus = parseCorpus(text);

/** Keep in sync with eval/run.ts — CI fails if heuristic quality regresses. */
const ACCURACY_FLOOR = 0.9;

function heuristicTier(prompt: string): { tier: "local" | "cloud"; score: number } {
	const { score } = heuristicScore(prompt);
	return { tier: score >= DEFAULTS.policy.threshold ? "cloud" : "local", score };
}

test("corpus is large and class-balanced enough to mean something", () => {
	assert.ok(corpus.length >= 100, `corpus has ${corpus.length} entries, want >= 100`);
	const local = corpus.filter((e) => e.label === "local").length;
	const ratio = local / corpus.length;
	assert.ok(ratio > 0.3 && ratio < 0.7, `label balance is lopsided: ${Math.round(ratio * 100)}% local`);
});

test("the heuristic clears the recorded accuracy floor", () => {
	const result = scoreCorpus(corpus, heuristicTier);
	assert.ok(
		result.accuracy >= ACCURACY_FLOOR,
		`accuracy ${(result.accuracy * 100).toFixed(1)}% < floor ${ACCURACY_FLOOR * 100}%\n${JSON.stringify(result.confusion)}`,
	);
});

test("no prompt is duplicated in the corpus", () => {
	const seen = new Set<string>();
	for (const entry of corpus) {
		assert.ok(!seen.has(entry.prompt), `duplicate prompt: ${entry.prompt}`);
		seen.add(entry.prompt);
	}
});
