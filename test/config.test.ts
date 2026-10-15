import assert from "node:assert/strict";
import { test } from "node:test";

import { applyOverrides, DEFAULTS, expandHome } from "../src/config.ts";

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
