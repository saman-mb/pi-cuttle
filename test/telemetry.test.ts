import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { formatStats, isPhysicalTurn, Telemetry, type DecisionRecord } from "../src/telemetry.ts";
import type { TelemetryConfig } from "../src/types.ts";

let dir: string;
let path: string;
let cfg: TelemetryConfig;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cuttle-telemetry-"));
	path = join(dir, "decisions.jsonl");
	cfg = {
		enabled: true,
		path,
		pricing: {
			"cloud/big": { input: 3, output: 15 },
			"cloud/baseline": { input: 1, output: 5 },
		},
		baseline: "cloud/baseline",
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function record(t: Telemetry, tier: "local" | "cloud", model: string, input: number, output: number): void {
	const rec: DecisionRecord = {
		ts: Date.now(),
		provider: model.split("/")[0] ?? "",
		model: model.split("/").slice(1).join("/"),
		tier,
		inputTokens: input,
		outputTokens: output,
	};
	t.record(rec);
}

test("isLocalModel matches full provider/model refs", () => {
	const t = new Telemetry(cfg, ["lmstudio/prism-ml/bonsai-27b", "ollama/qwen3:8b"]);
	assert.equal(t.isLocalModel("lmstudio/prism-ml/bonsai-27b"), true);
	assert.equal(t.isLocalModel("ollama/qwen3:8b"), true);
	assert.equal(t.isLocalModel("opencode-go/deepseek-v4.1-flash"), false);
});

test("record + stats: counts, tokens, and per-model breakdown", () => {
	const t = new Telemetry(cfg, ["lmstudio/local-model"]);
	record(t, "local", "lmstudio/local-model", 1_000, 200);
	record(t, "local", "lmstudio/local-model", 2_000, 300);
	record(t, "cloud", "cloud/big", 5_000, 1_000);
	const stats = t.stats(7);
	assert.equal(stats.turns, 3);
	assert.equal(stats.localTurns, 2);
	assert.equal(stats.cloudTurns, 1);
	assert.equal(stats.localTokens, 3_500);
	assert.equal(stats.cloudTokens, 6_000);
	assert.deepEqual(stats.perModel[0], { model: "local-model", turns: 2, tokens: 3_500 });
});

test("pricing: savings = baseline cost of every turn minus what cloud turns actually cost", () => {
	const t = new Telemetry(cfg, ["lmstudio/local-model"]);
	record(t, "local", "lmstudio/local-model", 1_000, 200);
	record(t, "cloud", "cloud/big", 5_000, 1_000);
	const stats = t.stats(7);
	assert.equal(stats.pricingComplete, true);
	assert.ok(Math.abs(stats.spent - 0.03) < 1e-9, `spent ${stats.spent}`);
	assert.ok(Math.abs(stats.baselineCost - 0.012) < 1e-9, `baseline ${stats.baselineCost}`);
	assert.ok(Math.abs(stats.saved - (0.012 - 0.03)) < 1e-9, `saved ${stats.saved}`);
});

test("missing cloud pricing degrades to counts instead of inventing numbers", () => {
	const t = new Telemetry({ ...cfg, pricing: { "cloud/baseline": { input: 1, output: 5 } } }, []);
	record(t, "cloud", "cloud/unknown", 1_000, 100);
	const stats = t.stats(7);
	assert.equal(stats.pricingComplete, false);
	assert.equal(stats.spent, 0);
	assert.ok(stats.baselineCost > 0);
});

test("corrupt ledger lines are skipped, not fatal", () => {
	const t = new Telemetry(cfg, []);
	writeFileSync(path, "{not json}\n");
	record(t, "local", "lmstudio/local-model", 100, 10);
	assert.equal(t.stats(7).turns, 1);
});

test("a window with no records reports nothing to show", () => {
	const t = new Telemetry({ ...cfg, path: join(dir, "missing.jsonl") }, []);
	const out = formatStats(t.stats(7), cfg.baseline);
	assert.match(out, /no decisions recorded/);
});

test("a turn attributed to the virtual provider is not recorded (#62)", () => {
	assert.equal(isPhysicalTurn({ provider: "cuttle", model: "auto" }), false);
	assert.equal(isPhysicalTurn({ provider: undefined, model: "auto" }), false);
	assert.equal(isPhysicalTurn({ provider: "", model: "auto" }), false);
});

test("stats falls back to registry pricing when telemetry.pricing is missing", () => {
	const t = new Telemetry({ ...cfg, pricing: {} }, []);
	record(t, "cloud", "cloud/big", 1_000_000, 0);
	const fakeCtx = {
		modelRegistry: {
			find: (provider: string, id: string) => {
				if (provider === "cloud" && id === "big") return { cost: { input: 2, output: 8 } };
				if (provider === "cloud" && id === "baseline") return { cost: { input: 1, output: 5 } };
				return undefined;
			},
		},
	};
	const stats = t.stats(7, (ref) => Telemetry.registryPriceFor(fakeCtx, ref));
	assert.equal(stats.pricingComplete, true);
	assert.ok(Math.abs(stats.spent - 2.0) < 1e-9, `spent ${stats.spent}`);
});

test("a turn that reached a physical model is recorded (#62)", () => {
	assert.equal(isPhysicalTurn({ provider: "lmstudio", model: "prism-ml/bonsai-27b" }), true);
	assert.equal(isPhysicalTurn({ provider: "opencode-go", model: "deepseek-v4.1-flash" }), true);
});
