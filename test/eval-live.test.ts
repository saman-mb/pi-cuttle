import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import { buildQuestions } from "../src/classifier.ts";
import { DEFAULTS } from "../src/config.ts";
import {
	directClassifierModel,
	formatLiveReport,
	runLiveEval,
	type LiveClassifierRegistry,
} from "../eval/live.ts";
import type { EvalEntry } from "../eval/score.ts";

const model = {
	type: "classifier",
	provider: "llama.cpp",
	id: "test/decision-model:Q4",
	name: "fake decision model",
	api: "llama-cpp-classify",
	baseUrl: "http://localhost:8080/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
} as ClassifierModel<ClassifierApi>;

const entries: EvalEntry[] = [
	{ prompt: "rename this variable", label: "local" },
	{ prompt: "refactor the routing engine", label: "cloud" },
];

test("live eval wires each corpus prompt through the injected pi classifier registry", async () => {
	const config = structuredClone(DEFAULTS);
	config.classifier.stateChars = 8;
	const calls: { model: ClassifierModel<ClassifierApi>; context: ClassifierContext; options?: ModelsClassifierOptions }[] = [];
	const registry: LiveClassifierRegistry = {
		async classify(classifierModel, context, options) {
			calls.push({ model: classifierModel, context, options });
			const score = calls.length === 1 ? 0.8 : 0.2;
			return {
				api: classifierModel.api,
				provider: classifierModel.provider,
				model: classifierModel.id,
				answers: {
					complexity: {
						type: "choice",
						choice: score >= 0.5 ? "complex" : "standard",
						probabilities: { standard: 1 - score, complex: score },
						confidence: Math.max(score, 1 - score),
					},
				},
				stopReason: "stop",
				timestamp: 0,
			} satisfies ClassifierResult;
		},
	};

	const report = await runLiveEval({
		ref: "llama.cpp/test/decision-model:Q4",
		model,
		registry,
		config,
		entries,
	});

	assert.equal(calls.length, entries.length);
	assert.ok(calls.every((call) => call.model === model));
	assert.deepEqual(calls.map((call) => call.context.state), [{ prompt: "rename t" }, { prompt: "refactor" }]);
	assert.deepEqual(calls[0]?.context.questions, buildQuestions(config));
	assert.ok(calls.every((call) => call.options?.signal instanceof AbortSignal));
	assert.ok(calls.every((call) => !("temperature" in (call.options ?? {}))));
	assert.deepEqual(report.classifier.confusion, {
		localLocal: 0,
		localCloud: 1,
		cloudLocal: 1,
		cloudCloud: 0,
	});
	assert.equal(report.classifier.accuracy, 0);
	assert.equal(report.heuristic.accuracy, 1);
	const output = formatLiveReport(report);
	assert.match(output, /classifier ref: llama\.cpp\/test\/decision-model:Q4/);
	assert.match(output, /model version\/digest:/);
	assert.match(output, /heuristic baseline/);
	assert.match(output, /local -> cloud/);
	assert.match(output, /cloud -> local/);
});

test("live eval fails clearly instead of using the heuristic on a failed classifier request", async () => {
	const registry: LiveClassifierRegistry = {
		async classify(classifierModel) {
			return {
				api: classifierModel.api,
				provider: classifierModel.provider,
				model: classifierModel.id,
				answers: {},
				stopReason: "error",
				errorMessage: "fetch failed",
				timestamp: 0,
			};
		},
	};

	await assert.rejects(
		runLiveEval({
			ref: "llama.cpp/test/decision-model:Q4",
			model,
			registry,
			config: structuredClone(DEFAULTS),
			entries: [entries[0]!],
		}),
		/classifier request failed.*fetch failed.*host is reachable/,
	);
});

/**
 * The direct path exists because a `llama.cpp` classifier is registered by a runtime
 * extension, so a standalone script cannot resolve it from pi's catalog even though pi
 * itself does. If this descriptor drifts from pi's provider contract, `npm run eval --live`
 * silently measures the wrong thing.
 */
test("the direct fallback builds a descriptor pi's llama-cpp classifier accepts (#97)", () => {
	const model = directClassifierModel({ provider: "llama.cpp", id: "org/model:Q8_0" }, "http://127.0.0.1:9931/v1");
	assert.equal(model.type, "classifier");
	assert.equal(model.api, "llama-cpp-classify");
	assert.equal(model.provider, "llama.cpp");
	assert.equal(model.id, "org/model:Q8_0");
	assert.equal(model.baseUrl, "http://127.0.0.1:9931/v1");
	assert.ok(model.contextWindow > 0);
});
