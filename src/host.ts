/**
 * The local-inference host abstraction.
 *
 * The plugin used to speak LM Studio's native management API directly, which made
 * every other host impossible. `LocalHost` is the seam: each host (LM Studio,
 * ollama, any OpenAI-compatible server) implements this interface and declares
 * what it can actually do, and the governor/classifier degrade per capability
 * instead of assuming the world is LM Studio.
 *
 * Design constraints:
 *   - `route()` is self-contained: hosts are plain HTTP clients (docs/ARCHITECTURE.md #2).
 *   - Hosts expose *capabilities*, not a broken subset: a host that cannot list
 *     loaded models must not make the governor believe it enforced a ceiling.
 *   - `chat()` is the floor: every host can answer a classifier prompt.
 */
import type { LmStudioConfig } from "./types.ts";
import { LmStudioHost } from "./lmstudio.ts";
import { OllamaHost } from "./ollama.ts";
import { OpenAiHost } from "./openai-host.ts";
import type { HostKind, RouterConfig } from "./types.ts";

/** What a host can actually do. Capability flags are read at routing time. */
export interface HostCapabilities {
	/** Can report which models are currently loaded in memory (drives the loaded-model ceiling). */
	canListLoaded: boolean;
	/** Can explicitly load and unload models (drives ceiling enforcement and preload). */
	canLoadUnload: boolean;
	/** Serves `decision`-type models through a typed decision API (System One). */
	hasDecisionModels: boolean;
	/** Reports on-disk model sizes (drives `router/fast-local` ordering). */
	hasModelSizes: boolean;
}

/** A model known to the host. Mirrors the LM Studio catalog fields we need. */
export interface HostModel {
	key: string;
	/** Host-specific type (`llm`, `vlm`, `decision`, ...) when the host reports one. */
	type?: string;
	/** On-disk size in bytes when the host reports one. */
	size_bytes?: number;
	/** Reported max context length when the host knows it. */
	max_context_length?: number;
	/** LM Studio-style loaded instance handles when the host reports them. */
	loaded_instances?: HostInstance[];
}

export interface HostInstance {
	id: string;
	remaining_ttl_seconds?: number;
}

export interface HostChatOptions {
	maxTokens?: number;
	signal?: AbortSignal;
}

/** One local-inference host. Implementations live in `lmstudio.ts`, `ollama.ts`, `openai-host.ts`. */
export interface LocalHost {
	readonly kind: HostKind;
	readonly capabilities: HostCapabilities;

	/** Every model the host knows (downloaded + loadable). */
	list(): Promise<HostModel[]>;
	/** Models currently loaded in memory. Must return [] when `canListLoaded` is false. */
	loaded(): Promise<{ key: string; instances: HostInstance[] }[]>;
	/** Explicitly load a model (e.g. to kill cold start). Must no-op when unsupported. */
	load(modelKey: string, options?: Record<string, unknown>): Promise<void>;
	/** Unload a model/instance. Must no-op when unsupported. */
	unload(instanceId: string): Promise<void>;
	/** One-shot completion, used by the local classifier. The universal floor. */
	chat(modelKey: string, prompt: string, options?: HostChatOptions): Promise<string>;
	/** Host model type when the host reports one (optional capability). */
	modelType?(modelKey: string): Promise<string | undefined>;
	/** System One typed decision call (LM Studio `decision` models only). */
	systemOne?(
		modelKey: string,
		state: Record<string, unknown>,
		questions: Record<string, { type: string } & Record<string, unknown>>,
		options?: { signal?: AbortSignal },
	): Promise<{ answers: Record<string, SystemOneAnswer>; errorMessage?: string }>;
}

export interface SystemOneAnswer {
	type?: string;
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
	score?: number;
	noul?: boolean | number;
}

/** Build the host named by `config.host`. Deterministic; never throws. */
export function createHost(config: RouterConfig): LocalHost {
	switch (config.host) {
		case "ollama":
			return new OllamaHost(config.ollama);
		case "openai":
			return new OpenAiHost(config.openai);
		default:
			return new LmStudioHost(config.lmstudio as LmStudioConfig);
	}
}
