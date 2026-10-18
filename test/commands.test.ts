/**
 * Covers `/cuttle status` rendering and the on/off toggle state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInitPatch, buildStatusLines, checkCatalog } from "../src/commands.ts";
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

test("checkCatalog separates resolvable catalog entries from missing ones", () => {
	const known = new Set(["mtplx/mtplx-flash-next-optimized-speed", "opencode-go/deepseek-v4.1-flash"]);
	const find = (provider: string, id: string): unknown =>
		known.has(`${provider}/${id}`) ? { provider, id } : undefined;

	const { resolvable, missing } = checkCatalog(
		["mtplx/mtplx-qwen38-27b-optimized-quality", "mtplx/mtplx-flash-next-optimized-speed", "garbage"],
		find,
	);
	assert.deepEqual(resolvable, ["mtplx/mtplx-flash-next-optimized-speed"]);
	assert.deepEqual(missing, ["mtplx/mtplx-qwen38-27b-optimized-quality", "garbage"]);
});

test("checkCatalog reports a fully unresolvable tier as all-missing", () => {
	const { resolvable, missing } = checkCatalog(["typo/model"], () => undefined);
	assert.deepEqual(resolvable, []);
	assert.deepEqual(missing, ["typo/model"]);
});

test("buildInitPatch writes a full first-run config", () => {
	const patch = buildInitPatch({
		autoSelect: true,
		classifier: "llama.cpp/kev",
		local: "mtplx/flash",
		cloud: "opencode-go/deepseek",
	});
	assert.equal(patch.autoSelect, true);
	assert.equal((patch.classifier as Record<string, unknown>).model, "llama.cpp/kev");
	assert.deepEqual((patch.catalog as Record<string, unknown>).local, ["mtplx/flash"]);
	assert.deepEqual((patch.catalog as Record<string, unknown>).cloud, ["opencode-go/deepseek"]);
});

test("buildInitPatch omits classifier when none chosen", () => {
	const patch = buildInitPatch({ autoSelect: false });
	assert.equal(patch.autoSelect, false);
	assert.equal(patch.classifier, undefined);
	assert.equal(patch.catalog, undefined);
});

test("buildStatusLines surfaces the last classifier failure", () => {
	const rt = rtWith(true);
	rt.lastClassifierError = { ref: "llama.cpp/kev", message: "connection refused", turn: 3, at: Date.now() };
	const lines = buildStatusLines({ rt, loaded: { config: DEFAULTS, sources: [], warnings: [] }, effectiveChars: DEFAULTS.classifier.stateChars, governor: { slots: [], localMax: 1 } });
	assert.ok(lines.some((line) => line.includes("failure:  turn 3 llama.cpp/kev")));
});
