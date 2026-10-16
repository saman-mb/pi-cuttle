/**
 * `/router` — inspect and edit routing without hand-editing JSON.
 *
 * Edits are persisted to the user config file (#17) via `saveUserConfig`, which
 * preserves unknown keys.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { saveUserConfig, type LoadedConfig } from "./config.ts";
import { isLocalProvider, splitRef } from "./classifier.ts";
import { formatStats, type Telemetry } from "./telemetry.ts";
import type { RouterRuntime } from "./virtual-models.ts";
import type { PolicyMode, RouterConfig, Tier } from "./types.ts";

function refresh(rt: RouterRuntime, patch: Record<string, unknown>): string {
	const path = saveUserConfig(patch);
	// Apply in-memory so the change takes effect without a restart.
	const next = patch as Record<string, Record<string, unknown>>;
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

	const gov = await rt.governor.status();
	lines.push(`slots: ${gov.slots.length}/${gov.localMax} used; loaded: ${gov.loadedModels.map((m) => m.key).join(", ") || "(none)"}`);
	lines.push(
		`host: ${rt.config.host} (listLoaded=${gov.capabilities.canListLoaded} loadUnload=${gov.capabilities.canLoadUnload} decision=${gov.capabilities.hasDecisionModels} sizes=${gov.capabilities.hasModelSizes})`,
	);
	lines.push(`slotDir: ${rt.config.local.slotDir}`);
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
		`policy:   ${rt.config.policy.mode} (threshold ${rt.config.policy.threshold}, reclassify ${rt.config.policy.reclassify})`,
		`autoselect: ${rt.config.autoSelect}`,
		`pin:      ${pinned ?? "auto"}`,
		`local:    ${governor.slots.length}/${governor.localMax} slots used`,
		`loaded:   ${governor.loadedModels.map((m) => m.key).join(", ") || "(none)"}`,
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
			if (sub === "models") return editModels(rt, ctx);
			if (sub === "policy") return editPolicy(rt, ctx);
			if (sub === "limit") return editLocalLimit(rt, ctx);
			if (sub === "doctor") return doctor(rt, ctx);
			return status(rt, loaded, ctx);
		},
	});
}
