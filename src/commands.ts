/**
 * `/router` — inspect and edit routing without hand-editing JSON.
 *
 * Writes are not implemented in the scaffold: the command reports state and sets
 * session pins. Persisting edits to `model-router.json` is tracked in the backlog.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { LoadedConfig } from "./config.ts";
import type { RouterRuntime } from "./virtual-models.ts";
import type { Tier } from "./types.ts";

const TIERS: Tier[] = ["local", "cloud"];

export function registerRouterCommand(pi: ExtensionAPI, rt: RouterRuntime, loaded: LoadedConfig): void {
	pi.registerCommand("router", {
		description: "Inspect and edit local/cloud model routing",
		handler: async (args, ctx) => {
			const [sub = "status"] = args.trim().split(/\s+/, 1);
			const sessionId = ctx.sessionManager.getSessionId();

			if (sub === "auto" || sub === "local" || sub === "cloud") {
				if (sub === "auto") rt.pins.delete(sessionId);
				else rt.pins.set(sessionId, sub);
				ctx.ui.notify(`router: this session pinned to ${sub === "auto" ? "classifier choice" : sub}`, "info");
				return;
			}

			if (sub === "models") {
				const slot = await ctx.ui.select("Which model slot?", ["local", "cloud", "decision model"]);
				if (!slot) return;
				const candidates =
					slot === "local"
						? rt.config.catalog.local
						: slot === "cloud"
							? rt.config.catalog.cloud
							: rt.config.classifier.model
								? [rt.config.classifier.model]
								: [];
				if (candidates.length === 0) {
					ctx.ui.notify("router: no candidates configured; edit model-router.json", "warning");
					return;
				}
				const chosen = await ctx.ui.select(`Set ${slot} model`, candidates);
				ctx.ui.notify(
					chosen ? `router: ${slot} -> ${chosen} (not yet persisted; see backlog #persist)` : "router: unchanged",
					"info",
				);
				return;
			}

			// status
			const status = await rt.governor.status();
			const pinned = rt.pins.get(sessionId);
			const lines = [
				`models:   local=${rt.config.catalog.local.join(", ") || "(none)"}`,
				`          cloud=${rt.config.catalog.cloud.join(", ") || "(none)"}`,
				`decision: ${rt.config.classifier.model ?? "heuristic only"} (fallback ${rt.config.classifier.fallback})`,
				`policy:   ${rt.config.policy.mode} (threshold ${rt.config.policy.threshold}, reclassify ${rt.config.policy.reclassify})`,
				`pin:      ${pinned ?? "auto"}`,
				`local:    ${status.slots.length}/${status.localMax} slots used`,
				`loaded:   ${status.loadedModels.map((m) => m.key).join(", ") || "(none)"}`,
				`config:   ${loaded.sources.join(" -> ") || "(defaults only)"}`,
			];
			for (const warning of loaded.warnings) lines.push(`warning:  ${warning}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
