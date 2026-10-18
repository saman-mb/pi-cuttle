/**
 * The "which side should this turn run on" decision.
 *
 * Uses pi's model registry exclusively. When a decision model is configured in
 * `classifier.model`, it is invoked through `ctx.modelRegistry.classify()`. When the
 * classifier is absent, unavailable, or fails, a deterministic heuristic takes over.
 *
 * The heuristic must never throw or block: it is what runs when no classifier is configured.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierQuestion, Message } from "@earendil-works/pi-ai";

import { buildClassifierContext, NEW_SESSION } from "./classifier-context.ts";
import { isSubagent } from "./subagent.ts";
import type {
	ChoiceGateConfig,
	Decision,
	GateAnswer,
	GateConfig,
	GateVerdicts,
	GatesConfig,
	PairedSignalVerdicts,
	RouterConfig,
	SignalPath,
	Tier,
} from "./types.ts";

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

/** Parse `provider/id` where `id` may itself contain slashes (e.g. Hugging Face ids). */
export function splitRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

const COMPLEXITY_QUESTION: ClassifierQuestion = {
	type: "choice",
	instructions: "How demanding is the software engineering work requested in prompt?",
	criteria: {
		standard: "Mechanical, well-scoped, or informational",
		complex: "Design judgement, cross-cutting change, or hard debugging",
	},
};

function defaultChoices(kind: keyof GatesConfig): string[] {
	switch (kind) {
		case "delegate":
			return ["inline", "scout", "worker", "oracle", "driver"];
		case "role":
			return ["scout", "worker", "oracle", "driver"];
		default:
			return [];
	}
}

function choiceQuestion(cfg: ChoiceGateConfig, kind: keyof GatesConfig): ClassifierQuestion {
	const choices = cfg.choices && cfg.choices.length > 0 ? cfg.choices : defaultChoices(kind);
	return {
		type: "choice",
		instructions: `What is the most appropriate ${kind} for this turn?`,
		criteria: Object.fromEntries(choices.map((c) => [c, c])),
	};
}

function boolQuestion(instructions: string): ClassifierQuestion {
	return { type: "bool", instructions, criteria: { true: "yes", false: "no" } };
}

/** Whether any gate is configured and enabled. */
export function gatesActive(gates?: GatesConfig): boolean {
	if (!gates) return false;
	return Object.values(gates).some((g) => g?.enabled);
}

/**
 * Build the full set of classifier questions for a turn. Complexity is always asked.
 * Phase-2 gates are added when enabled. Result judge is included only when the most
 * recent message is a tool result (i.e. a subagent or tool just returned).
 */
export function buildQuestions(
	config: RouterConfig,
	messages?: readonly Message[],
): Record<string, ClassifierQuestion> {
	const questions: Record<string, ClassifierQuestion> = { complexity: COMPLEXITY_QUESTION };
	const gates = config.gates;
	if (!gates) return questions;

	if (gates.delegate?.enabled) {
		questions.delegate = boolQuestion("Should this turn be delegated to a subagent?");
		if (gates.delegate.choices && gates.delegate.choices.length > 0) {
			questions.delegate_role = choiceQuestion(gates.delegate, "delegate");
		}
	}
	if (gates.role?.enabled) {
		questions.role = choiceQuestion(gates.role, "role");
	}
	if (gates.struggle?.enabled) {
		questions.struggle = boolQuestion("Is the current request likely to cause the model to struggle?");
	}

	const last = messages?.[messages.length - 1];
	if (gates.judge?.enabled && last?.role === "toolResult") {
		questions.judge = boolQuestion("Did the most recent tool/subagent result satisfy the request?");
	}

	return questions;
}

function toGateAnswer(answer: { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number } | { type: "bool"; probability: number } | { type: "score"; score: number; confidence: number }): GateAnswer {
	if (answer.type === "choice") {
		return { type: "choice", choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
	}
	if (answer.type === "bool") {
		return { type: "bool", probability: answer.probability };
	}
	return { type: "score", score: answer.score, confidence: answer.confidence };
}

function binding(cfg: GateConfig, answer: GateAnswer): boolean {
	const threshold = cfg.threshold ?? 0.7;
	if (answer.type === "bool") return answer.probability >= threshold;
	if (answer.type === "score") return answer.score >= threshold;
	return answer.confidence >= threshold;
}

/**
 * Extract normalized gate verdicts from classifier answers. Each verdict carries whether the
 * gate is currently in shadow mode (so callers can log without acting).
 */
export function parseGateVerdicts(answers: Record<string, unknown>, gates?: GatesConfig): GateVerdicts | undefined {
	if (!gatesActive(gates)) return undefined;
	const verdicts: GateVerdicts = {};
	const gateMap = gates ?? {};

	const add = (key: keyof GateVerdicts, cfg?: GateConfig) => {
		const raw = answers[key];
		if (!cfg?.enabled || typeof raw !== "object" || raw === null) return;
		const answer = toGateAnswer(raw as GateAnswer & { type: "choice" | "bool" | "score" });
		verdicts[key] = { ...answer, shadow: cfg.shadow !== false };
	};

	add("delegate", gateMap.delegate);
	add("role", gateMap.role);
	add("struggle", gateMap.struggle);
	add("judge", gateMap.judge);

	return Object.keys(verdicts).length > 0 ? verdicts : undefined;
}

/**
 * Decide the tier for one prompt. Never throws: any failure falls back per config.
 *
 * The classifier is always invoked through pi's model registry, so it works with any
 * provider pi already knows about (llama.cpp router, cloud classifiers, etc.) without
 * hard-coding a host or protocol.
 *
 * When phase-2 gates are enabled they are asked in the same forward pass as complexity,
 * satisfying the one-pass invariant.
 */
export interface TierClassification extends Decision {
	signalPath: SignalPath;
	/** Resolves after the non-authoritative comparison completes; callers must not await it for routing. */
	shadowComparison?: Promise<PairedSignalVerdicts | undefined>;
}

function withSignalPath(decision: Decision, signalPath: SignalPath): TierClassification {
	return { ...decision, signalPath };
}

async function classifyAlternateSignal(input: {
	config: RouterConfig;
	ctx: ExtensionContext;
	parsed: { provider: string; id: string };
	prompt: string;
	messages?: readonly Message[];
	signalPath: "last-message" | "conversation";
	contextBuilder: typeof buildClassifierContext;
}): Promise<{ signalPath: "last-message" | "conversation"; tier: Tier } | undefined> {
	try {
		let prompt = input.prompt.slice(0, input.config.classifier.stateChars);
		if (input.signalPath === "conversation") {
			// Same context-validation policy as the authoritative path. If they diverged, the shadow
			// data would compare one real signal against a garbage one — and that data is what gates
			// the default flip, so a misleading comparison is worse than no comparison.
			// (#103 integration board, architect)
			if (input.prompt.length > input.config.classifier.contextBudget) return undefined;
			prompt = input.contextBuilder(input.messages ?? [], {
				budget: input.config.classifier.contextBudget,
				window: input.config.classifier.conversationWindow,
			});
			if (!prompt || prompt.trim() === NEW_SESSION) return undefined;
		}
		const model = input.ctx.modelRegistry.findOfType("classifier", input.parsed.provider, input.parsed.id);
		if (!model) return undefined;
		const result = await input.ctx.modelRegistry.classify(
			model,
			{ state: { prompt }, questions: { complexity: COMPLEXITY_QUESTION } },
			{ signal: AbortSignal.timeout(input.config.classifier.timeoutMs) },
		);
		const choice = result.stopReason === "stop" ? result.answers.complexity : undefined;
		if (choice?.type !== "choice") return undefined;
		const complex = choice.probabilities?.complex ?? (choice.choice === "complex" ? 1 : 0);
		return { signalPath: input.signalPath, tier: complex >= input.config.policy.threshold ? "cloud" : "local" };
	} catch {
		// Comparison is best-effort. It must never affect the authoritative decision.
		return undefined;
	}
}

export async function decideTier(input: {
	config: RouterConfig;
	prompt: string;
	ctx: ExtensionContext;
	messages?: readonly Message[];
	forced?: Tier;
	/** Skip the classifier and use the heuristic (e.g. during a backoff). */
	skipClassifier?: boolean;
	/** Optional router log sink; receives trim and failure lines. */
	log?: (message: string) => void;
	/** Formatter override for deterministic failure-path tests. */
	contextBuilder?: typeof buildClassifierContext;
}): Promise<TierClassification> {
	const { config, prompt, ctx, messages, forced, skipClassifier, log } = input;
	if (forced) return withSignalPath({ tier: forced, score: 0, source: "pin", reason: `pinned ${forced}` }, "off");
	if (skipClassifier) {
		const h = heuristicDecision(config, prompt);
		return withSignalPath({ ...h, source: "heuristic", reason: `${h.reason} (classifier back off)` }, "heuristic");
	}
	if (config.classifier.contextSource === "off") return withSignalPath(heuristicDecision(config, prompt), "off");
	if (config.classifier.fallback === "heuristic" && !config.classifier.model) return withSignalPath(heuristicDecision(config, prompt), "heuristic");

	const ref = config.classifier.model;
	if (!ref) return withSignalPath(heuristicDecision(config, prompt), "heuristic");
	const parsed = splitRef(ref);
	if (!parsed) return withSignalPath(heuristicDecision(config, prompt), "heuristic");

	let classifierPrompt = prompt.slice(0, config.classifier.stateChars);
	let signalPath: "last-message" | "conversation" = "last-message";
	let contextFailure: string | undefined;
	if (config.classifier.contextSource === "conversation") {
		try {
			// Never show the classifier *less* than the default path would. When the latest message alone
			// is larger than the conversation budget, the formatter can only truncate it to that budget —
			// smaller than `stateChars` — so prefer the last-message path instead. (#103 integration board)
			if (prompt.length > config.classifier.contextBudget) {
				throw new Error(
					`latest message ${prompt.length} chars exceeds contextBudget ${config.classifier.contextBudget}`,
				);
			}
			const formatted = (input.contextBuilder ?? buildClassifierContext)(messages ?? [], {
				budget: config.classifier.contextBudget,
				window: config.classifier.conversationWindow,
			});
			if (typeof formatted !== "string" || formatted.length === 0) throw new Error("formatter returned empty context");
			// The formatter is contractually non-throwing: it returns the NEW_SESSION sentinel when it
			// cannot describe the conversation (empty session, malformed data, internal error).
			// Classifying that sentinel would be worse than today's behaviour, so treat it as a failure.
			if (formatted.trim() === NEW_SESSION) throw new Error("formatter produced no usable context");
			classifierPrompt = formatted;
			signalPath = "conversation";
		} catch (error) {
			contextFailure = error instanceof Error ? error.message : String(error);
			log?.(`classifier context: ${contextFailure}; falling back to last-message`);
		}
	}
	let classifierError: string | undefined;
	try {
		const model = ctx.modelRegistry.findOfType("classifier", parsed.provider, parsed.id);
		if (!model) throw new Error(`classifier ${parsed.provider}/${parsed.id} not in pi's catalog`);
		const questions = buildQuestions(config, messages);
		const result = await ctx.modelRegistry.classify(
			model,
			{
				state: { prompt: classifierPrompt },
				questions,
			},
			{ signal: AbortSignal.timeout(config.classifier.timeoutMs) },
		);
		const answers = result.stopReason === "stop" ? result.answers : {};
		const choice = answers.complexity;
		if (choice?.type === "choice") {
			const complex = choice.probabilities?.complex ?? (choice.choice === "complex" ? 1 : 0);
			const threshold = config.policy.threshold;
			const tier: Tier = complex >= threshold ? "cloud" : "local";
			const gates = parseGateVerdicts(answers, config.gates);
			const gateSummary = gates ? ` gates=${formatGateSummary(gates)}` : "";
			const decision = withSignalPath({
				tier,
				score: complex,
				source: "classifier",
				reason: `classifier p(complex)=${complex.toFixed(2)}${gateSummary}${contextFailure ? ` (context formatter failed: ${contextFailure})` : ""}`,
				// A context-path fallback is NOT a classifier failure: the classifier answered fine, we
				// just showed it a different signal. Reporting it as one would let repeated fallbacks
				// (e.g. an oversized message) trip the classifier backoff and skip the classifier for
				// a session that was never actually failing. (#103 integration board nit)

				gates,
			}, signalPath);
			if (config.classifier.contextShadow && (signalPath === "last-message" || signalPath === "conversation")) {
				const alternatePath = signalPath === "last-message" ? "conversation" : "last-message";
				decision.shadowComparison = Promise.resolve()
					.then(() => classifyAlternateSignal({
						config,
						ctx,
						parsed,
						prompt,
						messages,
						signalPath: alternatePath,
						contextBuilder: input.contextBuilder ?? buildClassifierContext,
					}))
					.then((alternate) => alternate ? {
						authoritative: { signalPath, tier },
						alternate,
						agree: tier === alternate.tier,
					} : undefined);
			}
			return decision;
		}
		throw new Error("classifier returned no parseable complexity answer");
	} catch (error) {
		classifierError = error instanceof Error ? error.message : String(error);
		if (contextFailure) classifierError = `context formatter failed: ${contextFailure}; classifier: ${classifierError}`;
		log?.(`classifier: ${classifierError}`);
	}

	// Carry the failure on the decision so the runtime can surface it without the
	// caller having to parse the reason string.
	const failure = { ref, message: classifierError ?? "no answer" };
	if (config.classifier.fallback === "heuristic") {
		const fallback = heuristicDecision(config, prompt);
		return withSignalPath({
			...fallback,
			classifierFailure: failure,
			reason: `${fallback.reason} (classifier failed: ${failure.message})`,
		}, "heuristic");
	}
	return withSignalPath({
		tier: config.classifier.fallback,
		score: 0,
		source: "heuristic",
		classifierFailure: failure,
		reason: `classifier unavailable (${failure.message}), fallback ${config.classifier.fallback}`,
	}, "heuristic");
}

function formatGateSummary(gates: GateVerdicts): string {
	return Object.entries(gates)
		.map(([key, v]) => {
			if (v.type === "choice") return `${key}:${v.choice}${v.shadow ? "(shadow)" : ""}`;
			if (v.type === "bool") return `${key}:p=${v.probability.toFixed(2)}${v.shadow ? "(shadow)" : ""}`;
			return `${key}:s=${v.score.toFixed(2)}${v.shadow ? "(shadow)" : ""}`;
		})
		.join(",");
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
	// Apply subagent policy override if running in a subagent.
	const effectivePolicy = isSubagent() && config.policy.subagent ? { ...config.policy, ...config.policy.subagent } : config.policy;
	const effectiveThreshold = effectivePolicy.threshold ?? config.policy.threshold;
	const localBias = effectivePolicy.localBias ?? 0;
	const adjustedThreshold = Math.min(1, effectiveThreshold + localBias);

	if (effectivePolicy.mode === "phase") {
		const tier: Tier = effectivePolicy.phase[phase === "planning" ? "plan" : "implement"];
		return { tier, score: decision.score, source: decision.source, reason: `phase ${phase} -> ${tier}` };
	}
	if (effectivePolicy.mode === "cost") {
		const bar = Math.max(adjustedThreshold, 0.75);
		const tier: Tier = (decision.score ?? 0) >= bar ? "cloud" : "local";
		return { tier, score: decision.score, source: decision.source, reason: `cost bar ${bar} (${decision.reason})` };
	}
	// complexity mode: apply localBias to threshold
	const tier: Tier = (decision.score ?? 0) >= adjustedThreshold ? "cloud" : "local";
	return { tier, score: decision.score, source: decision.source, reason: `complexity bar ${adjustedThreshold} (${decision.reason})` };
}

export { binding };
