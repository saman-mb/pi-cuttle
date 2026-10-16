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
import { isLocalProvider, splitRef } from "./classifier.ts";
import { createHost } from "./host.ts";
import { LocalGovernor } from "./governor.ts";
import { registerRouterCommand } from "./commands.ts";
import { Telemetry } from "./telemetry.ts";
import { registerVirtualModels, type RouterRuntime } from "./virtual-models.ts";
import type { Tier } from "./types.ts";

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
	return argv.includes("--model") || argv.includes("-m");
}

export default function modelRouter(pi: ExtensionAPI): void {
	const loaded = loadConfig(process.cwd());
	const debugPath = process.env.PI_MODEL_ROUTER_DEBUG;
	const log = debugPath ? (message: string) => appendFileSync(debugPath, message + "\n") : undefined;
	log?.(`factory cwd=${process.cwd()} autoSelect=${loaded.config.autoSelect} local=${loaded.config.catalog.local.join(",")} cloud=${loaded.config.catalog.cloud.join(",")} sources=${loaded.sources.join("|")} warnings=${loaded.warnings.join(";")}`);
	const host = createHost(loaded.config);
	const governor = new LocalGovernor(loaded.config.local, host);
	const telemetry = new Telemetry(loaded.config.telemetry, loaded.config.catalog.local);

	const rt: RouterRuntime = {
		config: loaded.config,
		host,
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
				for (const model of await host.list()) {
					if (typeof model.size_bytes === "number") rt.sizes.set(model.key, model.size_bytes);
				}
			} catch {
				/* host offline; fast-local falls back to config order */
			}
		},
	};

	pi.registerFlag("router-force", { type: "string", description: "Force router tier: local | cloud" });

	registerVirtualModels(pi, rt);
	registerRouterCommand(pi, rt, loaded, telemetry);

	// #44: pin the local classifier against ceiling eviction and warm the local model
	// while the user types their first prompt. Both are fire-and-forget so session start
	// is never blocked by a model load.
	pi.on("session_start", async (_event, ctx) => {
		void rt.refreshSizes?.();
		const classifierRef = rt.config.classifier.model;
		const classifierParsed = classifierRef ? splitRef(classifierRef) : undefined;
		if (classifierParsed && isLocalProvider(classifierParsed.provider) && rt.config.local.pinClassifier) {
			governor.pin(classifierParsed.id);
			log?.(`session_start pinned classifier ${classifierParsed.id}`);
		}
		if (rt.config.local.preload && host.capabilities.canLoadUnload) {
			const warmTarget = rt.config.catalog.local[0];
			for (const ref of [classifierRef, warmTarget]) {
				const key = ref ? splitRef(ref)?.id : undefined;
				if (!key) continue;
				void host.load(key).then(
					() => log?.(`preload ok ${key}`),
					(error) => log?.(`preload failed ${key}: ${error instanceof Error ? error.message : String(error)}`),
				);
			}
		}
		log?.(`session_start autoSelect=${rt.config.autoSelect} explicit=${explicitModelRequested(process.argv)} current=${ctx.model?.provider}/${ctx.model?.id}`);
		if (!rt.config.autoSelect) return;
		if (explicitModelRequested(process.argv)) return;
		if (ctx.model?.provider === "router") return;
		const model = ctx.modelRegistry.find("router", "auto");
		log?.(`session_start selecting router/auto found=${!!model}`);
		if (model) await pi.setModel(model);
	});

	// #25: exactly one message_end per assistant message, so this releases exactly once.
	// #38: release for ANY provider. Slots are keyed by model id and only ever exist for
	// local models, so a cloud message is a harmless no-op; the old `provider === "lmstudio"`
	// guard leaked slots for ollama/llama.cpp-served local models.
	// #42: the same hook writes the decision ledger — metadata only, best-effort.
	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			provider?: string;
			model?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant" || !message.model) return;
		governor.releaseOne(message.model);
		telemetry.record({
			ts: Date.now(),
			...(safeSessionId(ctx) ? { sessionId: safeSessionId(ctx)! } : {}),
			provider: message.provider ?? "",
			model: message.model,
			tier: telemetry.isLocalModel(message.model) ? "local" : "cloud",
			inputTokens: message.usage?.input ?? 0,
			outputTokens: message.usage?.output ?? 0,
			...(message.usage?.cacheRead !== undefined ? { cacheReadTokens: message.usage.cacheRead } : {}),
			...(message.usage?.cacheWrite !== undefined ? { cacheWriteTokens: message.usage.cacheWrite } : {}),
		});
	});

	// Safety net for teardown; stale reaping covers crashes.
	process.once("exit", () => governor.releaseAll());
}
