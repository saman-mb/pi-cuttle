import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTier, applyPolicy, heuristicScore, splitRef, decisionStateBudget, detectPhysicalBatchSize, isBatchLimitError } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import type { LocalHost } from "../src/host.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const host = {} as LocalHost;
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
		host,
		forced: "local",
	});
	assert.equal(decision.tier, "local");
	assert.equal(decision.source, "pin");
});

test("no classifier configured uses the heuristic", async () => {
	const decision = await decideTier({ config: DEFAULTS, prompt: "rename a variable", ctx, host });
	assert.equal(decision.source, "heuristic");
	assert.equal(decision.tier, "local");
});

test("an unreachable classifier falls back to the heuristic without throwing", async () => {
	// ctx.modelRegistry is undefined -> classify path throws -> fallback.
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "typesafe/jev-latest" } },
		prompt: "rename a variable",
		ctx,
		host,
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
	const cfg = { ...DEFAULTS, policy: { ...DEFAULTS.policy, mode: "phase" as const, phase: { plan: "cloud" as const, implement: "local" as const } } };
	const score = { tier: "local" as const, score: 0.1, source: "classifier" as const, reason: "x" };
	assert.equal(applyPolicy(cfg, score, "planning").tier, "cloud");
	assert.equal(applyPolicy(cfg, score, "implementation").tier, "local");
});

function fakeHost(overrides: Partial<Record<string, unknown>>): LocalHost {
	return {
		capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		kind: "lmstudio",
		...overrides,
	} as unknown as LocalHost;
}

test("decision model via System One: high complexity probability -> cloud", async () => {
	const localHost = fakeHost({
		modelType: async () => "decision",
		systemOne: async () => ({ answers: { complexity: { type: "choice", choice: "complex", probabilities: { standard: 0.1, complex: 0.9 } } } }),
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-2.0-kai-0.6b" } },
		prompt: "rename a variable",
		ctx,
		host: localHost,
	});
	assert.equal(d.tier, "cloud");
	assert.equal(d.source, "classifier");
});

/**
 * #57: the decision path must invoke `systemOne` on its host, not as a detached function.
 *
 * Every other fake in this file passes `systemOne` as an arrow function in an object literal.
 * An arrow function never reads `this`, so those fakes cannot fail however the method is
 * called — which is how a detached `host.systemOne` broke every decision-model turn on
 * LM Studio while the suite stayed green. This fake is a class method that reads `this` on
 * purpose, because that is what the real `LmStudioHost.systemOne` does.
 */
class ReceiverSensitiveHost {
	readonly capabilities = { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true };
	readonly kind = "lmstudio" as const;
	calls = 0;

	async modelType(): Promise<string> {
		return "decision";
	}

	async systemOne(): Promise<{ answers: Record<string, { type: string } & Record<string, unknown>> }> {
		// Throws when the method is called without the host as its receiver.
		this.calls++;
		return { answers: { complexity: { type: "choice", choice: "complex", probabilities: { standard: 0.1, complex: 0.9 } } } };
	}
}

test("decision model: systemOne is called with the host as its receiver (#57)", async () => {
	const localHost = new ReceiverSensitiveHost();
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-2.0-kai-0.6b" } },
		prompt: "rename a variable",
		ctx,
		host: localHost as unknown as LocalHost,
	});
	assert.equal(localHost.calls, 1, "systemOne must be invoked on the host instance");
	assert.equal(d.source, "classifier", `the classifier must be reached, not the fallback: ${d.reason}`);
	assert.equal(d.tier, "cloud");
});

test("decision model via System One: low complexity -> local", async () => {
	const localHost = fakeHost({
		modelType: async () => "decision",
		systemOne: async () => ({ answers: { complexity: { type: "choice", choice: "standard", probabilities: { standard: 0.95, complex: 0.05 } } } }),
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-2.0-kai-0.6b" } },
		prompt: "refactor the architecture",
		ctx,
		host: localHost,
	});
	assert.equal(d.tier, "local");
});

test("chat model classifier parses a one-word answer", async () => {
	const localHost = fakeHost({ modelType: async () => "llm", chat: async () => "CLOUD" });
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/some-chat" } },
		prompt: "add a button",
		ctx,
		host: localHost,
	});
	assert.equal(d.tier, "cloud");
});

test("a failing classifier falls back to the heuristic", async () => {
	const localHost = fakeHost({ modelType: async () => "decision", systemOne: async () => { throw new Error("boom"); } });
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-x" } },
		prompt: "rename a variable",
		ctx,
		host: localHost,
	});
	assert.equal(d.source, "heuristic");
	assert.equal(d.tier, "local");
});

test("fallback reason surfaces the classifier error (#29)", async () => {
	const localHost = fakeHost({
		modelType: async () => "decision",
		systemOne: async () => {
			throw new Error("Failed to load decision model 'decision-2.0-kai-0.6b'");
		},
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/decision-2.0-kai-0.6b" } },
		prompt: "rename a variable",
		ctx,
		host: localHost,
	});
	assert.equal(d.source, "heuristic");
	assert.match(d.reason, /Failed to load decision model/);
});

test("decisionStateBudget reserves the wrapper overhead and floors at a minimum (#50)", () => {
	assert.equal(decisionStateBudget(), 1920, "default 512-token batch -> 1920 chars");
	assert.equal(decisionStateBudget(512), 1920);
	assert.equal(decisionStateBudget(1024), 4480);
	assert.equal(decisionStateBudget(100), 256, "floors at the minimum instead of going negative");
});

test("isBatchLimitError matches the runtime's single-batch overflow error (#50)", () => {
	assert.equal(isBatchLimitError("input (2352 tokens) is too large to process. current batch size: 512"), true);
	assert.equal(isBatchLimitError("current batch size: 512"), true);
	assert.equal(isBatchLimitError("boom"), false);
	assert.equal(isBatchLimitError(undefined), false);
});

test("a prompt above the decision model's physical batch is trimmed and still classifies (#50)", async () => {
	const seen: string[] = [];
	const localHost = fakeHost({
		modelType: async () => "decision",
		physicalBatchSize: async () => 512,
		systemOne: async (_id: string, state: Record<string, unknown>) => {
			seen.push(String(state.prompt));
			return { answers: { complexity: { type: "choice", probabilities: { standard: 0.2, complex: 0.8 } } } };
		},
	});
	const logs: string[] = [];
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/cap-trim" } },
		prompt: "x".repeat(9000),
		ctx,
		host: localHost,
		log: (m) => logs.push(m),
	});
	assert.equal(d.source, "classifier");
	assert.equal(d.tier, "cloud");
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.length, decisionStateBudget(512), "state is clipped to the batch budget");
	assert.match(logs.join("\n"), /state trimmed 9000 -> 1920 chars \(physical_batch=512\)/);
});

test("a batch-limit rejection retries once at half size, and the retry keeps no memory (#50)", async () => {
	const seen: number[] = [];
	const localHost = fakeHost({
		modelType: async () => "decision",
		physicalBatchSize: async () => 512,
		systemOne: async (_id: string, state: Record<string, unknown>) => {
			const chars = String(state.prompt).length;
			seen.push(chars);
			if (chars > decisionStateBudget(512) / 2) {
				throw new Error("input (9999 tokens) is too large to process. current batch size: 512");
			}
			return { answers: { complexity: { type: "choice", probabilities: { standard: 0.9, complex: 0.1 } } } };
		},
	});
	const cfg = { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/cap-retry" } };
	const logs: string[] = [];
	const first = await decideTier({ config: cfg, prompt: "y".repeat(9000), ctx, host: localHost, log: (m) => logs.push(m) });
	assert.equal(first.source, "classifier");
	assert.equal(first.tier, "local");
	assert.deepEqual(seen, [1920, 960], "first attempt at the budget, then one retry at half");
	assert.match(logs.join("\n"), /batch limit at 1920 chars/);

	// No remembered shrink: a later call starts at the full budget again, so one dense prompt
	// cannot permanently cap every later classification of this model at half size.
	seen.length = 0;
	const second = await decideTier({ config: cfg, prompt: "y".repeat(9000), ctx, host: localHost });
	assert.equal(second.source, "classifier");
	assert.deepEqual(seen, [1920, 960], "the retry must not permanently halve the classifier's budget");
});

test("a decision-model failure is surfaced on the router log, not only in the reason (#50)", async () => {
	const localHost = fakeHost({
		modelType: async () => "decision",
		systemOne: async () => {
			throw new Error("model kaput");
		},
	});
	const logs: string[] = [];
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/cap-fail" } },
		prompt: "rename a variable",
		ctx,
		host: localHost,
		log: (m) => logs.push(m),
	});
	assert.equal(d.source, "heuristic");
	assert.match(d.reason, /model kaput/);
	assert.match(logs.join("\n"), /classifier: model kaput/);
});

test("a persistent batch-limit rejection retries once, then falls back with an explicit error (#50)", async () => {
	const seen: number[] = [];
	const localHost = fakeHost({
		modelType: async () => "decision",
		physicalBatchSize: async () => 512,
		systemOne: async (_id: string, state: Record<string, unknown>) => {
			seen.push(String(state.prompt).length);
			throw new Error("input (9999 tokens) is too large to process. current batch size: 512");
		},
	});
	const logs: string[] = [];
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/cap-hardfail" } },
		prompt: "z".repeat(9000),
		ctx,
		host: localHost,
		log: (m) => logs.push(m),
	});
	assert.equal(d.source, "heuristic");
	assert.deepEqual(seen, [1920, 960], "retries exactly once, then gives up");
	assert.match(d.reason, /too large to process/);
	assert.match(logs.join("\n"), /classifier: .*too large to process/);
});

test("each decision attempt gets its own abort signal, so a slow first attempt cannot starve the retry (#50)", async () => {
	// A single shared AbortSignal.timeout() starts counting when it is created, so a first
	// attempt that consumed the budget left the retry already aborted - and therefore
	// pointless - exactly when it was needed. Asserting distinct, un-aborted signals tests that
	// deterministically, with no timing dependency.
	const signals: (AbortSignal | undefined)[] = [];
	const seen: number[] = [];
	const localHost = fakeHost({
		modelType: async () => "decision",
		physicalBatchSize: async () => 512,
		systemOne: async (_id: string, state: Record<string, unknown>, _q: unknown, opts: { signal?: AbortSignal }) => {
			const chars = String(state.prompt).length;
			seen.push(chars);
			signals.push(opts.signal);
			if (chars > decisionStateBudget(512) / 2) {
				throw new Error("input (9999 tokens) is too large to process. current batch size: 512");
			}
			return { answers: { complexity: { type: "choice", probabilities: { standard: 0.9, complex: 0.1 } } } };
		},
	});
	const d = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "lmstudio/cap-timeout", timeoutMs: 5000 } },
		prompt: "w".repeat(9000),
		ctx,
		host: localHost,
	});
	assert.deepEqual(seen, [1920, 960]);
	assert.equal(signals.length, 2, "two attempts, each with its own signal");
	assert.notEqual(signals[0], signals[1], "the retry must not reuse the first attempt's signal");
	assert.equal(signals[1]?.aborted, false, "the retry's signal must not already be aborted");
	assert.equal(d.source, "classifier", "a fresh per-attempt timeout lets the retry actually run");
});

test("detectPhysicalBatchSize treats absence, a throw and a zero alike as unknown (#50)", async () => {
	assert.equal(await detectPhysicalBatchSize(fakeHost({}), "m"), undefined, "no method means unknown");

	const throwing = fakeHost({
		physicalBatchSize: async () => {
			throw new Error("host exploded");
		},
	});
	assert.equal(await detectPhysicalBatchSize(throwing, "m"), undefined, "a throwing host must not fail the call");

	assert.equal(await detectPhysicalBatchSize(fakeHost({ physicalBatchSize: async () => 0 }), "m"), undefined, "zero is not a usable batch");
	assert.equal(await detectPhysicalBatchSize(fakeHost({ physicalBatchSize: async () => 2048 }), "m"), 2048);
});

test("decisionStateBudget treats a zero or non-finite batch as unknown, not as a tiny limit (#50)", () => {
	assert.equal(decisionStateBudget(0), decisionStateBudget(), "0 means unknown, not a zero-token limit");
	assert.equal(decisionStateBudget(Number.NaN), decisionStateBudget());
	assert.equal(decisionStateBudget(Number.POSITIVE_INFINITY), decisionStateBudget());
	assert.equal(decisionStateBudget(100), 256, "a real but tiny batch still floors at the minimum");
});
