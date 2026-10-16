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
import type { HostChatOptions, HostModel, LocalHost, SystemOneAnswer } from "./host.ts";
import type { LoadedInstance, LmStudioConfig } from "./types.ts";

interface ChatResponse {
	choices?: { message?: { content?: string } }[];
}

export class LmStudioHost implements LocalHost {
	readonly kind = "lmstudio" as const;
	readonly capabilities = { canListLoaded: true, canLoadUnload: true, hasDecisionModels: true, hasModelSizes: true };

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

	async list(): Promise<HostModel[]> {
		const body = await this.request<{ models?: HostModel[]; data?: HostModel[] }>("/api/v1/models");
		return body.models ?? body.data ?? [];
	}

	/** Loaded models and their instances. The instance `id` is what `unload` needs. */
	async loaded(): Promise<{ key: string; instances: LoadedInstance[] }[]> {
		const models = await this.list();
		return models
			.filter((m) => Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0)
			.map((m) => ({ key: m.key, instances: m.loaded_instances ?? [] }));
	}

	/**
	 * The loaded instance for a bare model id, or `undefined` when the model is not loaded.
	 * Used to read a decision model's real `physical_batch_size` (#50); best-effort, so an
	 * unreachable server reads as "not loaded" rather than failing the caller.
	 */
	async loadedInstance(modelKey: string): Promise<LoadedInstance | undefined> {
		try {
			const models = await this.loaded();
			return models.find((m) => m.key === modelKey)?.instances[0];
		} catch {
			return undefined;
		}
	}

	/**
	 * The loaded model's `physical_batch_size` (#50). LM Studio reports it per loaded instance
	 * and does not let REST raise it, so it is read, not configured. `undefined` when the model
	 * is not loaded (the catalog entry omits batch fields entirely).
	 */
	async physicalBatchSize(modelKey: string): Promise<number | undefined> {
		return (await this.loadedInstance(modelKey))?.config?.physical_batch_size;
	}

	async load(modelKey: string, options: Record<string, unknown> = {}): Promise<void> {
		// #64: LM Studio creates a NEW instance for every load call, even when the model is already
		// resident, and nothing reclaims the extras. The session-start preload calls this once per
		// session, so an unconditional load leaks an instance — and its VRAM — on every session,
		// while `maxLoadedModels` cannot see it because the ceiling counts distinct keys, not
		// instances. "Load" here means "ensure loaded", so a resident model is left alone.
		if (await this.loadedInstance(modelKey)) return;
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

	async chat(modelKey: string, prompt: string, options: HostChatOptions = {}): Promise<string> {
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

	/** Model type from the catalog (`llm`, `vlm`, `embeddings`, `decision`). */
	async modelType(modelKey: string): Promise<string | undefined> {
		try {
			const models = await this.list();
			return models.find((m) => m.key === modelKey)?.type;
		} catch {
			return undefined;
		}
	}

	/**
	 * System One decision call, used for `decision`-type models such as the Jev-family GGUFs.
	 *
	 * Protocol verified against pi's `typesafe-system-one` transport: POST to `/v1/systemone`
	 * with `{ model, state, questions }`, `bool` renamed to `noul`, and answers keyed by question id.
	 */
	async systemOne(
		modelKey: string,
		state: Record<string, unknown>,
		questions: Record<string, { type: string } & Record<string, unknown>>,
		options: { signal?: AbortSignal } = {},
		): Promise<{ answers: Record<string, SystemOneAnswer>; errorMessage?: string }> {
		const wire = Object.fromEntries(
			Object.entries(questions).map(([id, q]) => [id, q.type === "bool" ? { ...q, type: "noul" } : q]),
		);
		const body = await this.request<{ answers?: Record<string, SystemOneAnswer> }>("/v1/systemone", {
			method: "POST",
			body: JSON.stringify({ model: modelKey, state, questions: wire }),
			...(options.signal ? { signal: options.signal } : {}),
		});
		return { answers: body.answers ?? {} };
	}
}
