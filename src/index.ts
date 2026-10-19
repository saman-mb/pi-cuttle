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
 *   - #28: children only route if they load this extension. The operator's manual setup adds it to
 *          `subagents.defaultSubagentOnlyExtensions`; since #131 the router also registers itself as
 *          a required child extension, so the manual config is a fallback rather than the fix.
 *   - #95: auto-select never claims a session whose model was already chosen — subagent
 *          children (`PI_SUBAGENT_CHILD=1`) and any session with a `parentSession` header
 *          (foreground children, forks). Claiming a child fails pi-subagents' model
 *          verification against its launch candidate.
 *   - #131: a foreground child does not load the parent's ambient extensions, so it inherits the
 *          parent's providers but not its `registerVirtualModel` models. Registering the router
 *          with pi-subagents' `registerRequiredChildExtensions` makes the router load in every
 *          child; the integration is optional and every failure path is soft.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { splitRef } from "./classifier.ts";
import { isSubagent } from "./subagent.ts";
import { bypassScores } from "./scores.ts";
import { LocalGovernor } from "./governor.ts";
import { registerCuttleCommand } from "./commands.ts";
import { Telemetry, isPhysicalTurn } from "./telemetry.ts";
import { registerVirtualModels, type RouterRuntime } from "./virtual-models.ts";
import { createRequiredChildExtensionController } from "./required-child-extension.ts";
import { LangFuseClient } from "./langfuse.ts";
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

/**
 * True when this session was created by another session — a subagent child, a fork, or a clone.
 * Those already have a model chosen for them, so auto-select must not claim them (#95).
 */
function hasParentSession(ctx: { sessionManager?: { getHeader?: () => { parentSession?: string } | null | undefined } }): boolean {
	try {
		return Boolean(ctx.sessionManager?.getHeader?.()?.parentSession);
	} catch {
		return false;
	}
}

/**
 * Record a child session that never entered the router (#130).
 *
 * A child whose launch model is not a `cuttle/*` virtual model never calls `route()`, so no routing
 * trace can exist for it: its tier, model and cost are invisible. That is exactly the gap that let a
 * local-only parent delegate to cloud children unseen. Emitting a bypass observation makes the
 * fall-through observable in LangFuse (`routed: false`) and in the debug log.
 *
 * Deliberately records rather than throws: a child deliberately pinned to a cloud model is
 * legitimate (`subagents.agentOverrides.<role>.model`), so this is a diagnostic, not a gate.
 */
function observeChildBypass(rt: RouterRuntime, ctx: ExtensionContext, kind: "subagent" | "parent-session"): void {
	const model = ctx.model;
	const ref = model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
	// A child that did route is already covered by the routing trace, which carries `isSubagent`.
	if (ref && ref.startsWith(`${VIRTUAL_PROVIDER}/`)) return;
	const sessionId = safeSessionId(ctx) ?? "unknown";
	let parentSession: string | undefined;
	try {
		const header = ctx.sessionManager?.getHeader?.() as { parentSession?: string } | null | undefined;
		parentSession = header?.parentSession ?? undefined;
	} catch {
		parentSession = undefined;
	}
	const reason =
		kind === "subagent"
			? "subagent child launched on a non-cuttle model, so it never entered the router"
			: "session with a parent launched on a non-cuttle model, so it never entered the router";
	rt.log?.(`child bypass kind=${kind} model=${ref ?? "unknown"} session=${sessionId}`);
	if (!rt.langfuse) return;
	const traceId = `${sessionId}-bypass-${Date.now()}`;
	const langfuse = rt.langfuse;
	// The score follows the trace: scoring before the trace lands, or letting it outlive the
	// session, both mislead. Best-effort throughout — a failure is logged, never thrown.
	void langfuse
		.bypass({ traceId, modelId: ref ?? "unknown", kind, parentSession, reason })
		.then(() => Promise.all(bypassScores().map((entry) => langfuse.score({ traceId, ...entry }))))
		.catch((error) => rt.log?.(`langfuse bypass failed: ${error instanceof Error ? error.message : String(error)}`));
}

/**
 * Absolute path to this extension's entry module, used to tell pi-subagents which extension
 * every child must load (#131). `import.meta.url` is the file pi loaded, so an installed copy and
 * a checkout each register themselves rather than a stale configured path.
 */
function extensionEntryPath(): string {
	try {
		return fileURLToPath(import.meta.url);
	} catch {
		return "";
	}
}

export default function modelRouter(pi: ExtensionAPI): void {
	const loaded = loadConfig(process.cwd());
	const debugPath = process.env.PI_CUTTLE_DEBUG;
	// A late log line must never throw: the debug file can be gone by the time an async emission
	// settles, and logging is diagnostic, not load-bearing.
	const log = debugPath
		? (message: string) => {
				try {
					appendFileSync(debugPath, message + "\n");
				} catch {
					/* the debug file is gone; drop the line */
				}
			}
		: undefined;
	log?.(`factory cwd=${process.cwd()} autoSelect=${loaded.config.autoSelect} local=${loaded.config.catalog.local.join(",")} cloud=${loaded.config.catalog.cloud.join(",")} sources=${loaded.sources.join("|")} warnings=${loaded.warnings.join(";")}`);
	const governor = new LocalGovernor(loaded.config.local);
	const telemetry = new Telemetry(loaded.config.telemetry, loaded.config.catalog.local);
	const langfuse = loaded.config.observability?.enabled ? new LangFuseClient(loaded.config.observability) : undefined;
	log?.(`observability=${loaded.config.observability?.enabled ? loaded.config.observability.provider : "off"}`);

	const rt: RouterRuntime = {
		config: loaded.config,
		governor,
		pins: new Map(),
		previousModels: new Map(),
		classifierFailures: 0,
		classifierBackoffUntil: 0,
		log,
		langfuse,
		// #26: read lazily; the value is undefined inside the factory.
		getForced: () => {
			const value = pi.getFlag("cuttle-force");
			return value === "local" || value === "cloud" ? (value as Tier) : undefined;
		},
	};

	pi.registerFlag("cuttle-force", { type: "string", description: "Force the tier for this invocation: local | cloud" });

	registerVirtualModels(pi, rt);
	registerCuttleCommand(pi, rt, loaded, telemetry);

	// #131: the router loads in every child, so a foreground child on an inherited `cuttle/*` model
	// resolves it instead of dying at preflight with `Model "…" not found`. Registered for every
	// session that loads this extension, not just top-level ones: a child that itself delegates
	// needs the same snapshot, and pi-subagents keys the registry by session id, so a nested
	// session registers under its own id rather than shadowing its parent's.
	const requiredChildExtension = createRequiredChildExtensionController(log ? { log } : {});

	pi.on("session_start", async (_event, ctx) => {
		log?.(`session_start autoSelect=${rt.config.autoSelect} explicit=${explicitModelRequested(process.argv)} current=${ctx.model?.provider}/${ctx.model?.id}`);
		const requiredChildSessionId = safeSessionId(ctx);
		if (requiredChildSessionId) await requiredChildExtension.register(requiredChildSessionId, extensionEntryPath());
		if (!rt.config.autoSelect) return;
		if (explicitModelRequested(process.argv)) return;
		if (ctx.model?.provider === VIRTUAL_PROVIDER) return;
		// #95: a session created by another session already has a model chosen for it — a subagent
		// child gets its launcher's candidate, a fork inherits its parent's. Children that should
		// route arrive on a `cuttle/*` model and are handled by the guard above.
		if (isSubagent()) {
			log?.("session_start subagent child, leaving model unchanged");
			observeChildBypass(rt, ctx, "subagent");
			return;
		}
		if (hasParentSession(ctx)) {
			log?.("session_start child session, leaving model unchanged");
			observeChildBypass(rt, ctx, "parent-session");
			return;
		}
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

	// Release only this session's snapshot. Another session in the same process still has children.
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = safeSessionId(ctx);
		if (sessionId) requiredChildExtension.dispose(sessionId);
		else requiredChildExtension.dispose();
	});

	// Safety net for teardown; stale reaping covers crashes.
	process.once("exit", () => {
		requiredChildExtension.dispose();
		governor.releaseAll();
	});
}
