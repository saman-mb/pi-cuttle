import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { LocalGovernor } from "../src/governor.ts";
import type { LocalHost } from "../src/host.ts";
import { DEFAULTS } from "../src/config.ts";
import type { LocalConfig } from "../src/types.ts";

const FAKE_CAPS = { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true };

/** Fake host client: no network, controllable loaded set. */
function fakeHost(loaded: string[] = [], capabilities: Partial<LocalHost["capabilities"]> = {}): LocalHost {
	return {
		kind: "lmstudio",
		capabilities: { ...FAKE_CAPS, ...capabilities },
		loaded: async () => loaded.map((key) => ({ key, instances: [{ id: key }] })),
		unload: async () => {},
	} as unknown as LocalHost;
}

let dir: string;
let cfg: LocalConfig;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cuttle-slots-"));
	cfg = { ...DEFAULTS.local, slotDir: dir, staleSlotMs: 60_000, maxConcurrent: 1, maxConcurrentPerModel: 1 };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("acquire writes a slot file and release removes it", async () => {
	const gov = new LocalGovernor(cfg, fakeHost());
	const res = await gov.acquire("lmstudio/model-a");
	assert.ok(res, "expected a reservation");
	assert.equal(readdirSync(dir).length, 1);

	gov.release(res!);
	assert.equal(readdirSync(dir).length, 0);
});

test("second acquire spills when maxConcurrent is reached", async () => {
	const gov = new LocalGovernor(cfg, fakeHost());
	const first = await gov.acquire("lmstudio/model-a");
	assert.ok(first);
	const second = await gov.acquire("lmstudio/model-b");
	assert.equal(second, null, "expected spill (null) while a slot is held");
	gov.release(first!);
});

test("per-model cap is independent of the global cap", async () => {
	cfg = { ...cfg, maxConcurrent: 5, maxConcurrentPerModel: 1 };
	const gov = new LocalGovernor(cfg, fakeHost());
	const a = await gov.acquire("lmstudio/model-a");
	assert.ok(a);
	assert.equal(await gov.acquire("lmstudio/model-a"), null, "same model over per-model cap");
	const b = await gov.acquire("lmstudio/model-b");
	assert.ok(b, "different model allowed under global cap");
});

test("maxLoadedModels spills when LM Studio is already at the ceiling", async () => {
	// model-a loaded, ceiling 1, asking for model-b -> spill.
	const gov = new LocalGovernor(cfg, fakeHost(["lmstudio/model-a"]));
	const res = await gov.acquire("lmstudio/model-b");
	assert.equal(res, null);
});

test("a stale slot from a dead pid is reaped", async () => {
	const gov = new LocalGovernor(cfg, fakeHost());
	// Write a slot owned by a pid that cannot exist.
	const { writeFileSync } = await import("node:fs");
	writeFileSync(
		join(dir, "slot-dead.json"),
		JSON.stringify({ id: "dead", modelKey: "lmstudio/model-a", pid: 2 ** 30, startedAt: Date.now(), file: "" }),
	);
	assert.equal(gov.live().length, 0, "dead-pid slot should be reaped");
	assert.equal(readdirSync(dir).length, 0, "reaped file should be deleted");
});

test("releaseOne frees the oldest reservation for a model", async () => {
	const gov = new LocalGovernor(cfg, fakeHost());
	await gov.acquire("lmstudio/model-a");
	assert.equal(gov.releaseOne("lmstudio/model-a"), true);
	assert.equal(gov.releaseOne("lmstudio/model-a"), false, "nothing left to release");
});

test("per-flavor budget gates one flavor without blocking another (#16)", async () => {
	cfg = { ...cfg, maxConcurrent: 5, maxConcurrentPerModel: 5, maxConcurrentByFlavor: { local: 1 } };
	const gov = new LocalGovernor(cfg, fakeHost());
	const a = await gov.acquire("lmstudio/model-a", { flavor: "local" });
	assert.ok(a, "first local-flavor slot");
	assert.equal(await gov.acquire("lmstudio/model-a", { flavor: "local" }), null, "second local-flavor blocked");
	assert.ok(await gov.acquire("lmstudio/model-a", { flavor: "auto" }), "auto flavor is not gated");
});

test("enforceLoadedCeiling unloads the models closest to TTL, keeping the target (#14)", async () => {
	cfg = { ...cfg, maxLoadedModels: 1 };
	const unloads: string[] = [];
	const lm = { capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		loaded: async () => [
			{ key: "lmstudio/keep", instances: [{ id: "lmstudio/keep", remaining_ttl_seconds: 5000 }] },
			{ key: "lmstudio/old", instances: [{ id: "lmstudio/old", remaining_ttl_seconds: 10 }] },
		],
		unload: async (id: string) => {
			unloads.push(id);
		},
	} as unknown as LocalHost;
	const gov = new LocalGovernor(cfg, lm);
	const unloaded = await gov.enforceLoadedCeiling("lmstudio/keep");
	assert.deepEqual(unloaded, ["lmstudio/old"]);
	assert.deepEqual(unloads, ["lmstudio/old"]);
});

test("enforceLoadedCeiling is a no-op when the ceiling is disabled", async () => {
	cfg = { ...cfg, maxLoadedModels: 0 };
	const unloads: string[] = [];
	const lm = { capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		loaded: async () => [{ key: "a", instances: [{ id: "a" }] }],
		unload: async (id: string) => void unloads.push(id),
	} as unknown as LocalHost;
	assert.deepEqual(await new LocalGovernor(cfg, lm).enforceLoadedCeiling(), []);
	assert.equal(unloads.length, 0);
});

test("enforceLoadedCeiling frees a slot when the target is not loaded (#30)", async () => {
	cfg = { ...cfg, maxLoadedModels: 1 };
	const unloads: string[] = [];
	const lm = { capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		loaded: async () => [{ key: "lmstudio/other", instances: [{ id: "lmstudio/other" }] }],
		unload: async (id: string) => void unloads.push(id),
	} as unknown as LocalHost;
	const gov = new LocalGovernor(cfg, lm);
	assert.deepEqual(await gov.enforceLoadedCeiling("lmstudio/target"), ["lmstudio/other"]);
	assert.deepEqual(unloads, ["lmstudio/other"]);
});

test("enforceLoadedCeiling keeps one other when the target is already loaded", async () => {
	cfg = { ...cfg, maxLoadedModels: 2 };
	const unloads: string[] = [];
	const lm = { capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		loaded: async () => [
			{ key: "lmstudio/target", instances: [{ id: "lmstudio/target" }] },
			{ key: "lmstudio/a", instances: [{ id: "lmstudio/a" }] },
			{ key: "lmstudio/b", instances: [{ id: "lmstudio/b" }] },
		],
		unload: async (id: string) => void unloads.push(id),
	} as unknown as LocalHost;
	const gov = new LocalGovernor(cfg, lm);
	const unloaded = await gov.enforceLoadedCeiling("lmstudio/target");
	assert.equal(unloaded.length, 1, "cap 2 means one other plus the target");
	assert.equal(unloads.length, 1);
});

test("enforceLoadedCeiling unloads every instance of a victim model (#30)", async () => {
	cfg = { ...cfg, maxLoadedModels: 1 };
	const unloads: string[] = [];
	const lm = { capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		loaded: async () => [{ key: "other", instances: [{ id: "other:1" }, { id: "other:2" }, { id: "other:3" }] }],
		unload: async (id: string) => void unloads.push(id),
	} as unknown as LocalHost;
	const gov = new LocalGovernor(cfg, lm);
	assert.deepEqual(await gov.enforceLoadedCeiling("target"), ["other"]);
	assert.deepEqual(unloads, ["other:1", "other:2", "other:3"], "all instances of the victim must go");
});

test("releaseOne matches by model key regardless of provider, false when nothing held (#38)", async () => {
	const gov = new LocalGovernor(cfg, fakeHost());
	const res = await gov.acquire("qwen3:8b");
	assert.ok(res);
	// A cloud-message no-op must not throw and must report false.
	assert.equal(gov.releaseOne("some/cloud-model"), false);
	// The local model is released by its bare message id, as delivered by message_end.
	assert.equal(gov.releaseOne("qwen3:8b"), true);
	assert.equal(gov.live().length, 0);
});

test("a pinned model survives the loaded ceiling (#44)", async () => {
	cfg = { ...cfg, maxLoadedModels: 1 };
	const unloads: string[] = [];
	const lm = {
		capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
		loaded: async () => [
			{ key: "lmstudio/classifier", instances: [{ id: "lmstudio/classifier", remaining_ttl_seconds: 5 }] },
			{ key: "lmstudio/old", instances: [{ id: "lmstudio/old", remaining_ttl_seconds: 10 }] },
		],
		unload: async (id: string) => void unloads.push(id),
	} as unknown as LocalHost;
	const gov = new LocalGovernor(cfg, lm);
	gov.pin("lmstudio/classifier");
	const unloaded = await gov.enforceLoadedCeiling("lmstudio/keep");
	assert.deepEqual(unloaded, ["lmstudio/old"], "the evictable model goes, even though it has more TTL left");
	assert.equal(unloads.includes("lmstudio/classifier"), false, "classifier never evicted");
	assert.deepEqual((await gov.status()).pinnedKeys, ["lmstudio/classifier"]);
	gov.unpin("lmstudio/classifier");
});
