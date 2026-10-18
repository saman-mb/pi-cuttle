/**
 * pi-cuttle — extension entry point.
 *
 * Registers the `cuttle/*` virtual-model family, the `/cuttle` command, and the
 * session-start auto-selection. All models come from pi's own registry; the router
 * never hard-codes a local serving tool or talks to one directly.
 *
 * Delivery notes proven by the spikes (docs/ARCHITECTURE.md):
 *   - #24: `defaultModel` does NOT resolve an extension virtual model. "By default" is
 *          delivered by selecting `cuttle/auto` on `session_start` via `pi.setModel`. The
 *          default for `autoSelect` is false: the extension registers the virtual models but
 *          does not hijack the session model unless the user explicitly opts in.
 *   - #26: extension flags are unreadable during the factory; `--cuttle-force` is read lazily.
 *   - #25: `message_end` fires exactly once per assistant message.
 *   - #28: children only route if they load this extension, so the documented setup adds it
 *          to `subagents.defaultSubagentOnlyExtensions`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { splitRef } from "./classifier.ts";
import { LocalGovernor } from "./governor.ts";
import { registerCuttleCommand } from "./commands.ts";
import { Telemetry, isPhysicalTurn } from "./telemetry.ts";
import { registerVirtualModels, type RouterRuntime } from "./virtual-models.ts";
import type { Tier } from "./types.ts";
import { VIRTUAL_PROVIDER } from "./types.ts";

/** Session id for telemetry, tolerating a minimal context (tests, early teardown). */
function safeSessionId(ctx: { sessionManager?: { getSessionId?: () => string } }): string | undefined {
	try {
		return ctx.sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

/** True when the user pinned a model on the command line; auto-select must not override it. */
function explicitModelRequested(argv: readonly string[]): boolean {
	return argv.some(
		(arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model=") || arg.startsWith("-m="),
	);
}

export default function modelRouter(pi: ExtensionAPI): void {
	const loaded = loadConfig(process.cwd());
	const debugPath = process.env.PI_CUTTLE_DEBUG;
	const log = debugPath ? (message: string) => appendFileSync(debugPath, message + "\n") : undefined;
	log?.(`factory cwd=${process.cwd()} autoSelect=${loaded.config.autoSelect} local=${loaded.config.catalog.local.join(",")} cloud=${loaded.config.catalog.cloud.join(",")} sources=${loaded.sources.join("|")} warnings=${loaded.warnings.join(";")}`);
	const governor = new LocalGovernor(loaded.config.local);
	const telemetry = new Telemetry(loaded.config.telemetry, loaded.config.catalog.local);

	const rt: RouterRuntime = {
		config: loaded.config,
		governor,
		pins: new Map(),
		previousModels: new Map(),
		sizes: new Map(),
		log,
		// #26: read lazily; the value is undefined inside the factory.
		getForced: () => {
			const value = pi.getFlag("cuttle-force");
			return value === "local" || value === "cloud" ? (value as Tier) : undefined;
		},
	};

	pi.registerFlag("cuttle-force", { type: "string", description: "Force the tier for this invocation: local | cloud" });

	registerVirtualModels(pi, rt);
	registerCuttleCommand(pi, rt, loaded, telemetry);

	pi.on("session_start", async (_event, ctx) => {
		log?.(`session_start autoSelect=${rt.config.autoSelect} explicit=${explicitModelRequested(process.argv)} current=${ctx.model?.provider}/${ctx.model?.id}`);
		if (!rt.config.autoSelect) return;
		if (explicitModelRequested(process.argv)) return;
		if (ctx.model?.provider === VIRTUAL_PROVIDER) return;
		if (rt.config.catalog.local.length === 0 && rt.config.catalog.cloud.length === 0) {
			log?.("session_start no catalog configured, leaving model unchanged");
			return;
		}
		const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		if (currentRef && !currentRef.startsWith(`${VIRTUAL_PROVIDER}/`)) {
			rt.previousModels.set(ctx.sessionManager.getSessionId(), currentRef);
		}
		const model = ctx.modelRegistry.find(VIRTUAL_PROVIDER, "auto");
		log?.(`session_start selecting cuttle/auto found=${!!model}`);
		if (model) await pi.setModel(model);
	});

	// #25: exactly one message_end per assistant message, so this releases exactly once.
	// #38: release for ANY provider. Slots are keyed by model id and only ever exist for
	// local models, so a cloud message is a harmless no-op.
	// #62: the same hook writes the decision ledger — metadata only, best-effort.
	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			provider?: string;
			model?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant" || !message.model) return;
		governor.releaseOne(message.model);
		// #62: a message the provider layer attributes to the virtual provider means routing never
		// resolved a physical model — nothing ran, nothing was spent. Recording it as a cloud turn
		// would quietly deflates both the local share and the savings figure /cuttle stats reports.
		if (!isPhysicalTurn(message)) return;
		telemetry.record({
			ts: Date.now(),
			...(safeSessionId(ctx) ? { sessionId: safeSessionId(ctx)! } : {}),
			provider: message.provider ?? "",
			model: message.model,
			tier: telemetry.isLocalModel(`${message.provider}/${message.model}`) ? "local" : "cloud",
			inputTokens: message.usage?.input ?? 0,
			outputTokens: message.usage?.output ?? 0,
			...(message.usage?.cacheRead !== undefined ? { cacheReadTokens: message.usage.cacheRead } : {}),
			...(message.usage?.cacheWrite !== undefined ? { cacheWriteTokens: message.usage.cacheWrite } : {}),
		});
	});

	// Safety net for teardown; stale reaping covers crashes.
	process.once("exit", () => governor.releaseAll());
}
