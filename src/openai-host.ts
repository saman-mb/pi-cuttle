/**
 * Generic OpenAI-compatible host adapter (`local.host: "openai"`).
 *
 * Covers llama.cpp's `llama-server`, vLLM, text-generation-webui, and anything else
 * that serves `GET /v1/models` + `POST /v1/chat/completions`.
 *
 * This is the capability floor of the whole system: the OpenAI API is a menu —
 * order, receive. It says nothing about what is loaded in memory, so the governor
 * degrades to cross-process slot accounting only (docs/CONFIG.md capability
 * matrix). That still caps concurrency and still spills, which is the invariant
 * that matters; what it cannot do is cooperate with the host's own memory policy.
 */
import type { HostCapabilities, HostChatOptions, HostModel, LocalHost } from "./host.ts";
import type { OpenAiConfig } from "./types.ts";

interface ModelsResponse {
	data?: { id?: string }[];
}
interface ChatResponse {
	choices?: { message?: { content?: string } }[];
}

const FLOOR: HostCapabilities = {
	canListLoaded: false,
	canLoadUnload: false,
	hasDecisionModels: false,
	hasModelSizes: false,
};

export class OpenAiHost implements LocalHost {
	readonly kind = "openai" as const;
	readonly capabilities: HostCapabilities = FLOOR;

		private readonly cfg: OpenAiConfig;

	constructor(cfg: OpenAiConfig) {
		this.cfg = cfg;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
		return headers;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${this.cfg.baseUrl}${path}`, {
			...init,
			headers: this.headers(),
			signal: init?.signal ?? AbortSignal.timeout(this.cfg.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`openai host ${init?.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
		}
		return (await response.json()) as T;
	}

	async list(): Promise<HostModel[]> {
		const body = await this.request<ModelsResponse>("/v1/models");
		return (body.data ?? []).filter((m) => m.id).map((m) => ({ key: m.id! }));
	}

	async loaded(): Promise<{ key: string; instances: never[] }[]> {
		return [];
	}

	async load(_modelKey: string, _options: Record<string, unknown> = {}): Promise<void> {}
	async unload(_instanceId: string): Promise<void> {}

	async chat(modelKey: string, prompt: string, options: HostChatOptions = {}): Promise<string> {
		const body = await this.request<ChatResponse>("/v1/chat/completions", {
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
