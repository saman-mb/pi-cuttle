import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTier, heuristicScore, splitRef } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import type { LmStudioClient } from "../src/lmstudio.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const lm = {} as LmStudioClient;
const ctx = {} as ExtensionContext;

test("mechanical prompts lean local, design prompts lean cloud", () => {
	assert.ok(heuristicScore("rename this variable and fix the typo").score < 0.5);
	assert.ok(heuristicScore("refactor the architecture across the codebase").score >= 0.5);
});

test("a pin short-circuits everything, including the classifier", async () => {
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/x" } },
		prompt: "refactor everything",
		ctx,
		lm,
		forced: "local",
	});
	assert.equal(decision.tier, "local");
	assert.equal(decision.source, "pin");
});

test("no classifier configured uses the heuristic", async () => {
	const decision = await decideTier({ config: DEFAULTS, prompt: "rename a variable", ctx, lm });
	assert.equal(decision.source, "heuristic");
	assert.equal(decision.tier, "local");
});

test("an unreachable classifier falls back to the heuristic without throwing", async () => {
	// ctx.modelRegistry is undefined -> classify path throws -> fallback.
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "typesafe/jev-latest" } },
		prompt: "rename a variable",
		ctx,
		lm,
	});
	assert.equal(decision.source, "heuristic");
});

test("splitRef handles ids containing slashes", () => {
	assert.deepEqual(splitRef("lmstudio/deepseek/deepseek-v4-flash"), {
		provider: "lmstudio",
		id: "deepseek/deepseek-v4-flash",
	});
	assert.deepEqual(splitRef("cloud/model"), { provider: "cloud", id: "model" });
	assert.equal(splitRef("noslash"), undefined);
	assert.equal(splitRef("/leading"), undefined);
});
