import assert from "node:assert/strict";
import { test } from "node:test";

import { applyOverrides, DEFAULTS, expandHome } from "../src/config.ts";

test("classifier context defaults preserve last-message behavior and disable shadow comparisons", () => {
	assert.equal(DEFAULTS.classifier.contextSource, "last-message");
	assert.equal(DEFAULTS.classifier.contextShadow, false);
	assert.equal(applyOverrides(DEFAULTS, { classifier: { contextShadow: true } }).classifier.contextShadow, true);
	assert.equal(applyOverrides(DEFAULTS, { classifier: { contextShadow: "yes" } }).classifier.contextShadow, false);
	assert.equal(DEFAULTS.classifier.contextBudget, 8192);
	assert.equal(DEFAULTS.classifier.conversationWindow, 3);
	const existingConfig = applyOverrides(DEFAULTS, { classifier: { model: "llama.cpp/kev", stateChars: 1234 } });
	assert.equal(existingConfig.classifier.contextSource, "last-message");
	assert.equal(existingConfig.classifier.stateChars, 1234);
});

test("unknown classifier context sources fall back to last-message", () => {
	const merged = applyOverrides(DEFAULTS, { classifier: { contextSource: "future-mode" } });
	assert.equal(merged.classifier.contextSource, "last-message");
});

test("classifier conversation budget is clamped and invalid values are ignored", () => {
	const capped = applyOverrides(DEFAULTS, { classifier: { contextBudget: 100_000 } });
	assert.equal(capped.classifier.contextBudget, 64_000);
	const floored = applyOverrides(DEFAULTS, { classifier: { contextBudget: -10 } });
	assert.equal(floored.classifier.contextBudget, 1);
	const invalid = applyOverrides(DEFAULTS, { classifier: { contextBudget: "large" } });
	assert.equal(invalid.classifier.contextBudget, 8192);
	assert.equal(DEFAULTS.classifier.conversationWindow, 3);
});

test("defaults route by complexity once per session", () => {
	assert.equal(DEFAULTS.policy.mode, "complexity");
	assert.equal(DEFAULTS.policy.reclassify, "session");
	assert.equal(DEFAULTS.local.onFull, "spill");
	assert.equal(DEFAULTS.local.maxConcurrent, 1);
});

test("applyOverrides replaces only the sections present", () => {
	const merged = applyOverrides(DEFAULTS, {
		catalog: { local: ["lmstudio/a"], cloud: ["cloud/b"] },
		local: { maxConcurrent: 3 },
	});
	assert.deepEqual(merged.catalog.local, ["lmstudio/a"]);
	assert.equal(merged.local.maxConcurrent, 3);
	// Untouched sections keep defaults.
	assert.equal(merged.policy.threshold, DEFAULTS.policy.threshold);
	assert.equal(merged.local.staleSlotMs, DEFAULTS.local.staleSlotMs);
	assert.equal(merged.classifier.fallback, "heuristic");
});

test("applyOverrides is a no-op for non-objects", () => {
	assert.equal(applyOverrides(DEFAULTS, null), DEFAULTS);
	assert.equal(applyOverrides(DEFAULTS, "nonsense"), DEFAULTS);
	assert.equal(applyOverrides(DEFAULTS, [1, 2, 3]), DEFAULTS);
});

test("expandHome expands only a leading tilde", () => {
	assert.ok(expandHome("~/x").endsWith("/x"));
	assert.ok(!expandHome("~/x").startsWith("~"));
	assert.equal(expandHome("/abs/~inside"), "/abs/~inside");
});
