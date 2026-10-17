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

test("fast-local orders local candidates by on-disk size, smallest first", () => {
	const cfg = config({ catalog: { local: ["llama.cpp/big", "llama.cpp/small"], cloud: ["c/m"] } });
	const sizes = new Map([
		["llama.cpp/big", 90_000],
		["llama.cpp/small", 2_000],
	]);
	assert.equal(pickLocal(cfg, fakeCtx(), "fast-local", sizes), "llama.cpp/small");
	assert.equal(pickLocal(cfg, fakeCtx(), "auto"), "llama.cpp/big", "auto keeps configured order");
});

test("fast-local with no sizes falls back to configured order", () => {
	const cfg = config({ catalog: { local: ["llama.cpp/a", "llama.cpp/b"], cloud: [] } });
	assert.equal(pickLocal(cfg, fakeCtx(), "fast-local", new Map()), "llama.cpp/a");
});

test("pickCloud returns the first cloud candidate", () => {
	const cfg = config({ catalog: { local: [], cloud: ["cloud/one", "cloud/two"] } });
	assert.equal(pickCloud(cfg, fakeCtx()), "cloud/one");
});

test("complexity score selects the smallest model that can handle it", () => {
	const cfg = config({ catalog: { local: ["llama.cpp/small", "llama.cpp/medium", "llama.cpp/large"], cloud: [] } });
	const ctx = fakeCtx({ "llama.cpp/small": 32_000, "llama.cpp/medium": 64_000, "llama.cpp/large": 128_000 });
	assert.equal(pickLocal(cfg, ctx, "auto", undefined, 0.1), "llama.cpp/small");
	assert.equal(pickLocal(cfg, ctx, "auto", undefined, 0.4), "llama.cpp/medium");
	assert.equal(pickLocal(cfg, ctx, "auto", undefined, 0.9), "llama.cpp/large");
});

test("lastUserText reads the latest user text block", () => {
	const messages = [
		{ role: "user", content: "first" },
		{ role: "assistant", content: [{ type: "text", text: "reply" }] },
		{ role: "user", content: [{ type: "text", text: "latest" }] },
	] as unknown as Message[];
	assert.equal(lastUserText(messages), "latest");
});
