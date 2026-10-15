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

import { applyPolicy, decideTier, splitRef } from "./classifier.ts";
import type { LocalGovernor } from "./governor.ts";
import type { LmStudioClient } from "./lmstudio.ts";
import type { RouterConfig, RouterFlavor, RouterState, Tier } from "./types.ts";

export interface RouterRuntime {
	config: RouterConfig;
	lm: LmStudioClient;
	governor: LocalGovernor;
	/** Session-scoped pins set by `/router local|cloud|auto`. */
	pins: Map<string, Tier>;
	/** Invocation-wide override from `--router-force`, read lazily (#26). */
	getForced?: () => Tier | undefined;
	/** Local model key -> size in bytes, for `router/fast-local` ordering (#19). */
	sizes: Map<string, number>;
	/** Refresh `sizes` from LM Studio; best-effort. */
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

/** Can the whole conversation fit the local model's window? (#15) */
function fitsLocalWindow(rt: RouterRuntime, ctx: ExtensionContext, flavor: RouterFlavor): boolean {
	const localRef = pickLocal(rt.config, flavor, rt.sizes);
	if (!localRef) return false;
	const parsed = splitRef(localRef);
	if (!parsed) return false;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	const window = model?.contextWindow ?? 0;
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
	const phase = state?.phase ?? "planning";

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
		const cloudRef = pickCloud(rt.config);
		if (cloudRef && looksLikeLocalFailure(failed.model.provider, failed.message.errorMessage)) {
			const next: RouterState = {
				tier: "cloud",
				modelId: cloudRef,
				phase,
				decision: { source: "heuristic", reason: `retry: ${failed.model.provider} failure, switched to cloud` },
			};
			return resolveModel(ctx, cloudRef, thinking, next);
		}
		// Otherwise stay on the model that failed, preserving cache and signatures.
		const sameRef = `${failed.model.provider}/${failed.model.id}`;
		const next: RouterState =
			state ?? { tier: "cloud", modelId: sameRef, phase, decision: { source: "heuristic", reason: "retry on same model" } };
		return resolveModel(ctx, sameRef, thinking, next);
	}

	// Sticky within a session unless policy says re-classify every user turn (#12).
	const reclassify = rt.config.policy.reclassify === "turn" && request.reason === "user";
	if (state && !reclassify) {
		const ref = state.tier === "local" ? pickLocal(rt.config, flavor, rt.sizes) : pickCloud(rt.config);
		return resolveModel(ctx, ref, thinking, state);
	}

	const prompt = lastUserText(request.messages);
	const forced = rt.getForced?.() ?? rt.pins.get(sessionId) ?? flavorBias(flavor);
	const decided = await decideTier({ config: rt.config, prompt, ctx, lm: rt.lm, ...(forced ? { forced } : {}) });
	const decision = applyPolicy(rt.config, decided, phase);

	let tier: Tier = decision.tier;
	const reasons: string[] = [decision.reason];

	// Local side: context guard (#15), then reserve a slot or spill (#13/#16).
	if (tier === "local") {
		const modelKey = pickLocal(rt.config, flavor, rt.sizes);
		if (!modelKey) {
			tier = "cloud";
			reasons.push("no local model configured");
		} else if (!fitsLocalWindow(rt, ctx, flavor)) {
			tier = "cloud";
			reasons.push("context exceeds local window");
		} else {
			// LM Studio reports loaded models and assistant messages by bare model id, with no
			// provider prefix. Key the slot by that same id so acquire/release and the
			// loaded-model ceiling all agree.
			const bareKey = splitRef(modelKey)?.id ?? modelKey;
			if (rt.config.local.maxLoadedModels > 0) await rt.governor.enforceLoadedCeiling(bareKey);
			const reservation = await rt.governor.acquire(bareKey, { sessionId, flavor });
			if (!reservation) {
				tier = "cloud";
				reasons.push("local full, spilled to cloud");
			}
		}
	}

	const ref = tier === "local" ? pickLocal(rt.config, flavor, rt.sizes) : pickCloud(rt.config);
	rt.log?.(`route result tier=${tier} ref=${ref} reasons=${reasons.join("; ")}`);
	const next: RouterState = {
		tier,
		modelId: ref ?? "",
		phase,
		decision: { source: decision.source, ...(decision.score !== undefined ? { score: decision.score } : {}), reason: reasons.join("; ") },
	};
	return resolveModel(ctx, ref, thinking, next);
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
