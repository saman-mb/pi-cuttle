/**
 * ollama host adapter (`local.host: "ollama"`, default `http://localhost:11434`).
 *
 * Verified against ollama's documented native API (not an OpenAI compatibility
 * shim, because the governor needs real load/unload control):
 *   GET  /api/tags    -> downloaded models { models: [{ name, size }] }
 *   GET  /api/ps      -> loaded models { models: [{ name, expires_at }] }
 *   POST /api/chat    -> chat completion { message: { content } }
 *   POST /api/generate with { keep_alive: 0 }   -> unload
 *   POST /api/generate with { keep_alive: "…" } -> load (ollama JIT-loads otherwise)
 *
 * ollama has no typed decision models and no per-instance handles: "unload" is
 * model-wide via keep_alive:0, so instance id == model name.
 */
import type { HostCapabilities, HostChatOptions, HostModel, LocalHost, SystemOneAnswer } from "./host.ts";
import type { OllamaConfig } from "./types.ts";

interface TagsResponse {
	models?: { name?: string; size?: number; model?: string }[];
}
interface PsResponse {
	models?: { name?: string; expires_at?: string }[];
}
interface ChatResponse {
	message?: { content?: string };
}

const FLOOR: HostCapabilities = {
	canListLoaded: false,
	canLoadUnload: false,
	hasDecisionModels: false,
	hasModelSizes: true,
};

export class OllamaHost implements LocalHost {
	readonly kind = "ollama" as const;
	readonly capabilities: HostCapabilities = {
		...FLOOR,
		canListLoaded: true,
		canLoadUnload: true,
	};

		private readonly cfg: OllamaConfig;

	constructor(cfg: OllamaConfig) {
		this.cfg = cfg;
	}

	private headers(): Record<string, string> {
		return { "content-type": "application/json" };
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${this.cfg.baseUrl}${path}`, {
			...init,
			headers: this.headers(),
			signal: init?.signal ?? AbortSignal.timeout(this.cfg.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`ollama ${init?.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
		}
		return (await response.json()) as T;
	}

	async list(): Promise<HostModel[]> {
		const body = await this.request<TagsResponse>("/api/tags");
		return (body.models ?? []).filter((m) => m.name).map((m) => ({ key: m.name!, ...(typeof m.size === "number" ? { size_bytes: m.size } : {}) }));
	}

	async loaded(): Promise<{ key: string; instances: { id: string; remaining_ttl_seconds?: number }[] }[]> {
		const body = await this.request<PsResponse>("/api/ps");
		const now = Date.now();
		return (body.models ?? [])
			.filter((m) => m.name)
			.map((m) => {
				const ttl = m.expires_at ? Math.max(0, Math.round((new Date(m.expires_at).getTime() - now) / 1000)) : undefined;
				return { key: m.name!, instances: [{ id: m.name!, ...(ttl !== undefined ? { remaining_ttl_seconds: ttl } : {}) }] };
			});
	}

	async load(modelKey: string, options: Record<string, unknown> = {}): Promise<void> {
		await this.request<unknown>("/api/generate", {
			method: "POST",
			body: JSON.stringify({ model: modelKey, keep_alive: options.keep_alive ?? "30m" }),
		});
	}

	async unload(modelKey: string): Promise<void> {
		await this.request<unknown>("/api/generate", {
			method: "POST",
			body: JSON.stringify({ model: modelKey, keep_alive: 0 }),
		});
	}

	async chat(modelKey: string, prompt: string, options: HostChatOptions = {}): Promise<string> {
		const body = await this.request<ChatResponse>("/api/chat", {
			method: "POST",
			body: JSON.stringify({
				model: modelKey,
				messages: [{ role: "user", content: prompt }],
				stream: false,
				...(options.maxTokens !== undefined ? { options: { num_predict: options.maxTokens } } : {}),
			}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		return body.message?.content ?? "";
	}

	/** ollama reports nothing usable as a model type today. */
	async modelType(_modelKey: string): Promise<string | undefined> {
		return undefined;
	}
}
