import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTier, applyPolicy, heuristicScore, splitRef } from "../src/classifier.ts";
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

test("applyPolicy: complexity passes through", () => {
	const d = { tier: "cloud" as const, score: 0.6, source: "classifier" as const, reason: "x" };
	const out = applyPolicy({ ...DEFAULTS, policy: { ...DEFAULTS.policy, mode: "complexity" } }, d, "planning");
	assert.equal(out.tier, "cloud");
});

test("applyPolicy: cost biases local and only a strong signal escapes", () => {
	const cfg = { ...DEFAULTS, policy: { ...DEFAULTS.policy, mode: "cost" as const } };
	const weak = applyPolicy(cfg, { tier: "cloud", score: 0.6, source: "classifier", reason: "x" }, "planning");
	assert.equal(weak.tier, "local", "0.6 is below the 0.75 cost bar");
	const strong = applyPolicy(cfg, { tier: "cloud", score: 0.9, source: "classifier", reason: "x" }, "planning");
	assert.equal(strong.tier, "cloud");
});

test("applyPolicy: phase ignores the score", () => {
	const cfg = { ...DEFAULTS, policy: { ...DEFAULTS.policy, mode: "phase" as const, phase: { plan: "cloud", implement: "local" } } };
	const score = { tier: "local" as const, score: 0.1, source: "classifier" as const, reason: "x" };
	assert.equal(applyPolicy(cfg, score, "planning").tier, "cloud");
	assert.equal(applyPolicy(cfg, score, "implementation").tier, "local");
});

function fakeLm(overrides: Partial<Record<string, unknown>>): LmStudioClient {
	return overrides as unknown as LmStudioClient;
}

test("decision model via System One: high complexity probability -> cloud", async () => {
	const lm = fakeLm({
		modelType: async () => "decision",
		systemOne: async () => ({ answers: { complexity: { type: "choice", choice: "complex", probabilities: { standard: 0.1, complex: 0.9 } } } }),
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-2.0-kai-0.6b" } },
		prompt: "rename a variable",
		ctx,
		lm,
	});
	assert.equal(d.tier, "cloud");
	assert.equal(d.source, "classifier");
});

test("decision model via System One: low complexity -> local", async () => {
	const lm = fakeLm({
		modelType: async () => "decision",
		systemOne: async () => ({ answers: { complexity: { type: "choice", choice: "standard", probabilities: { standard: 0.95, complex: 0.05 } } } }),
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-2.0-kai-0.6b" } },
		prompt: "refactor the architecture",
		ctx,
		lm,
	});
	assert.equal(d.tier, "local");
});

test("chat model classifier parses a one-word answer", async () => {
	const lm = fakeLm({ modelType: async () => "llm", chat: async () => "CLOUD" });
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/some-chat" } },
		prompt: "add a button",
		ctx,
		lm,
	});
	assert.equal(d.tier, "cloud");
});

test("a failing classifier falls back to the heuristic", async () => {
	const lm = fakeLm({ modelType: async () => "decision", systemOne: async () => { throw new Error("boom"); } });
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-x" } },
		prompt: "rename a variable",
		ctx,
		lm,
	});
	assert.equal(d.source, "heuristic");
	assert.equal(d.tier, "local");
});
