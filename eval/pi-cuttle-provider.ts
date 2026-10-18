/**
 * Custom Promptfoo provider for pi-cuttle routing evaluation.
 *
 * Calls pi-cuttle's routeRequest() with a mocked ExtensionContext.
 * No live model needed for routing decision itself.
 *
 * Usage in promptfoo.yaml:
 *   providers:
 *     - id: file://pi-cuttle-provider.ts
 */
import type { ApiProvider, ProviderResponse } from "promptfoo";
import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai/compat";

import { routeRequest } from "../src/virtual-models.ts";
import type { RouterRuntime } from "../src/virtual-models.ts";
import { DEFAULTS } from "../src/config.ts";
import type { RouterConfig, Tier, RouterFlavor } from "../src/types.ts";
import { isSubagent } from "../src/subagent.ts";

interface RoutingOutput {
	tier: Tier;
	modelId: string;
	flavor: RouterFlavor;
	thinkingLevel: string;
	decision: {
		source: string;
		reason: string;
		score?: number;
	};
	isSubagent: boolean;
	localBiasApplied: boolean;
	userCeilingRespected: boolean;
	requestedThinkingLevel?: string;
	effectiveThinkingLevel: string;
	complexityScore?: number;
}

function makeFakeContext(): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => "test-session-eval",
		},
		modelRegistry: {
			find: (provider: string, id: string) => {
				// Return fake models for testing
				if (provider === "lmstudio" && id === "meta/muse-glimmer") {
					return {
						id: "meta/muse-glimmer",
						provider: "lmstudio",
						name: "Muse Glimmer",
						api: "openai-completions" as any,
						baseUrl: "http://localhost:1235/v1",
						contextWindow: 131072,
						maxTokens: 32768,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						input: ["text", "image"],
						reasoning: true,
						thinkingLevelMap: {
							off: "none",
							minimal: null,
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
							max: "xhigh",
						},
					} as Model<Api>;
				}
				if (provider === "lmstudio" && id === "prism-ml/bonsai-27b") {
					return {
						id: "prism-ml/bonsai-27b",
						provider: "lmstudio",
						name: "Bonsai 27B",
						api: "openai-completions" as any,
						baseUrl: "http://localhost:1235/v1",
						contextWindow: 262144,
						maxTokens: 32768,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						input: ["text", "image"],
						reasoning: true,
						thinkingLevelMap: {
							off: "none",
							minimal: null,
							low: null,
							medium: null,
							high: "high",
							xhigh: null,
							max: null,
						},
					} as Model<Api>;
				}
				if (provider === "opencode-go" && id === "deepseek-v4.1-flash") {
					return {
						id: "deepseek-v4.1-flash",
						provider: "opencode-go",
						name: "DeepSeek V4.1 Flash",
						api: "openai-completions" as any,
						baseUrl: "https://api.opencode-go.ai/v1",
						contextWindow: 1000000,
						maxTokens: 384000,
						cost: { input: 0.14, output: 0.56, cacheRead: 0, cacheWrite: 0 },
						input: ["text", "image"],
						reasoning: true,
						thinkingLevelMap: {
							off: null,
							minimal: null,
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
							max: "xhigh",
						},
					} as Model<Api>;
				}
				return undefined;
			},
			getAvailable: () => [],
			findOfType: () => undefined,
			getModelsOfType: () => [],
			classify: async () => ({
				stopReason: "stop" as any,
				answers: {
					complexity: {
						type: "choice" as any,
						choice: "standard",
						probabilities: { standard: 0.7, complex: 0.3 },
						confidence: 0.8,
					},
				},
			}),
		},
		getContextUsage: () => ({ tokens: 1000 }),
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => "",
			notify: () => {},
		},
	} as unknown as ExtensionContext;
}

function makeFakeRuntime(config: RouterConfig): RouterRuntime {
	return {
		config,
		governor: {
			acquire: async () => ({
				id: "test-slot",
				modelKey: "test",
				file: "/tmp/test",
				pid: 123,
				startedAt: Date.now(),
			}),
			release: async () => {},
			releaseOne: () => {},
			status: async () => ({ slots: [], localMax: 1 }),
		},
		pins: new Map(),
		previousModels: new Map(),
		classifierFailures: 0,
		classifierBackoffUntil: 0,
		log: undefined,
	} as RouterRuntime;
}

class PiCuttleProvider implements ApiProvider {
	readonly config: Record<string, unknown>;

	constructor(options: { id?: string; config?: Record<string, unknown> } = {}) {
		this.config = options.config || {};
	}

	id() {
		return "pi-cuttle-router";
	}

	async callApi(prompt: string, context?: any): Promise<ProviderResponse> {
		try {
			const thinkingLevel = (context?.vars?.thinkingLevel as string) ?? "medium";
			const flavor = (context?.vars?.flavor as RouterFlavor) ?? "auto";
			const isSubagentRequest = context?.vars?.isSubagent === true;

			// Set subagent environment variable if fixture requests it
			if (isSubagentRequest) {
				process.env.PI_SUBAGENT_CHILD = "1";
			} else {
				delete process.env.PI_SUBAGENT_CHILD;
			}

			// Configure router with features enabled for comprehensive testing
			const config: RouterConfig = {
				...DEFAULTS,
				classifier: { ...DEFAULTS.classifier, model: undefined }, // use heuristic
				catalog: {
					local: ["lmstudio/meta/muse-glimmer", "lmstudio/prism-ml/bonsai-27b"],
					cloud: ["opencode-go/deepseek-v4.1-flash"],
				},
				capabilities: {
					"lmstudio/meta/muse-glimmer": 0.5,
					"lmstudio/prism-ml/bonsai-27b": 1.0,
				},
				policy: {
					...DEFAULTS.policy,
					localBias: 0.1, // Enable local bias for testing
					subagent: {
						// When running as a subagent, force local routing for eval coverage.
						threshold: 1.0,
						mode: "complexity",
					},
					thinkingLevels: {
						enabled: true,
						map: [
							{ score: 0.2, level: "off" },
							{ score: 0.4, level: "low" },
							{ score: 0.6, level: "medium" },
							{ score: 0.75, level: "high" },
						],
						default: "high",
						enforceUserCeiling: true,
					},
				},
			};

			const ctx = makeFakeContext();
			const rt = makeFakeRuntime(config);

			const request = {
				model: { id: flavor, provider: "cuttle" } as any,
				thinkingLevel: thinkingLevel as any,
				reason: "user" as const,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
				state: undefined,
				failed: undefined,
			};

			const result = await routeRequest(rt, flavor, request as any, ctx);

			const output: RoutingOutput = {
				tier: result.model.provider === "opencode-go" ? "cloud" : "local",
				modelId: `${result.model.provider}/${result.model.id}`,
				flavor,
				thinkingLevel: result.thinkingLevel,
				decision: {
					source: result.state?.decision.source ?? "heuristic",
					reason: result.state?.decision.reason ?? "",
					score: result.state?.decision.score,
				},
				isSubagent: isSubagent(),
				localBiasApplied: config.policy.localBias !== undefined && config.policy.localBias > 0,
				userCeilingRespected: config.policy.thinkingLevels?.enforceUserCeiling !== false,
				requestedThinkingLevel: thinkingLevel,
				effectiveThinkingLevel: result.thinkingLevel,
				complexityScore: result.state?.decision.score,
			};

			return {
				output,
			};
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

export default PiCuttleProvider;
