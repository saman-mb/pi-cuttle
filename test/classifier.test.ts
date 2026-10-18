import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTier, applyPolicy, buildQuestions, heuristicScore, parseGateVerdicts, splitRef } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import { NEW_SESSION } from "../src/classifier-context.ts";
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
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/x", contextShadow: true } },
		prompt: "refactor everything",
		ctx: fakeCtx(),
		forced: "local",
	});
	assert.equal(decision.tier, "local");
	assert.equal(decision.source, "pin");
	assert.equal(decision.signalPath, "off");
	assert.equal(decision.shadowComparison, undefined);
});

test("no classifier configured uses the heuristic", async () => {
	const decision = await decideTier({ config: DEFAULTS, prompt: "rename a variable", ctx: fakeCtx() });
	assert.equal(decision.source, "heuristic");
	assert.equal(decision.tier, "local");
	assert.equal(decision.signalPath, "heuristic");
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

test("classifier honors policy.threshold", async () => {
	const ctxLow = fakeCtx({
		stopReason: "stop",
		answers: { complexity: { type: "choice", choice: "standard", probabilities: { standard: 0.85, complex: 0.15 } } },
	});
	const cfgLow = { ...DEFAULTS, policy: { ...DEFAULTS.policy, threshold: 0.2 }, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } };
	const dLow = await decideTier({ config: cfgLow, prompt: "x", ctx: ctxLow });
	assert.equal(dLow.tier, "local", "score 0.15 < threshold 0.2 routes local");

	const ctxHigh = fakeCtx({
		stopReason: "stop",
		answers: { complexity: { type: "choice", choice: "complex", probabilities: { standard: 0.3, complex: 0.7 } } },
	});
	const cfgHigh = { ...DEFAULTS, policy: { ...DEFAULTS.policy, threshold: 0.8 }, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } };
	const dHigh = await decideTier({ config: cfgHigh, prompt: "x", ctx: ctxHigh });
	assert.equal(dHigh.tier, "local", "score 0.7 < threshold 0.8 routes local");
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

test("default and last-message modes pass the clipped prompt to the classifier", async () => {
	for (const config of [
		{ ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		{ ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextSource: "last-message" as const } },
	]) {
		let receivedPrompt: string | undefined;
		const ctx = {
			modelRegistry: {
				findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
				classify: async (_model: unknown, input: { state: { prompt: string } }) => {
					receivedPrompt = input.state.prompt;
					return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "standard", probabilities: { complex: 0.1 } } } };
				},
			},
		} as unknown as ExtensionContext;
		const prompt = "rename the temporary variable";
		await decideTier({ config, prompt, ctx });
		assert.equal(receivedPrompt, prompt.slice(0, config.classifier.stateChars));
	}
});

test("conversation mode passes formatted assistant and user context to the classifier", async () => {
	let receivedPrompt: string | undefined;
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async (_model: unknown, input: { state: { prompt: string } }) => {
				receivedPrompt = input.state.prompt;
				return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "complex", probabilities: { complex: 0.9 } } } };
			},
		},
	} as unknown as ExtensionContext;
	const messages = [
		{ role: "assistant", content: "I traced the earlier failure to a cache invalidation race." },
		{ role: "user", content: "Now compare the two safe migration approaches." },
	] as never;
	const decision = await decideTier({
		config: {
			...DEFAULTS,
			classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextSource: "conversation" },
		},
		prompt: "Now compare the two safe migration approaches.",
		messages,
		ctx,
	});
	assert.equal(decision.source, "classifier");
	assert.ok(receivedPrompt?.includes("[assistant]\nI traced the earlier failure"));
	assert.ok(receivedPrompt?.includes("[user]\nNow compare the two safe migration approaches."));
	assert.notEqual(receivedPrompt, "Now compare the two safe migration approaches.");
});

test("signalPath identifies the actual last-message, conversation, and off source", async () => {
	const config = { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } };
	const lastMessage = await decideTier({ config, prompt: "do it", ctx: fakeCtx() });
	assert.equal(lastMessage.signalPath, "last-message");

	const conversation = await decideTier({
		config: { ...config, classifier: { ...config.classifier, contextSource: "conversation" } },
		prompt: "do it",
		ctx: fakeCtx(),
		contextBuilder: () => "formatted conversation",
	});
	assert.equal(conversation.signalPath, "conversation");

	const off = await decideTier({
		config: { ...config, classifier: { ...config.classifier, contextSource: "off" } },
		prompt: "do it",
		ctx: fakeCtx(),
	});
	assert.equal(off.signalPath, "off");
});

test("disabled contextShadow makes no extra classifier call or routing wait", async () => {
	let calls = 0;
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async () => {
				calls++;
				return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "standard", probabilities: { complex: 0.1 } } } };
			},
		},
	} as unknown as ExtensionContext;
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" } },
		prompt: "rename a variable",
		ctx,
	});
	assert.equal(decision.tier, "local");
	assert.equal(calls, 1);
	assert.equal(decision.shadowComparison, undefined);
});

test("contextShadow compares an alternate verdict without changing the authoritative tier", async () => {
	const classify = (contextShadow: boolean) => {
		let calls = 0;
		const ctx = {
			modelRegistry: {
				findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
				classify: async () => {
					calls++;
					const complex = calls === 1 ? 0.1 : 0.9;
					return { stopReason: "stop", answers: { complexity: { type: "choice", choice: complex >= 0.5 ? "complex" : "standard", probabilities: { complex } } } };
				},
			},
		} as unknown as ExtensionContext;
		return decideTier({
			config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextShadow } },
			prompt: "fix it",
			messages: [{ role: "user", content: "fix it" }] as never,
			ctx,
			contextBuilder: () => "older context plus fix it",
		});
	};

	const authoritativeOnly = await classify(false);
	const shadowed = await classify(true);
	assert.equal(authoritativeOnly.tier, "local");
	assert.equal(shadowed.tier, authoritativeOnly.tier, "alternate verdict must not select the routed tier");
	assert.deepEqual(await shadowed.shadowComparison, {
		authoritative: { signalPath: "last-message", tier: "local" },
		alternate: { signalPath: "conversation", tier: "cloud" },
		agree: false,
	});
});

test("a failed alternate classifier leaves the authoritative decision unchanged", async () => {
	let calls = 0;
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async () => {
				calls++;
				if (calls > 1) throw new Error("alternate failed");
				return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "standard", probabilities: { complex: 0.1 } } } };
			},
		},
	} as unknown as ExtensionContext;
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextShadow: true } },
		prompt: "rename a variable",
		ctx,
	});
	assert.equal(decision.tier, "local");
	assert.equal(decision.source, "classifier");
	assert.equal(await decision.shadowComparison, undefined);
});

test("off mode skips the classifier and returns a heuristic decision", async () => {
	let classifierCalls = 0;
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async () => {
				classifierCalls++;
				return { stopReason: "stop", answers: {} };
			},
		},
	} as unknown as ExtensionContext;
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextSource: "off" } },
		prompt: "refactor the architecture across the codebase",
		ctx,
	});
	assert.equal(classifierCalls, 0);
	assert.equal(decision.source, "heuristic");
	assert.equal(decision.tier, "cloud");
});

test("formatter failure or empty signal falls back to last-message and is reported", async () => {
	for (const [contextBuilder, expectedFailure] of [
		[() => { throw new Error("formatting broke"); }, /formatting broke/],
		[() => "", /empty context/],
	] as const) {
		let receivedPrompt: string | undefined;
		const logs: string[] = [];
		const ctx = {
			modelRegistry: {
				findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
				classify: async (_model: unknown, input: { state: { prompt: string } }) => {
					receivedPrompt = input.state.prompt;
					return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "standard", probabilities: { complex: 0.1 } } } };
				},
			},
		} as unknown as ExtensionContext;
		const prompt = "rename a variable safely";
		const decision = await decideTier({
			config: {
				...DEFAULTS,
				classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextSource: "conversation", stateChars: 9 },
			},
			prompt,
			ctx,
			contextBuilder,
			log: (message) => logs.push(message),
		});
		assert.equal(receivedPrompt, prompt.slice(0, 9));
		assert.equal(decision.source, "classifier");
		assert.match(decision.reason, expectedFailure);
		// A context-path fallback must NOT be reported as a classifier failure: the classifier
		// answered correctly, it was simply shown a different signal. Reporting it as a failure
		// would let repeated fallbacks (an oversized message, say) trip classifier backoff and
		// skip the classifier for a session that was never failing. (#103 integration board nit)
		assert.equal(decision.classifierFailure, undefined, "context fallback is not a classifier failure");
		assert.match(logs.join("\n"), /falling back to last-message/);
	}
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

test("buildQuestions always includes complexity", () => {
	const qs = buildQuestions(DEFAULTS);
	assert.ok(qs.complexity);
	assert.equal(Object.keys(qs).length, 1);
});

test("buildQuestions adds enabled gates in one question record", () => {
	const config = {
		...DEFAULTS,
		gates: {
			delegate: { enabled: true, choices: ["scout", "worker"] },
			role: { enabled: true, choices: ["driver"] },
			struggle: { enabled: true },
		},
	};
	const qs = buildQuestions(config);
	assert.ok(qs.complexity);
	assert.ok(qs.delegate);
	assert.ok(qs.delegate_role);
	assert.ok(qs.role);
	assert.ok(qs.struggle);
	assert.equal(Object.keys(qs).length, 5);
});

test("buildQuestions adds judge only after a tool result", () => {
	const config = { ...DEFAULTS, gates: { judge: { enabled: true } } };
	const noTool = buildQuestions(config, [{ role: "user", content: "hi" }] as never);
	assert.equal(noTool.judge, undefined);
	const tool = buildQuestions(config, [
		{ role: "user", content: "hi" },
		{ role: "toolResult", content: "done", isError: false },
	] as never);
	assert.ok(tool.judge);
});

test("parseGateVerdicts normalizes classifier answers", () => {
	const answers = {
		complexity: { type: "choice", choice: "complex", probabilities: { complex: 0.9 }, confidence: 0.9 },
		delegate: { type: "bool", probability: 0.8 },
		role: { type: "choice", choice: "scout", probabilities: { scout: 0.8 }, confidence: 0.8 },
	};
	const gates = parseGateVerdicts(answers, {
		delegate: { enabled: true },
		role: { enabled: true, shadow: false },
	});
	assert.equal(gates?.delegate?.type, "bool");
	assert.equal((gates?.delegate as { shadow: boolean }).shadow, true);
	assert.equal((gates?.role as { shadow: boolean }).shadow, false);
});

test("decideTier returns gate verdicts when gates are enabled", async () => {
	const ctx = fakeCtx({
		stopReason: "stop",
		answers: {
			complexity: { type: "choice", choice: "standard", probabilities: { standard: 0.95, complex: 0.05 } },
			struggle: { type: "bool", probability: 0.2 },
		},
	});
	const d = await decideTier({
		config: {
			...DEFAULTS,
			classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev" },
			gates: { struggle: { enabled: true } },
		},
		prompt: "rename a variable",
		ctx,
	});
	assert.equal(d.source, "classifier");
	assert.equal(d.gates?.struggle?.type, "bool");
	assert.match(d.reason, /struggle:/);
});

// Region: integration defect found by the epic board (#103).
//
// The formatter is contractually non-throwing — it returns the NEW_SESSION sentinel when it cannot
// build context. The classifier's fallback only caught throws and empty strings, so a formatter that
// degraded internally was classified as the literal sentinel instead of falling back to the
// last-message prompt. Each unit was correct alone; the combination was wrong.

test("a sentinel from the formatter falls back to last-message instead of being classified", async () => {
	let receivedPrompt: string | undefined;
	const logs: string[] = [];
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async (_model: unknown, input: { state: { prompt: string } }) => {
				receivedPrompt = input.state.prompt;
				return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "standard", probabilities: { complex: 0.1 } } } };
			},
		},
	} as unknown as ExtensionContext;
	const prompt = "do the other thing";
	const decision = await decideTier({
		config: { ...DEFAULTS, classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextSource: "conversation" } },
		prompt,
		ctx,
		// Simulates the built-in formatter degrading on malformed data.
		contextBuilder: () => NEW_SESSION,
		log: (message) => logs.push(message),
	});
	assert.notEqual(receivedPrompt, NEW_SESSION, "the sentinel must never be classified");
	assert.equal(receivedPrompt, prompt);
	assert.match(decision.reason, /no usable context/);
	assert.match(logs.join("\n"), /falling back to last-message/);
});

test("conversation context never shows the classifier less than the default path would", async () => {
	// A single message larger than contextBudget: the formatter could only truncate it to the
	// (smaller) conversation budget, which is worse than the default stateChars path.
	let receivedPrompt: string | undefined;
	const ctx = {
		modelRegistry: {
			findOfType: () => ({ id: "kev", provider: "llama.cpp" }),
			classify: async (_model: unknown, input: { state: { prompt: string } }) => {
				receivedPrompt = input.state.prompt;
				return { stopReason: "stop", answers: { complexity: { type: "choice", choice: "standard", probabilities: { complex: 0.1 } } } };
			},
		},
	} as unknown as ExtensionContext;
	const prompt = "x".repeat(500);
	const decision = await decideTier({
		config: {
			...DEFAULTS,
			classifier: { ...DEFAULTS.classifier, model: "llama.cpp/kev", contextSource: "conversation", contextBudget: 100, stateChars: 400 },
		},
		prompt,
		ctx,
		log: () => {},
	});
	assert.equal(receivedPrompt, prompt.slice(0, 400), "must fall back to the larger stateChars window");
	assert.match(decision.reason, /exceeds contextBudget/);
});
