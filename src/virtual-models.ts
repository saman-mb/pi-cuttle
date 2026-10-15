/**
 * The family of virtual models.
 *
 * Rather than guessing a child's role from its prompt, we register one virtual
 * model per policy and let pi's native per-role model config choose between them
 * (`subagents.agentOverrides.<role>.model`). `router/auto` is the global default.
 *
 * pi stores returned router state on the session branch, so it follows forks and
 * survives compaction.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import { decideTier, splitRef } from "./classifier.ts";
import type { LocalGovernor } from "./governor.ts";
import type { LmStudioClient } from "./lmstudio.ts";
import type { RouterConfig, RouterFlavor, RouterState, Tier } from "./types.ts";

export interface RouterRuntime {
	config: RouterConfig;
	lm: LmStudioClient;
	governor: LocalGovernor;
	/** Session-scoped pins set by `/router local|cloud|auto`. */
	pins: Map<string, Tier>;
	/** Invocation-wide override from `--router-force`. */
	forceAll?: Tier;
}

type RouterRequest = ModelRouteRequest<RouterState>;

/** Extract the latest user text from the conversation. */
export function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function pickLocal(config: RouterConfig, flavor?: RouterFlavor): string | undefined {
	// TODO(fast-local): order by on-disk size once LM Studio size is read.
	const list = config.catalog.local;
	return flavor === "fast-local" ? list.at(-1) : list[0];
}

export function pickCloud(config: RouterConfig): string | undefined {
	return config.catalog.cloud[0];
}

function flavorBias(flavor: RouterFlavor): Tier | undefined {
	if (flavor === "local" || flavor === "fast-local") return "local";
	if (flavor === "cloud") return "cloud";
	return undefined;
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

async function routeRequest(
	rt: RouterRuntime,
	flavor: RouterFlavor,
	request: RouterRequest,
	ctx: ExtensionContext,
): Promise<ModelRoute<RouterState>> {
	const sessionId = ctx.sessionManager.getSessionId();
	const state = request.state;
	const thinking = request.thinkingLevel;

	// Requests outside the agent loop (e.g. compaction summaries) use the deterministic tier.
	if (request.reason === "direct") {
		const tier = flavorBias(flavor) ?? "cloud";
		const ref = tier === "local" ? pickLocal(rt.config, flavor) : pickCloud(rt.config);
		const next: RouterState = state ?? { tier, modelId: ref ?? "", phase: "planning", decision: { source: "pin", reason: "direct request" } };
		return resolveModel(ctx, ref, thinking, next);
	}

	// Sticky within a session unless policy says re-classify every user turn.
	const reclassify = rt.config.policy.reclassify === "turn" && request.reason === "user";
	if (state && !reclassify) {
		const ref = state.tier === "local" ? pickLocal(rt.config, flavor) : pickCloud(rt.config);
		return resolveModel(ctx, ref, thinking, state);
	}

	const prompt = lastUserText(request.messages);
	const forced = rt.forceAll ?? rt.pins.get(sessionId) ?? flavorBias(flavor);
	const decision = await decideTier({ config: rt.config, prompt, ctx, lm: rt.lm, ...(forced ? { forced } : {}) });

	let tier: Tier = decision.tier;
	let spilled = false;

	// Local side: reserve a slot or spill to cloud.
	if (tier === "local") {
		const modelKey = pickLocal(rt.config, flavor);
		if (!modelKey) {
			tier = "cloud";
			spilled = true;
		} else {
			const reservation = await rt.governor.acquire(modelKey, { sessionId });
			if (!reservation) {
				tier = "cloud";
				spilled = true;
			}
		}
	}

	const ref = tier === "local" ? pickLocal(rt.config, flavor) : pickCloud(rt.config);
	const next: RouterState = {
		tier,
		modelId: ref ?? "",
		phase: state?.phase ?? "planning",
		decision: {
			source: decision.source,
			...(decision.score !== undefined ? { score: decision.score } : {}),
			reason: spilled ? `${decision.reason} (local full, spilled to cloud)` : decision.reason,
		},
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
			// Shared across local and cloud candidates; kept generous so the first
			// request is not compacted before the target model's real limits apply.
			contextWindow: 262_144,
			maxTokens: 32_768,
			input: ["text", "image"],
			route: (request, ctx) => routeRequest(rt, flavor.id, request, ctx),
		});
	}
}
