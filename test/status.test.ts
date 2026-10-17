import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatusLines, oneLine } from "../src/commands.ts";
import { DEFAULTS } from "../src/config.ts";
import type { GovernorStatus, RouterConfig } from "../src/types.ts";
import type { RouterRuntime } from "../src/virtual-models.ts";

function runtimeWith(overrides: Partial<RouterRuntime> = {}): RouterRuntime {
	const config: RouterConfig = {
		...structuredClone(DEFAULTS),
		classifier: { ...DEFAULTS.classifier, model: "llama.cpp/decision-x" },
		catalog: { local: ["llama.cpp/local-a"], cloud: ["cloud/big"] },
	};
	return { config, pins: new Map(), previousModels: new Map(), sizes: new Map(), ...overrides } as unknown as RouterRuntime;
}

const GOVERNOR: GovernorStatus = {
	slots: [],
	localMax: 1,
};

function render(rt: RouterRuntime): string[] {
	return buildStatusLines({ rt, loaded: { config: rt.config, sources: [], warnings: [] }, effectiveChars: 4096, governor: GOVERNOR });
}

test("the failure line is absent when the last classification succeeded (#53)", () => {
	const lines = render(runtimeWith());
	assert.equal(
		lines.some((line) => line.startsWith("failure:")),
		false,
		"no failure line unless a classification actually failed",
	);
});

test("the failure line renders turn, ref, and sanitized error text (#53)", () => {
	const rt = runtimeWith({
		lastClassifierError: {
			ref: "lmstudio/decision-x",
			message: 'LM Studio POST /v1/systemone -> 400 {\n  "error": {\n    "message": "Failed to load model",\n    "code": "jitLoadFailed"\n  }\n}',
			turn: 3,
			at: 1,
		},
	});
	const line = render(rt).find((l) => l.startsWith("failure:"));
	assert.equal(
		line,
		'failure:  turn 3 lmstudio/decision-x \u2014 LM Studio POST /v1/systemone -> 400 { "error": { "message": "Failed to load model", "code": "jitLoadFailed" } }',
	);
	assert.equal(line?.includes("\n"), false, "never multi-line in the status panel");
});

test("oneLine collapses whitespace and truncates long errors (#53)", () => {
	assert.equal(oneLine("a\n b\t c"), "a b c");
	const long = "x".repeat(300);
	const clipped = oneLine(long);
	assert.equal(clipped.length, 160);
	assert.equal(clipped.endsWith("\u2026"), true);
});
