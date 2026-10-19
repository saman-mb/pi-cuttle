/**
 * The family of virtual models.
 *
 * Rather than guessing a child's role from its prompt, we register one virtual
 * model per policy and let pi's native per-role model config choose between them
 * (`subagents.agentOverrides.<role>.model`). `cuttle/auto` is the global default.
 *
 * pi stores returned router state on the session branch, so it follows forks and
 * survives compaction.
 *
 * Design constraints proven by the verification spikes (see docs/ARCHITECTURE.md):
 *   - #24: `session_start` + `setModel` is how "by default" is delivered; `defaultModel`
 *          does not resolve a virtual model. Handled in src/index.ts.
 *   - #25: `message_end` fires once per assistant message, so slot release is exact enough.
 *   - #26: extension flags are only readable after the factory returns, so the forced tier
 *          is read lazily via `rt.getForced`.
 */
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import { applyPolicy, decideTier, detectPhase, gatesActive, splitRef, struggleSignals } from "./classifier.ts";
import { appendShadow } from "./shadow.ts";
import { isSubagent } from "./subagent.ts";
import { LangFuseClient } from "./langfuse.ts";
import { decisionScores } from "./scores.ts";
import {
	applyContextPressure,
	applyUserCeiling,
	clampToSupportedLevel,
	scoreToThinkingLevel,
} from "./thinking-levels.ts";
import type { LocalGovernor } from "./governor.ts";
import type {ClassifierFailure, Reservation, RouterConfig, RouterFlavor, RouterState, Tier, SignalPath} from "./types.ts";
import { VIRTUAL_PROVIDER } from "./types.ts";

export interface RouterRuntime {
	config: RouterConfig;
	governor: LocalGovernor;
	/** Session-scoped pins set by `/cuttle local|cloud|auto` (legacy; replaced by on/off toggle). */
	pins: Map<string, Tier>;
	/** Per-session model to restore when `/cuttle off` disables routing. */
	previousModels: Map<string, string>;
	/** Invocation-wide override from `--cuttle-force`, read lazily (#26). */
	getForced?: () => Tier | undefined;
	/** Optional debug logger (set from `PI_CUTTLE_DEBUG`). */
	log?: (message: string) => void;
	/** Most recent classifier failure, for `/cuttle status` (#53). */
	lastClassifierError?: ClassifierFailure;
	/** Most recent routing decision, for `/cuttle why`. */
	lastDecision?: {
		flavor: RouterFlavor;
		tier: Tier;
		ref: string;
		thinkingLevel: string;
		reason: string;
		source: string;
		/** Which signal the classifier was given (#108). Absent when no classifier ran. */
		signalPath?: SignalPath;
		score?: number;
		subagent: boolean;
		at: number;
	};
	/** Consecutive classifier failures in this process. */
	classifierFailures: number;
	/** Unix ms after which the classifier can be tried again. */
	classifierBackoffUntil: number;
	/** Optional LangFuse client for observability (#88). */
	langfuse?: LangFuseClient;
}

type RouterRequest = ModelRouteRequest<RouterState>;

/** 1-based index of the user turn a request belongs to (count of user messages). */
export function userTurn(messages: readonly Message[]): number {
	return messages.filter((message) => message.role === "user").length;
}

/** Extract the latest user text from the conversation. */
export function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function modelContextWindow(ctx: ExtensionContext, ref: string): number {
	const parsed = splitRef(ref);
	if (!parsed) return 0;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	return model?.contextWindow ?? 0;
}

function capacityScore(ctx: ExtensionContext, ref: string, pool: readonly string[], capabilities?: Record<string, number>): number {
	if (capabilities?.[ref] !== undefined) return capabilities[ref];
	const window = modelContextWindow(ctx, ref);
	if (window <= 0) return 0;
	const windows = pool.map((r) => modelContextWindow(ctx, r)).filter((w) => w > 0);
	if (windows.length === 0) return 0.5;
	const max = Math.max(...windows);
	return window / max;
}

function costOf(ctx: ExtensionContext, ref: string): number {
	const parsed = splitRef(ref);
	if (!parsed) return Number.POSITIVE_INFINITY;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model?.cost) return Number.POSITIVE_INFINITY;
	return model.cost.input + model.cost.output;
}

/** Pick a local candidate. `fast-local` orders by configured capability; otherwise the smallest model that can handle `score` is chosen. */
export function pickLocal(config: RouterConfig, ctx: ExtensionContext, flavor?: RouterFlavor, score = 0): string | undefined {
	return localCandidates(config, ctx, flavor, score)[0];
}

export function pickCloud(config: RouterConfig, ctx: ExtensionContext, score = 0): string | undefined {
	return cloudCandidates(config, ctx, score)[0];
}

/** Ordered local candidates; `fast-local` sorts by configured capability, otherwise by complexity capacity. */
export function localCandidates(config: RouterConfig, ctx: ExtensionContext, flavor?: RouterFlavor, score = 0): string[] {
	const list = [...config.catalog.local];
	const caps = config.capabilities;
	if (flavor === "fast-local") {
		list.sort((a, b) => {
			const ca = caps?.[a] ?? Number.POSITIVE_INFINITY;
			const cb = caps?.[b] ?? Number.POSITIVE_INFINITY;
			if (ca === cb) return 0;
			return ca - cb;
		});
	} else if (flavor === "big-local") {
		// Largest model first — for orchestration work that benefits from capacity.
		list.sort((a, b) => {
			const ca = caps?.[a] ?? 0;
			const cb = caps?.[b] ?? 0;
			if (ca === cb) return 0;
			return cb - ca;
		});
	} else if (score > 0 && list.length > 1) {
		list.sort((a, b) => {
			const ca = capacityScore(ctx, a, list, caps);
			const cb = capacityScore(ctx, b, list, caps);
			const aFits = ca >= score;
			const bFits = cb >= score;
			if (aFits && !bFits) return -1;
			if (!aFits && bFits) return 1;
			return ca - cb;
		});
	}
	return list;
}

export function cloudCandidates(config: RouterConfig, ctx: ExtensionContext, score = 0): string[] {
	const list = [...config.catalog.cloud];
	const caps = config.capabilities;
	if (score > 0 && list.length > 1) {
		list.sort((a, b) => {
			const ca = capacityScore(ctx, a, list, caps);
			const cb = capacityScore(ctx, b, list, caps);
			const aFits = ca >= score;
			const bFits = cb >= score;
			if (aFits && !bFits) return -1;
			if (!aFits && bFits) return 1;
			// Among models that fit the work, prefer the cheapest; window ratio breaks ties.
			return costOf(ctx, a) - costOf(ctx, b) || ca - cb;
		});
	}
	return list;
}

/** First ref in `candidates` that the model registry can actually resolve (#45). */
export function firstResolvable(ctx: ExtensionContext, candidates: readonly string[]): string | undefined {
	for (const ref of candidates) {
		const parsed = splitRef(ref);
		if (!parsed) continue;
		if (ctx.modelRegistry.find(parsed.provider, parsed.id)) return ref;
	}
	return undefined;
}

function flavorBias(flavor: RouterFlavor): Tier | undefined {
	if (flavor === "local" || flavor === "fast-local" || flavor === "big-local" || flavor === "orchestrator") return "local";
	if (flavor === "cloud") return "cloud";
	return undefined;
}

/** Flavors that promise never to route a request to a cloud model. */
export function isLocalOnlyFlavor(flavor: RouterFlavor): boolean {
	return flavor === "local" || flavor === "fast-local" || flavor === "big-local";
}

function missingLocalModelCause(refs: readonly string[]): string {
	return `local model not in pi's catalog: ${refs.length > 0 ? refs.join(", ") : "no refs configured"} (check catalog.local)`;
}

function throwLocalOnlyUnavailable(flavor: RouterFlavor, causes: readonly string[]): never {
	const cause = causes.length > 0 ? causes.join("; ") : missingLocalModelCause([]);
	const remedies = new Set<string>();
	for (const item of causes) {
		if (item === "local full") remedies.add("raise local.maxConcurrent (or the per-model/per-flavor caps)");
		else if (item === "context exceeds local window") remedies.add("use a local model with a larger context window");
		else if (item.startsWith("local model not in pi's catalog:")) remedies.add("add or fix a resolvable catalog.local entry");
		else if (item.startsWith("local provider failure:")) remedies.add("repair local availability");
	}
	if (remedies.size === 0) remedies.add("repair local availability");
	throw new Error(`pi-cuttle: cuttle/${flavor} is local-only; local model unavailable: ${cause}. Fix: ${[...remedies].join("; ")}. To permit cloud routing, select cuttle/auto.`);
}

/** True when a failed request looks like the local side fell over. */
export function looksLikeLocalFailure(localProviders: readonly string[], provider: string, errorMessage: string | undefined): boolean {
	if (localProviders.includes(provider)) return true;
	return /out of memory|\boom\b|exceed|overload|timed? ?out|ECONNREFUSED|context_length_exceeded/i.test(errorMessage ?? "");
}

function resolveModel(
	ctx: ExtensionContext,
	ref: string | undefined,
	thinkingLevel: RouterRequest["thinkingLevel"],
	state: RouterState,
): ModelRoute<RouterState> {
	if (!ref) throw new Error("pi-cuttle: no model configured for the chosen tier (set catalog.local/cloud)");
	const parsed = splitRef(ref);
	if (!parsed) throw new Error(`pi-cuttle: invalid model ref '${ref}'`);
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) throw new Error(`pi-cuttle: model '${ref}' is not in the catalog`);
	return { model, thinkingLevel, state };
}

/**
 * Reserve a local slot for the turn, or return a reason to spill to cloud.
 * Context guard (#15), then the cross-process slot cap (#13/#14/#16).
 */
async function ensureLocalSlot(
	rt: RouterRuntime,
	ctx: ExtensionContext,
	flavor: RouterFlavor,
	sessionId: string,
	score = 0,
	localOnly = false,
): Promise<{ spill?: string; causes?: string[]; reservation?: Reservation; ref?: string }> {
	const candidates = localCandidates(rt.config, ctx, flavor, score);
	if (candidates.length === 0) {
		return localOnly ? { causes: [missingLocalModelCause(candidates)] } : { spill: "no local model configured" };
	}
	const unresolvable: string[] = [];
	let sawContextOverflow = false;
	let sawCapacity = false;
	for (const ref of candidates) {
		const parsed = splitRef(ref);
		if (!parsed) {
			unresolvable.push(ref);
			continue;
		}
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) {
			unresolvable.push(ref);
			continue;
		}
		if (!fitsWindow(ctx, model.contextWindow ?? 0)) {
			sawContextOverflow = true;
			continue;
		}
		// Slots are keyed by bare model id to match assistant message attribution.
		const reservation = await rt.governor.acquire(parsed.id, {
			sessionId,
			flavor,
			...(rt.config.local.onFull === "wait" ? { waitMs: rt.config.local.waitMs } : {}),
		});
		if (reservation) return { reservation, ref };
		sawCapacity = true;
	}
	const reasons: string[] = [];
	if (unresolvable.length > 0) {
		reasons.push(`local model not in pi's catalog: ${unresolvable.join(", ")} (check catalog.local)`);
	}
	if (sawContextOverflow) reasons.push("context exceeds local window");
	if (sawCapacity) reasons.push("local full");
	if (localOnly) {
		return { causes: reasons.length > 0 ? reasons : [missingLocalModelCause(candidates)] };
	}
	return { spill: reasons.length > 0 ? `${reasons.join("; ")}, spilled to cloud` : "spilled to cloud" };
}

/** Can the whole conversation fit a model's window? (#15) */
function fitsWindow(ctx: ExtensionContext, window: number): boolean {
	if (window <= 0) return true;
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return true;
	return usage.tokens < window * 0.9;
}

export async function routeRequest(
	rt: RouterRuntime,
	flavor: RouterFlavor,
	request: RouterRequest,
	ctx: ExtensionContext,
): Promise<ModelRoute<RouterState>> {
	const sessionId = ctx.sessionManager.getSessionId();
	const state = request.state;
	const phase = state?.phase ?? detectPhase(request.messages) ?? "planning";
	const localOnly = isLocalOnlyFlavor(flavor);

	// Compute effective thinking level. If state has a clamped level from a prior turn,
	// reuse it for continuity; otherwise compute fresh from the user's selection.
	let effectiveThinking: ModelThinkingLevel = request.thinkingLevel ?? "medium";
	if (state?.thinkingLevel) {
		effectiveThinking = state.thinkingLevel;
	}

	// Requests outside the agent loop (e.g. compaction summaries) use the deterministic tier.
	// Direct requests deliberately skip the governor and the context guard: pi routes them
	// through `modelRegistry.streamSimple()` (docs/virtual-models.md: "direct" = compaction
	// summary or an extension calling streamSimple) and there is no completion hook to release
	// a held slot — holding one would block every later local request until stale reaping.
	// Compaction is also the safety valve that *reduces* context, so gating it on the local
	// window would reject the request that fixes the overflow. The local-only guarantee still
	// holds; only capacity/context gating is skipped (pre-existing behaviour, see #119).
	if (request.reason === "direct") {
		const tier = flavorBias(flavor) ?? "cloud";
		const localRefs = tier === "local" ? localCandidates(rt.config, ctx, flavor) : [];
		let ref: string | undefined;
		if (tier === "local") {
			ref = localOnly ? firstResolvable(ctx, localRefs) : pickLocal(rt.config, ctx, flavor);
		} else {
			ref = pickCloud(rt.config, ctx);
		}
		if (localOnly && !ref) throwLocalOnlyUnavailable(flavor, [missingLocalModelCause(localRefs)]);
		const next: RouterState = localOnly
			? {
				tier: "local",
				modelId: ref ?? "",
				phase,
				...(state?.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
				decision: state?.decision ?? { source: "pin", reason: "direct request" },
			}
			: state ?? { tier, modelId: ref ?? "", phase, decision: { source: "pin", reason: "direct request" } };
		return resolveModel(ctx, ref, effectiveThinking, next);
	}

	// #11: a retry may switch models. Local failures and overflow-style errors go to cloud.
	if (request.reason === "retry" && request.failed) {
		const failed = request.failed;
		if (localOnly) {
			rt.governor.releaseOne(failed.model.id);
			const errorMessage = failed.message.errorMessage ?? "unknown error";
			throwLocalOnlyUnavailable(flavor, [`local provider failure: ${failed.model.provider} (${errorMessage})`]);
		}
		const cloudRef = firstResolvable(ctx, cloudCandidates(rt.config, ctx));
		if (cloudRef && looksLikeLocalFailure(rt.config.local.providers, failed.model.provider, failed.message.errorMessage)) {
			rt.governor.releaseOne(failed.model.id);
			const next: RouterState = {
				tier: "cloud",
				modelId: cloudRef,
				phase,
				decision: { source: "heuristic", reason: `retry: ${failed.model.provider} failure, switched to cloud` },
				degradedFrom: "local",
			};
			return resolveModel(ctx, cloudRef, effectiveThinking, next);
		}
		const sameRef = `${failed.model.provider}/${failed.model.id}`;
		const next: RouterState =
			state ?? { tier: "cloud", modelId: sameRef, phase, decision: { source: "heuristic", reason: "retry on same model" } };
		return resolveModel(ctx, sameRef, effectiveThinking, next);
	}

	// #37: a session degraded by a local failure re-decides on the next user turn.
	const recovering = state?.degradedFrom !== undefined && request.reason === "user";
	// #41: struggle-based escalation.
	const escalateCfg = rt.config.policy.escalate;
	const signals = escalateCfg?.enabled ? struggleSignals(request.messages, escalateCfg.window) : { errors: 0 };
	const cleanStreak = (state?.cleanTurns ?? 0) + (request.reason === "user" && signals.errors === 0 ? 1 : 0);
	const deescalating =
		escalateCfg?.enabled === true &&
		state?.escalatedFrom !== undefined &&
		request.reason === "user" &&
		signals.errors === 0 &&
		cleanStreak >= escalateCfg.cleanTurns;
	const reclassify = (rt.config.policy.reclassify === "turn" || recovering || deescalating) && request.reason === "user";
	if (state && !reclassify) {
		if (!localOnly && escalateCfg?.enabled && state.tier === "local" && signals.errors >= escalateCfg.toolErrors) {
			const cloudRef = firstResolvable(ctx, cloudCandidates(rt.config, ctx));
			if (cloudRef) {
					rt.governor.releaseOne(splitRef(state.modelId)?.id ?? "");
				rt.log?.(`route escalate local->cloud errors=${signals.errors} window=${escalateCfg.window}`);
				const next: RouterState = {
					tier: "cloud",
					modelId: cloudRef,
					phase: state.phase,
					decision: {
						...state.decision,
						reason: `escalated local->cloud: ${signals.errors} error(s) in last ${escalateCfg.window} messages`,
					},
					escalatedFrom: "local",
					cleanTurns: 0,
				};
				return resolveModel(ctx, cloudRef, effectiveThinking, next);
			}
		}

		if (!localOnly && state.tier === "cloud" && state.escalatedFrom && request.reason === "user") {
			const nextClean = signals.errors === 0 ? cleanStreak : 0;
			if (nextClean !== (state.cleanTurns ?? 0)) {
				const next: RouterState = { ...state, cleanTurns: nextClean };
				return resolveModel(ctx, firstResolvable(ctx, cloudCandidates(rt.config, ctx)), effectiveThinking, next);
			}
		}

		if (state.phase === "planning") {
			const detected = detectPhase(request.messages);
			if (detected) {
				const flipped = applyPolicy(
					rt.config,
					{ tier: state.tier, score: state.decision.score ?? 0, source: state.decision.source, reason: state.decision.reason },
					detected,
				);
				let tier = localOnly ? "local" : flipped.tier;
				const reason = `${flipped.reason}; phase -> ${detected}`;
				let held: Reservation | undefined;
				let flippedRef: string | undefined;
				if (localOnly || (tier === "local" && state.tier !== "local")) {
					const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId, state.decision.score ?? 0, localOnly);
					if (localOnly && reserved.causes) throwLocalOnlyUnavailable(flavor, reserved.causes);
					if (reserved.spill) tier = "cloud";
					else {
						held = reserved.reservation;
						flippedRef = reserved.ref;
					}
				}
				const ref = tier === "local" ? (flippedRef ?? firstResolvable(ctx, localCandidates(rt.config, ctx, flavor, state.decision.score ?? 0))) : firstResolvable(ctx, cloudCandidates(rt.config, ctx, state.decision.score ?? 0));
				rt.log?.(`route phase-flip ${state.phase} -> ${detected} tier=${tier} ref=${ref}`);
				const next: RouterState = {
					tier,
					modelId: ref ?? "",
					phase: detected,
					decision: { ...state.decision, reason },
					...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
				};
				try {
					return resolveModel(ctx, ref, effectiveThinking, next);
				} catch (error) {
					if (held) rt.governor.release(held);
					throw error;
				}
			}
		}
		let ref: string | undefined;
		let held: Reservation | undefined;
		let effectiveTier: Tier = localOnly ? "local" : state.tier;
		let reasonSuffix: string | undefined;

		if (localOnly || state.tier === "local") {
			const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId, state.decision.score ?? 0, localOnly);
			if (localOnly && reserved.causes) throwLocalOnlyUnavailable(flavor, reserved.causes);
			if (reserved.ref) {
				held = reserved.reservation;
				ref = reserved.ref;
			} else if (reserved.spill) {
				effectiveTier = "cloud";
				reasonSuffix = reserved.spill;
			}
		}
		if (!ref && !localOnly) {
			ref = firstResolvable(ctx, cloudCandidates(rt.config, ctx, state.decision.score ?? 0));
		}
		if (!ref && !localOnly) {
			const fallback = await ensureLocalSlot(rt, ctx, flavor, sessionId, state.decision.score ?? 0);
			if (fallback.ref) {
				held = fallback.reservation;
				ref = fallback.ref;
				effectiveTier = "local";
				reasonSuffix = "cloud catalog unavailable, routed local";
			}
		}
		if (!ref) {
			if (localOnly) throwLocalOnlyUnavailable(flavor, [missingLocalModelCause(localCandidates(rt.config, ctx, flavor))]);
			throw new Error("pi-cuttle: no configured model resolves (check catalog.local/cloud)");
		}
		const next: RouterState = localOnly
			? {
				tier: "local",
				modelId: ref,
				phase: state.phase,
				...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
				decision: state.decision,
			}
			: effectiveTier === state.tier
				? state
				: { ...state, tier: effectiveTier, modelId: ref, ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}), decision: { ...state.decision, reason: `${state.decision.reason}; ${reasonSuffix}` } };
		try {
			return resolveModel(ctx, ref, effectiveThinking, next);
		} catch (error) {
			if (held) rt.governor.release(held);
			throw error;
		}
	}

	const prompt = lastUserText(request.messages);
	const forced = rt.getForced?.() ?? rt.pins.get(sessionId) ?? flavorBias(flavor);
	const now = Date.now();
	const skipClassifier =
		rt.config.classifier.model !== undefined &&
		rt.classifierFailures >= rt.config.classifier.backoffAfterFailures &&
		now < rt.classifierBackoffUntil;
	if (skipClassifier) rt.log?.("classifier: skipping due to backoff");
	const decided = await decideTier({
		config: rt.config,
		prompt,
		messages: request.messages,
		ctx,
		log: rt.log,
		skipClassifier,
		...(forced ? { forced } : {}),
	});
	const signalPath = decided.signalPath;
	const shadowComparison = decided.shadowComparison;
	if (decided.classifierFailure) {
		rt.lastClassifierError = { ...decided.classifierFailure, turn: userTurn(request.messages), at: Date.now() };
		rt.classifierFailures += 1;
		if (rt.classifierFailures >= rt.config.classifier.backoffAfterFailures) {
			rt.classifierBackoffUntil = now + rt.config.classifier.backoffMs;
		}
	} else if (decided.source === "classifier") {
		rt.lastClassifierError = undefined;
		rt.classifierFailures = 0;
		rt.classifierBackoffUntil = 0;
	}
	const decision = applyPolicy(rt.config, decided, phase);

	let tier: Tier = localOnly ? "local" : decision.tier;
	const reasons: string[] = [decision.reason];
	if (localOnly && decision.tier === "cloud") reasons.push("local-only flavor");

	let held: Reservation | undefined;
	let localRef: string | undefined;
	if (tier === "local") {
		const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId, decision.score, localOnly);
		if (localOnly && reserved.causes) throwLocalOnlyUnavailable(flavor, reserved.causes);
		if (reserved.spill) {
			tier = "cloud";
			reasons.push(reserved.spill);
		} else {
			held = reserved.reservation;
			localRef = reserved.ref;
		}
	}

	let ref: string | undefined;
	if (tier === "local") {
		ref = localRef;
	} else {
		ref = firstResolvable(ctx, cloudCandidates(rt.config, ctx, decision.score));
		if (!ref) {
			const fallback = await ensureLocalSlot(rt, ctx, flavor, sessionId, decision.score);
			if (fallback.ref) {
				tier = "local";
				ref = fallback.ref;
				held = fallback.reservation;
				reasons.push("no cloud candidate available, routed local");
			}
		}
	}
	if (!ref) throw new Error("pi-cuttle: no configured model resolves (check catalog.local/cloud)");

	// Compute clamped thinking level based on classifier score (#69).
	const thinkingLevelsPolicy = rt.config.policy.thinkingLevels;
	if (thinkingLevelsPolicy?.enabled && decision.score !== undefined) {
		const targetLevel = scoreToThinkingLevel(decision.score, thinkingLevelsPolicy);
		const parsed = splitRef(ref);
		if (parsed) {
			const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
			if (model) {
				const clamped = clampToSupportedLevel(targetLevel, model);
				const respectCeiling = thinkingLevelsPolicy.enforceUserCeiling !== false;
				const withCeiling = respectCeiling ? applyUserCeiling(clamped, request.thinkingLevel ?? "medium") : clamped;
				const usage = ctx.getContextUsage();
				const withPressure = applyContextPressure(
					withCeiling,
					usage?.tokens ?? null,
					model.contextWindow,
					thinkingLevelsPolicy.contextThreshold,
				);
				effectiveThinking = withPressure;
				rt.log?.(`thinking clamped: score=${decision.score.toFixed(2)} target=${targetLevel} clamped=${clamped}${respectCeiling ? ` ceiling=${request.thinkingLevel ?? "medium"}` : " (ceiling off)"} final=${withPressure}`);
			}
		}
	}

	rt.log?.(`route result tier=${tier} ref=${ref} thinking=${effectiveThinking} reasons=${reasons.join("; ")}`);
	if (gatesActive(rt.config.gates) || rt.config.classifier.contextShadow) {
		const record = {
			at: Date.now(),
			flavor,
			tier,
			source: decision.source,
			signalPath,
			gates: decision.gates,
			// Keep the ledger metadata-only, even if a classifier error echoes its input.
			reason: `${decision.source} decision`,
		};
		if (shadowComparison) {
			// Never wait for the alternate classifier: it is observability only and may time out.
			void shadowComparison.then((paired) => appendShadow({ ...record, ...(paired ? { paired } : {}) }));
		} else {
			appendShadow(record);
		}
	}
	const next: RouterState = {
		tier,
		modelId: ref ?? "",
		phase,
		...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
		decision: { source: decision.source, ...(decision.score !== undefined ? { score: decision.score } : {}), reason: reasons.join("; ") },
	};

	// Store the routing decision for `/cuttle why`.
	rt.lastDecision = {
		flavor,
		tier,
		ref,
		thinkingLevel: effectiveThinking,
		reason: reasons.join("; "),
		source: decision.source,
		signalPath,
		score: decision.score,
		subagent: isSubagent(),
		at: Date.now(),
	};

	// Emit routing trace to LangFuse if observability is enabled (#88).
	if (rt.langfuse) {
		const traceId = `${sessionId ?? "unknown"}-${rt.lastDecision.at}`;
		rt.langfuse
			.trace({
				traceId,
				name: "pi-cuttle routing decision",
				prompt: lastUserText(request.messages),
				tier,
				modelId: ref ?? "",
				flavor,
				thinkingLevel: effectiveThinking,
				score: decision.score,
				reason: reasons.join("; "),
				source: decision.source,
				isSubagent: isSubagent(),
				localBias: rt.config.policy.localBias,
				enforceUserCeiling: rt.config.policy.thinkingLevels?.enforceUserCeiling,
			})
			.catch((error) => rt.log?.(`langfuse trace failed: ${error instanceof Error ? error.message : String(error)}`));

		// Score the decision (#132). Observational only: a failure is logged, never thrown into the turn.
		for (const entry of decisionScores(flavor, ref ?? "", rt.config.catalog.local)) {
			void rt.langfuse
				.score({ traceId, ...entry })
				.catch((error) => rt.log?.(`langfuse score failed: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	try {
		return resolveModel(ctx, ref, effectiveThinking, next);
	} catch (error) {
		if (held) rt.governor.release(held);
		throw error;
	}
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const FLAVORS: { id: RouterFlavor; name: string }[] = [
	{ id: "auto", name: "Auto (local/cloud)" },
	{ id: "local", name: "Local only" },
	{ id: "cloud", name: "Cloud only" },
	{ id: "fast-local", name: "Fast local" },
	{ id: "big-local", name: "Big local" },
	{ id: "orchestrator", name: "Orchestrator" },
];

export function registerVirtualModels(pi: ExtensionAPI, rt: RouterRuntime): void {
	for (const flavor of FLAVORS) {
		pi.registerVirtualModel<RouterState>({
			provider: VIRTUAL_PROVIDER,
			id: flavor.id,
			name: flavor.name,
			thinkingLevels: [...THINKING_LEVELS],
			contextWindow: 262_144,
			maxTokens: 32_768,
			input: ["text", "image"],
			route: (request, ctx) => routeRequest(rt, flavor.id, request, ctx),
		});
	}
}
