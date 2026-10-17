/**
 * Covers `/cuttle status` rendering and the on/off toggle state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatusLines } from "../src/commands.ts";
import { DEFAULTS } from "../src/config.ts";
import type { RouterRuntime } from "../src/virtual-models.ts";

function rtWith(autoSelect: boolean): RouterRuntime {
	return {
		config: { ...DEFAULTS, autoSelect },
		governor: { status: async () => ({ slots: [], localMax: DEFAULTS.local.maxConcurrent }) } as unknown as RouterRuntime["governor"],
		pins: new Map(),
		previousModels: new Map(),
		sizes: new Map(),
	} as unknown as RouterRuntime;
}

test("buildStatusLines shows routing enabled/disabled", () => {
	const enabled = buildStatusLines({ rt: rtWith(true), loaded: { config: DEFAULTS, sources: [], warnings: [] }, effectiveChars: DEFAULTS.classifier.stateChars, governor: { slots: [], localMax: 1 } });
	assert.ok(enabled.some((line) => line.includes("routing:  enabled")));

	const disabled = buildStatusLines({ rt: rtWith(false), loaded: { config: DEFAULTS, sources: [], warnings: [] }, effectiveChars: DEFAULTS.classifier.stateChars, governor: { slots: [], localMax: 1 } });
	assert.ok(disabled.some((line) => line.includes("routing:  disabled")));
});

test("buildStatusLines surfaces the last classifier failure", () => {
	const rt = rtWith(true);
	rt.lastClassifierError = { ref: "llama.cpp/kev", message: "connection refused", turn: 3, at: Date.now() };
	const lines = buildStatusLines({ rt, loaded: { config: DEFAULTS, sources: [], warnings: [] }, effectiveChars: DEFAULTS.classifier.stateChars, governor: { slots: [], localMax: 1 } });
	assert.ok(lines.some((line) => line.includes("failure:  turn 3 llama.cpp/kev")));
});
