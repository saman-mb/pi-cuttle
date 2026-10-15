/**
 * Minimal LM Studio REST client.
 *
 * Deliberately talks HTTP directly rather than going through pi's provider layer.
 * Foreground subagent children do not reload ambient extensions, so the router must
 * not depend on pi's LM Studio provider being present in the child.
 *
 * Verified endpoints (live probe, LM Studio on :1235):
 *   GET  /api/v1/models            -> { models: [{ key, loaded_instances: [{ id, config, remaining_ttl_seconds }] }] }
 *   POST /api/v1/models/load       -> { model, ...loadOptions }
 *   POST /api/v1/models/unload     -> { instance_id }
 *   POST /api/v1/chat              -> OpenAI-ish chat completion
 *
 * Note: `/api/v0/models` reports `loaded_instances: null` even for loaded models.
 * Use `/api/v1/models` as the source of truth for loaded state.
 */
import type { LoadedInstance, LmModel, LmStudioConfig } from "./types.ts";

interface ChatResponse {
	choices?: { message?: { content?: string } }[];
}

export class LmStudioClient {
	private readonly cfg: LmStudioConfig;

	constructor(cfg: LmStudioConfig) {
		this.cfg = cfg;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.cfg.apiToken) headers.authorization = `Bearer ${this.cfg.apiToken}`;
		return headers;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${this.cfg.baseUrl}${path}`, {
			...init,
			headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
			signal: init?.signal ?? AbortSignal.timeout(this.cfg.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`LM Studio ${init?.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
		}
		return (await response.json()) as T;
	}

	async healthy(): Promise<boolean> {
		try {
			await this.request<unknown>("/api/v1/models");
			return true;
		} catch {
			return false;
		}
	}

	async list(): Promise<LmModel[]> {
		const body = await this.request<{ models?: LmModel[]; data?: LmModel[] }>("/api/v1/models");
		return body.models ?? body.data ?? [];
	}

	/** Loaded models and their instances. The instance `id` is what `unload` needs. */
	async loaded(): Promise<{ key: string; instances: LoadedInstance[] }[]> {
		const models = await this.list();
		return models
			.filter((m) => Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0)
			.map((m) => ({ key: m.key, instances: m.loaded_instances ?? [] }));
	}

	async load(modelKey: string, options: Record<string, unknown> = {}): Promise<void> {
		await this.request<unknown>("/api/v1/models/load", {
			method: "POST",
			body: JSON.stringify({ model: modelKey, ...options }),
		});
	}

	async unload(instanceId: string): Promise<void> {
		await this.request<unknown>("/api/v1/models/unload", {
			method: "POST",
			body: JSON.stringify({ instance_id: instanceId }),
		});
	}

	/** One-shot chat completion, used by the local classifier. */
	async chat(modelKey: string, prompt: string, options: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<string> {
		const body = await this.request<ChatResponse>("/api/v1/chat", {
			method: "POST",
			body: JSON.stringify({
				model: modelKey,
				messages: [{ role: "user", content: prompt }],
				max_tokens: options.maxTokens ?? 8,
				temperature: 0,
				stream: false,
			}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		return body.choices?.[0]?.message?.content ?? "";
	}
}
