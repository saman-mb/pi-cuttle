/**
 * The parent-side guard for subagent launches (#130).
 *
 * A `cuttle/local`, `cuttle/fast-local` or `cuttle/big-local` session runs under a contract: this
 * work never reaches a cloud model. A delegation breaks that contract silently when the launch names
 * a cloud model explicitly — `subagent({agent: "scout", model: "opencode-go/..."})` — because the
 * child then runs on a model the router never saw. That is the leak this module closes.
 *
 * It runs in the *parent* process, on `tool_call`, for two reasons measured on pi 1.3.0:
 *   - a `tool_call` handler returning `{ block: true, reason }` stops the child before it starts
 *     (two probe runs: zero child sessions, zero artifacts);
 *   - it is the only place that also covers a child that never loaded pi-cuttle. Child model choice
 *     belongs to pi-subagents; this guard reads its tool arguments and nothing else, so it depends
 *     on no other extension's hooks (AGENTS.md: `route()` must be self-contained).
 *
 * Two shapes are pinned here because both were measured, not inferred:
 *   - the requested model lives at `event.input.model`. `docs/extensions.md` and
 *     `dist/core/extensions/types.d.ts` say `args`; the runtime emits `input`. Read `input` first,
 *     `args` as fallback — a future pi that matches the docs must not silently disable the guard.
 *   - a terse reason gets quoted back as if it were the child's answer (a `PROBE2-BLOCKED` reason
 *     burned a confused turn). So the reason names itself a notice and ends with what to do.
 *
 * Everything unverifiable fails **open**: a guard bug must never cost a session a turn.
 */
import { splitRef } from "./classifier.ts";
import { VIRTUAL_PROVIDER } from "./types.ts";
import { isLocalOnlyFlavor } from "./virtual-models.ts";
import type { DelegationMode, RouterFlavor } from "./types.ts";

/**
 * The tools that start a child session: pi-subagents registers these two
 * (`src/extension/index.js:608`, `tool-activation.js:7`). Exact match, no prefix guessing — another
 * tool that happens to carry a `model` field is not a delegation.
 */
export const LAUNCH_TOOLS = ["subagent", "subagent_supervisor"] as const;

/** What the guard could see of one `tool_call` event, plus what it needs to decide. */
export interface DelegationCallInput {
	/** The tool being called, read off the event. */
	toolName: string;
	/** The raw `tool_call` event: `{type, toolName, toolCallId, input}` at runtime, `args` per docs. */
	event: unknown;
	/** The session's current model — the virtual selection, not the physical model it routed to. */
	model: { provider: string; id: string } | undefined;
	mode: DelegationMode;
	/** Providers treated as local, from `local.providers`. */
	localProviders: readonly string[];
}

/** What the guard saw, before the mode decides what to do about it. */
export type DelegationVerdict =
	/** Nothing to act on: not a launch tool, nothing readable, or nothing classifiable. */
	| "skipped"
	/** A child model was named and it is served locally: the local-only contract holds. */
	| "local"
	/** A local-only flavor met an explicitly requested cloud model. */
	| "cloud";

export interface DelegationOutcome {
	verdict: DelegationVerdict;
	/** Only `block` blocks. `warn` and `off` still count the launch. */
	action: "allow" | "block";
	/** The refused model, for the debug log; `/cuttle status` shows counts, not models. */
	model?: string;
	/** True when the guard allowed the call because it could not determine something. */
	failOpen?: boolean;
	/** The text handed back to the calling model when a launch is blocked. */
	reason?: string;
}

/**
 * Per-process guard state, one per loaded extension, so counts cannot leak between installs.
 * `blocked` is what the guard refused; `allowed` is what it saw and let through — in `warn` and
 * `off` alike, because "did the leak still happen?" is the question a user brings to status.
 */
export interface DelegationGuard {
	/** Read per call, so a config edit takes effect without reloading the extension. */
	getMode(): DelegationMode;
	localProviders: readonly string[];
	blocked: number;
	allowed: number;
	/** Debug sink, from `PI_CUTTLE_DEBUG`. Per-launch detail lives here, not in status. */
	log?: (message: string) => void;
}

export function createDelegationGuard(
	input: { getMode: () => DelegationMode; localProviders: readonly string[]; log?: (message: string) => void },
): DelegationGuard {
	return {
		getMode: input.getMode,
		localProviders: input.localProviders,
		blocked: 0,
		allowed: 0,
		...(input.log ? { log: input.log } : {}),
	};
}

/** True for the two tools that start a child. Exact match, no prefix guessing. */
export function isLaunchTool(toolName: string): boolean {
	return (LAUNCH_TOOLS as readonly string[]).includes(toolName);
}

/**
 * True when the session is on a flavor that promises never to reach cloud.
 *
 * Reuses `isLocalOnlyFlavor` rather than repeating the list: `subagent-audit.ts` keeps its own copy
 * and a test pins the two together, so a third copy here would be a third thing to drift.
 */
export function isLocalOnlyModel(model: { provider: string; id: string } | undefined): boolean {
	if (!model || model.provider !== VIRTUAL_PROVIDER) return false;
	// A ref can carry a thinking suffix (`cuttle/local:high`) while a physical model id may itself
	// contain a colon, so only strip the suffix after the flavor position.
	const flavor = model.id.split(":")[0] as RouterFlavor;
	return isLocalOnlyFlavor(flavor);
}

/**
 * The requested child model, from the runtime shape (`input`) or the documented one (`args`).
 * Undefined means nothing readable: no payload, no `model`, or a non-string. `input` wins when both
 * are present, because that is what pi actually emits today.
 */
export function requestedChildModel(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as { input?: unknown; args?: unknown };
	for (const payload of [record.input, record.args]) {
		if (typeof payload !== "object" || payload === null) continue;
		const model = (payload as { model?: unknown }).model;
		if (typeof model === "string" && model.length > 0) return model;
	}
	return undefined;
}

/** True when the requested ref is served by one of the configured local providers. */
export function isLocalChildModel(model: string, localProviders: readonly string[]): boolean {
	const parsed = splitRef(model);
	if (!parsed) return false;
	return localProviders.includes(parsed.provider);
}

/**
 * True when a requested model would run on a cloud provider.
 *
 * A `cuttle/*` request is the router, not a cloud request: a child that cannot resolve it never
 * loaded the extension, which is #131 and deliberately not this gate's business. A ref with no
 * provider separator cannot be classified either way, so it is not treated as cloud.
 */
export function isCloudModel(model: string, localProviders: readonly string[]): boolean {
	const parsed = splitRef(model);
	if (!parsed) return false;
	if (parsed.provider === VIRTUAL_PROVIDER) return false;
	return !localProviders.includes(parsed.provider);
}

/**
 * Decide one launch. Pure: the caller owns counting and logging, so the rule is testable without a
 * guard, a context, or a pi process.
 */
export function evaluateDelegationCall(input: DelegationCallInput): DelegationOutcome {
	const skipped = (failOpen = false): DelegationOutcome => ({
		verdict: "skipped",
		action: "allow",
		...(failOpen ? { failOpen: true } : {}),
	});

	if (input.mode === "off") return skipped();
	if (!isLaunchTool(input.toolName)) return skipped();

	// No flavor means no contract to enforce: the session is either off the router entirely or in a
	// state with no model yet. Blocking on a guess would break ordinary sessions to catch a maybe.
	if (!isLocalOnlyModel(input.model)) return skipped(true);

	const requested = requestedChildModel(input.event);
	if (requested === undefined) return skipped(true);

	if (isLocalChildModel(requested, input.localProviders)) {
		// A local child is what a local-only session wants. Reported apart from `skipped` so the
		// debug log can tell a kept contract from an unreadable call.
		return { verdict: "local", action: "allow" };
	}
	if (!isCloudModel(requested, input.localProviders)) return skipped();

	const flavor = `${VIRTUAL_PROVIDER}/${input.model!.id}`;
	return {
		verdict: "cloud",
		action: input.mode === "block" ? "block" : "allow",
		model: requested,
		reason: blockReason(flavor, requested, input.localProviders),
	};
}

/**
 * The block notice handed back to the calling model.
 *
 * Order is deliberate and pinned by test: notice, active flavor, refused model and why it is
 * refused, then the two allowed moves. It must not read like data, because a reason that reads like
 * data gets quoted back as the child's answer.
 */
export function blockReason(flavor: string, requested: string, localProviders: readonly string[]): string {
	const local = localProviders.join(", ");
	return [
		`pi-cuttle: this is a block notice, not a subagent result. No subagent ran and nothing was delegated.`,
		`The session is on ${flavor}, which is local-only, and the requested child model ${requested} is not`,
		`served by a local provider, so launching a child on it is refused.`,
		`To continue: re-run this delegation without a model so the child inherits the session's routing, or`,
		`name a local model instead — one served by ${local}.`,
		`If a cloud child is intended here, that is a config choice (delegation.mode, see docs/CONFIG.md),`,
		`not a mistake to retry against the same flavor.`,
	].join(" ");
}

/**
 * Count one outcome and log it. Called in every mode, so a launch the guard let through is still
 * visible afterwards — that visibility is half of what #130 lacked.
 */
export function recordDelegationCall(guard: DelegationGuard, outcome: DelegationOutcome): void {
	if (outcome.verdict !== "cloud") return;
	if (outcome.action === "block") guard.blocked += 1;
	else guard.allowed += 1;
	guard.log?.(
		`delegation ${outcome.action} model=${outcome.model ?? "unknown"} mode=${guard.getMode()} ` +
			`counts=${guard.blocked}blocked/${guard.allowed}allowed`,
	);
}

/**
 * The `/cuttle status` line for the guard, or nothing when it has seen nothing.
 *
 * One line, counts only, and only when non-zero: the panel is where a user looks after a confusing
 * turn, and a permanent line about a guard that never fired is noise. Per-launch detail — which
 * model, which mode — goes to the debug log instead.
 */
export function statusDelegationLines(guard: DelegationGuard | undefined): string[] {
	if (!guard) return [];
	const mode = guard.getMode();
	if (mode === "off") return [];
	if (guard.blocked === 0 && guard.allowed === 0) return [];
	const counts = [
		guard.blocked > 0 ? `${guard.blocked} blocked` : undefined,
		guard.allowed > 0 ? `${guard.allowed} allowed` : undefined,
	].filter((part): part is string => part !== undefined);
	return [`delegation: ${counts.join(", ")} (mode ${mode})`];
}

/**
 * Wire one `tool_call` event to a decision: read it, count it, return what pi expects.
 *
 * Never throws. A throw in this hook is reported as a broken extension and costs the whole call,
 * which is exactly the failure mode a guard must not add, so the body is wrapped and any surprise
 * allows the launch.
 */
export function runDelegationGuard(
	guard: DelegationGuard,
	event: unknown,
	ctx: { model?: { provider: string; id: string } },
): { block?: boolean; reason?: string } | undefined {
	try {
		const toolName =
			typeof event === "object" && event !== null ? String((event as { toolName?: unknown }).toolName ?? "") : "";
		const outcome = evaluateDelegationCall({
			toolName,
			event,
			model: ctx.model,
			mode: guard.getMode(),
			localProviders: guard.localProviders,
		});
		recordDelegationCall(guard, outcome);
		if (outcome.action !== "block") return undefined;
		return { block: true, reason: outcome.reason };
	} catch (error) {
		guard.log?.(`delegation guard failed open: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
