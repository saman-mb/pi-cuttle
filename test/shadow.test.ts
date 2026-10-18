import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULTS } from "../src/config.ts";
import { routeRequest } from "../src/virtual-models.ts";
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

test("readShadow accepts legacy records without signalPath", () => {
	withTempDir((dir) => {
		const path = join(dir, "shadow.jsonl");
		writeFileSync(path, JSON.stringify({ at: 3, tier: "local", source: "classifier", reason: "legacy" }) + "\n");
		const records = shadow.readShadow();
		assert.equal(records.length, 1);
		assert.equal(records[0]!.signalPath, undefined);
		assert.equal(records[0]!.tier, "local");
	});
});

test("route writes paired metadata without logging conversation or prompt text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cuttle-shadow-route-"));
	const path = join(dir, "shadow.jsonl");
	shadow.setShadowLogPath(path);
	const marker = "PRIVATE_CONTEXT_SENTINEL_106";
	try {
		let classifyCalls = 0;
		let releaseAlternate!: () => void;
		const alternateGate = new Promise<void>((resolve) => { releaseAlternate = resolve; });
		const model = { id: "big", provider: "cloud", contextWindow: 100_000 };
		const ctx = {
			modelRegistry: {
				findOfType: () => ({ id: "classifier", provider: "llama.cpp" }),
				find: () => model,
				classify: async () => {
					classifyCalls++;
					if (classifyCalls > 1) await alternateGate;
					const complex = classifyCalls === 1 ? 0.9 : 0.1;
					return { stopReason: "stop", answers: { complexity: { type: "choice", choice: complex >= 0.5 ? "complex" : "standard", probabilities: { complex } } } };
				},
			},
			sessionManager: { getSessionId: () => "session" },
			getContextUsage: () => undefined,
		} as never;
		const rt = {
			config: {
				...DEFAULTS,
				classifier: { ...DEFAULTS.classifier, model: "llama.cpp/classifier", contextShadow: true },
				catalog: { local: [], cloud: ["cloud/big"] },
			},
			governor: {},
			pins: new Map(),
			previousModels: new Map(),
			classifierFailures: 0,
			classifierBackoffUntil: 0,
		} as never;
		const routedInTime = await Promise.race([
			routeRequest(rt, "auto", {
				reason: "user",
				messages: [
					{ role: "assistant", content: `earlier context ${marker}` },
					{ role: "user", content: `do it ${marker}` },
				],
			} as never, ctx).then((routed) => ({ routed })),
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
		]);
		assert.ok(routedInTime, "route must not wait for the alternate classifier");
		const routed = routedInTime.routed;
		assert.equal(routed.state?.tier, "cloud", "routing uses the authoritative classifier result");
		releaseAlternate();

		for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const records = shadow.readShadow();
		assert.equal(records.length, 1);
		assert.equal(records[0]!.signalPath, "last-message");
		assert.deepEqual(records[0]!.paired, {
			authoritative: { signalPath: "last-message", tier: "cloud" },
			alternate: { signalPath: "conversation", tier: "local" },
			agree: false,
		});
		const contents = readFileSync(path, "utf8");
		assert.equal(contents.includes(marker), false, "shadow JSONL must not contain prompt or conversation text");
		assert.equal(classifyCalls, 2);
	} finally {
		shadow.setShadowLogPath(join(dir, "unused.jsonl"));
		rmSync(dir, { recursive: true, force: true });
	}
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
