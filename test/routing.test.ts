import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { DEFAULTS } from "../src/config.ts";
import type { LocalGovernor } from "../src/governor.ts";
import type { LmStudioClient } from "../src/lmstudio.ts";
import type { RouterConfig } from "../src/types.ts";
import { looksLikeLocalFailure, routeRequest, type RouterRuntime } from "../src/virtual-models.ts";

const USER: Message[] = [{ role: "user", content: [{ type: "text", text: "do the thing" }] }] as unknown as Message[];

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
	const base = structuredClone(DEFAULTS);
	base.catalog = { local: ["lmstudio/local-model"], cloud: ["cloud/big"] };
	return Object.assign(base, overrides);
}

function ctxWith(opts: { window?: number; tokens?: number | null } = {}): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id, contextWindow: opts.window ?? 100_000 }),
		},
		getContextUsage: () => ({ tokens: opts.tokens ?? 10, contextWindow: opts.window ?? 100_000, percent: 0.01 }),
	} as unknown as ExtensionContext;
}

function runtime(cfg: RouterConfig, grant = true): { rt: RouterRuntime; acquired: string[] } {
	const acquired: string[] = [];
	const governor = {
		acquire: async (key: string, o?: { flavor?: string }) => {
			if (!grant) return null;
			acquired.push(`${key}:${o?.flavor ?? ""}`);
			return { id: "r1", modelKey: key, file: "", pid: 1, startedAt: 0, flavor: o?.flavor };
		},
		enforceLoadedCeiling: async () => [],
	} as unknown as LocalGovernor;
	const rt: RouterRuntime = { config: cfg, lm: {} as LmStudioClient, governor, pins: new Map(), sizes: new Map() };
	return { rt, acquired };
}

const baseReq = { model: { id: "auto" }, thinkingLevel: "high" as const, messages: USER };

test("sticky: a continuation keeps the previous state without re-classifying", async () => {
	const cfg = config();
	const { rt, acquired } = runtime(cfg);
	const state = { tier: "local" as const, modelId: "lmstudio/local-model", phase: "planning" as const, decision: { source: "heuristic" as const, reason: "prior" } };
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "continuation", state }, ctxWith());
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
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user", state: priorState, messages }, ctxWith());
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
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" }, ctxWith({ window: 1000, tokens: 999 }));
	assert.equal(route.model.provider, "cloud");
	assert.match(route.state?.decision.reason ?? "", /context exceeds local window/);
});

test("local saturation spills to cloud", async () => {
	const cfg = config();
	const { rt } = runtime(cfg, false); // governor refuses
	const route = await routeRequest(rt, "auto", { ...baseReq, reason: "user" }, ctxWith());
	assert.equal(route.model.provider, "cloud");
	assert.match(route.state?.decision.reason ?? "", /local full/);
});

test("looksLikeLocalFailure flags local providers and overflow errors", () => {
	assert.equal(looksLikeLocalFailure("lmstudio", undefined), true);
	assert.equal(looksLikeLocalFailure("opencode-go", "context_length_exceeded"), true);
	assert.equal(looksLikeLocalFailure("opencode-go", "invalid api key"), false);
});
