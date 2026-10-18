/**
 * Eval tests for pi-cuttle routing decisions.
 *
 * Loads fixtures from eval/routing-fixtures.jsonl and verifies that routeRequest()
 * makes correct routing decisions (tier, model characteristics, thinking level).
 *
 * Uses fake ExtensionContext with controlled config to ensure deterministic results.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai/compat";

import { routeRequest } from "../src/virtual-models.ts";
import type { RouterRuntime } from "../src/virtual-models.ts";
import { DEFAULTS } from "../src/config.ts";
import type { RouterConfig, RouterState, Tier } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(here, "routing-fixtures.jsonl");

interface RoutingFixture {
	prompt: string;
	expectedTier: Tier;
	expectedModel?: string;
	expectedThinkingLevel?: string;
	features?: string[];
	notes?: string;
}

function loadFixtures(): RoutingFixture[] {
	const text = readFileSync(fixturesPath, "utf8");
	const fixtures: RoutingFixture[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		fixtures.push(JSON.parse(line) as RoutingFixture);
	}
	return fixtures;
}

function makeFakeContext(): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => "test-session",
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
			acquire: async () => ({ id: "test-slot", modelKey: "test", file: "/tmp/test", pid: 123, startedAt: Date.now() }),
			release: async () => {},
			releaseOne: () => {},
			status: async () => ({ slots: [], localMax: 1 }),
		},
		pins: new Map(),
		previousModels: new Map(),
		classifierFailures: 0,
		classifierBackoffUntil: 0,
	} as RouterRuntime;
}

describe("routing fixtures", () => {
	const fixtures = loadFixtures();
	const ctx = makeFakeContext();

	it("should load fixtures", () => {
		assert.ok(fixtures.length > 0, "fixtures should not be empty");
	});

	for (const fixture of fixtures) {
		it(`should route correctly: ${fixture.prompt.slice(0, 50)}...`, async () => {
			const config: RouterConfig = {
				...DEFAULTS,
				classifier: { ...DEFAULTS.classifier, model: undefined }, // use heuristic
				catalog: {
					local: ["lmstudio/meta/muse-glimmer", "lmstudio/prism-ml/bonsai-27b"],
					cloud: ["opencode-go/deepseek-v4.1-flash"],
				},
				policy: {
					...DEFAULTS.policy,
					thinkingLevels: {
						enabled: true,
						map: [
							{ score: 0.2, level: "off" },
							{ score: 0.4, level: "low" },
							{ score: 0.6, level: "medium" },
						],
						default: "high",
					},
				},
			};

			const rt = makeFakeRuntime(config);
			const request = {
				model: { id: "auto", provider: "cuttle" } as any,
				thinkingLevel: "high" as any,
				reason: "user" as const,
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: fixture.prompt }], timestamp: Date.now() }],
			};

			const result = await routeRequest(rt, "auto", request as any, ctx);

			// Check tier
			assert.equal(result.model.provider === "opencode-go" ? "cloud" : "local", fixture.expectedTier,
				`tier mismatch for: ${fixture.prompt}`);

			// Check thinking level if specified
			if (fixture.expectedThinkingLevel) {
				assert.equal(result.thinkingLevel, fixture.expectedThinkingLevel,
					`thinking level mismatch for: ${fixture.prompt}`);
			}
		});
	}
});
