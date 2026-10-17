import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as shadow from "../src/shadow.ts";
import type { GateVerdicts, Tier } from "../src/types.ts";

function withTempDir(testFn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-cuttle-shadow-"));
	const path = join(dir, "shadow.jsonl");
	const original = join(dir, "unused.jsonl");
	shadow.setShadowLogPath(original);
	shadow.setShadowLogPath(path);
	try {
		testFn(dir);
	} finally {
		shadow.setShadowLogPath(original);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("appendShadow writes a JSONL record", () => {
	withTempDir((dir) => {
		shadow.appendShadow({ at: 1, tier: "local", source: "classifier", reason: "x" });
		const path = join(dir, "shadow.jsonl");
		assert.ok(existsSync(path));
		const lines = readFileSync(path, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const record = JSON.parse(lines[0]!) as { tier: string };
		assert.equal(record.tier, "local");
	});
});

test("readShadow returns records in order", () => {
	withTempDir(() => {
		shadow.appendShadow({ at: 1, tier: "local", source: "classifier", reason: "a" });
		shadow.appendShadow({ at: 2, tier: "cloud", source: "classifier", reason: "b" });
		const records = shadow.readShadow();
		assert.equal(records.length, 2);
		assert.equal(records[0]!.tier, "local");
		assert.equal(records[1]!.tier, "cloud");
	});
});

function boolVerdict(p: number): GateVerdicts["struggle"] {
	return { type: "bool", probability: p, shadow: true };
}

test("computeAgreement compares struggle gate to actual tier", () => {
	const records = [
		{ at: 1, tier: "cloud" as Tier, source: "classifier" as const, reason: "escalated", gates: { struggle: boolVerdict(0.9) } },
		{ at: 2, tier: "local" as Tier, source: "classifier" as const, reason: "ok", gates: { struggle: boolVerdict(0.2) } },
		{ at: 3, tier: "local" as Tier, source: "classifier" as const, reason: "ok", gates: { struggle: boolVerdict(0.9) } },
	];
	const rows = shadow.computeAgreement(records);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.total, 3);
	assert.equal(rows[0]!.agreed, 2);
	assert.equal(rows[0]!.disagreed, 1);
});

test("formatAgreement renders a table", () => {
	const rows = [{ name: "struggle", total: 10, agreed: 9, disagreed: 1, belowThreshold: 0 }];
	const out = shadow.formatAgreement(rows);
	assert.match(out, /struggle/);
	assert.match(out, /90.0%/);
});
