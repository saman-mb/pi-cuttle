/**
 * Live Layer 2 evaluation through pi's classifier registry.
 *
 * This intentionally uses ModelRegistry.classify() so pi-ai selects and renders the
 * configured provider's real classifier protocol; no provider HTTP prompt is recreated here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ModelsClassifierOptions,
} from "@earendil-works/pi-ai";

import { buildQuestions, heuristicScore, splitRef } from "../src/classifier.ts";
import { DEFAULTS, loadConfig } from "../src/config.ts";
import type { RouterConfig, Tier } from "../src/types.ts";
import { formatResult, parseCorpus, scoreCorpus } from "./score.ts";
import type { EvalEntry, EvalResult } from "./score.ts";

export interface LiveClassifierRegistry {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface LiveEvalOptions {
	ref: string;
	model: ClassifierModel<ClassifierApi>;
	registry: LiveClassifierRegistry;
	config: RouterConfig;
	entries?: readonly EvalEntry[];
}

export interface LiveEvalReport {
	ref: string;
	model: ClassifierModel<ClassifierApi>;
	classifier: EvalResult;
	heuristic: EvalResult;
}

function clean(value: string): string {
	return value.replace(/[\r\n\t]/g, " ");
}

function classifierVersionDigest(model: ClassifierModel<ClassifierApi>): string {
	// ClassifierModel in pi-ai has no first-class version/digest fields. Some providers
	// may attach those metadata fields; report them when present, otherwise be explicit.
	const metadata = model as ClassifierModel<ClassifierApi> & {
		version?: unknown;
		digest?: unknown;
		sha256?: unknown;
	};
	const version = typeof metadata.version === "string" ? clean(metadata.version) : "not exposed by pi catalog";
	const digest =
		typeof metadata.digest === "string"
			? clean(metadata.digest)
			: typeof metadata.sha256 === "string"
				? clean(metadata.sha256)
				: "not exposed by pi catalog";
	return `version=${version}; digest=${digest}`;
}

function complexityDecision(result: ClassifierResult, ref: string, threshold: number): { tier: Tier; score: number } {
	if (result.stopReason !== "stop") {
		const details = result.errorMessage ? `: ${clean(result.errorMessage)}` : ` (stopReason=${result.stopReason})`;
		throw new Error(
			`classifier request failed for ${ref}${details}; check that the classifier host is reachable and its credentials/provider configuration are valid`,
		);
	}
	const answer = result.answers.complexity;
	if (answer?.type !== "choice") {
		throw new Error(`classifier ${ref} returned no parseable complexity choice`);
	}
	const score = answer.probabilities?.complex ?? (answer.choice === "complex" ? 1 : 0);
	if (!Number.isFinite(score)) throw new Error(`classifier ${ref} returned an invalid complexity probability`);
	return { tier: score >= threshold ? "cloud" : "local", score };
}

/** Evaluate sequentially so local classifier hosts are not flooded by corpus concurrency. */
export async function runLiveEval(options: LiveEvalOptions): Promise<LiveEvalReport> {
	const { ref, model, registry, config } = options;
	const entries = options.entries ?? parseCorpus(readFileSync(new URL("./corpus.jsonl", import.meta.url), "utf8"));
	const parsedRef = splitRef(ref);
	if (!parsedRef) throw new Error(`invalid classifier ref ${ref}; expected provider/model`);
	if (model.provider !== parsedRef.provider || model.id !== parsedRef.id) {
		throw new Error(`resolved classifier ${model.provider}/${model.id} does not match configured ref ${ref}`);
	}

	const timeoutMs = Number.isFinite(config.classifier.timeoutMs) && config.classifier.timeoutMs > 0
		? config.classifier.timeoutMs
		: DEFAULTS.classifier.timeoutMs;
	const stateChars = Number.isFinite(config.classifier.stateChars) && config.classifier.stateChars >= 0
		? config.classifier.stateChars
		: DEFAULTS.classifier.stateChars;
	const threshold = Number.isFinite(config.policy.threshold) ? config.policy.threshold : DEFAULTS.policy.threshold;
	const questions = buildQuestions(config);
	const decisions = new Map<string, { tier: Tier; score: number }>();

	for (const entry of entries) {
		if (decisions.has(entry.prompt)) throw new Error(`duplicate prompt in live eval corpus: ${entry.prompt}`);
		let result: ClassifierResult;
		try {
			result = await registry.classify(
				model,
				{ state: { prompt: entry.prompt.slice(0, stateChars) }, questions },
				// pi's classifier temperature is a softmax divisor over label log-probabilities,
				// not sampling temperature. Omit it: zero is invalid and inference is deterministic.
				{ signal: AbortSignal.timeout(timeoutMs) },
			);
		} catch (error) {
			const detail = error instanceof Error ? clean(error.message) : clean(String(error));
			throw new Error(
				`classifier request failed for ${ref}: ${detail}; check that the classifier host is reachable and its credentials/provider configuration are valid`,
			);
		}
		decisions.set(entry.prompt, complexityDecision(result, ref, threshold));
	}

	const classifier = scoreCorpus(entries, (prompt) => {
		const decision = decisions.get(prompt);
		if (!decision) throw new Error("classifier result missing for corpus prompt");
		return decision;
	});
	const heuristic = scoreCorpus(entries, (prompt) => {
		const { score } = heuristicScore(prompt);
		return { tier: score >= threshold ? "cloud" : "local", score };
	});
	return { ref, model, classifier, heuristic };
}

export function formatLiveReport(report: LiveEvalReport): string {
	return [
		"Layer 2 — live pi classifier",
		`classifier ref: ${clean(report.ref)}`,
		`pi registry model: ${clean(report.model.provider)}/${clean(report.model.id)} (api=${clean(report.model.api)})`,
		`model version/digest: ${classifierVersionDigest(report.model)}`,
		"classifier result:",
		formatResult(report.classifier),
		"heuristic baseline (same corpus and policy threshold):",
		formatResult(report.heuristic),
	].join("\n");
}

/** Construct pi's runtime from the same user auth/models files used by pi itself. */
export async function runLiveEvalCli(): Promise<void> {
	try {
		const { config } = loadConfig(process.cwd());
		const ref = config.classifier.model;
		if (!ref) {
			throw new Error("no classifier is configured; set classifier.model in pi-cuttle.json before running the live eval");
		}
		const parsedRef = splitRef(ref);
		if (!parsedRef) throw new Error(`invalid classifier ref ${ref}; expected provider/model`);

		const agentDir = getAgentDir();
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		const registry = new ModelRegistry(runtime);
		const model = registry.findOfType("classifier", parsedRef.provider, parsedRef.id);
		if (!model) {
			throw new Error(
				`classifier ${ref} is not in pi's classifier catalog; add it to pi's models.json or use a classifier listed by pi`,
			);
		}

		const report = await runLiveEval({ ref, model, registry, config });
		console.log(formatLiveReport(report));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Live classifier eval failed: ${message}`);
		process.exitCode = 1;
	}
}
