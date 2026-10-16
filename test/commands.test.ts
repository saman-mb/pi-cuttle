/**
 * Covers the `/cuttle doctor` and `/cuttle status` capacity reporting (#50, review nit).
 *
 * These are quiet strings a human reads once at setup, which is exactly the kind of output
 * that rots unnoticed. `classifierCapacity` is the whole computation behind the `capacity:`
 * line, so it is exercised directly rather than through the TUI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decisionStateBudget } from "../src/classifier.ts";
import { classifierCapacity } from "../src/commands.ts";
import { DEFAULTS } from "../src/config.ts";
import type { RouterRuntime } from "../src/virtual-models.ts";

/** A runtime whose host reports one model, and a batch size only when one is supplied. */
function rtWith(model: { key: string; type?: string } | undefined, batch?: number): RouterRuntime {
	return {
		config: DEFAULTS,
		host: {
			capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
			systemOne: async () => ({ answers: {} }),
			list: async () => (model ? [model] : []),
			...(batch === undefined ? {} : { physicalBatchSize: async () => batch }),
		},
	} as unknown as RouterRuntime;
}

test("classifierCapacity reports the detected batch and the trimmed budget (#50)", async () => {
	const capacity = await classifierCapacity(rtWith({ key: "m", type: "decision" }, 512), "m");
	assert.equal(capacity.isDecision, true);
	assert.equal(capacity.batch, 512, "the loaded model's real batch is reported");
	assert.equal(capacity.budget, decisionStateBudget(512));
	assert.equal(capacity.effective, decisionStateBudget(512), "the effective size is the trimmed budget");
	assert.ok(capacity.effective < DEFAULTS.classifier.stateChars, "the trim is what makes it effective");
});

test("classifierCapacity falls back to the conservative default when the model is not loaded (#50)", async () => {
	const capacity = await classifierCapacity(rtWith({ key: "m", type: "decision" }), "m");
	assert.equal(capacity.batch, undefined, "an unloaded catalog entry reports no batch");
	assert.equal(capacity.effective, decisionStateBudget(), "the conservative default governs");
});

test("classifierCapacity does not trim a chat classifier (#50)", async () => {
	const capacity = await classifierCapacity(rtWith({ key: "m", type: "llm" }, 512), "m");
	assert.equal(capacity.isDecision, false);
	assert.equal(capacity.effective, DEFAULTS.classifier.stateChars, "chat classifiers have no single-pass batch limit");
});

test("classifierCapacity reports the default when the host is unreachable (#50)", async () => {
	const rt = {
		config: DEFAULTS,
		host: {
			capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true },
			systemOne: async () => ({ answers: {} }),
			list: async () => {
				throw new Error("host down");
			},
		},
	} as unknown as RouterRuntime;
	const capacity = await classifierCapacity(rt, "m");
	assert.equal(capacity.batch, undefined);
	assert.equal(capacity.effective, DEFAULTS.classifier.stateChars, "an unknown model type is not trimmed");
});

test("classifierCapacity does not trim a decision type the host cannot serve (#50)", async () => {
	// Guards the gate against drifting from decideTier, which requires hasDecisionModels and
	// systemOne as well as the model type.
	const rt = {
		config: DEFAULTS,
		host: {
			capabilities: { canListLoaded: true, canLoadUnload: true, hasDecisionModels: false, hasModelSizes: true },
			list: async () => [{ key: "m", type: "decision" }],
		},
	} as unknown as RouterRuntime;
	const capacity = await classifierCapacity(rt, "m");
	assert.equal(capacity.isDecision, false, "the host cannot serve decision models, so nothing is trimmed");
	assert.equal(capacity.effective, DEFAULTS.classifier.stateChars);
});
