import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { LocalGovernor } from "../src/governor.ts";
import { DEFAULTS } from "../src/config.ts";
import type { LocalConfig } from "../src/types.ts";

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
	const gov = new LocalGovernor(cfg);
	const res = await gov.acquire("model-a");
	assert.ok(res, "expected a reservation");
	assert.equal(readdirSync(dir).length, 1);

	gov.release(res!);
	assert.equal(readdirSync(dir).length, 0);
});

test("second acquire spills when maxConcurrent is reached", async () => {
	const gov = new LocalGovernor(cfg);
	const first = await gov.acquire("model-a");
	assert.ok(first);
	const second = await gov.acquire("model-b");
	assert.equal(second, null, "expected spill (null) while a slot is held");
	gov.release(first!);
});

test("per-model cap is independent of the global cap", async () => {
	cfg = { ...cfg, maxConcurrent: 5, maxConcurrentPerModel: 1 };
	const gov = new LocalGovernor(cfg);
	const a = await gov.acquire("model-a");
	assert.ok(a);
	assert.equal(await gov.acquire("model-a"), null, "same model over per-model cap");
	const b = await gov.acquire("model-b");
	assert.ok(b, "different model allowed under global cap");
});

test("a stale slot from a dead pid is reaped", async () => {
	const gov = new LocalGovernor(cfg);
	const { writeFileSync } = await import("node:fs");
	writeFileSync(
		join(dir, "slot-dead.json"),
		JSON.stringify({ id: "dead", modelKey: "model-a", pid: 2 ** 30, startedAt: Date.now(), file: "" }),
	);
	assert.equal(gov.live().length, 0, "dead-pid slot should be reaped");
	assert.equal(readdirSync(dir).length, 0, "reaped file should be deleted");
});

test("releaseOne frees the oldest reservation for a model", async () => {
	const gov = new LocalGovernor(cfg);
	await gov.acquire("model-a");
	assert.equal(gov.releaseOne("model-a"), true);
	assert.equal(gov.releaseOne("model-a"), false, "nothing left to release");
});

test("per-flavor budget gates one flavor without blocking another", async () => {
	cfg = { ...cfg, maxConcurrent: 5, maxConcurrentPerModel: 5, maxConcurrentByFlavor: { local: 1 } };
	const gov = new LocalGovernor(cfg);
	const a = await gov.acquire("model-a", { flavor: "local" });
	assert.ok(a, "first local-flavor slot");
	assert.equal(await gov.acquire("model-a", { flavor: "local" }), null, "second local-flavor blocked");
	assert.ok(await gov.acquire("model-a", { flavor: "auto" }), "auto flavor is not gated");
});

test("releaseOne matches by model key, false when nothing held", async () => {
	const gov = new LocalGovernor(cfg);
	const res = await gov.acquire("qwen3:8b");
	assert.ok(res);
	assert.equal(gov.releaseOne("some/cloud-model"), false);
	assert.equal(gov.releaseOne("qwen3:8b"), true);
	assert.equal(gov.live().length, 0);
});
