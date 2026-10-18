import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { DEFAULTS } from "../src/config.ts";
import type { LocalGovernor } from "../src/governor.ts";

import type { RouterConfig } from "../src/types.ts";
import { looksLikeLocalFailure, routeRequest, type RouterRuntime } from "../src/virtual-models.ts";

const USER: Message[] = [{ role: "user", content: [{ type: "text", text: "do the thing" }] }] as unknown as Message[];

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
	const base = structuredClone(DEFAULTS);
	base.catalog = { local: ["lmstudio/local-model"], cloud: ["cloud/big"] };
	return Object.assign(base, overrides);
}

function ctxWith(
	opts: { window?: number; tokens?: number | null; missingLocal?: boolean; classifyResult?: { stopReason: "stop" | "error"; answers: Record<string, unknown> } } = {},
): ExtensionContext {
	const classifyResult = opts.classifyResult ?? {
		stopReason: "stop",
		answers: { complexity: { type: "choice", probabilities: { standard: 0.5, complex: 0.5 } } },
	};
	return {
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: {
			find: (provider: string, id: string) => {
				if (opts.missingLocal && provider === "lmstudio") return undefined;
				return { provider, id, contextWindow: opts.window ?? 100_000 };
			},
			findOfType: (type: string, provider: string, id: string) => {
				if (type !== "classifier") return undefined;
				return { provider, id, api: "typesafe-system-one" };
			},
			classify: async () => classifyResult as never,
		},
		getContextUsage: () => ({ tokens: opts.tokens ?? 10, contextWindow: opts.window ?? 100_000, percent: 0.01 }),
	} as unknown as ExtensionContext;
}

function runtime(cfg: RouterConfig, grant = true): { rt: RouterRuntime; acquired: string[]; released: string[] } {
	const acquired: string[] = [];
	const released: string[] = [];
	const governor = {
		acquire: async (key: string, o?: { flavor?: string }) => {
			if (!grant) return null;
			acquired.push(`${key}:${o?.flavor ?? ""}`);
			return { id: "r1", modelKey: key, file: "", pid: 1, startedAt: 0, flavor: o?.flavor };
		},
		release: (res: { modelKey: string }) => void released.push(res.modelKey),
		releaseOne: (key: string) => {
			released.push(key);
			return true;
		},
		enforceLoadedCeiling: async () => [],
	} as unknown as LocalGovernor;
	const rt: RouterRuntime = { config: cfg, governor, pins: new Map(), previousModels: new Map(), sizes: new Map() };
	return { rt, acquired, released };
}

const baseReq = { model: { id: "auto" }, thinkingLevel: "high" as const, messages: USER };

test("sticky: a continuation keeps the previous state and holds a local slot", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg);
	const state = { tier: "local" as const, modelId: "lmstudio/local-model", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation" as const, state } as never, ctxWith());
	assert.equal(route.model.id, "local-model");
	assert.equal(route.state, state, "state object is reused so pi keeps it");
	assert.deepEqual(acquired, ["local-model:auto"], "slot acquired on continuation");
});

test("sticky: a saturated local continuation spills to cloud", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg, false);
	const state = { tier: "local" as const, modelId: "lmstudio/local-model", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation" as const, state } as never, ctxWith());
	assert.equal(route.model.provider, "cloud");
	assert.equal(route.state?.tier, "cloud");
	assert.equal(acquired.length, 0, "no local slot acquired when saturated");
});

test("sticky: a local continuation falls back to cloud when the local catalog disappears", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg);
	const state = { tier: "local" as const, modelId: "lmstudio/local-model", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation" as const, state } as never, ctxWith({ missingLocal: true }));
	assert.equal(route.model.provider, "cloud");
	assert.equal(route.state?.tier, "cloud");
	assert.equal(acquired.length, 0, "no slot acquired for missing local models");
});

test("sticky: a cloud continuation falls back to local when the cloud catalog disappears", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg);
	const state = { tier: "cloud" as const, modelId: "cloud/big", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const ctx = ctxWith();
	const original = ctx.modelRegistry.find.bind(ctx.modelRegistry);
	(ctx.modelRegistry as unknown as { find: typeof original }).find = (provider: string, id: string) =>
		provider === "cloud" ? undefined : original(provider, id);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation" as const, state } as never, ctx);
	assert.equal(route.model.provider, "lmstudio");
	assert.equal(route.state?.tier, "local");
	assert.deepEqual(acquired, ["local-model:auto"], "local slot acquired when falling back from cloud");
});

test("reclassify=turn re-decides on each user turn", async () => {
	const cfg = config({ policy: { ...DEFAULTS.policy, reclassify: "turn", mode: "complexity" } });
	const { rt } = runtime(cfg);
	const priorState = { tier: "local" as const, modelId: "lmstudio/local-model", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	// A cloud-hinting prompt, so the new decision differs from the prior state.
	const messages = [{ role: "user", content: [{ type: "text", text: "refactor the architecture across the codebase" }] }] as unknown as Message[];
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user", state: priorState, messages } as never, ctxWith());
	assert.equal(route.state?.tier, "cloud");
});

test("retry after a local failure switches to cloud", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const request = {
		...baseReq,
		reason: "retry" as const,
		failed: {
			model: { provider: "lmstudio", id: "local-model" },
			message: { provider: "lmstudio", model: "local-model", errorMessage: "out of memory" },
		},
	};
	const route = await routeRequest(rt, "auto", request as never, ctxWith());
	assert.equal(route.model.provider, "cloud");
	assert.match(route.state?.decision.reason ?? "", /retry/);
});

test("context guard spills to cloud when the prompt exceeds the local window", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" as const } as never, ctxWith({ window: 1000, tokens: 999 }));
	assert.equal(route.model.provider, "cloud");
	assert.match(route.state?.decision.reason ?? "", /context exceeds local window/);
});

test("local saturation spills to cloud", async () => {
	const cfg = config();
	const { rt } = runtime(cfg, false); // governor refuses
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" as const } as never, ctxWith());
	assert.equal(route.model.provider, "cloud");
	assert.match(route.state?.decision.reason ?? "", /local full/);
});

test("looksLikeLocalFailure flags local providers and overflow errors", () => {
	assert.equal(looksLikeLocalFailure("lmstudio", undefined), true);
	assert.equal(looksLikeLocalFailure("opencode-go", "context_length_exceeded"), true);
	assert.equal(looksLikeLocalFailure("opencode-go", "invalid api key"), false);
});

const EDIT_CALL = [
	{ role: "user", content: [{ type: "text", text: "do it" }] },
	{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }] },
] as unknown as Message[];

const READ_CALL = [
	{ role: "user", content: [{ type: "text", text: "look around" }] },
	{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
] as unknown as Message[];

test("detectPhase flips on edit/write and ignores read-only tools (#36)", async () => {
	const { detectPhase } = await import("../src/classifier.ts");
	assert.equal(detectPhase(EDIT_CALL), "implementation");
	assert.equal(detectPhase(READ_CALL), undefined);
});

test("phase policy: the first edit flips the sticky session to the implement tier (#36)", async () => {
	const cfg = config({
		policy: { ...DEFAULTS.policy, mode: "phase", phase: { plan: "cloud", implement: "local" } },
	});
	const { rt } = runtime(cfg);
	const state = { tier: "cloud" as const, modelId: "cloud/big", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation", state, messages: EDIT_CALL } as never, ctxWith());
	assert.equal(route.state?.phase, "implementation");
	assert.equal(route.state?.tier, "local");
	assert.equal(route.model.provider, "lmstudio");
	assert.match(route.state?.decision.reason ?? "", /phase -> implementation/);
});

test("phase flip spills back to cloud when the governor refuses (#36)", async () => {
	const cfg = config({
		policy: { ...DEFAULTS.policy, mode: "phase", phase: { plan: "cloud", implement: "local" } },
	});
	const { rt } = runtime(cfg, false);
	const state = { tier: "cloud" as const, modelId: "cloud/big", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation", state, messages: EDIT_CALL } as never, ctxWith());
	assert.equal(route.state?.phase, "implementation");
	assert.equal(route.state?.tier, "cloud", "kept cloud when no local slot");
});

test("a read-only continuation does not flip the phase (#36)", async () => {
	const cfg = config({ policy: { ...DEFAULTS.policy, mode: "phase", phase: { plan: "cloud", implement: "local" } } });
	const { rt } = runtime(cfg);
	const state = { tier: "cloud" as const, modelId: "cloud/big", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation", state, messages: READ_CALL } as never, ctxWith());
	assert.equal(route.state, state, "state untouched");
});

test("retry escalation records the degradation so the next user turn re-decides (#37)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const request = {
		...baseReq,
		reason: "retry" as const,
		failed: {
			model: { provider: "lmstudio", id: "local-model" },
			message: { provider: "lmstudio", model: "local-model", errorMessage: "ECONNREFUSED" },
		},
	};
	const route = await routeRequest(rt, "auto", request as never, ctxWith());
	assert.equal(route.state?.tier, "cloud");
	assert.equal(route.state?.degradedFrom, "local");
});

test("a degraded session re-classifies on the next user turn and recovers to local (#37)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const degraded = {
		tier: "cloud" as const,
		modelId: "cloud/big",
		phase: "planning" as const,
		decision: { source: "heuristic" as const, reason: "retry: local failure" },
		degradedFrom: "local" as const,
	};
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user", state: degraded } as never, ctxWith());
	assert.equal(route.state?.tier, "local", "mechanical prompt recovers to local");
	assert.equal(route.state?.degradedFrom, undefined, "degradation cleared");
});

test("a degraded session stays cloud on a continuation without re-deciding (#37)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const degraded = {
		tier: "cloud" as const,
		modelId: "cloud/big",
		phase: "planning" as const,
		decision: { source: "heuristic" as const, reason: "retry: local failure" },
		degradedFrom: "local" as const,
	};
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation", state: degraded } as never, ctxWith());
	assert.equal(route.state, degraded, "continuation keeps cloud without burning a classifier call");
});

test("a missing local candidate spills to cloud instead of throwing (#45)", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctxWith({ missingLocal: true }));
	assert.equal(route.model.provider, "cloud");
	assert.equal(acquired.length, 0, "no slot is taken for an unresolvable model");
	assert.match(route.state?.decision.reason ?? "", /spilled to cloud/);
});

test("a candidate missing from the registry is named, not blamed on capacity (#58)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctxWith({ missingLocal: true }));
	const reason = route.state?.decision.reason ?? "";
	assert.equal(route.model.provider, "cloud");
	assert.match(reason, /not in pi's catalog/, "the real cause must be named");
	assert.match(reason, /lmstudio\/local-model/, "the offending ref must be named");
	assert.match(reason, /catalog\.local/, "the user must be pointed at the field to fix");
	assert.doesNotMatch(reason, /local full/, "capacity is not the cause here");
});

test("a missing candidate and a saturated one are both reported (#58)", async () => {
	const cfg = config({ catalog: { local: ["lmstudio/missing-model", "lmstudio/local-model"], cloud: ["cloud/big"] } });
	const { rt } = runtime(cfg, false); // governor refuses the second candidate
	const ctx = ctxWith();
	const original = ctx.modelRegistry.find.bind(ctx.modelRegistry);
	(ctx.modelRegistry as unknown as { find: typeof original }).find = (provider: string, id: string) =>
		id === "missing-model" ? undefined : original(provider, id);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctx);
	const reason = route.state?.decision.reason ?? "";
	assert.match(reason, /not in pi's catalog/, "the missing candidate is still named");
	assert.match(reason, /local full/, "and the saturated one too");
});

test("the second local candidate is used when the first is unresolvable (#45)", async () => {
	const cfg = config({ catalog: { local: ["lmstudio/missing-model", "lmstudio/local-model"], cloud: ["cloud/big"] } });
	const { rt, acquired } = runtime(cfg);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctxWith({ missingLocal: true }));
	// missingLocal hides every lmstudio ref; make only the first disappear instead:
	assert.equal(route.model.provider, "cloud");
	assert.equal(acquired.length, 0);
});

test("a resolvable second local candidate is chosen when the first is absent (#45)", async () => {
	const cfg = config({ catalog: { local: ["lmstudio/missing-model", "lmstudio/local-model"], cloud: ["cloud/big"] } });
	const { rt, acquired } = runtime(cfg);
	const ctx = ctxWith();
	const original = ctx.modelRegistry.find.bind(ctx.modelRegistry);
	(ctx.modelRegistry as unknown as { find: typeof original }).find = (provider: string, id: string) =>
		id === "missing-model" ? undefined : original(provider, id);
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctx);
	assert.equal(route.model.provider, "lmstudio");
	assert.equal(route.model.id, "local-model");
	assert.deepEqual(acquired, ["local-model:auto"], "slot held for the fallback candidate");
});

test("a cloud catalog that resolves nothing falls back to local (#45)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const ctx = ctxWith();
	const original = ctx.modelRegistry.find.bind(ctx.modelRegistry);
	(ctx.modelRegistry as unknown as { find: typeof original }).find = (provider: string, id: string) =>
		provider === "cloud" ? undefined : original(provider, id);
	const cloudPrompt = [{ role: "user", content: [{ type: "text", text: "refactor the architecture across the codebase" }] }] as unknown as Message[];
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user", messages: cloudPrompt } as never, ctx);
	assert.equal(route.model.provider, "lmstudio");
	assert.match(route.state?.decision.reason ?? "", /no cloud candidate available, routed local/);
});

test("nothing resolvable fails with one clear error (#45)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const ctx = ctxWith();
	(ctx.modelRegistry as unknown as { find: () => undefined }).find = () => undefined;
	await assert.rejects(
		() => routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctx),
		/no configured model resolves/,
	);
});

const TOOL_ERRORS = [
	{ role: "user", content: [{ type: "text", text: "fix the failing test" }] },
	{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }] },
	{ role: "toolResult", toolCallId: "t1", toolName: "edit", content: [{ type: "text", text: "no match" }], isError: true, timestamp: 0 },
	{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "edit", arguments: {} }] },
	{ role: "toolResult", toolCallId: "t2", toolName: "edit", content: [{ type: "text", text: "no match" }], isError: true, timestamp: 0 },
] as unknown as Message[];

test("struggleSignals counts error tool results and errored assistant turns (#41)", async () => {
	const { struggleSignals } = await import("../src/classifier.ts");
	assert.equal(struggleSignals(TOOL_ERRORS, 8).errors, 2);
	assert.equal(struggleSignals(USER, 8).errors, 0);
	const errored = [{ role: "assistant", content: [], stopReason: "error" }] as unknown as Message[];
	assert.equal(struggleSignals(errored, 8).errors, 1);
});

test("a flailing local session escalates to cloud mid-turn (#41)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const state = {
		tier: "local" as const,
		modelId: "lmstudio/local-model",
		phase: "implementation" as const,
		decision: { source: "classifier" as const, reason: "prior" },
	};
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation", state, messages: TOOL_ERRORS } as never, ctxWith());
	assert.equal(route.state?.tier, "cloud");
	assert.equal(route.state?.escalatedFrom, "local");
	assert.equal(route.state?.cleanTurns, 0);
	assert.match(route.state?.decision.reason ?? "", /escalated local->cloud: 2 error/);
});

test("escalated sessions step back down after clean user turns (#41)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const escalated = {
		tier: "cloud" as const,
		modelId: "cloud/big",
		phase: "implementation" as const,
		decision: { source: "heuristic" as const, reason: "escalated" },
		escalatedFrom: "local" as const,
		cleanTurns: 2,
	};
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user", state: escalated } as never, ctxWith());
	assert.equal(route.state?.tier, "local", "third clean turn re-classifies back to local");
	assert.equal(route.state?.escalatedFrom, undefined);
});

test("clean user turns accumulate while escalated (#41)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const escalated = {
		tier: "cloud" as const,
		modelId: "cloud/big",
		phase: "implementation" as const,
		decision: { source: "heuristic" as const, reason: "escalated" },
		escalatedFrom: "local" as const,
		cleanTurns: 0,
	};
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user", state: escalated } as never, ctxWith());
	assert.equal(route.state?.tier, "cloud");
	assert.equal(route.state?.cleanTurns, 1, "streak persists for the next turn");
});

test("an error resets the clean streak and keeps the session on cloud (#41)", async () => {
	const cfg = config();
	const { rt } = runtime(cfg);
	const escalated = {
		tier: "cloud" as const,
		modelId: "cloud/big",
		phase: "implementation" as const,
		decision: { source: "heuristic" as const, reason: "escalated" },
		escalatedFrom: "local" as const,
		cleanTurns: 2,
	};
	const route = await routeRequest(
		rt,
		"auto",
		{ ...baseReq, reason: "user", state: escalated, messages: TOOL_ERRORS } as never,
		ctxWith(),
	);
	assert.equal(route.state?.tier, "cloud");
	assert.equal(route.state?.cleanTurns, 0);
});

test("a failing classifier is recorded on the runtime with its turn (#53)", async () => {
	const cfg = config({ classifier: { ...DEFAULTS.classifier, model: "llama.cpp/decision-x" } });
	const { rt } = runtime(cfg);
	const ctx = {
		...ctxWith(),
		modelRegistry: {
			find: ctxWith().modelRegistry.find,
			findOfType: () => ({ provider: "llama.cpp", id: "decision-x" }),
			classify: async () => { throw new Error("classifier down"); },
		},
	} as unknown as ExtensionContext;
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctx);
	assert.ok(route.model, "the turn still routes on the heuristic fallback");
	assert.equal(rt.lastClassifierError?.ref, "llama.cpp/decision-x");
	assert.equal(rt.lastClassifierError?.turn, 1, "one user message so far");
	assert.equal(rt.lastClassifierError?.message.length > 0, true);
});

test("a successful classification clears the recorded failure (#53)", async () => {
	const cfg = config({ classifier: { ...DEFAULTS.classifier, model: "llama.cpp/decision-x" } });
	const { rt } = runtime(cfg);
	rt.lastClassifierError = { ref: "llama.cpp/decision-x", message: "stale failure", turn: 0, at: 0 };
	const ctx = ctxWith({ classifyResult: { stopReason: "stop", answers: { complexity: { type: "choice", probabilities: { standard: 0.9, complex: 0.1 } } } } });
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctx);
	assert.equal(route.state?.decision.source, "classifier");
	assert.equal(rt.lastClassifierError, undefined, "successful classification clears the failure");
});
