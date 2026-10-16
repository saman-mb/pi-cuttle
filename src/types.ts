import type { HostCapabilities } from "./host.ts";

export type { HostCapabilities } from "./host.ts";

/**
 * Shared types for pi-model-router.
 *
 * Nothing here imports pi at runtime; these are plain data shapes so tests and the
 * governor can run outside a pi process.
 */

/** Which side of the local/cloud split a turn belongs on. */
export type Tier = "local" | "cloud";

/** Which of the registered virtual models is being selected. */
export type RouterFlavor = "auto" | "local" | "cloud" | "fast-local";

/** Which local-inference host serves local models. */
export type HostKind = "lmstudio" | "ollama" | "openai";

export interface ClassifierConfig {
	/** `provider/model` of the decision model. Local or cloud; both are valid. */
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
	/** Cooperative ceiling on models loaded in LM Studio at once. */
	maxLoadedModels: number;
	/** What to do when the local side is saturated. */
	onFull: "spill" | "wait";
	/** How long `wait` polls before giving up and spilling. */
	waitMs: number;
	/** Ask LM Studio to unload idle instances after this long. 0 disables. */
	idleUnloadMs: number;
	/** Warm the local target model at session start so turn one is not cold (#44). */
	preload: boolean;
	/** Never evict the local classifier under the loaded ceiling (#44). */
	pinClassifier: boolean;
	/** Directory holding the cross-process slot files. `~` is expanded. */
	slotDir: string;
	/** A slot older than this is considered abandoned and reaped. */
	staleSlotMs: number;
}

export interface TelemetryConfig {
	/** Append one JSONL line per assistant turn and expose `/router stats`. */
	enabled: boolean;
	/** Ledger file. `~` is expanded. Metadata only, never prompt content. */
	path: string;
	/** USD per million tokens, keyed by `provider/model`. */
	pricing: Record<string, { input: number; output: number }>;
	/** Model ref the "saved vs all-cloud" baseline is priced at (usually catalog.cloud[0]). */
	baseline?: string;
}

export interface LmStudioConfig {
	baseUrl: string;
	apiToken?: string;
	timeoutMs: number;
}

export interface OllamaConfig {
	baseUrl: string;
	timeoutMs: number;
}

export interface OpenAiConfig {
	baseUrl: string;
	apiKey?: string;
	timeoutMs: number;
}

export interface RouterConfig {
	/** Which local host serves local models (and the local classifier). */
	host: HostKind;
	autoSelect: boolean;
	classifier: ClassifierConfig;
	catalog: CatalogConfig;
	policy: PolicyConfig;
	local: LocalConfig;
	telemetry: TelemetryConfig;
	lmstudio: LmStudioConfig;
	ollama: OllamaConfig;
	openai: OpenAiConfig;
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

export interface Decision {
	tier: Tier;
	score: number;
	source: "classifier" | "heuristic" | "pin";
	reason: string;
	/** Set when a classifier was configured but failed, so the tier fell back (#53). */
	classifierFailure?: { ref: string; message: string };
}

/** Most recent classifier failure, surfaced by `/router status` (#53). */
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

export interface LoadedInstance {
	id: string;
	config?: {
		context_length?: number;
		parallel?: number;
		/** LM Studio's per-forward-pass token limit for decision models (#50). Read-only over REST. */
		physical_batch_size?: number;
		/** Reported alongside `physical_batch_size`; not the per-pass limit. */
		eval_batch_size?: number;
	};
	remaining_ttl_seconds?: number;
}

export interface LmModel {
	key: string;
	type?: string;
	state?: string;
	size_bytes?: number;
	max_context_length?: number;
	loaded_instances?: LoadedInstance[];
}

export interface GovernorStatus {
	slots: Reservation[];
	localMax: number;
	/** Model keys protected from ceiling eviction. */
	pinnedKeys: string[];
	loadedModels: { key: string; instances: LoadedInstance[] }[];
	/** What the configured host can do; degraded hosts report fewer capabilities. */
	capabilities: HostCapabilities;
}
