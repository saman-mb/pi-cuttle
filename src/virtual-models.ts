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
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import { applyPolicy, decideTier, detectPhase, gatesActive, splitRef, struggleSignals } from "./classifier.ts";
import { appendShadow } from "./shadow.ts";
import type { LocalGovernor } from "./governor.ts";
import type { ClassifierFailure, Reservation, RouterConfig, RouterFlavor, RouterState, Tier } from "./types.ts";
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
	/** Local model key -> size in bytes, for `cuttle/fast-local` ordering (#19). */
	sizes: Map<string, number>;
	/** Optional debug logger (set from `PI_CUTTLE_DEBUG`). */
	log?: (message: string) => void;
	/** Most recent classifier failure, for `/cuttle status` (#53). */
	lastClassifierError?: ClassifierFailure;
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

function capacityScore(ctx: ExtensionContext, ref: string, pool: readonly string[]): number {
	const window = modelContextWindow(ctx, ref);
	if (window <= 0) return 0;
	const windows = pool.map((r) => modelContextWindow(ctx, r)).filter((w) => w > 0);
	if (windows.length === 0) return 0.5;
	const max = Math.max(...windows);
	return window / max;
}

/** Pick a local candidate. `fast-local` orders by on-disk size; otherwise the smallest model that can handle `score` is chosen. */
export function pickLocal(
	config: RouterConfig,
	ctx: ExtensionContext,
	flavor?: RouterFlavor,
	sizes?: Map<string, number>,
	score = 0,
): string | undefined {
	return localCandidates(config, ctx, flavor, sizes, score)[0];
}

export function pickCloud(config: RouterConfig, ctx: ExtensionContext, score = 0): string | undefined {
	return cloudCandidates(config, ctx, score)[0];
}

/** Ordered local candidates; `fast-local` sorts by on-disk size, otherwise by complexity capacity. */
export function localCandidates(
	config: RouterConfig,
	ctx: ExtensionContext,
	flavor?: RouterFlavor,
	sizes?: Map<string, number>,
	score = 0,
): string[] {
	const list = [...config.catalog.local];
	if (flavor === "fast-local" && sizes && sizes.size > 0) {
		list.sort((a, b) => (sizes.get(a) ?? Number.POSITIVE_INFINITY) - (sizes.get(b) ?? Number.POSITIVE_INFINITY));
	} else if (score > 0 && list.length > 1) {
		list.sort((a, b) => {
			const ca = capacityScore(ctx, a, list);
			const cb = capacityScore(ctx, b, list);
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
	if (score > 0 && list.length > 1) {
		list.sort((a, b) => {
			const ca = capacityScore(ctx, a, list);
			const cb = capacityScore(ctx, b, list);
			const aFits = ca >= score;
			const bFits = cb >= score;
			if (aFits && !bFits) return -1;
			if (!aFits && bFits) return 1;
			return ca - cb;
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
	if (flavor === "local" || flavor === "fast-local") return "local";
	if (flavor === "cloud") return "cloud";
	return undefined;
}

/** True when a failed request looks like the local side fell over. */
export function looksLikeLocalFailure(provider: string, errorMessage: string | undefined): boolean {
	if (provider === "lmstudio" || provider === "llama.cpp" || provider === "ollama" || provider === "mtplx") return true;
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
): Promise<{ spill?: string; reservation?: Reservation; ref?: string }> {
	const candidates = localCandidates(rt.config, ctx, flavor, rt.sizes, score);
	if (candidates.length === 0) return { spill: "no local model configured" };
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
		const reservation = await rt.governor.acquire(parsed.id, { sessionId, flavor });
		if (reservation) return { reservation, ref };
		sawCapacity = true;
	}
	const reasons: string[] = [];
	if (unresolvable.length > 0) {
		reasons.push(`local model not in pi's catalog: ${unresolvable.join(", ")} (check catalog.local)`);
	}
	if (sawContextOverflow) reasons.push("context exceeds local window");
	if (sawCapacity) reasons.push("local full");
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
	const thinking = request.thinkingLevel;
	const phase = state?.phase ?? detectPhase(request.messages) ?? "planning";

	// Requests outside the agent loop (e.g. compaction summaries) use the deterministic tier.
	if (request.reason === "direct") {
		const tier = flavorBias(flavor) ?? "cloud";
		const ref = tier === "local" ? pickLocal(rt.config, ctx, flavor, rt.sizes) : pickCloud(rt.config, ctx);
		const next: RouterState =
			state ?? { tier, modelId: ref ?? "", phase, decision: { source: "pin", reason: "direct request" } };
		return resolveModel(ctx, ref, thinking, next);
	}

	// #11: a retry may switch models. Local failures and overflow-style errors go to cloud.
	if (request.reason === "retry" && request.failed) {
		const failed = request.failed;
		const cloudRef = firstResolvable(ctx, cloudCandidates(rt.config, ctx));
		if (cloudRef && looksLikeLocalFailure(failed.model.provider, failed.message.errorMessage)) {
			rt.governor.releaseOne(failed.model.id);
			const next: RouterState = {
				tier: "cloud",
				modelId: cloudRef,
				phase,
				decision: { source: "heuristic", reason: `retry: ${failed.model.provider} failure, switched to cloud` },
				degradedFrom: "local",
			};
			return resolveModel(ctx, cloudRef, thinking, next);
		}
		const sameRef = `${failed.model.provider}/${failed.model.id}`;
		const next: RouterState =
			state ?? { tier: "cloud", modelId: sameRef, phase, decision: { source: "heuristic", reason: "retry on same model" } };
		return resolveModel(ctx, sameRef, thinking, next);
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
		if (escalateCfg?.enabled && state.tier === "local" && signals.errors >= escalateCfg.toolErrors) {
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
				return resolveModel(ctx, cloudRef, thinking, next);
			}
		}

		if (state.tier === "cloud" && state.escalatedFrom && request.reason === "user") {
			const nextClean = signals.errors === 0 ? cleanStreak : 0;
			if (nextClean !== (state.cleanTurns ?? 0)) {
				const next: RouterState = { ...state, cleanTurns: nextClean };
				return resolveModel(ctx, firstResolvable(ctx, cloudCandidates(rt.config, ctx)), thinking, next);
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
				let tier = flipped.tier;
				const reason = `${flipped.reason}; phase -> ${detected}`;
				let held: Reservation | undefined;
				let flippedRef: string | undefined;
				if (tier === "local" && state.tier !== "local") {
					const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId, state.decision.score ?? 0);
					if (reserved.spill) tier = "cloud";
					else {
						held = reserved.reservation;
						flippedRef = reserved.ref;
					}
				}
				const ref = tier === "local" ? (flippedRef ?? firstResolvable(ctx, localCandidates(rt.config, ctx, flavor, rt.sizes, state.decision.score ?? 0))) : firstResolvable(ctx, cloudCandidates(rt.config, ctx, state.decision.score ?? 0));
				rt.log?.(`route phase-flip ${state.phase} -> ${detected} tier=${tier} ref=${ref}`);
				const next: RouterState = {
					tier,
					modelId: ref ?? "",
					phase: detected,
					decision: { ...state.decision, reason },
				};
				try {
					return resolveModel(ctx, ref, thinking, next);
				} catch (error) {
					if (held) rt.governor.release(held);
					throw error;
				}
			}
		}
		let ref: string | undefined;
		let held: Reservation | undefined;
		if (state.tier === "local") {
			const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId, state.decision.score ?? 0);
			if (reserved.spill) {
				ref = firstResolvable(ctx, cloudCandidates(rt.config, ctx, state.decision.score ?? 0));
				if (ref) {
					const next: RouterState = {
						...state,
						tier: "cloud",
						modelId: ref,
						decision: { ...state.decision, reason: `${state.decision.reason}; ${reserved.spill}` },
					};
					try {
						return resolveModel(ctx, ref, thinking, next);
					} catch (error) {
						throw error;
					}
				}
			} else {
				held = reserved.reservation;
				ref = reserved.ref;
			}
		}
		if (!ref) {
			ref =
				state.tier === "local"
					? firstResolvable(ctx, localCandidates(rt.config, ctx, flavor, rt.sizes, state.decision.score ?? 0))
					: firstResolvable(ctx, cloudCandidates(rt.config, ctx, state.decision.score ?? 0));
		}
		try {
			return resolveModel(ctx, ref, thinking, state);
		} catch (error) {
			if (held) rt.governor.release(held);
			throw error;
		}
	}

	const prompt = lastUserText(request.messages);
	const forced = rt.getForced?.() ?? rt.pins.get(sessionId) ?? flavorBias(flavor);
	const decided = await decideTier({ config: rt.config, prompt, messages: request.messages, ctx, log: rt.log, ...(forced ? { forced } : {}) });
	if (decided.classifierFailure) {
		rt.lastClassifierError = { ...decided.classifierFailure, turn: userTurn(request.messages), at: Date.now() };
	} else if (decided.source === "classifier") {
		rt.lastClassifierError = undefined;
	}
	const decision = applyPolicy(rt.config, decided, phase);

	let tier: Tier = decision.tier;
	const reasons: string[] = [decision.reason];

	let held: Reservation | undefined;
	let localRef: string | undefined;
	if (tier === "local") {
		const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId, decision.score);
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
	rt.log?.(`route result tier=${tier} ref=${ref} reasons=${reasons.join("; ")}`);
	if (gatesActive(rt.config.gates)) {
		appendShadow({ at: Date.now(), flavor, tier, source: decision.source, gates: decision.gates, reason: reasons.join("; ") });
	}
	const next: RouterState = {
		tier,
		modelId: ref ?? "",
		phase,
		decision: { source: decision.source, ...(decision.score !== undefined ? { score: decision.score } : {}), reason: reasons.join("; ") },
	};
	try {
		return resolveModel(ctx, ref, thinking, next);
	} catch (error) {
		if (held) rt.governor.release(held);
		throw error;
	}
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const FLAVORS: { id: RouterFlavor; name: string }[] = [
	{ id: "auto", name: "Auto (local/cloud)" },
	{ id: "local", name: "Local preferred" },
	{ id: "cloud", name: "Cloud only" },
	{ id: "fast-local", name: "Fast local" },
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
