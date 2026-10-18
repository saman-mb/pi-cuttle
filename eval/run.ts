/**
 * `npm run eval` — score the heuristic against eval/corpus.jsonl.
 *
 * Exits non-zero below the recorded floor, so a heuristic change that regresses
 * routing quality cannot land quietly.
 *
 * NOTE: this scores the **heuristic**, not the decision model. The classifier is
 * not reachable from a standalone script without pi's model registry, so scoring
 * the real model (a `--live` mode) is tracked in #97 and will run through pi.
 * Do not describe this script's score as decision-model accuracy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { heuristicScore } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import { formatResult, parseCorpus, scoreCorpus } from "./score.ts";

/** Heuristic accuracy floor; raise it when the heuristic improves. */
export const ACCURACY_FLOOR = 0.8;

if (process.argv.includes("--live") || process.env.npm_config_live === "true") {
	const { runLiveEvalCli } = await import("./live.ts");
	await runLiveEvalCli();
} else {
	const here = dirname(fileURLToPath(import.meta.url));
	const corpusPath = join(here, "corpus.jsonl");
	const entries = parseCorpus(readFileSync(corpusPath, "utf8"));
	const threshold = DEFAULTS.policy.threshold;

	const result = scoreCorpus(entries, (prompt) => {
		const { score } = heuristicScore(prompt);
		return { tier: score >= threshold ? "cloud" : "local", score };
	});

	console.log(formatResult(result));
	if (result.accuracy < ACCURACY_FLOOR) {
		console.error(`\nheuristic accuracy ${(result.accuracy * 100).toFixed(1)}% is below the ${ACCURACY_FLOOR * 100}% floor`);
		process.exit(1);
	}
}
