/**
 * Covers `/cuttle status` rendering and the on/off toggle state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { applyRuntimePatch, buildInitPatch, buildStatusLines, checkCatalog } from "../src/commands.ts";
import { DEFAULTS, saveUserConfig } from "../src/config.ts";
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

test("applyRuntimePatch deep-merges policy so phase subkeys survive", () => {
	const rt = rtWith(false);
	applyRuntimePatch(rt, { policy: { phase: { plan: "local" as const } } });
	assert.equal(rt.config.policy.phase.plan, "local");
	assert.equal(rt.config.policy.phase.implement, DEFAULTS.policy.phase.implement, "implement subkey is preserved");
});

test("applyRuntimePatch deep-merges policy escalate subkeys", () => {
	const rt = rtWith(false);
	applyRuntimePatch(rt, { policy: { escalate: { toolErrors: 5 } } });
	assert.equal(rt.config.policy.escalate.toolErrors, 5);
	assert.equal(rt.config.policy.escalate.window, DEFAULTS.policy.escalate.window, "window subkey is preserved");
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

/**
 * Behavior tests for config panel changes.
 *
 * We cannot easily drive the full SettingsList keyboard path without a TUI,
 * so we test the layer just below it: the handler logic and row structure.
 */

// Helper to create a minimal runtime for patch testing
function freshRt(): RouterRuntime {
	return {
		config: structuredClone(DEFAULTS),
		governor: { status: async () => ({ slots: [], localMax: DEFAULTS.local.maxConcurrent }) } as unknown as RouterRuntime["governor"],
		pins: new Map(),
		previousModels: new Map(),
		sizes: new Map(),
	} as unknown as RouterRuntime;
}

// Clean up user config after tests
const userConfigPath = join(homedir(), ".pi", "agent", "pi-cuttle.json");
let hadUserConfig = false;
let savedUserConfig: string | undefined;

test.before(() => {
	try {
		savedUserConfig = readFileSync(userConfigPath, "utf8");
		hadUserConfig = true;
	} catch {
		hadUserConfig = false;
	}
});

test.after(() => {
	if (hadUserConfig && savedUserConfig !== undefined) {
		writeFileSync(userConfigPath, savedUserConfig);
	} else if (!hadUserConfig) {
		try {
			unlinkSync(userConfigPath);
		} catch {
			/* file may not exist */
		}
	}
});

test("policy change produces correct config patch", () => {
	const rt = freshRt();
	applyRuntimePatch(rt, { policy: { mode: "cost" } });
	assert.equal(rt.config.policy.mode, "cost");
	// Verify the patch shape that would be written
	const path = saveUserConfig({ policy: { mode: "phase" } });
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.policy.mode, "phase");
});

test("max-concurrent change produces { local: { maxConcurrent: N } }", () => {
	const rt = freshRt();
	applyRuntimePatch(rt, { local: { maxConcurrent: 4 } });
	assert.equal(rt.config.local.maxConcurrent, 4);
	// Verify the patch shape
	const path = saveUserConfig({ local: { maxConcurrent: 6 } });
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.local.maxConcurrent, 6);
});

test("classifier change produces { classifier: { model: ref } }", () => {
	const rt = freshRt();
	applyRuntimePatch(rt, { classifier: { model: "llama.cpp/test" } });
	assert.equal(rt.config.classifier.model, "llama.cpp/test");
	// Verify the patch shape
	const path = saveUserConfig({ classifier: { model: "llama.cpp/another" } });
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.classifier.model, "llama.cpp/another");
});

test("classifier unset produces { classifier: { model: undefined } }", () => {
	const rt = freshRt();
	rt.config.classifier.model = "llama.cpp/existing";
	applyRuntimePatch(rt, { classifier: { model: undefined } });
	assert.equal(rt.config.classifier.model, undefined);
	// Verify the patch shape - undefined should remove the key or set to null
	const path = saveUserConfig({ classifier: { model: null } });
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.classifier.model, null);
});
