import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCORE_TAXONOMY, type ScoreDataType } from "../src/scores.ts";

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
			assert.equal(byName[name].dataType, dataType, `${name} data type`);
			assert.ok(byName[name].rule.trim().length > 0, `${name} must state its rule`);
		}
	});
});
