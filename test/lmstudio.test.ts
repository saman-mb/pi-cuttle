import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostModel } from "../src/host.ts";
import { LmStudioHost } from "../src/lmstudio.ts";
import type { LoadedInstance } from "../src/types.ts";

/** Build a host whose catalog read is stubbed, so no live server is needed. */
function hostWith(models: HostModel[]): LmStudioHost {
	const host = new LmStudioHost({ baseUrl: "http://localhost:1234", timeoutMs: 100 });
	host.list = async () => models;
	return host;
}

/**
 * Stub `loaded()` directly: it returns the richer `LoadedInstance` (with `config`) that LM
 * Studio actually reports, which is what the batch-capacity probe reads.
 */
function hostWithLoaded(entries: { key: string; instances: LoadedInstance[] }[]): LmStudioHost {
	const host = new LmStudioHost({ baseUrl: "http://localhost:1234", timeoutMs: 100 });
	host.loaded = async () => entries;
	return host;
}

test("loadedInstance returns the loaded instance for a model id (#50)", async () => {
	const host = hostWithLoaded([
		{ key: "vllm-d3-nano", instances: [{ id: "inst-1", config: { physical_batch_size: 512, eval_batch_size: 2048 } }] },
	]);
	const instance = await host.loadedInstance("vllm-d3-nano");
	assert.equal(instance?.id, "inst-1");
	assert.equal(instance?.config?.physical_batch_size, 512);
});

test("loadedInstance is undefined for a model that is not loaded (#50)", async () => {
	const host = hostWithLoaded([{ key: "other", instances: [{ id: "inst-9" }] }]);
	assert.equal(await host.loadedInstance("vllm-d3-nano"), undefined);
});

test("loadedInstance reads the catalog: an unloaded model has no instances (#50)", async () => {
	const host = hostWith([{ key: "vllm-d3-nano", type: "decision" }]);
	assert.equal(await host.loadedInstance("vllm-d3-nano"), undefined);
});

test("physicalBatchSize reports the loaded instance's real batch limit (#50)", async () => {
	const host = hostWithLoaded([
		{ key: "vllm-d3-nano", instances: [{ id: "inst-1", config: { physical_batch_size: 1024, eval_batch_size: 2048 } }] },
	]);
	assert.equal(await host.physicalBatchSize("vllm-d3-nano"), 1024);
});

test("physicalBatchSize is undefined when the model is not loaded (#50)", async () => {
	// An unloaded catalog entry omits batch fields entirely, which is why callers keep a
	// conservative default instead of trusting the catalog.
	const host = hostWith([{ key: "vllm-d3-nano", type: "decision" }]);
	assert.equal(await host.physicalBatchSize("vllm-d3-nano"), undefined);
});

test("physicalBatchSize is best-effort when the host is unreachable (#50)", async () => {
	const host = new LmStudioHost({ baseUrl: "http://127.0.0.1:1", timeoutMs: 50 });
	assert.equal(await host.physicalBatchSize("anything"), undefined);
});
