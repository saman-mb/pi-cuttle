/**
 * Audit real subagent launches against the router's local-only contract (#130).
 *
 * The offline eval cannot answer this: its `subagent-policy` fixtures run `flavor: auto` on an
 * in-process fake child, so a real launch contract — ambient extensions disabled, a model chosen
 * by the launcher — never occurs. Real runs do leave evidence, though. `pi-subagents` writes a
 * `*_meta.json` per run recording `model`, `requestedModel` and `launchResolvedExtensions`, and
 * the parent session records `model_change` entries. Together they say exactly which of the three
 * candidate causes fired:
 *
 *   - a child on a non-`cuttle/*` model with `requestedModel` set  -> an explicit override
 *     bypassed the router (the #130 leak)
 *   - a child on a non-`cuttle/*` model with no `requestedModel`   -> it inherited a non-router
 *     model from the parent
 *   - a `cuttle/*` child that failed with "not found"              -> #131, the child never loaded
 *     the extension and died loudly
 *
 * Deliberately pure and IO-free so it can be tested without a live pi install; the CLI in
 * eval/subagent-audit.ts does the file reading.
 */
import { VIRTUAL_PROVIDER } from "./types.ts";

/**
 * Flavors whose contract is "local only". Mirrors `isLocalOnlyFlavor` in virtual-models.ts; a test
 * pins that the two agree, so this copy cannot drift.
 */
export const LOCAL_ONLY_FLAVORS = ["local", "fast-local", "big-local"] as const;

export interface SubagentRunMeta {
	runId?: string;
	parentSessionId?: string;
	agent?: string;
	model?: string;
	requestedModel?: string;
	error?: string;
	durationMs?: number;
	launchResolvedExtensions?: {
		disableAmbientExtensions?: boolean;
		effective?: string[];
	};
}

/** How a child reached (or failed to reach) a model. */
export type ChildVerdict = "routed" | "bypass-override" | "bypass-inherited" | "crash";

/** One `model_change` entry from a pi session transcript. */
export interface ModelChange {
	timestamp: string;
	provider: string;
	modelId: string;
}

export interface AuditedRun {
	runId?: string;
	agent: string;
	/** The model the child actually ran on. */
	model: string;
	requestedModel?: string;
	verdict: ChildVerdict;
	/** The parent session's active model at launch, when resolvable. */
	parentModel?: string;
	/** True when the parent was on a local-only `cuttle/*` flavor. */
	parentLocalOnly: boolean;
	/** True when the child's model is in `catalog.local`. */
	childLocal: boolean;
	/** A local-only parent let a child reach a non-local model: the #130 defect. */
	violation: boolean;
	/** A local-only parent's child died because the router never loaded: #131. */
	crashUnderLocalOnly: boolean;
	detail: string;
}

/** True for a model ref served by the router itself. */
export function isVirtualRef(ref: string | undefined): boolean {
	return Boolean(ref && ref.startsWith(`${VIRTUAL_PROVIDER}/`));
}

/** Extract the flavor from a `cuttle/<flavor>[:level]` ref. */
export function flavorOf(ref: string | undefined): string | undefined {
	if (!isVirtualRef(ref)) return undefined;
	const afterProvider = ref!.slice(VIRTUAL_PROVIDER.length + 1);
	return afterProvider.split(":")[0];
}

/**
 * True when `ref` names a configured local model.
 *
 * A ref may carry a thinking suffix (`:high`) while a model id may itself contain a colon
 * (`ggml-org/Kev-9B-GGUF:Q8_0`), so match exact-or-`<local>:` rather than splitting on the colon.
 */
export function isLocalRef(ref: string | undefined, localCatalog: readonly string[]): boolean {
	if (!ref) return false;
	return localCatalog.some((local) => ref === local || ref.startsWith(`${local}:`));
}

/** Classify what actually happened to a child. */
export function classifyChild(meta: SubagentRunMeta): ChildVerdict {
	const model = meta.model ?? "";
	if (isVirtualRef(model)) {
		return meta.error && /not found/i.test(meta.error) ? "crash" : "routed";
	}
	// A non-router model was used. An explicit non-router request is the override that skipped
	// the router entirely; without one the child simply inherited a model the router does not own.
	return meta.requestedModel && !isVirtualRef(meta.requestedModel) ? "bypass-override" : "bypass-inherited";
}

/** The last `model_change` at or before `at`, i.e. the model active when the child launched. */
export function pickActiveModel(changes: readonly ModelChange[], at: Date): ModelChange | undefined {
	let active: ModelChange | undefined;
	for (const change of changes) {
		const when = new Date(change.timestamp);
		if (Number.isNaN(when.getTime())) continue;
		if (when.getTime() <= at.getTime()) active = change;
	}
	return active;
}

/** Judge one run against the contract its parent was under. */
export function auditRun(meta: SubagentRunMeta, parentModel: string | undefined, localCatalog: readonly string[]): AuditedRun {
	const verdict = classifyChild(meta);
	const model = meta.model ?? "";
	const childLocal = isLocalRef(model, localCatalog);
	const flavor = flavorOf(parentModel);
	const parentLocalOnly = Boolean(flavor && (LOCAL_ONLY_FLAVORS as readonly string[]).includes(flavor));
	const violation = parentLocalOnly && !childLocal && verdict.startsWith("bypass");
	const crashUnderLocalOnly = parentLocalOnly && verdict === "crash";
	const detail =
		verdict === "routed"
			? "child routed through the router"
			: verdict === "crash"
				? "child inherited a cuttle/* model but the router never loaded (#131)"
				: verdict === "bypass-override"
					? `child was explicitly launched on ${model}, bypassing the router`
					: `child inherited ${model} from its parent, bypassing the router`;
	return {
		runId: meta.runId,
		agent: meta.agent ?? "unknown",
		model,
		requestedModel: meta.requestedModel,
		verdict,
		parentModel,
		parentLocalOnly,
		childLocal,
		violation,
		crashUnderLocalOnly,
		detail,
	};
}

export interface AuditSummary {
	total: number;
	verdicts: Record<ChildVerdict, number>;
	violations: AuditedRun[];
	crashesUnderLocalOnly: AuditedRun[];
	/** Plain-language answer to "which candidate cause fired". */
	cause: string;
}

/** Roll runs up into the answer the ticket needs. */
export function summarize(runs: readonly AuditedRun[]): AuditSummary {
	const verdicts: Record<ChildVerdict, number> = { routed: 0, "bypass-override": 0, "bypass-inherited": 0, crash: 0 };
	for (const run of runs) verdicts[run.verdict] += 1;
	const violations = runs.filter((run) => run.violation);
	const crashesUnderLocalOnly = runs.filter((run) => run.crashUnderLocalOnly);
	let cause: string;
	if (verdicts["bypass-override"] > 0) {
		cause = "per-run override: children were explicitly launched on non-router models";
	} else if (verdicts["bypass-inherited"] > 0) {
		cause = "inheritance: children inherited a non-router model from their parent";
	} else if (verdicts.crash > 0) {
		cause = "extension load: children inherited cuttle/* but never loaded the router (#131)";
	} else if (verdicts.routed > 0) {
		cause = "none observed: every child routed through the router";
	} else {
		cause = "no runs found to audit";
	}
	return { total: runs.length, verdicts, violations, crashesUnderLocalOnly, cause };
}
