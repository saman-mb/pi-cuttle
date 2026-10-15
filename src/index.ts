/**
 * pi-model-router — extension entry point.
 *
 * Registers the `router/*` virtual-model family, the `/router` command, the
 * session-start auto-selection, and the slot-release hook.
 *
 * Delivery notes proven by the spikes (docs/ARCHITECTURE.md):
 *   - #24: `defaultModel` does NOT resolve an extension virtual model. "By default" is
 *          delivered by selecting `router/auto` on `session_start` via `pi.setModel`.
 *   - #26: extension flags are unreadable during the factory; `--router-force` is read lazily.
 *   - #25: `message_end` fires exactly once per assistant message.
 *   - #28: children only route if they load this extension, so the documented setup adds it
 *          to `subagents.defaultSubagentOnlyExtensions`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { LocalGovernor } from "./governor.ts";
import { LmStudioClient } from "./lmstudio.ts";
import { registerRouterCommand } from "./commands.ts";
import { registerVirtualModels, type RouterRuntime } from "./virtual-models.ts";
import type { Tier } from "./types.ts";

/** True when the user pinned a model on the command line; auto-select must not override it. */
function explicitModelRequested(argv: readonly string[]): boolean {
	return argv.includes("--model") || argv.includes("-m");
}

export default function modelRouter(pi: ExtensionAPI): void {
	const loaded = loadConfig(process.cwd());
	const debugPath = process.env.PI_MODEL_ROUTER_DEBUG;
	const log = debugPath ? (message: string) => appendFileSync(debugPath, message + "\n") : undefined;
	log?.(`factory cwd=${process.cwd()} autoSelect=${loaded.config.autoSelect} local=${loaded.config.catalog.local.join(",")} cloud=${loaded.config.catalog.cloud.join(",")} sources=${loaded.sources.join("|")} warnings=${loaded.warnings.join(";")}`);
	const lm = new LmStudioClient(loaded.config.lmstudio);
	const governor = new LocalGovernor(loaded.config.local, lm);

	const rt: RouterRuntime = {
		config: loaded.config,
		lm,
		governor,
		pins: new Map(),
		sizes: new Map(),
		log,
		// #26: read lazily; the value is undefined inside the factory.
		getForced: () => {
			const value = pi.getFlag("router-force");
			return value === "local" || value === "cloud" ? (value as Tier) : undefined;
		},
		refreshSizes: async () => {
			try {
				for (const model of await lm.list()) {
					if (typeof model.size_bytes === "number") rt.sizes.set(model.key, model.size_bytes);
				}
			} catch {
				/* LM Studio offline; fast-local falls back to config order */
			}
		},
	};

	pi.registerFlag("router-force", { type: "string", description: "Force router tier: local | cloud" });

	registerVirtualModels(pi, rt);
	registerRouterCommand(pi, rt, loaded);

	// #24: select the router at session start. This is what makes routing the default for
	// both the main agent and any child that loads this extension.
	pi.on("session_start", async (_event, ctx) => {
		void rt.refreshSizes?.();
		log?.(`session_start autoSelect=${rt.config.autoSelect} explicit=${explicitModelRequested(process.argv)} current=${ctx.model?.provider}/${ctx.model?.id}`);
		if (!rt.config.autoSelect) return;
		if (explicitModelRequested(process.argv)) return;
		if (ctx.model?.provider === "router") return;
		const model = ctx.modelRegistry.find("router", "auto");
		log?.(`session_start selecting router/auto found=${!!model}`);
		if (model) await pi.setModel(model);
	});

	// #25: exactly one message_end per assistant message, so this releases exactly once.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; provider?: string; model?: string };
		if (message.role !== "assistant" || message.provider !== "lmstudio" || !message.model) return;
		governor.releaseOne(message.model);
	});

	// Safety net for teardown; stale reaping covers crashes.
	process.once("exit", () => governor.releaseAll());
}
