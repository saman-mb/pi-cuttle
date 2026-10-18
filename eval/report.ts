/**
 * Eval report generator for pi-cuttle routing decisions.
 *
 * Loads fixtures from eval/routing-fixtures.jsonl, runs them through routeRequest(),
 * and generates a human-readable report with pass/fail counts and details.
 *
 * Usage: node --experimental-strip-types eval/report.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai/compat";

import { routeRequest } from "../src/virtual-models.ts";
import type { RouterRuntime } from "../src/virtual-models.ts";
import { DEFAULTS } from "../src/config.ts";
import type { RouterConfig, Tier } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(here, "routing-fixtures.jsonl");
const reportPath = join(here, "routing-report.json");

interface RoutingFixture {
	prompt: string;
	expectedTier: Tier;
	expectedThinkingLevel?: string;
	features?: string[];
	notes?: string;
}

interface TestResult {
	prompt: string;
	expectedTier: Tier;
	actualTier: Tier;
	expectedThinkingLevel?: string;
	actualThinkingLevel?: string;
	passed: boolean;
	error?: string;
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
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {
			find: (provider: string, id: string) => {
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

async function runEval(): Promise<TestResult[]> {
	const fixtures = loadFixtures();
	const ctx = makeFakeContext();
	const results: TestResult[] = [];

	const config: RouterConfig = {
		...DEFAULTS,
		classifier: { ...DEFAULTS.classifier, model: undefined },
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

	for (const fixture of fixtures) {
		const request = {
			model: { id: "auto", provider: "cuttle" } as any,
			thinkingLevel: "high" as any,
			reason: "user" as const,
			messages: [{ role: "user" as const, content: [{ type: "text" as const, text: fixture.prompt }], timestamp: Date.now() }],
		};

		try {
			const result = await routeRequest(rt, "auto", request as any, ctx);
			const actualTier = result.model.provider === "opencode-go" ? "cloud" : "local";
			const passed = actualTier === fixture.expectedTier && (!fixture.expectedThinkingLevel || result.thinkingLevel === fixture.expectedThinkingLevel);

			results.push({
				prompt: fixture.prompt,
				expectedTier: fixture.expectedTier,
				actualTier,
				expectedThinkingLevel: fixture.expectedThinkingLevel,
				actualThinkingLevel: result.thinkingLevel,
				passed,
				error: passed ? undefined : `tier: expected ${fixture.expectedTier}, got ${actualTier}; thinking: expected ${fixture.expectedThinkingLevel}, got ${result.thinkingLevel}`,
			});
		} catch (error) {
			results.push({
				prompt: fixture.prompt,
				expectedTier: fixture.expectedTier,
				actualTier: "error" as any,
				passed: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

function generateReport(results: TestResult[]): string {
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	const total = results.length;
	const accuracy = total > 0 ? (passed / total) * 100 : 0;

	const lines = [
		"# pi-cuttle Routing Eval Report",
		"",
		`**Total:** ${total} fixtures`,
		`**Passed:** ${passed}`,
		`**Failed:** ${failed}`,
		`**Accuracy:** ${accuracy.toFixed(1)}%`,
		"",
	];

	if (failed > 0) {
		lines.push("## Failures", "");
		for (const result of results.filter((r) => !r.passed)) {
			lines.push(`- **${result.prompt.slice(0, 60)}...**`);
			lines.push(`  - Error: ${result.error}`);
			lines.push("");
		}
	}

	return lines.join("\n");
}

async function main() {
	console.log("Running routing eval...");
	const results = await runEval();
	const report = generateReport(results);

	writeFileSync(reportPath, JSON.stringify(results, null, 2));
	console.log(report);
	console.log(`\nDetailed results saved to ${reportPath}`);

	const failed = results.filter((r) => !r.passed).length;
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Eval failed:", error);
	process.exit(1);
});
