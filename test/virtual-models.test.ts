import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS } from "../src/config.ts";
import { lastUserText, pickCloud, pickLocal } from "../src/virtual-models.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { RouterConfig } from "../src/types.ts";

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
	return { ...structuredClone(DEFAULTS), ...overrides };
}

function fakeCtx(windows: Record<string, number> = {}): ExtensionContext {
	return {
		modelRegistry: {
			find: (provider: string, id: string) => {
				const ref = `${provider}/${id}`;
				return { provider, id, contextWindow: windows[ref] ?? 100_000 };
			},
		},
	} as unknown as ExtensionContext;
}

function fakeCtxWithCost(costs: Record<string, { input: number; output: number }>): ExtensionContext {
	return {
		modelRegistry: {
			find: (provider: string, id: string) => {
				const ref = `${provider}/${id}`;
				const cost = costs[ref];
				return { provider, id, contextWindow: 100_000, ...(cost ? { cost } : {}) };
			},
		},
	} as unknown as ExtensionContext;
}

test("fast-local orders local candidates by configured capability, smallest first", () => {
	const cfg = config({
		catalog: { local: ["llama.cpp/big", "llama.cpp/small"], cloud: ["c/m"] },
		capabilities: { "llama.cpp/big": 0.9, "llama.cpp/small": 0.2 },
	});
	assert.equal(pickLocal(cfg, fakeCtx(), "fast-local"), "llama.cpp/small");
	assert.equal(pickLocal(cfg, fakeCtx(), "auto"), "llama.cpp/big", "auto keeps configured order");
});

test("fast-local with no capabilities falls back to configured order", () => {
	const cfg = config({ catalog: { local: ["llama.cpp/a", "llama.cpp/b"], cloud: [] } });
	assert.equal(pickLocal(cfg, fakeCtx(), "fast-local"), "llama.cpp/a");
});

test("pickCloud returns the first cloud candidate when no score", () => {
	const cfg = config({ catalog: { local: [], cloud: ["cloud/one", "cloud/two"] } });
	assert.equal(pickCloud(cfg, fakeCtx()), "cloud/one");
});

test("pickCloud prefers the cheapest model that fits", () => {
	const cfg = config({
		catalog: { local: [], cloud: ["cloud/cheap", "cloud/dear"] },
		capabilities: { "cloud/cheap": 0.8, "cloud/dear": 0.8 },
	});
	const ctx = fakeCtxWithCost({
		"cloud/cheap": { input: 0.1, output: 0.4 },
		"cloud/dear": { input: 1, output: 4 },
	});
	assert.equal(pickCloud(cfg, ctx, 0.5), "cloud/cheap");
});

test("pickCloud capacity filter still takes precedence over cost", () => {
	const cfg = config({
		catalog: { local: [], cloud: ["cloud/small", "cloud/big"] },
		capabilities: { "cloud/small": 0.2, "cloud/big": 0.9 },
	});
	const ctx = fakeCtxWithCost({
		"cloud/small": { input: 0.01, output: 0.04 },
		"cloud/big": { input: 1, output: 4 },
	});
	assert.equal(pickCloud(cfg, ctx, 0.5), "cloud/big", "small model does not fit despite being cheaper");
});

test("capabilities override context window for model selection", () => {
	const cfg = config({
		catalog: { local: ["llama.cpp/small-window", "llama.cpp/big-window"], cloud: [] },
		capabilities: { "llama.cpp/small-window": 0.9, "llama.cpp/big-window": 0.3 },
	});
	const ctx = fakeCtx({ "llama.cpp/small-window": 32_000, "llama.cpp/big-window": 128_000 });
	assert.equal(pickLocal(cfg, ctx, "auto", 0.5), "llama.cpp/small-window", "capability map overrides window ratio");

	const noCaps = config({ catalog: { local: ["llama.cpp/small-window", "llama.cpp/big-window"], cloud: [] } });
	assert.equal(pickLocal(noCaps, ctx, "auto", 0.5), "llama.cpp/big-window", "without capabilities window ratio decides");
});

test("complexity score selects the smallest model that can handle it", () => {
	const cfg = config({ catalog: { local: ["llama.cpp/small", "llama.cpp/medium", "llama.cpp/large"], cloud: [] } });
	const ctx = fakeCtx({ "llama.cpp/small": 32_000, "llama.cpp/medium": 64_000, "llama.cpp/large": 128_000 });
	assert.equal(pickLocal(cfg, ctx, "auto", 0.1), "llama.cpp/small");
	assert.equal(pickLocal(cfg, ctx, "auto", 0.4), "llama.cpp/medium");
	assert.equal(pickLocal(cfg, ctx, "auto", 0.9), "llama.cpp/large");
});

test("lastUserText reads the latest user text block", () => {
	const messages = [
		{ role: "user", content: "first" },
		{ role: "assistant", content: [{ type: "text", text: "reply" }] },
		{ role: "user", content: [{ type: "text", text: "latest" }] },
	] as unknown as Message[];
	assert.equal(lastUserText(messages), "latest");
});
