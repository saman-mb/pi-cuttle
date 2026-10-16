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

export interface PolicyConfig {
	mode: PolicyMode;
	/** Complexity below this routes local. Used when `mode` is `complexity`. */
	threshold: number;
	/** Model pair per phase, when `mode` is `phase`. */
	phase: { plan: Tier; implement: Tier };
	/** `session` classifies once per session; `turn` re-classifies on each user turn. */
	reclassify: "session" | "turn";
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
	/** Directory holding the cross-process slot files. `~` is expanded. */
	slotDir: string;
	/** A slot older than this is considered abandoned and reaped. */
	staleSlotMs: number;
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
	config?: { context_length?: number; parallel?: number };
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
	loadedModels: { key: string; instances: LoadedInstance[] }[];
	/** What the configured host can do; degraded hosts report fewer capabilities. */
	capabilities: HostCapabilities;
}
