import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTier, applyPolicy, heuristicScore, splitRef } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function fakeCtx(classifyResult?: { stopReason: "stop" | "error"; answers: Record<string, unknown> }): ExtensionContext {
	return {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp", api: "typesafe-system-one" } as unknown),
			classify: async () =>
				(classifyResult ?? {
					stopReason: "stop",
					answers: { complexity: { type: "choice", choice: "complex", probabilities: { standard: 0.1, complex: 0.9 } } },
				}) as never,
		},
	} as unknown as ExtensionContext;
}

test("mechanical prompts lean local, design prompts lean cloud", () => {
	assert.ok(heuristicScore("rename this variable and fix the typo").score < 0.5);
	assert.ok(heuristicScore("refactor the architecture across the codebase").score >= 0.5);
});

test("a pin short-circuits everything, including the classifier", async () => {
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/x" } },
		prompt: "refactor everything",
		ctx: fakeCtx(),
		forced: "local",
	});
	assert.equal(decision.tier, "local");
	assert.equal(decision.source, "pin");
});

test("no classifier configured uses the heuristic", async () => {
	const decision = await decideTier({ config: DEFAULTS, prompt: "rename a variable", ctx: fakeCtx() });
	assert.equal(decision.source, "heuristic");
	assert.equal(decision.tier, "local");
});

test("a classifier configured but missing from pi falls back to heuristic", async () => {
	const ctx = {
		modelRegistry: { findOfType: () => undefined, classify: async () => ({ stopReason: "error", answers: {} }) },
	} as unknown as ExtensionContext;
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/missing" } },
		prompt: "rename a variable",
		ctx,
	});
	assert.equal(decision.source, "heuristic");
	assert.match(decision.reason, /not in pi/);
});

test("splitRef handles ids containing slashes", () => {
	assert.deepEqual(splitRef("llama.cpp/deepseek/deepseek-v4-flash"), {
		provider: "llama.cpp",
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
	const cfg = { ...DEFAULTS, policy: { ...DEFAULTS.policy, mode: "phase" as const, phase: { plan: "cloud" as const, implement: "local" as const } } };
	const score = { tier: "local" as const, score: 0.1, source: "classifier" as const, reason: "x" };
	assert.equal(applyPolicy(cfg, score, "planning").tier, "cloud");
	assert.equal(applyPolicy(cfg, score, "implementation").tier, "local");
});

test("classifier via modelRegistry: high complexity -> cloud", async () => {
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		prompt: "rename a variable",
		ctx: fakeCtx(),
	});
	assert.equal(d.tier, "cloud");
	assert.equal(d.source, "classifier");
});

test("classifier via modelRegistry: low complexity -> local", async () => {
	const ctx = fakeCtx({
		stopReason: "stop",
		answers: { complexity: { type: "choice", choice: "standard", probabilities: { standard: 0.95, complex: 0.05 } } },
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		prompt: "refactor the architecture",
		ctx,
	});
	assert.equal(d.tier, "local");
});

test("a failing classifier falls back to the heuristic", async () => {
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async () => { throw new Error("boom"); },
		},
	} as unknown as ExtensionContext;
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		prompt: "rename a variable",
		ctx,
	});
	assert.equal(d.source, "heuristic");
	assert.equal(d.tier, "local");
});

test("fallback reason surfaces the classifier error", async () => {
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async () => { throw new Error("classifier unavailable"); },
		},
	} as unknown as ExtensionContext;
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		prompt: "rename a variable",
		ctx,
	});
	assert.equal(d.source, "heuristic");
	assert.match(d.reason, /classifier unavailable/);
});

test("a classifier failure is surfaced on the router log", async () => {
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async () => { throw new Error("model kaput"); },
		},
	} as unknown as ExtensionContext;
	const logs: string[] = [];
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		prompt: "rename a variable",
		ctx,
		log: (m) => logs.push(m),
	});
	assert.equal(d.source, "heuristic");
	assert.match(d.reason, /model kaput/);
	assert.match(logs.join("\n"), /classifier: model kaput/);
});
