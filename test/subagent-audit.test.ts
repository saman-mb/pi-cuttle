/**
 * Tests for the subagent launch audit (#130).
 *
 * The shapes here are taken from real `*_meta.json` artifacts, so the classifier is pinned against
 * the evidence rather than an invented schema.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLocalOnlyFlavor } from "../src/virtual-models.ts";
import {
	LOCAL_ONLY_FLAVORS,
	auditRun,
	classifyChild,
	flavorOf,
	isLocalRef,
	isVirtualRef,
	pickActiveModel,
	summarize,
	type ModelChange,
	type SubagentRunMeta,
} from "../src/subagent-audit.ts";

const LOCAL_CATALOG = ["mtplx/mtplx-flash-next-optimized-speed", "lmstudio/prism-ml/bonsai-27b"];

describe("LOCAL_ONLY_FLAVORS", () => {
	it("agrees with isLocalOnlyFlavor for every flavor, so the copy cannot drift", () => {
		for (const flavor of ["auto", "local", "fast-local", "big-local", "orchestrator", "cloud"] as const) {
			assert.equal(
				(LOCAL_ONLY_FLAVORS as readonly string[]).includes(flavor),
				isLocalOnlyFlavor(flavor),
				`mismatch for flavor ${flavor}`,
			);
		}
	});
});

describe("isVirtualRef / flavorOf", () => {
	it("recognises router refs and extracts the flavor", () => {
		assert.equal(isVirtualRef("cuttle/local"), true);
		assert.equal(isVirtualRef("cuttle/local:high"), true);
		assert.equal(flavorOf("cuttle/fast-local:medium"), "fast-local");
	});

	it("does not treat a physical model as a router ref", () => {
		assert.equal(isVirtualRef("xai/grok-4.7:high"), false);
		assert.equal(flavorOf("opencode-go/gpt-6-luna"), undefined);
	});
});

describe("isLocalRef", () => {
	it("accepts a catalog model with a thinking suffix", () => {
		assert.equal(isLocalRef("mtplx/mtplx-flash-next-optimized-speed:high", LOCAL_CATALOG), true);
	});

	it("accepts a catalog model whose id already contains a colon", () => {
		assert.equal(isLocalRef("ggml-org/Kev-9B-GGUF:Q8_0:high", ["ggml-org/Kev-9B-GGUF:Q8_0"]), true);
	});

	it("rejects a cloud model and a near-miss prefix", () => {
		assert.equal(isLocalRef("xai/grok-4.7:high", LOCAL_CATALOG), false);
		assert.equal(isLocalRef("mtplx/mtplx-flash-next-optimized-speed-extra", LOCAL_CATALOG), false);
	});
});

describe("classifyChild", () => {
	it("calls an explicit non-router launch a per-run override", () => {
		// Real artifact: agent 'architect', parent on cuttle/local, child on grok.
		assert.equal(
			classifyChild({ agent: "architect", model: "xai/grok-4.7:high", requestedModel: "xai/grok-4.7:high" }),
			"bypass-override",
		);
	});

	it("calls a non-router model with no request an inheritance", () => {
		assert.equal(classifyChild({ model: "opencode-go/qwen3.8-max:high" }), "bypass-inherited");
	});

	it("calls a cuttle/* child that could not resolve a crash", () => {
		// Real artifact: agent 'senior-engineer', inherited cuttle/local:medium.
		assert.equal(
			classifyChild({
				model: "cuttle/local:medium",
				error: 'Model "cuttle/local:medium" not found. Use --list-models to see available models.',
			}),
			"crash",
		);
	});

	it("calls a resolvable cuttle/* child routed", () => {
		assert.equal(classifyChild({ model: "cuttle/local:high", requestedModel: "cuttle/local" }), "routed");
	});
});

describe("pickActiveModel", () => {
	const changes: ModelChange[] = [
		{ timestamp: "2026-10-18T21:30:18.764Z", provider: "cuttle", modelId: "auto" },
		{ timestamp: "2026-10-18T21:38:11.316Z", provider: "cuttle", modelId: "local" },
	];

	it("returns the model active at a later time", () => {
		const active = pickActiveModel(changes, new Date("2026-10-18T23:00:00Z"));
		assert.equal(`${active?.provider}/${active?.modelId}`, "cuttle/local");
	});

	it("returns nothing before the first change", () => {
		assert.equal(pickActiveModel(changes, new Date("2026-10-18T20:00:00Z")), undefined);
	});
});

describe("auditRun", () => {
	it("flags a local-only parent whose child reached the cloud", () => {
		const run = auditRun(
			{ agent: "architect", model: "xai/grok-4.7:high", requestedModel: "xai/grok-4.7:high" },
			"cuttle/local",
			LOCAL_CATALOG,
		);
		assert.equal(run.parentLocalOnly, true);
		assert.equal(run.childLocal, false);
		assert.equal(run.violation, true);
		assert.match(run.detail, /explicitly launched on xai\/grok-4\.7:high/);
	});

	it("does not flag the same child when the parent was on auto", () => {
		const run = auditRun({ model: "xai/grok-4.7:high" }, "cuttle/auto", LOCAL_CATALOG);
		assert.equal(run.parentLocalOnly, false);
		assert.equal(run.violation, false, "auto is allowed to reach cloud");
	});

	it("does not flag a local child under a local-only parent", () => {
		const run = auditRun(
			{ model: "mtplx/mtplx-flash-next-optimized-speed:high" },
			"cuttle/local",
			LOCAL_CATALOG,
		);
		assert.equal(run.childLocal, true);
		assert.equal(run.violation, false);
	});

	it("separates a crash under a local-only parent from a leak", () => {
		const run = auditRun(
			{ model: "cuttle/local:high", error: 'Model "cuttle/local:high" not found.' },
			"cuttle/local",
			LOCAL_CATALOG,
		);
		assert.equal(run.verdict, "crash");
		assert.equal(run.violation, false, "a crash is #131, not a cloud leak");
		assert.equal(run.crashUnderLocalOnly, true);
	});
});

describe("summarize", () => {
	it("names the per-run override as the cause", () => {
		const runs = [
			auditRun({ model: "xai/grok-4.7:high", requestedModel: "xai/grok-4.7:high" }, "cuttle/local", LOCAL_CATALOG),
			auditRun({ model: "cuttle/local:high", error: "not found" }, "cuttle/local", LOCAL_CATALOG),
		];
		const summary = summarize(runs);
		assert.equal(summary.total, 2);
		assert.equal(summary.violations.length, 1);
		assert.equal(summary.crashesUnderLocalOnly.length, 1);
		assert.match(summary.cause, /per-run override/);
	});

	it("reports no cause when there is nothing to audit", () => {
		assert.match(summarize([]).cause, /no runs found/);
	});
});
