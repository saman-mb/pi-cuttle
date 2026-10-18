/**
 * Pins the eval-pipeline documentation against the code it describes.
 *
 * Two drifts motivated this file:
 *
 * 1. `eval/BASELINE.md` advertised `ACCURACY_FLOOR = 0.9` while `eval/run.ts` exported
 *    `0.8`. The floor is the promise the eval makes ("a regression cannot land quietly"),
 *    so the documented number must be the enforced one.
 * 2. `docs/EVAL.md` and `docs/EVAL-IMPACT.md` described the pipeline as validating routing
 *    decisions, while `eval/pi-cuttle-provider.ts` runs with `classifier.model: undefined` —
 *    the heuristic, never the decision model. The docs must say which layer they describe,
 *    so a reader cannot mistake a heuristic pass for decision-model coverage.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the documented accuracy floor matches the enforced one", () => {
	const run = read("eval/run.ts");
	const match = run.match(/export const ACCURACY_FLOOR = ([\d.]+)/);
	assert.ok(match, "eval/run.ts must export ACCURACY_FLOOR");
	const floor = match[1] as string;

	const baseline = read("eval/BASELINE.md");
	assert.match(
		baseline,
		new RegExp(`ACCURACY_FLOOR\\s*=\\s*${floor.replace(".", "\\.")}`),
		`eval/BASELINE.md must document the floor that eval/run.ts enforces (${floor})`,
	);
});

test("the eval docs name both layers and stay honest about what runs today (#84)", () => {
	const evalDoc = read("docs/EVAL.md");
	assert.match(evalDoc, /Layer 1/, "docs/EVAL.md must name the routing-policy layer");
	assert.match(evalDoc, /Layer 2/, "docs/EVAL.md must name the decision-model layer");
	assert.match(evalDoc, /#97/, "docs/EVAL.md must link the decision-model work (#97)");
	assert.match(evalDoc, /#98/, "docs/EVAL.md must link the holdout-corpus work (#98)");
});

test("the eval provider's default path is the heuristic, and the docs say so (#97)", () => {
	const provider = read("eval/pi-cuttle-provider.ts");
	assert.match(
		provider,
		/model\s*[:=]\s*undefined/,
		"the default eval provider runs the heuristic; if this changes, update docs/EVAL.md's layer table",
	);
	assert.match(
		read("docs/EVAL.md"),
		/does\s+\*\*not\*\*\s+invoke the decision model|not.*invoke the decision model/i,
		"docs/EVAL.md must state that the default eval layer does not invoke the decision model",
	);
});

test("the CI doc warns against self-hosted runners before one is registered (#84)", () => {
	const ci = read("docs/CI.md");
	assert.match(ci, /runs-on: self-hosted/, "docs/CI.md must address the self-hosted runner");
	assert.match(ci, /queue/i, "docs/CI.md must warn that an unregistered self-hosted job queues forever");
	assert.match(ci, /actions\/runners/, "docs/CI.md must show how to check for a registered runner");
});
