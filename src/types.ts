/**
 * Shared types for pi-cuttle.
 *
 * Nothing here imports pi at runtime; these are plain data shapes so tests and the
 * governor can run outside a pi process.
 */

/**
 * The provider id the `cuttle/*` virtual models are registered under.
 *
 * Shared rather than repeated as a literal: the auto-select path, the virtual-model
 * registration, and the rule that a message attributed to this provider never reached a
 * physical model (#62) all have to agree on it.
 */
export const VIRTUAL_PROVIDER = "cuttle";

/** Which side of the local/cloud split a turn belongs on. */
export type Tier = "local" | "cloud";

/** Which of the registered virtual models is being selected. */
export type RouterFlavor = "auto" | "local" | "cloud" | "fast-local";

export interface ClassifierConfig {
	/** `provider/model` of the decision model. Discovered from pi's model registry. */
	model?: string;
	/** What to do when the classifier is unavailable or times out. */
	fallback: "heuristic" | Tier;
	timeoutMs: number;
	/** Characters of the prompt handed to the classifier. */
	stateChars: number;
}

export interface CatalogConfig {
	/** Ordered candidate local models, most-preferred first. */
	local: string[];
	/** Ordered candidate cloud models, most-preferred first. */
	cloud: string[];
}

export type PolicyMode = "complexity" | "phase" | "cost";

/** Struggle-based escalation (#41): what counts as flailing, and when to step back down. */
export interface EscalationConfig {
	/** Allow a local session to escalate to cloud on evidence of struggle. */
	enabled: boolean;
	/** Error results in the recent window that trigger escalation. */
	toolErrors: number;
	/** How many recent messages are scanned for struggle signals. */
	window: number;
	/** Consecutive clean user turns on the cloud side before re-classifying back. */
	cleanTurns: number;
}

export interface PolicyConfig {
	mode: PolicyMode;
	/** Complexity below this routes local. Used when `mode` is `complexity`. */
	threshold: number;
	/** Model pair per phase, when `mode` is `phase`. */
	phase: { plan: Tier; implement: Tier };
	/** `session` classifies once per session; `turn` re-classifies on each user turn. */
	reclassify: "session" | "turn";
	/** Struggle-based escalation (#41). */
	escalate: EscalationConfig;
}

export interface LocalConfig {
	/** Maximum concurrent local requests across every pi process on this machine. */
	maxConcurrent: number;
	/** Maximum concurrent local requests for any single local model. */
	maxConcurrentPerModel: number;
	/** Optional per-virtual-model concurrency budgets (e.g. { "local": 1, "fast-local": 1 }). */
	maxConcurrentByFlavor?: Record<string, number>;
	/** What to do when the local side is saturated. */
	onFull: "spill" | "wait";
	/** How long `wait` polls before giving up and spilling. */
	waitMs: number;
	/** Directory holding the cross-process slot files. `~` is expanded. */
	slotDir: string;
	/** A slot older than this is considered abandoned and reaped. */
	staleSlotMs: number;
	/** Provider ids treated as local for retry-to-cloud decisions. */
	providers: string[];
}

export interface TelemetryConfig {
	/** Append one JSONL line per assistant turn and expose `/cuttle stats`. */
	enabled: boolean;
	/** Ledger file. `~` is expanded. Metadata only, never prompt content. */
	path: string;
	/** USD per million tokens, keyed by `provider/model`. */
	pricing: Record<string, { input: number; output: number }>;
	/** Model ref the "saved vs all-cloud" baseline is priced at (usually catalog.cloud[0]). */
	baseline?: string;
}

/** A single gate's configuration. */
export interface GateConfig {
	/** When false, the gate is skipped entirely. */
	enabled: boolean;
	/**
	 * When true, the gate records its verdict but never changes routing. Shadow mode runs the
	 * gate against live traffic so its agreement with the existing router can be measured before
	 * it is allowed to escalate, delegate, or block.
	 */
	shadow?: boolean;
	/** Minimum confidence/probability before the gate's verdict is considered binding. */
	threshold?: number;
}

/** Candidate roles the classifier may assign when a gate asks for a role. */
export interface ChoiceGateConfig extends GateConfig {
	/** Ordered list of allowed answers. */
	choices?: string[];
}

/** Phase-2 routing gates, all off by default. */
export interface GatesConfig {
	/**
	 * Whether this turn should be delegated to a subagent. When confident and not in shadow mode,
	 * the router can return a delegation signal for the runtime to act on.
	 */
	delegate?: ChoiceGateConfig;
	/**
	 * What role the current turn should play (e.g. scout, worker, oracle, driver). Logged and,
	 * when not shadowed, attached to the decision for downstream tooling.
	 */
	role?: ChoiceGateConfig;
	/**
	 * After a subagent returns, judge whether its result satisfied the request. In shadow mode
	 * this is compared against the signal-based struggle/escalation path.
	 */
	judge?: GateConfig;
	/**
	 * Predict struggle from the prompt/conversation before any tool errors occur. Shadow mode
	 * compares this to the existing error-driven escalation.
	 */
	struggle?: GateConfig;
}

export interface RouterConfig {
	/** When true, new sessions start on `cuttle/auto` and routing is active. */
	autoSelect: boolean;
	classifier: ClassifierConfig;
	catalog: CatalogConfig;
	policy: PolicyConfig;
	local: LocalConfig;
	telemetry: TelemetryConfig;
	/** Optional phase-2 gates. */
	gates?: GatesConfig;
}

/** Router state persisted on the session branch by pi. Must be JSON-serializable. */
export interface RouterState {
	tier: Tier;
	/** The physical model id chosen for this tier. */
	modelId: string;
	/** Phase for the plan/implement split; `planning` until the first edit. */
	phase: "planning" | "implementation";
	/** Set when a local failure escalated this session; the next user turn re-decides (#37). */
	degradedFrom?: Tier;
	/** Set when struggle escalated a local session to cloud; drives the step back down (#41). */
	escalatedFrom?: Tier;
	/** Consecutive clean user turns since an escalation (#41). */
	cleanTurns?: number;
	decision: {
		source: "classifier" | "heuristic" | "pin";
		score?: number;
		reason: string;
	};
}

/** Answer to one gate question, normalized for logging and routing. */
export type GateAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "bool"; probability: number }
	| { type: "score"; score: number; confidence: number };

export interface GateVerdicts {
	delegate?: GateAnswer & { shadow: boolean };
	role?: GateAnswer & { shadow: boolean };
	judge?: GateAnswer & { shadow: boolean };
	struggle?: GateAnswer & { shadow: boolean };
}

export interface Decision {
	tier: Tier;
	score: number;
	source: "classifier" | "heuristic" | "pin";
	reason: string;
	/** Set when a classifier was configured but failed, so the tier fell back (#53). */
	classifierFailure?: { ref: string; message: string };
	/** Phase-2 gate verdicts, when gates are configured. */
	gates?: GateVerdicts;
}

/** Most recent classifier failure, surfaced by `/cuttle status` (#53). */
export interface ClassifierFailure {
	/** The configured classifier ref that failed. */
	ref: string;
	/** The failure text, possibly multi-line (host errors often are). */
	message: string;
	/** User-turn index the failure happened on, for "it still works?" context. */
	turn: number;
	/** Unix ms, for ordering and debugging. */
	at: number;
}

/** A reserved local slot. Mirrored to a file so other pi processes can see it. */
export interface Reservation {
	id: string;
	modelKey: string;
	file: string;
	pid: number;
	startedAt: number;
	sessionId?: string;
	/** The virtual-model flavor that reserved the slot, for per-role budgets. */
	flavor?: string;
}

export interface GovernorStatus {
	slots: Reservation[];
	localMax: number;
}
