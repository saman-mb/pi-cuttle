/**
 * `/router` — inspect and edit routing without hand-editing JSON.
 *
 * Edits are persisted to the user config file (#17) via `saveUserConfig`, which
 * preserves unknown keys.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { saveUserConfig, type LoadedConfig } from "./config.ts";
import type { RouterRuntime } from "./virtual-models.ts";
import type { PolicyMode, Tier } from "./types.ts";

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
			const models = await rt.lm.list();
			candidates = models.filter((m) => m.key && m.type !== "embeddings").map((m) => `lmstudio/${m.key}`);
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

export function registerRouterCommand(pi: ExtensionAPI, rt: RouterRuntime, loaded: LoadedConfig): void {
	pi.registerCommand("router", {
		description: "Inspect and edit local/cloud model routing",
		handler: async (args, ctx) => {
			const [sub = "status"] = args.trim().split(/\s+/, 1);
			const sessionId = ctx.sessionManager.getSessionId();

			if (sub === "auto" || sub === "local" || sub === "cloud") {
				if (sub === "auto") rt.pins.delete(sessionId);
				else rt.pins.set(sessionId, sub as Tier);
				ctx.ui.notify(`router: this session pinned to ${sub === "auto" ? "classifier choice" : sub}`, "info");
				return;
			}
			if (sub === "models") return editModels(rt, ctx);
			if (sub === "policy") return editPolicy(rt, ctx);
			if (sub === "limit") return editLocalLimit(rt, ctx);
			return status(rt, loaded, ctx);
		},
	});
}
