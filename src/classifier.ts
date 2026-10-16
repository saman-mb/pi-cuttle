/**
 * The "which side should this turn run on" decision.
 *
 * Two paths:
 *   1. A decision model (local or cloud) answers a typed question through pi's
 *      `ctx.modelRegistry.classify()` when the configured model is a registered
 *      pi classifier, or through a direct LM Studio chat call when it is local.
 *   2. A deterministic heuristic, used as the fallback and when no model is set.
 *
 * The heuristic must never throw or block: it is what runs when LM Studio is down.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Message } from "@earendil-works/pi-ai";

import type { LocalHost } from "./host.ts";
import type { Decision, RouterConfig, Tier } from "./types.ts";

/**
 * Signals that lean local: the request names a mechanical operation on a known
 * target (rename, format, add, list, explain, ...).
 */
const MECHANICAL_HINTS =
	/^(rename|format\b|lint\b|sort\b|align\b|bump\b|update\b|change\b|move\b|extract\b|copy\b|count\b|list\b|show\b|print\b|read\b|summar\w*|explain\b|what (is|does|version|happens)|where is\b|which \w+ (is|are|file)|grep\b|find where\b|delete\b|remove\b|drop\b|add\b|fix (the )?(typo|broken|formatting|indent|markdown|link|import|missing|semicolon)|document\b|check (if|whether)\b|convert\b|replace\b|deduplicat\w*|increase\b|decrease\b|translate\b|write a test\b|use\b|version\b|tell me\b|show me\b)/i;

/**
 * Signals that need judgement: design, cross-cutting change, hard debugging,
 * trade-offs, or open-ended evaluation. Deliberately broader than before (#43):
 * the old two-regex heuristic scored 70.5% on eval/corpus.jsonl, missing every
 * cloud prompt that did not use one of five magic words.
 */
const CLOUD_HINTS =
	/\b(?<![./])(refactor\w*|architect\w*|redesign|design\w*|migrat\w*|race condition|deadlock\w*|root[- ]?cause|security|threat model|audit\b|strateg\w*|trade-?offs?|evaluat\w*|propose\b|decide\b|compare\b|review\b|investigat\w*|debug\b|diagnos\w*|profile\b|benchmark\w*|optimi[sz]\w*|performance|flaky|intermittent|why\b|how come|understand|analy[sz]\w*|spike\b|implement\b|across\b|multi-?file|plan\b|planning|consider\b|assess\b|recommend\b|choose\b|best (way|approach|strategy)|should (we|i|the)\b|safe\b|risk\w*|interaction\w*|unbounded|shard\w*|streaming|zero-?downtime|explainab\w*|reload\w*|instead of|compatib\w*|thrash\w*|vram|testable|incremental|state machine|hysteresis|plugin api|partially-loaded)\b/i;

/** Crude complexity score in [0,1]; higher means "more likely to need the big model". */
export function heuristicScore(prompt: string): { score: number; reason: string } {
	const text = prompt.trim();
	const lengthScore = Math.min(text.length / 4000, 1); // long prompts trend complex
	const mechanical = MECHANICAL_HINTS.test(text);
	const complex = CLOUD_HINTS.test(text);
	let score: number;
	let reason: string;
	if (complex && !mechanical) {
		score = 0.75 + 0.1 * lengthScore;
		reason = "cloud keyword";
	} else if (mechanical && !complex) {
		score = 0.15 + 0.1 * lengthScore;
		reason = "local keyword";
	} else if (complex && mechanical) {
		// Mixed signals: a mechanical verb wrapped around a judgement task. Lean cloud,
		// because a wrong local decision risks the work; a wrong cloud decision only costs.
		score = 0.55 + 0.1 * lengthScore;
		reason = "mixed signals";
	} else {
		score = 0.3 + 0.55 * lengthScore;
		reason = "length only";
	}
	return { score: Math.max(0, Math.min(1, score)), reason };
}

function heuristicDecision(config: RouterConfig, prompt: string): Decision {
	const { score, reason } = heuristicScore(prompt);
	const tier: Tier = score >= config.policy.threshold ? "cloud" : "local";
	return { tier, score, source: "heuristic", reason };
}

/** pi tools that mutate files: their first use flips the session into implementation (#36). */
const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Detect the session phase from conversation evidence (#36).
 *
 * `phase` used to be a constant, which made `policy.mode: "phase"` silently route
 * everything to the plan tier. The first file-mutating tool call is the signal that
 * planning ended.
 */
export function detectPhase(messages: readonly Message[]): "implementation" | undefined {
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && MUTATING_TOOLS.has(block.name)) return "implementation";
		}
	}
	return undefined;
}

/**
 * Count struggle evidence in the recent conversation (#41).
 *
 * Two signals the turn loop already delivers: tool results marked `isError`, and
 * assistant messages that ended with `stopReason: "error"`. Pure and throw-free.
 */
export function struggleSignals(messages: readonly Message[], window: number): { errors: number } {
	let errors = 0;
	for (const message of messages.slice(-Math.max(1, window))) {
		if (message.role === "toolResult" && message.isError === true) errors += 1;
		else if (message.role === "assistant" && message.stopReason === "error") errors += 1;
	}
	return { errors };
}

/** Providers whose models are served by the *local* host, so the classifier call is free. */
/** True when `provider` names a local host token, so the classifier call is free. */
export function isLocalProvider(provider: string): boolean {
	return LOCAL_PROVIDERS.has(provider);
}

const LOCAL_PROVIDERS = new Set<string>(["lmstudio", "ollama", "openai", "llama.cpp", "llamacpp", "vllm"]);

/** Parse `provider/id` where `id` may itself contain slashes (e.g. Hugging Face ids). */
export function splitRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

const CLASSIFIER_PROMPT = (prompt: string, threshold: number): string =>
	[
		"You are a routing classifier. Decide whether the software-engineering request below",
		"needs a large cloud model, or can be handled by a small local model.",
		"Answer with exactly one word: LOCAL or CLOUD.",
		`Choose CLOUD when the work needs design judgement, cross-cutting changes, or hard debugging.`,
		`Choose LOCAL for mechanical, well-scoped, or informational work.`,
		"",
		"REQUEST:",
		prompt,
	].join("\n");

function parseTier(raw: string): Tier | undefined {
	const word = raw.trim().toUpperCase();
	if (word.startsWith("CLOUD")) return "cloud";
	if (word.startsWith("LOCAL")) return "local";
	return undefined;
}

/**
 * Decide the tier for one prompt. Never throws: any failure falls back per config.
 *
 * `threshold` is only used by the heuristic and by the local classifier's numeric
 * mapping; the classifier's own answer is authoritative when it is parseable.
 */
export async function decideTier(input: {
	config: RouterConfig;
	prompt: string;
	ctx: ExtensionContext;
	host: LocalHost;
	forced?: Tier;
}): Promise<Decision> {
	const { config, prompt, ctx, host, forced } = input;
	if (forced) return { tier: forced, score: 0, source: "pin", reason: `pinned ${forced}` };
	if (config.classifier.fallback === "heuristic" && !config.classifier.model) return heuristicDecision(config, prompt);

	const ref = config.classifier.model;
	if (!ref) return heuristicDecision(config, prompt);
	const parsed = splitRef(ref);
	if (!parsed) return heuristicDecision(config, prompt);

	const clipped = prompt.slice(0, config.classifier.stateChars);
	let classifierError: string | undefined;
	try {
		let answer: string | undefined;
		if (LOCAL_PROVIDERS.has(parsed.provider)) {
			// The provider names a local host, so the decision itself costs nothing.
			const signal = AbortSignal.timeout(config.classifier.timeoutMs);
			const type = (await host.modelType?.(parsed.id)) ?? undefined;
			if (type === "decision" && host.capabilities.hasDecisionModels && host.systemOne) {
				// A Jev-style decision model: ask it a typed question over the System One API.
				const result = await host.systemOne(
					parsed.id,
					{ prompt: clipped },
					{
						complexity: {
							type: "choice",
							instructions: "How demanding is the software engineering work requested in prompt?",
							criteria: {
								standard: "Mechanical, well-scoped, or informational",
								complex: "Design judgement, cross-cutting change, or hard debugging",
							},
						},
					},
					{ signal },
				);
				const choice = result.answers.complexity;
				if (choice?.type === "choice") {
					const complex = choice.probabilities?.complex ?? (choice.choice === "complex" ? 1 : 0);
					const tier: Tier = complex >= 0.5 ? "cloud" : "local";
					return { tier, score: complex, source: "classifier", reason: `local system-one p(complex)=${complex.toFixed(2)}` };
				}
			} else {
				answer = await host.chat(parsed.id, CLASSIFIER_PROMPT(clipped, config.policy.threshold), { signal });
			}
		} else {
			const model = ctx.modelRegistry.findOfType("classifier", parsed.provider, parsed.id);
			if (!model) throw new Error(`classifier ${parsed.provider}/${parsed.id} not in catalog`);
			const result = await ctx.modelRegistry.classify(
				model,
				{
					state: { prompt: clipped },
					questions: {
						tier: {
							type: "choice",
							instructions: "Which model tier should handle the request in `prompt`?",
							criteria: { local: "Mechanical, well-scoped, or informational", cloud: "Design judgement or hard debugging" },
						},
					},
				},
				{ signal: AbortSignal.timeout(config.classifier.timeoutMs) },
			);
			const choice = result.stopReason === "stop" ? result.answers.tier : undefined;
			if (choice?.type === "choice") {
				const cloud = choice.probabilities.cloud ?? 0;
				const tier: Tier = cloud >= 0.5 ? "cloud" : "local";
				return { tier, score: cloud, source: "classifier", reason: `classifier p(cloud)=${cloud.toFixed(2)}` };
			}
		}

		const tier = answer === undefined ? undefined : parseTier(answer);
		if (tier) return { tier, score: tier === "cloud" ? 1 : 0, source: "classifier", reason: `classifier said ${tier}` };
	} catch (error) {
		classifierError = error instanceof Error ? error.message : String(error);
	}

	if (config.classifier.fallback === "heuristic") {
		const fallback = heuristicDecision(config, prompt);
		return { ...fallback, reason: `${fallback.reason} (classifier failed: ${classifierError ?? "no answer"})` };
	}
	return {
		tier: config.classifier.fallback,
		score: 0,
		source: "heuristic",
		reason: `classifier unavailable (${classifierError ?? "no answer"}), fallback ${config.classifier.fallback}`,
	};
}

/**
 * Apply `policy.mode` to the raw complexity decision (#10).
 *
 * - `complexity`: the decision stands.
 * - `cost`: biased toward local; only a strong cloud signal escapes.
 * - `phase`: the phase decides, ignoring the classifier score.
 */
export function applyPolicy(
	config: RouterConfig,
	decision: Decision,
	phase: "planning" | "implementation",
): Decision {
	if (config.policy.mode === "phase") {
		const tier: Tier = config.policy.phase[phase === "planning" ? "plan" : "implement"];
		return { tier, score: decision.score, source: decision.source, reason: `phase ${phase} -> ${tier}` };
	}
	if (config.policy.mode === "cost") {
		const bar = Math.max(config.policy.threshold, 0.75);
		const tier: Tier = (decision.score ?? 0) >= bar ? "cloud" : "local";
		return { tier, score: decision.score, source: decision.source, reason: `cost bar ${bar} (${decision.reason})` };
	}
	return decision;
}
