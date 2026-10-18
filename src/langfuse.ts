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

export class LangFuseClient {
	private readonly cfg: ObservabilityConfig;
	private readonly auth: string;
	private readonly baseUrl: string;

	constructor(cfg: ObservabilityConfig) {
		this.cfg = cfg;
		this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
		this.auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
	}

	async trace(decision: RoutingTrace): Promise<void> {
		const url = `${this.baseUrl}/api/public/traces`;
		const body = {
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
		};

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: this.auth,
				},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				// 409 means the trace already exists, which is harmless.
				if (response.status === 409) return;
				throw new Error(`LangFuse trace failed: ${response.status} ${await response.text()}`);
			}
		} catch (error) {
			// Best-effort: never throw. Callers may log if they wish.
			throw error;
		}
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
