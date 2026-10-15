import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { LocalGovernor } from "../src/governor.ts";
import type { LmStudioClient } from "../src/lmstudio.ts";
import { DEFAULTS } from "../src/config.ts";
import type { LocalConfig } from "../src/types.ts";

/** Fake LM Studio client: no network, controllable loaded set. */
function fakeLm(loaded: string[] = []): LmStudioClient {
	return { loaded: async () => loaded.map((key) => ({ key, instances: [{ id: key }] })) } as unknown as LmStudioClient;
}

let dir: string;
let cfg: LocalConfig;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "router-slots-"));
	cfg = { ...DEFAULTS.local, slotDir: dir, staleSlotMs: 60_000, maxConcurrent: 1, maxConcurrentPerModel: 1 };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("acquire writes a slot file and release removes it", async () => {
	const gov = new LocalGovernor(cfg, fakeLm());
	const res = await gov.acquire("lmstudio/model-a");
	assert.ok(res, "expected a reservation");
	assert.equal(readdirSync(dir).length, 1);

	gov.release(res!);
	assert.equal(readdirSync(dir).length, 0);
});

test("second acquire spills when maxConcurrent is reached", async () => {
	const gov = new LocalGovernor(cfg, fakeLm());
	const first = await gov.acquire("lmstudio/model-a");
	assert.ok(first);
	const second = await gov.acquire("lmstudio/model-b");
	assert.equal(second, null, "expected spill (null) while a slot is held");
	gov.release(first!);
});

test("per-model cap is independent of the global cap", async () => {
	cfg = { ...cfg, maxConcurrent: 5, maxConcurrentPerModel: 1 };
	const gov = new LocalGovernor(cfg, fakeLm());
	const a = await gov.acquire("lmstudio/model-a");
	assert.ok(a);
	assert.equal(await gov.acquire("lmstudio/model-a"), null, "same model over per-model cap");
	const b = await gov.acquire("lmstudio/model-b");
	assert.ok(b, "different model allowed under global cap");
});

test("maxLoadedModels spills when LM Studio is already at the ceiling", async () => {
	// model-a loaded, ceiling 1, asking for model-b -> spill.
	const gov = new LocalGovernor(cfg, fakeLm(["lmstudio/model-a"]));
	const res = await gov.acquire("lmstudio/model-b");
	assert.equal(res, null);
});

test("a stale slot from a dead pid is reaped", async () => {
	const gov = new LocalGovernor(cfg, fakeLm());
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
	const gov = new LocalGovernor(cfg, fakeLm());
	await gov.acquire("lmstudio/model-a");
	assert.equal(gov.releaseOne("lmstudio/model-a"), true);
	assert.equal(gov.releaseOne("lmstudio/model-a"), false, "nothing left to release");
});
