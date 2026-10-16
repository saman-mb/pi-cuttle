import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS } from "../src/config.ts";
import { OllamaHost } from "../src/ollama.ts";
import { OpenAiHost } from "../src/openai-host.ts";

/** Capture requests and answer them from a routing table. */
function fakeFetch(routes: { match: (url: string, init?: RequestInit) => boolean; response: unknown }[]): {
	fetch: typeof fetch;
	calls: { url: string; init?: RequestInit }[];
} {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, ...(init ? { init } : {}) });
		const route = routes.find((r) => r.match(url, init));
		if (!route) throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
		return new Response(JSON.stringify(route.response), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { fetch: impl as typeof fetch, calls };
}

test("ollama: list maps /api/tags name+size", async () => {
	const { fetch } = fakeFetch([{ match: (u) => u.endsWith("/api/tags"), response: { models: [{ name: "qwen3:8b", size: 5_000_000_000 }] } }]);
	globalThis.fetch = fetch;
	try {
		const host = new OllamaHost(DEFAULTS.ollama);
		const models = await host.list();
		assert.deepEqual(models, [{ key: "qwen3:8b", size_bytes: 5_000_000_000 }]);
	} finally {
		globalThis.fetch = undefined as never;
	}
});

test("ollama: loaded maps /api/ps and derives remaining TTL", async () => {
	const expires = new Date(Date.now() + 60_000).toISOString();
	const { fetch } = fakeFetch([{ match: (u) => u.endsWith("/api/ps"), response: { models: [{ name: "qwen3:8b", expires_at: expires }] } }]);
	globalThis.fetch = fetch;
	try {
		const host = new OllamaHost(DEFAULTS.ollama);
		const loaded = await host.loaded();
		assert.equal(loaded[0]?.key, "qwen3:8b");
		const ttl = loaded[0]?.instances[0]?.remaining_ttl_seconds ?? 0;
		assert.ok(ttl > 50 && ttl <= 60, `ttl ~60s, got ${ttl}`);
	} finally {
		globalThis.fetch = undefined as never;
	}
});

test("ollama: unload posts keep_alive:0 with the model name", async () => {
	const { fetch, calls } = fakeFetch([{ match: (u) => u.endsWith("/api/generate"), response: {} }]);
	globalThis.fetch = fetch;
	try {
		await new OllamaHost(DEFAULTS.ollama).unload("qwen3:8b");
		const body = JSON.parse(String(calls[0]?.init?.body));
		assert.equal(calls[0]?.url.endsWith("/api/generate"), true);
		assert.equal(body.model, "qwen3:8b");
		assert.equal(body.keep_alive, 0);
	} finally {
		globalThis.fetch = undefined as never;
	}
});

test("ollama: chat returns message.content from /api/chat", async () => {
	const { fetch, calls } = fakeFetch([{ match: (u) => u.endsWith("/api/chat"), response: { message: { content: "CLOUD" } } }]);
	globalThis.fetch = fetch;
	try {
		const answer = await new OllamaHost(DEFAULTS.ollama).chat("qwen3:8b", "classify this", { maxTokens: 4 });
		assert.equal(answer, "CLOUD");
		const body = JSON.parse(String(calls[0]?.init?.body));
		assert.equal(body.stream, false);
		assert.equal(body.options.num_predict, 4);
	} finally {
		globalThis.fetch = undefined as never;
	}
});

test("openai: list maps /v1/models data[].id and loaded is empty by contract", async () => {
	const { fetch } = fakeFetch([{ match: (u) => u.endsWith("/v1/models"), response: { data: [{ id: "llama-3.2-3b" }] } }]);
	globalThis.fetch = fetch;
	try {
		const host = new OpenAiHost(DEFAULTS.openai);
		assert.deepEqual(await host.list(), [{ key: "llama-3.2-3b" }]);
		assert.deepEqual(await host.loaded(), []);
		// load/unload are no-ops: they must not hit the network.
		await host.load("llama-3.2-3b");
		await host.unload("llama-3.2-3b");
	} finally {
		globalThis.fetch = undefined as never;
	}
});

test("openai: chat posts to /v1/chat/completions and reads choices[0].message.content", async () => {
	const { fetch, calls } = fakeFetch([
		{ match: (u) => u.endsWith("/v1/chat/completions"), response: { choices: [{ message: { content: "LOCAL" } }] } },
	]);
	globalThis.fetch = fetch;
	try {
		const answer = await new OpenAiHost(DEFAULTS.openai).chat("llama-3.2-3b", "classify", { maxTokens: 4 });
		assert.equal(answer, "LOCAL");
		assert.equal(String(calls[0]?.url).endsWith("/v1/chat/completions"), true);
	} finally {
		globalThis.fetch = undefined as never;
	}
});
