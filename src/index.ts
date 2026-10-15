/**
 * pi-model-router — extension entry point.
 *
 * Registers the `router/*` virtual-model family, the `/router` command, and the
 * slot-release hook. Everything it needs lives in `model-router.json` plus LM
 * Studio's local REST API.
 *
 * IMPORTANT: `route()` must stay self-contained. Foreground subagent children do
 * not reload ambient extensions, so the router may not depend on another
 * extension's hooks being active in the child.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import { LocalGovernor } from "./governor.ts";
import { LmStudioClient } from "./lmstudio.ts";
import { registerRouterCommand } from "./commands.ts";
import { registerVirtualModels, type RouterRuntime } from "./virtual-models.ts";
import type { Tier } from "./types.ts";

export default function modelRouter(pi: ExtensionAPI): void {
	const loaded = loadConfig(process.cwd());
	const lm = new LmStudioClient(loaded.config.lmstudio);
	const governor = new LocalGovernor(loaded.config.local, lm);
	const rt: RouterRuntime = { config: loaded.config, lm, governor, pins: new Map() };

	// `--router-force=local|cloud` applies to every session in this invocation.
	pi.registerFlag("router-force", { type: "string", description: "Force router tier: local | cloud" });
	const forced = pi.getFlag("router-force");
	if (forced === "local" || forced === "cloud") rt.forceAll = forced as Tier;

	registerVirtualModels(pi, rt);
	registerRouterCommand(pi, rt, loaded);

	// Release the local slot when the response that held it completes.
	// Release is approximate by design; stale reaping is the real safety net.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; provider?: string; model?: string };
		if (message.role !== "assistant" || message.provider !== "lmstudio" || !message.model) return;
		governor.releaseOne(message.model);
	});

	// Safety net for process teardown; stale reaping covers crashes.
	process.once("exit", () => governor.releaseAll());
}
