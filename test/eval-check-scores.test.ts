/**
 * The pure core of the live score check (#132). No Langfuse, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verdicts, type TraceView } from "../eval/check-scores.ts";

const LOCAL = ["mtplx/mtplx-flash-next-optimized-speed"];

function trace(id: string, flavor: string, modelId: string): TraceView {
	return { id, metadata: { flavor, modelId } };
}

describe("score verdicts", () => {
	it("a local flavor on a cloud model is a disagreement when the recorded score says compliant", () => {
		const rows = verdicts(
			[trace("t1", "local", "opencode-go/gpt-6-luna")],
			new Map([["t1", true]]),
			LOCAL,
		);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.expected, false);
		assert.equal(rows[0]?.recorded, true);
		assert.notEqual(rows[0]?.expected, rows[0]?.recorded, "the disagreement is the detection");
	});

	it("a local flavor on a local model agrees with a compliant score", () => {
		const rows = verdicts(
			[trace("t1", "local", "mtplx/mtplx-flash-next-optimized-speed")],
			new Map([["t1", true]]),
			LOCAL,
		);
		assert.equal(rows[0]?.expected, rows[0]?.recorded);
	});

	it("a trace with no recorded score is reported but is not a disagreement", () => {
		const rows = verdicts([trace("t1", "local", "opencode-go/gpt-6-luna")], new Map(), LOCAL);
		assert.equal(rows[0]?.recorded, undefined);
	});

	it("a non-local-only flavor is not judged", () => {
		const rows = verdicts([trace("t1", "auto", "opencode-go/gpt-6-luna")], new Map(), LOCAL);
		assert.equal(rows.length, 0);
	});
});
