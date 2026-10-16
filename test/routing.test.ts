import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { DEFAULTS } from "../src/config.ts";
import type { LocalGovernor } from "../src/governor.ts";
import type { LocalHost } from "../src/host.ts";
import type { RouterConfig } from "../src/types.ts";
import { looksLikeLocalFailure, routeRequest, type RouterRuntime } from "../src/virtual-models.ts";

const USER: Message[] = [{ role: "user", content: [{ type: "text", text: "do the thing" }] }] as unknown as Message[];

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
	const base = structuredClone(DEFAULTS);
	base.catalog = { local: ["lmstudio/local-model"], cloud: ["cloud/big"] };
	return Object.assign(base, overrides);
}

function ctxWith(opts: { window?: number; tokens?: number | null; missingLocal?: boolean } = {}): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: {
			find: (provider: string, id: string) => {
				if (opts.missingLocal && provider === "lmstudio") return undefined;
				return { provider, id, contextWindow: opts.window ?? 100_000 };
			},
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
	const rt: RouterRuntime = { config: cfg, host: {} as LocalHost, governor, pins: new Map(), sizes: new Map() };
	return { rt, acquired, released };
}

const baseReq = { model: { id: "auto" }, thinkingLevel: "high" as const, messages: USER };

test("sticky: a continuation keeps the previous state without re-classifying", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg);
	const state = { tier: "local" as const, modelId: "lmstudio/local-model", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation" as const, state } as never, ctxWith());
	assert.equal(route.model.id, "local-model");
	assert.equal(route.state, state, "state object is reused so pi keeps it");
	assert.equal(acquired.length, 0, "no new slot on a continuation");
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

test("a slot is released when the local target cannot be resolved (#39)", async () => {
	const cfg = config();
	const { rt, released } = runtime(cfg);
	await assert.rejects(
		() => routeRequest(rt, "auto", { ...baseReq, reason: "user" } as never, ctxWith({ missingLocal: true })),
		/not in the catalog/,
	);
	assert.deepEqual(released, ["local-model"], "acquired slot given back on resolve failure");
});
