import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { availableHosts, createHost, type LocalHost } from "../src/host.ts";
import { OllamaHost } from "../src/ollama.ts";
import { OpenAiHost } from "../src/openai-host.ts";
import { DEFAULTS } from "../src/config.ts";
import { LocalGovernor } from "../src/governor.ts";
import type { LocalConfig } from "../src/types.ts";

test("createHost picks the host named by config.host", () => {
	assert.equal(createHost({ ...DEFAULTS, host: "lmstudio" }).kind, "lmstudio");
	assert.equal(createHost({ ...DEFAULTS, host: "ollama" }).kind, "ollama");
	assert.equal(createHost({ ...DEFAULTS, host: "openai" }).kind, "openai");
});

test("lmstudio reports full capabilities; openai reports the floor", () => {
	const lm = createHost({ ...DEFAULTS, host: "lmstudio" });
	assert.deepEqual(lm.capabilities, { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true });

	const oai = new OpenAiHost(DEFAULTS.openai);
	assert.deepEqual(oai.capabilities, { canListLoaded: false, canLoadUnload: false, hasDecisionModels: false, hasModelSizes: false });
});

test("ollama reports inventory + load/unload but no decision models", () => {
	const caps = new OllamaHost(DEFAULTS.ollama).capabilities;
	assert.deepEqual(caps, { canListLoaded: true, canLoadUnload: true, hasDecisionModels: false, hasModelSizes: true });
});

test("an OpenAI-compatible host cannot enforce a loaded-model ceiling", async () => {
	const unloads: string[] = [];
	const oai = {
		capabilities: { canListLoaded: false, canLoadUnload: false, hasDecisionModels: false, hasModelSizes: false },
		loaded: async () => [{ key: "m-a", instances: [{ id: "m-a" }] }, { key: "m-b", instances: [{ id: "m-b" }] }],
		unload: async (id: string) => void unloads.push(id),
	} as unknown as LocalHost;
	const cfg: LocalConfig = { ...DEFAULTS.local, maxLoadedModels: 1 };
	const gov = new LocalGovernor(cfg, oai);
	assert.deepEqual(await gov.enforceLoadedCeiling("m-c"), [], "no unload calls when the host cannot load/unload");
	assert.equal(unloads.length, 0);
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "router-host-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("a host that cannot list loaded models still maps via slot accounting", async () => {
	const caps = { canListLoaded: false, canLoadUnload: false, hasDecisionModels: false, hasModelSizes: false };
	const host = { capabilities: caps, loaded: async () => [] } as unknown as LocalHost;
	const gov = new LocalGovernor({ ...DEFAULTS.local, slotDir: dir, maxConcurrent: 1 }, host);
	const first = await gov.acquire("openai/model-x");
	assert.ok(first, "first reservation succeeds");
	assert.equal(await gov.acquire("openai/model-y"), null, "cap still bites across processes via slots");
	gov.release(first!);

	const status = await gov.status();
	assert.equal(status.capabilities.canListLoaded, false);
});

test("availableHosts reports only reachable hosts, in preference order (#46)", async () => {
	const impl = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes(":1235/api/v1/models")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
		return new Response("nope", { status: 500 });
	};
	globalThis.fetch = impl as typeof fetch;
	try {
		assert.deepEqual(await availableHosts(DEFAULTS, 200), ["lmstudio"]);
	} finally {
		globalThis.fetch = undefined as never;
	}
});

test("availableHosts returns nothing when every host is down (#46)", async () => {
	globalThis.fetch = (async () => {
		throw new Error("ECONNREFUSED");
	}) as typeof fetch;
	try {
		assert.deepEqual(await availableHosts(DEFAULTS, 200), []);
	} finally {
		globalThis.fetch = undefined as never;
	}
});
