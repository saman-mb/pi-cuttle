/**
 * Tests for turning Langfuse traces into misroute fixtures (#90, #132).
 *
 * The selection is pure: a trace tagged `misroute` exports, and so does one carrying a failing
 * `flavor_compliance` score. Everything else does not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectMisroutes, type ScoredTrace } from "../eval/export-misroutes.ts";

function trace(over: Partial<ScoredTrace> = {}): ScoredTrace {
	return {
		id: "t1",
		timestamp: "2026-10-18T00:00:00.000Z",
		metadata: { prompt: "do the thing", tier: "cloud", modelId: "opencode-go/gpt-6-luna", flavor: "local" },
		...over,
	};
}

describe("misroute selection", () => {
	it("a failing flavor_compliance score exports the trace", () => {
		const fixtures = selectMisroutes([trace({ scores: [{ name: "flavor_compliance", value: false }] })]);
		assert.equal(fixtures.length, 1);
		assert.equal(fixtures[0]?.actualModel, "opencode-go/gpt-6-luna");
		assert.match(fixtures[0]?.notes ?? "", /flavor_compliance=false/);
	});

	it("a trace tagged misroute still exports", () => {
		const fixtures = selectMisroutes([trace({ tags: ["misroute"] })]);
		assert.equal(fixtures.length, 1);
	});

	it("a compliant score, or no score at all, does not export", () => {
		assert.equal(selectMisroutes([trace({ scores: [{ name: "flavor_compliance", value: true }] })]).length, 0);
		assert.equal(selectMisroutes([trace()]).length, 0);
	});

	it("a trace missing its prompt or model cannot become a fixture", () => {
		const fixtures = selectMisroutes([
			trace({ metadata: { tier: "cloud" }, scores: [{ name: "flavor_compliance", value: false }] }),
		]);
		assert.equal(fixtures.length, 0);
	});
});
