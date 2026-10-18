/**
 * Minimal LangFuse HTTP client for pi-cuttle routing traces (#88).
 *
 * Does not depend on the LangFuse SDK so the extension stays lightweight.
 * Writes are best-effort: failures are logged but never break a turn.
 */
import type { ObservabilityConfig } from "./types.ts";

export interface RoutingTrace {
	traceId: string;
	name: string;
	prompt: string;
	tier: string;
	modelId: string;
	flavor: string;
	thinkingLevel: string;
	score?: number;
	reason: string;
	source: string;
	isSubagent: boolean;
	localBias?: number;
	enforceUserCeiling?: boolean;
}

/**
 * A child session that inherited a non-`cuttle/*` model (#130). The router never saw it, so it has
 * no routing trace; recording the bypass is the only way its tier becomes visible.
 */
export interface ChildBypassObservation {
	traceId: string;
	/** Trace name; defaults to "pi-cuttle child bypass". */
	name?: string;
	/** The physical model the child actually landed on. */
	modelId: string;
	/** Why the child was not claimed. */
	kind: "subagent" | "parent-session";
	/** The session's parent, when the runtime exposes it. */
	parentSession?: string;
	reason: string;
}

export interface LangFuseTrace {
	id: string;
	timestamp: string;
	name: string;
	metadata?: Record<string, unknown>;
	tags?: string[];
}

export interface LangFuseTraceList {
	data: LangFuseTrace[];
}

export class LangFuseClient {
	private readonly cfg: ObservabilityConfig;
	private readonly auth: string;
	private readonly baseUrl: string;

	constructor(cfg: ObservabilityConfig) {
		this.cfg = cfg;
		this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
		this.auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
	}

	/** POST one payload. A 409 means it already exists, which is harmless. */
	private async post(path: string, body: unknown): Promise<void> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.auth,
			},
			body: JSON.stringify(body),
		});
		if (response.ok || response.status === 409) return;
		throw new Error(`LangFuse ${path} failed: ${response.status} ${await response.text()}`);
	}

	async trace(decision: RoutingTrace): Promise<void> {
		await this.post("/api/public/traces", {
			id: decision.traceId,
			name: decision.name,
			metadata: {
				tier: decision.tier,
				modelId: decision.modelId,
				flavor: decision.flavor,
				thinkingLevel: decision.thinkingLevel,
				score: decision.score,
				reason: decision.reason,
				source: decision.source,
				isSubagent: decision.isSubagent,
				localBias: decision.localBias,
				enforceUserCeiling: decision.enforceUserCeiling,
			},
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a child session that inherited a non-`cuttle/*` model (#130).
	 *
	 * Such a child never calls `route()`, so no routing trace can exist for it and its tier and cost
	 * are invisible. Emitting `routed: false` plus the model it actually landed on makes the
	 * fall-through docs/SUBAGENTS.md warns about observable instead of silent.
	 */
	async bypass(observation: ChildBypassObservation): Promise<void> {
		await this.post("/api/public/traces", {
			id: observation.traceId,
			name: observation.name ?? "pi-cuttle child bypass",
			metadata: {
				routed: false,
				kind: observation.kind,
				isSubagent: observation.kind === "subagent",
				modelId: observation.modelId,
				parentSession: observation.parentSession,
				reason: observation.reason,
			},
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Ingest one score against a trace (#132). Hand-rolled like the rest of the client: no SDK.

	 * Best-effort by contract — callers fire and forget, and a failure here must never reach a turn.
	 */
	async score(entry: { traceId: string; name: string; value: boolean | number | string; dataType: string }): Promise<void> {
		await this.post("/api/public/scores", {
			traceId: entry.traceId,
			name: entry.name,
			value: entry.value,
			dataType: entry.dataType,
		});
	}

	async fetchTraces(from?: Date, to?: Date, tags?: string[]): Promise<LangFuseTrace[]> {
		const params = new URLSearchParams();
		params.set("limit", "100");
		if (from) params.set("fromTimestamp", from.toISOString());
		if (to) params.set("toTimestamp", to.toISOString());
		if (tags && tags.length > 0) {
			for (const tag of tags) params.append("tags", tag);
		}

		const response = await fetch(`${this.baseUrl}/api/public/traces?${params.toString()}`, {
			headers: { Authorization: this.auth },
		});
		if (!response.ok) {
			throw new Error(`LangFuse fetchTraces failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as LangFuseTraceList;
		return body.data ?? [];
	}

	async health(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/api/public/health`, {
				headers: { Authorization: this.auth },
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}
