/**
 * The family of virtual models.
 *
 * Rather than guessing a child's role from its prompt, we register one virtual
 * model per policy and let pi's native per-role model config choose between them
 * (`subagents.agentOverrides.<role>.model`). `router/auto` is the global default.
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

import { applyPolicy, decideTier, detectPhase, splitRef, struggleSignals } from "./classifier.ts";
import type { LocalGovernor } from "./governor.ts";
import type { LocalHost } from "./host.ts";
import type { Reservation, RouterConfig, RouterFlavor, RouterState, Tier } from "./types.ts";

export interface RouterRuntime {
	config: RouterConfig;
	host: LocalHost;
	governor: LocalGovernor;
	/** Session-scoped pins set by `/router local|cloud|auto`. */
	pins: Map<string, Tier>;
	/** Invocation-wide override from `--router-force`, read lazily (#26). */
	getForced?: () => Tier | undefined;
	/** Local model key -> size in bytes, for `router/fast-local` ordering (#19). */
	sizes: Map<string, number>;
	/** Optional debug logger (set from `PI_MODEL_ROUTER_DEBUG`). */
	log?: (message: string) => void;
	/** Refresh `sizes` from the local host; best-effort. */
	refreshSizes?: () => Promise<void>;
}

type RouterRequest = ModelRouteRequest<RouterState>;

/** Extract the latest user text from the conversation. */
export function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Pick a local candidate. `fast-local` orders by on-disk size, smallest first (#19). */
export function pickLocal(config: RouterConfig, flavor?: RouterFlavor, sizes?: Map<string, number>): string | undefined {
	const list = [...config.catalog.local];
	if (flavor === "fast-local" && sizes && sizes.size > 0) {
		list.sort((a, b) => (sizes.get(a) ?? Number.POSITIVE_INFINITY) - (sizes.get(b) ?? Number.POSITIVE_INFINITY));
	}
	return list[0];
}

export function pickCloud(config: RouterConfig): string | undefined {
	return config.catalog.cloud[0];
}

/** Ordered local candidates; `fast-local` sorts by on-disk size when known (#19). */
export function localCandidates(config: RouterConfig, flavor?: RouterFlavor, sizes?: Map<string, number>): string[] {
	const list = [...config.catalog.local];
	if (flavor === "fast-local" && sizes && sizes.size > 0) {
		list.sort((a, b) => (sizes.get(a) ?? Number.POSITIVE_INFINITY) - (sizes.get(b) ?? Number.POSITIVE_INFINITY));
	}
	return list;
}

export function cloudCandidates(config: RouterConfig): string[] {
	return [...config.catalog.cloud];
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
	if (provider === "lmstudio" || provider === "llama.cpp" || provider === "ollama") return true;
	return /out of memory|\boom\b|exceed|overload|timed? ?out|ECONNREFUSED|context_length_exceeded/i.test(errorMessage ?? "");
}

function resolveModel(
	ctx: ExtensionContext,
	ref: string | undefined,
	thinkingLevel: RouterRequest["thinkingLevel"],
	state: RouterState,
): ModelRoute<RouterState> {
	if (!ref) throw new Error("pi-model-router: no model configured for the chosen tier (set catalog.local/cloud)");
	const parsed = splitRef(ref);
	if (!parsed) throw new Error(`pi-model-router: invalid model ref '${ref}'`);
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) throw new Error(`pi-model-router: model '${ref}' is not in the catalog`);
	return { model, thinkingLevel, state };
}

/**
 * Reserve a local slot for the turn, or return a reason to spill to cloud.
 * Context guard (#15), then the loaded ceiling + cross-process slot (#13/#14/#16).
 */
async function ensureLocalSlot(
	rt: RouterRuntime,
	ctx: ExtensionContext,
	flavor: RouterFlavor,
	sessionId: string,
): Promise<{ spill?: string; reservation?: Reservation; ref?: string }> {
	const candidates = localCandidates(rt.config, flavor, rt.sizes);
	if (candidates.length === 0) return { spill: "no local model configured" };
	let sawContextOverflow = false;
	for (const ref of candidates) {
		const parsed = splitRef(ref);
		if (!parsed) continue;
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) continue; // #45: try the next candidate instead of throwing
		if (!fitsWindow(ctx, model.contextWindow ?? 0)) {
			sawContextOverflow = true;
			continue;
		}
		// Hosts report loaded state and assistant messages by bare model id, with no provider
		// prefix. Key the slot by that same id so acquire/release and the ceiling all agree.
		const bareKey = parsed.id;
		if (rt.config.local.maxLoadedModels > 0) await rt.governor.enforceLoadedCeiling(bareKey);
		const reservation = await rt.governor.acquire(bareKey, { sessionId, flavor });
		if (reservation) return { reservation, ref };
	}
	return { spill: sawContextOverflow ? "context exceeds local window" : "local full, spilled to cloud" };
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
		const ref = tier === "local" ? pickLocal(rt.config, flavor, rt.sizes) : pickCloud(rt.config);
		const next: RouterState =
			state ?? { tier, modelId: ref ?? "", phase, decision: { source: "pin", reason: "direct request" } };
		return resolveModel(ctx, ref, thinking, next);
	}

	// #11: a retry may switch models. Local failures and overflow-style errors go to cloud.
	if (request.reason === "retry" && request.failed) {
		const failed = request.failed;
		const cloudRef = firstResolvable(ctx, cloudCandidates(rt.config));
		if (cloudRef && looksLikeLocalFailure(failed.model.provider, failed.message.errorMessage)) {
			// The failed local attempt holds a slot in this process; free it as we escalate.
			rt.governor.releaseOne(failed.model.id);
			const next: RouterState = {
				tier: "cloud",
				modelId: cloudRef,
				phase,
				decision: { source: "heuristic", reason: `retry: ${failed.model.provider} failure, switched to cloud` },
				// #37: remember this was a failure escalation, so the next user turn re-decides
				// instead of the session paying cloud prices until it ends.
				degradedFrom: "local",
			};
			return resolveModel(ctx, cloudRef, thinking, next);
		}
		// Otherwise stay on the model that failed, preserving cache and signatures.
		const sameRef = `${failed.model.provider}/${failed.model.id}`;
		const next: RouterState =
			state ?? { tier: "cloud", modelId: sameRef, phase, decision: { source: "heuristic", reason: "retry on same model" } };
		return resolveModel(ctx, sameRef, thinking, next);
	}

	// #37: a session degraded by a local failure re-decides on the next user turn, so one
	// transient hiccup does not pin it to cloud prices for good. Everything else stays sticky.
	const recovering = state?.degradedFrom !== undefined && request.reason === "user";
	// #41: struggle-based escalation. Evidence is read from the conversation, so a local
	// session that is flailing moves up; a cloud session that came up this way steps back
	// down after `cleanTurns` clean user turns. Hysteresis: both transitions need evidence.
	const escalateCfg = rt.config.policy.escalate;
	const signals = escalateCfg?.enabled ? struggleSignals(request.messages, escalateCfg.window) : { errors: 0 };
	const cleanStreak = (state?.cleanTurns ?? 0) + (request.reason === "user" && signals.errors === 0 ? 1 : 0);
	const deescalating =
		escalateCfg?.enabled === true &&
		state?.escalatedFrom !== undefined &&
		request.reason === "user" &&
		signals.errors === 0 &&
		cleanStreak >= escalateCfg.cleanTurns;
	// Sticky within a session unless policy says re-classify every user turn (#12).
	const reclassify = (rt.config.policy.reclassify === "turn" || recovering || deescalating) && request.reason === "user";
	if (state && !reclassify) {
		// #41: a local session that is visibly flailing escalates to cloud mid-turn.
		if (escalateCfg?.enabled && state.tier === "local" && signals.errors >= escalateCfg.toolErrors) {
			const cloudRef = firstResolvable(ctx, cloudCandidates(rt.config));
			if (cloudRef) {
				rt.governor.releaseOne(splitRef(pickLocal(rt.config, flavor, rt.sizes) ?? "")?.id ?? "");
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

		// #41: while escalated, count clean user turns; an error resets the streak.
		if (state.tier === "cloud" && state.escalatedFrom && request.reason === "user") {
			const nextClean = signals.errors === 0 ? cleanStreak : 0;
			if (nextClean !== (state.cleanTurns ?? 0)) {
				const next: RouterState = { ...state, cleanTurns: nextClean };
				return resolveModel(ctx, firstResolvable(ctx, cloudCandidates(rt.config)), thinking, next);
			}
		}

		// #36: planning ends at the first file-mutating tool call. Flip the phase and, under
		// phase policy, let the tier follow it — the one place a sticky session changes tier
		// without evidence of struggle.
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
					const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId);
					if (reserved.spill) tier = "cloud";
					else {
						held = reserved.reservation;
						flippedRef = reserved.ref;
					}
				}
				const ref = tier === "local" ? (flippedRef ?? firstResolvable(ctx, localCandidates(rt.config, flavor, rt.sizes))) : firstResolvable(ctx, cloudCandidates(rt.config));
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
		const ref =
			state.tier === "local"
				? firstResolvable(ctx, localCandidates(rt.config, flavor, rt.sizes))
				: firstResolvable(ctx, cloudCandidates(rt.config));
		return resolveModel(ctx, ref, thinking, state);
	}

	const prompt = lastUserText(request.messages);
	const forced = rt.getForced?.() ?? rt.pins.get(sessionId) ?? flavorBias(flavor);
	const decided = await decideTier({ config: rt.config, prompt, ctx, host: rt.host, ...(forced ? { forced } : {}) });
	const decision = applyPolicy(rt.config, decided, phase);

	let tier: Tier = decision.tier;
	const reasons: string[] = [decision.reason];

	// Local side: reserve a slot or spill to cloud (#45: the first workable candidate).
	let held: Reservation | undefined;
	let localRef: string | undefined;
	if (tier === "local") {
		const reserved = await ensureLocalSlot(rt, ctx, flavor, sessionId);
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
		ref = firstResolvable(ctx, cloudCandidates(rt.config));
		if (!ref) {
			// #45: a broken cloud catalog must not break the turn; fall back to local.
			const fallback = await ensureLocalSlot(rt, ctx, flavor, sessionId);
			if (fallback.ref) {
				tier = "local";
				ref = fallback.ref;
				held = fallback.reservation;
				reasons.push("no cloud candidate available, routed local");
			}
		}
	}
	if (!ref) throw new Error("pi-model-router: no configured model resolves (check catalog.local/cloud)");
	rt.log?.(`route result tier=${tier} ref=${ref} reasons=${reasons.join("; ")}`);
	const next: RouterState = {
		tier,
		modelId: ref ?? "",
		phase,
		decision: { source: decision.source, ...(decision.score !== undefined ? { score: decision.score } : {}), reason: reasons.join("; ") },
	};
	// #39: if the target cannot be resolved after the slot was taken, give it back instead
	// of leaking it until stale reaping.
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
			provider: "router",
			id: flavor.id,
			name: flavor.name,
			thinkingLevels: [...THINKING_LEVELS],
			// Shared across local and cloud candidates; generous so the first request is not
			// compacted before the target physical model's real limits apply.
			contextWindow: 262_144,
			maxTokens: 32_768,
			input: ["text", "image"],
			route: (request, ctx) => routeRequest(rt, flavor.id, request, ctx),
		});
	}
}
