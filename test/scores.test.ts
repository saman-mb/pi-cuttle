import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLocalOnlyFlavor } from "../src/virtual-models.ts";
import type { RouterFlavor } from "../src/types.ts";
import { SCORE_TAXONOMY, decisionScores, bypassScores, type ScoreDataType } from "../src/scores.ts";

const LOCAL = ["mtplx/mtplx-flash-next-optimized-speed", "lmstudio/meta/muse-glimmer"];
const ALL_FLAVORS: RouterFlavor[] = ["auto", "local", "cloud", "fast-local", "big-local", "orchestrator"];

describe("score taxonomy", () => {
	it("pins every score name, data type, and rule so a rename cannot silently reset history", () => {
		const byName = Object.fromEntries(SCORE_TAXONOMY.map((s) => [s.name, s]));

		assert.deepEqual(
			Object.keys(byName).sort(),
			["flavor_compliance", "routed"],
			"the taxonomy names exactly the committed scores",
		);

		const expected: Record<string, ScoreDataType> = {
			flavor_compliance: "boolean",
			routed: "boolean",
		};
		for (const [name, dataType] of Object.entries(expected)) {
			const score = byName[name];
			assert.ok(score, `${name} is in the taxonomy`);
			assert.equal(score.dataType, dataType, `${name} data type`);
			assert.ok(score.rule.trim().length > 0, `${name} must state its rule`);
		}
	});
});

describe("score computation", () => {
	it("flavor_compliance is true when a local-only flavor is served by a local model", () => {
		for (const flavor of ["local", "fast-local", "big-local"]) {
			const scores = decisionScores(flavor, "mtplx/mtplx-flash-next-optimized-speed", LOCAL);
			assert.deepEqual(scores, [{ name: "flavor_compliance", value: true, dataType: "BOOLEAN" }], flavor);
		}
	});

	it("flavor_compliance is false when a local-only flavor is served by a cloud model", () => {
		// The #130 detector. The pairing is synthetic: route()'s #112 pin makes a local-only flavor
		// served by a cloud model unreachable through route() itself, so the false case can only be
		// exercised here, at the computation level.
		const scores = decisionScores("local", "opencode-go/gpt-6-luna", LOCAL);
		assert.deepEqual(scores, [{ name: "flavor_compliance", value: false, dataType: "BOOLEAN" }]);
	});

	it("a thinking suffix on a local model still counts as local", () => {
		const scores = decisionScores("local", "lmstudio/meta/muse-glimmer:high", LOCAL);
		assert.equal(scores[0]?.value, true);
	});

	it("non-local-only flavors emit no flavor_compliance score", () => {
		for (const flavor of ["auto", "cloud", "orchestrator"]) {
			assert.deepEqual(decisionScores(flavor, "opencode-go/gpt-6-luna", LOCAL), [], flavor);
		}
	});

	it("the child-bypass path emits routed:false and nothing else", () => {
		assert.deepEqual(bypassScores(), [{ name: "routed", value: false, dataType: "BOOLEAN" }]);
	});

	it("the local-only flavor copy agrees with isLocalOnlyFlavor, so it cannot drift", () => {
		for (const flavor of ALL_FLAVORS) {
			const emits = decisionScores(flavor, "opencode-go/gpt-6-luna", LOCAL).some(
				(s) => s.name === "flavor_compliance",
			);
			assert.equal(emits, isLocalOnlyFlavor(flavor), flavor);
		}
	});
});
