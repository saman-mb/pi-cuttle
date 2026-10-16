/**
 * `/router` — inspect and edit routing without hand-editing JSON.
 *
 * Edits are persisted to the user config file (#17) via `saveUserConfig`, which
 * preserves unknown keys.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { availableHosts, createHost } from "./host.ts";

import { saveUserConfig, type LoadedConfig } from "./config.ts";
import { DEFAULT_PHYSICAL_BATCH_TOKENS, decisionStateBudget, detectPhysicalBatchSize, isLocalProvider, splitRef } from "./classifier.ts";
import type { HostModel } from "./host.ts";
import { formatStats, type Telemetry } from "./telemetry.ts";
import type { RouterRuntime } from "./virtual-models.ts";
import type { PolicyMode, RouterConfig, Tier } from "./types.ts";

function refresh(rt: RouterRuntime, patch: Record<string, unknown>): string {
	const path = saveUserConfig(patch);
	// Apply in-memory so the change takes effect without a restart.
	const next = patch as Record<string, Record<string, unknown>>;
	if (typeof patch.host === "string") rt.config.host = patch.host as RouterRuntime["config"]["host"];
	if (next.classifier) Object.assign(rt.config.classifier, next.classifier);
	if (next.catalog) Object.assign(rt.config.catalog, next.catalog);
	if (next.policy) Object.assign(rt.config.policy, next.policy);
	if (next.local) Object.assign(rt.config.local, next.local);
	return path;
}

async function editModels(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const slot = await ctx.ui.select("Which model slot?", ["local", "cloud", "decision model"]);
	if (!slot) return;

	let candidates: string[] = [];
	if (slot === "cloud") {
		candidates = [...rt.config.catalog.cloud];
	} else {
		try {
			const models = await rt.host.list();
			candidates = models.filter((m) => m.key && m.type !== "embeddings").map((m) => `${rt.config.host}/${m.key}`);
		} catch {
			candidates = [];
		}
		candidates = [...new Set([...candidates, ...(slot === "local" ? rt.config.catalog.local : rt.config.classifier.model ? [rt.config.classifier.model] : [])])];
	}

	const manual = "<type a model id>";
	const chosen = await ctx.ui.select(`Set ${slot} model`, [...candidates, manual]);
	if (!chosen) return;
	const ref = chosen === manual ? (await ctx.ui.input("Model id (provider/model)"))?.trim() : chosen;
	if (!ref) return;

	const patch =
		slot === "local"
			? { catalog: { local: [ref] } }
			: slot === "cloud"
				? { catalog: { cloud: [ref] } }
				: { classifier: { model: ref } };
	const path = refresh(rt, patch);
	ctx.ui.notify(`router: ${slot} -> ${ref}\nwritten to ${path}`, "info");
}

async function editPolicy(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const mode = await ctx.ui.select("Routing policy", ["complexity", "cost", "phase"]);
	if (!mode) return;
	const path = refresh(rt, { policy: { mode: mode as PolicyMode } });
	ctx.ui.notify(`router: policy -> ${mode}\nwritten to ${path}`, "info");
}

async function editLocalLimit(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const raw = await ctx.ui.input("Max concurrent local requests", String(rt.config.local.maxConcurrent));
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		ctx.ui.notify("router: not a number, unchanged", "warning");
		return;
	}
	const path = refresh(rt, { local: { maxConcurrent: Math.floor(value) } });
	ctx.ui.notify(`router: maxConcurrent -> ${Math.floor(value)}\nwritten to ${path}`, "info");
}

/** Probe the configured host by hitting its inventory endpoint. */
async function probeHost(rt: import("./virtual-models.ts").RouterRuntime): Promise<boolean> {
	try {
		if (rt.host.capabilities.canListLoaded) await rt.host.loaded();
		else await rt.host.list();
		return true;
	} catch {
		return false;
	}
}

function baseUrlOf(config: RouterConfig): string {
	if (config.host === "ollama") return config.ollama.baseUrl;
	if (config.host === "openai") return config.openai.baseUrl;
	return config.lmstudio.baseUrl;
}

/**
 * `/router init` — first-run wizard (#46). Detect reachable hosts, list their models,
 * pick local/decision/cloud, and write a working config in one pass.
 */
async function init(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const reachable = await availableHosts(rt.config);
	if (reachable.length === 0) {
		ctx.ui.notify(
			"router: no local host reachable.\n" +
				`tried: LM Studio ${rt.config.lmstudio.baseUrl}, ollama ${rt.config.ollama.baseUrl}, OpenAI-compatible ${rt.config.openai.baseUrl}\n` +
				"start one and rerun /router init",
			"warning",
		);
		return;
	}
	const kind =
		reachable.length === 1
			? reachable[0]!
			: ((await ctx.ui.select("Which local host?", reachable)) as (typeof reachable)[number] | undefined);
	if (!kind) return;

	const host = createHost({ ...rt.config, host: kind });
	let models: { key: string; type?: string }[] = [];
	try {
		models = (await host.list()).filter((m) => m.key && m.type !== "embeddings");
	} catch (error) {
		ctx.ui.notify(`router: could not list models from ${kind}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return;
	}
	if (models.length === 0) {
		ctx.ui.notify(`router: ${kind} is reachable but has no downloaded models`, "warning");
		return;
	}

	const refs = models.map((m) => `${kind}/${m.key}`);
	const localPick = await ctx.ui.select("Local model (runs free)", refs);
	if (!localPick) return;

	const decisionChoices = [
		"heuristic (no model call)",
		...models.filter((m) => m.type === "decision").map((m) => `${kind}/${m.key} (decision model)`),
		...models.filter((m) => m.type !== "decision").map((m) => `${kind}/${m.key} (chat prompt)`),
	];
	const decisionPick = await ctx.ui.select("How should the router classify each session?", decisionChoices);
	if (!decisionPick) return;
	const decisionRef = decisionPick === "heuristic (no model call)" ? undefined : decisionPick.replace(/ \((decision model|chat prompt)\)$/, "");

	const cloudChoices = [
		"<none for now>",
		...[...new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`))]
			.filter((ref) => !isLocalProvider(ref.slice(0, ref.indexOf("/"))))
			.slice(0, 40),
		"<type a model id>",
	];
	const cloudPick = await ctx.ui.select("Cloud model (used when the work needs judgement)", cloudChoices);
	if (!cloudPick) return;
	let cloudRef: string | undefined;
	if (cloudPick === "<type a model id>") cloudRef = (await ctx.ui.input("Cloud model id (provider/model)"))?.trim() || undefined;
	else if (cloudPick !== "<none for now>") cloudRef = cloudPick;

	const patch: Record<string, unknown> = {
		host: kind,
		catalog: { local: [localPick], ...(cloudRef ? { cloud: [cloudRef] } : {}) },
		...(decisionRef ? { classifier: { model: decisionRef } } : {}),
	};
	const path = refresh(rt, patch);
	rt.config.host = kind;
	ctx.ui.notify(
		[
			`router: configured ${kind}`,
			`  local:    ${localPick}`,
			`  decision: ${decisionRef ?? "heuristic"}`,
			`  cloud:    ${cloudRef ?? "(none)"}`,
			`written to ${path}`,
			rt.config.local.maxLoadedModels < 2 && decisionRef ? "tip: set local.maxLoadedModels >= 2 so the classifier is not evicted" : "",
		]
			.filter(Boolean)
			.join("\n"),
		"info",
	);
}

/**
 * A decision model's effective prompt capacity (#50): the detected `physical_batch_size` when
 * the host reports one (the model is loaded), else the conservative default. Used by
 * `/router doctor` and `/router` status to show the character budget a prompt is trimmed to.
 */
export async function classifierCapacity(
	rt: RouterRuntime,
	id: string,
): Promise<{ loaded: boolean; batch?: number; budget: number; isDecision: boolean; effective: number }> {
	let model: HostModel | undefined;
	try {
		model = (await rt.host.list()).find((m) => m.key === id);
	} catch {
		/* offline reads as unloaded; the conservative default still applies */
	}
	const isDecision = model?.type === "decision";
	// Only decision models have a single-pass batch limit to trim against.
	const batch = isDecision ? await detectPhysicalBatchSize(rt.host, id) : undefined;
	const budget = decisionStateBudget(batch);
	const effective = isDecision ? Math.min(rt.config.classifier.stateChars, budget) : rt.config.classifier.stateChars;
	return { loaded: (model?.loaded_instances ?? []).length > 0, batch, budget, isDecision, effective };
}

/** The `stateChars` actually handed to the classifier, after the decision-model trim (#50). */
async function effectiveStateChars(rt: RouterRuntime): Promise<number> {
	const ref = rt.config.classifier.model;
	const parsed = ref ? splitRef(ref) : undefined;
	if (!parsed || !isLocalProvider(parsed.provider)) return rt.config.classifier.stateChars;
	return (await classifierCapacity(rt, parsed.id)).effective;
}

async function doctor(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const lines: string[] = [];
	const up = await probeHost(rt);
	lines.push(`${rt.config.host}: ${up ? "reachable" : "UNREACHABLE"} (${baseUrlOf(rt.config)})`);

	const ref = rt.config.classifier.model;
	if (!ref) {
		lines.push("classifier: none configured -> heuristic");
	} else {
		const parsed = splitRef(ref);
		if (!parsed) {
			lines.push(`classifier: FAIL invalid ref '${ref}'`);
		} else if (isLocalProvider(parsed.provider)) {
			const type = rt.host.capabilities.hasDecisionModels ? ((await rt.host.modelType?.(parsed.id)) ?? undefined) : undefined;
			if (!type) {
				lines.push(`classifier: FAIL '${parsed.id}' is not in the ${rt.config.host} catalog`);
			} else {
				const start = Date.now();
				try {
					if (type === "decision" && rt.host.systemOne) {
						const result = await rt.host.systemOne!(
							parsed.id,
							{ prompt: "doctor probe" },
							{ complexity: { type: "choice", instructions: "Trivial probe.", criteria: { standard: "the probe", complex: "the probe" } } },
						);
						if (!result.answers.complexity) throw new Error("no answer returned");
					} else {
						await rt.host.chat(parsed.id, "Reply with one word.", { maxTokens: 4 });
					}
					lines.push(`classifier: PASS ${parsed.id} (${type}) ${Date.now() - start}ms`);
				} catch (error) {
					lines.push(`classifier: FAIL ${parsed.id} (${type}) — ${error instanceof Error ? error.message : String(error)}`);
					lines.push("  fix: load it in LM Studio, pick another decision model, or remove classifier.model for heuristic");
				}
			}
		} else {
			const model = ctx.modelRegistry.findOfType("classifier", parsed.provider, parsed.id);
			lines.push(`classifier: ${model ? "registered" : "FAIL not in catalog"} ${ref}`);
		}
	}

	if (ref) {
		const capacityRef = splitRef(ref);
		if (capacityRef && isLocalProvider(capacityRef.provider)) {
			const capacity = await classifierCapacity(rt, capacityRef.id);
			if (capacity.isDecision) {
				const source =
					capacity.batch !== undefined
						? `detected physical_batch=${capacity.batch}`
						: `not loaded - conservative default ${DEFAULT_PHYSICAL_BATCH_TOKENS}`;
				lines.push(`capacity: trims state to ${capacity.effective} chars (${source})`);
				if (rt.config.classifier.stateChars > capacity.effective) {
					lines.push(
						`note: classifier.stateChars ${rt.config.classifier.stateChars} exceeds that capacity; the state is trimmed, not rejected`,
					);
				}
			}
		}
	}

	const gov = await rt.governor.status();
	lines.push(`slots: ${gov.slots.length}/${gov.localMax} used; loaded: ${gov.loadedModels.map((m) => m.key).join(", ") || "(none)"}`);
	lines.push(
		`host: ${rt.config.host} (listLoaded=${gov.capabilities.canListLoaded} loadUnload=${gov.capabilities.canLoadUnload} decision=${gov.capabilities.hasDecisionModels} sizes=${gov.capabilities.hasModelSizes})`,
	);
	lines.push(`slotDir: ${rt.config.local.slotDir}`);
	lines.push("turn-level classifier failures are logged to $PI_MODEL_ROUTER_DEBUG when set (see README)");
	if (ref && isLocalProvider(splitRef(ref)?.provider ?? "") && rt.config.local.maxLoadedModels > 0 && rt.config.local.maxLoadedModels < 2) {
		lines.push("warning: a local classifier plus maxLoadedModels < 2 can evict the target; set maxLoadedModels >= 2");
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function status(rt: RouterRuntime, loaded: LoadedConfig, ctx: ExtensionCommandContext): Promise<void> {
	const governor = await rt.governor.status();
	const pinned = rt.pins.get(ctx.sessionManager.getSessionId());
	const lines = [
		`models:   local=${rt.config.catalog.local.join(", ") || "(none)"}`,
		`          cloud=${rt.config.catalog.cloud.join(", ") || "(none)"}`,
		`decision: ${rt.config.classifier.model ?? "heuristic only"} (fallback ${rt.config.classifier.fallback})`,
		`stateChars: ${await effectiveStateChars(rt)} (configured ${rt.config.classifier.stateChars})`,
		`policy:   ${rt.config.policy.mode} (threshold ${rt.config.policy.threshold}, reclassify ${rt.config.policy.reclassify})`,
		`autoselect: ${rt.config.autoSelect}`,
		`pin:      ${pinned ?? "auto"}`,
		`local:    ${governor.slots.length}/${governor.localMax} slots used`,
		`loaded:   ${governor.loadedModels.map((m) => m.key).join(", ") || "(none)"}`,
		`pinned:   ${governor.pinnedKeys.join(", ") || "(none)"}`,
		`config:   ${loaded.sources.join(" -> ") || "(defaults only)"}`,
	];
	for (const warning of loaded.warnings) lines.push(`warning:  ${warning}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

export function registerRouterCommand(pi: ExtensionAPI, rt: RouterRuntime, loaded: LoadedConfig, telemetry: Telemetry): void {
	pi.registerCommand("router", {
		description: "Inspect and edit local/cloud model routing",
		handler: async (args, ctx) => {
			const [sub = "status", extra] = args.trim().split(/\s+/);
			const sessionId = ctx.sessionManager.getSessionId();

			if (sub === "stats") {
				const days = Number.isFinite(Number(extra)) && Number(extra) > 0 ? Math.floor(Number(extra)) : 7;
				ctx.ui.notify(formatStats(telemetry.stats(days), rt.config.telemetry.baseline), "info");
				return;
			}

			if (sub === "auto" || sub === "local" || sub === "cloud") {
				if (sub === "auto") rt.pins.delete(sessionId);
				else rt.pins.set(sessionId, sub as Tier);
				ctx.ui.notify(`router: this session pinned to ${sub === "auto" ? "classifier choice" : sub}`, "info");
				return;
			}
			if (sub === "init") return init(rt, ctx);
			if (sub === "models") return editModels(rt, ctx);
			if (sub === "policy") return editPolicy(rt, ctx);
			if (sub === "limit") return editLocalLimit(rt, ctx);
			if (sub === "doctor") return doctor(rt, ctx);
			return status(rt, loaded, ctx);
		},
	});
}
