/**
 * Thinking-level mapping unit tests. Pure helpers; no ExtensionContext required.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai/compat";

import {
	applyContextPressure,
	applyUserCeiling,
	clampToSupportedLevel,
	reduceThinkingLevel,
	scoreToThinkingLevel,
} from "../src/thinking-levels.ts";
import { EXTENDED_THINKING_LEVELS } from "../src/thinking-levels.ts";
import type { ThinkingLevelsPolicy } from "../src/types.ts";

const POLICY: ThinkingLevelsPolicy = {
	enabled: true,
	map: [
		{ score: 0.15, level: "off" },
		{ score: 0.35, level: "minimal" },
		{ score: 0.55, level: "low" },
		{ score: 0.75, level: "medium" },
	],
	default: "high",
};

function makeModel(thinkingLevelMap: Record<string, string | null>): Model<any> {
	return {
		id: "test",
		provider: "test",
		name: "Test",
		api: "openai-completions",
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: true,
		thinkingLevelMap,
	} as unknown as Model<any>;
}

describe("scoreToThinkingLevel", () => {
	it("returns default when policy is disabled", () => {
		const disabled: ThinkingLevelsPolicy = { ...POLICY, enabled: false };
		assert.equal(scoreToThinkingLevel(0.5, disabled), "high");
	});

	it("returns default when map is empty", () => {
		const empty: ThinkingLevelsPolicy = { enabled: true, map: [], default: "medium" };
		assert.equal(scoreToThinkingLevel(0.5, empty), "medium");
	});

	it("maps low scores to off", () => {
		assert.equal(scoreToThinkingLevel(0.1, POLICY), "off");
	});

	it("maps moderate-low scores to minimal", () => {
		assert.equal(scoreToThinkingLevel(0.25, POLICY), "minimal");
	});

	it("maps moderate scores to low", () => {
		assert.equal(scoreToThinkingLevel(0.45, POLICY), "low");
	});

	it("maps moderate-high scores to medium", () => {
		assert.equal(scoreToThinkingLevel(0.65, POLICY), "medium");
	});

	it("returns default for scores above all thresholds", () => {
		assert.equal(scoreToThinkingLevel(0.9, POLICY), "high");
	});

	it("handles unsorted map by sorting ascending", () => {
		const unsorted: ThinkingLevelsPolicy = {
			...POLICY,
			map: [
				{ score: 0.75, level: "medium" },
				{ score: 0.15, level: "off" },
			],
		};
		assert.equal(scoreToThinkingLevel(0.1, unsorted), "off");
		assert.equal(scoreToThinkingLevel(0.5, unsorted), "medium");
	});
});

describe("clampToSupportedLevel", () => {
	const binaryModel = makeModel({ off: "none", high: "high" });
	const fullModel = makeModel({
		off: "none",
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "xhigh",
	});

	it("passes through supported levels unchanged", () => {
		assert.equal(clampToSupportedLevel("off", binaryModel), "off");
		assert.equal(clampToSupportedLevel("high", binaryModel), "high");
	});

	it("walks up from unsupported level to nearest supported", () => {
		// minimal is unsupported on binaryModel; walks up to high
		assert.equal(clampToSupportedLevel("minimal", binaryModel), "high");
		assert.equal(clampToSupportedLevel("medium", binaryModel), "high");
	});

	it("walks down when walking up exhausts the ladder", () => {
		const offOnlyModel = makeModel({ off: "none" });
		// high is unsupported; walks up (none left), then down to off
		assert.equal(clampToSupportedLevel("high", offOnlyModel), "off");
	});

	it("full model accepts all levels", () => {
		for (const level of EXTENDED_THINKING_LEVELS) {
			assert.equal(clampToSupportedLevel(level, fullModel), level);
		}
	});
});

describe("applyUserCeiling", () => {
	it("keeps target when below ceiling", () => {
		assert.equal(applyUserCeiling("low", "high"), "low");
	});

	it("caps target at ceiling when above", () => {
		assert.equal(applyUserCeiling("xhigh", "medium"), "medium");
	});

	it("allows equal levels", () => {
		assert.equal(applyUserCeiling("medium", "medium"), "medium");
	});

	it("returns target when ceiling is not a valid level", () => {
		assert.equal(applyUserCeiling("high", "invalid" as any), "high");
	});

	it("returns target when target is not a valid level", () => {
		assert.equal(applyUserCeiling("invalid" as any, "high"), "invalid" as any);
	});
});

describe("reduceThinkingLevel", () => {
	it("steps down one level", () => {
		assert.equal(reduceThinkingLevel("high"), "medium");
		assert.equal(reduceThinkingLevel("minimal"), "off");
	});

	it("stays at bottom of ladder", () => {
		assert.equal(reduceThinkingLevel("off"), "off");
	});
});

describe("applyContextPressure", () => {
	it("does not reduce when usage is below threshold", () => {
		assert.equal(applyContextPressure("high", 50000, 128000, 0.7), "high");
	});

	it("reduces by one step when usage exceeds threshold", () => {
		assert.equal(applyContextPressure("high", 100000, 128000, 0.7), "medium");
	});

	it("does not reduce below off", () => {
		assert.equal(applyContextPressure("off", 100000, 128000, 0.7), "off");
	});

	it("ignores null usage", () => {
		assert.equal(applyContextPressure("high", null, 128000, 0.7), "high");
	});

	it("uses 0.7 default threshold when not specified", () => {
		assert.equal(applyContextPressure("high", 100000, 128000), "medium");
	});
});
