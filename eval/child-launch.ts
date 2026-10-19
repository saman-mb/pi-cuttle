/**
 * Replay the #131 launch failures as fixtures against the installed pi-subagents.
 *
 * No child is started and no model is called. Each fixture is a model string that died in
 * Langfuse (`cuttle/local:high` and the same shape). The check registers this router with the
 * real `registerRequiredChildExtensions`, then asks pi-subagents' own launch planner what the
 * child would load. A pass means the child extension args include the router and the thinking
 * suffix is stripped back to a virtual model the router actually registers.
 *
 *   node --experimental-strip-types eval/child-launch.ts
 *
 * Exits 1 when a fixture would still launch without the router. Exits 2 when pi-subagents is
 * not installed, so a machine without it cannot report a false pass.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRequiredChildExtensionController } from "../src/required-child-extension.ts";

export interface ChildLaunchFixture {
	id: string;
	agent: string;
	model: string;
	parentSessionId: string;
	note: string;
}

interface RequiredSnapshotEntry {
	id: string;
	path: string;
}

interface LaunchPlan {
	extensionArgs: string[];
	requiredExtensions: readonly RequiredSnapshotEntry[];
}

interface LaunchProjection {
	required: string[];
	effective: string[];
}

interface SubagentsLaunch {
	registerRequiredChildExtensions(input: {
		sessionId: string;
		extensions: readonly RequiredSnapshotEntry[];
	}): { dispose(): void };
	resolveRequiredChildExtensions(sessionId: string): readonly RequiredSnapshotEntry[];
	resolvePiLaunchToolPlan(input: { model?: string; agentName?: string; requiredExtensions?: readonly RequiredSnapshotEntry[]; cwd?: string }): LaunchPlan;
	projectLaunchResolvedChildExtensions(plan: LaunchPlan): LaunchProjection;
	splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string };
}

const VIRTUAL_FLAVOR_IDS = ["auto", "local", "cloud", "fast-local", "big-local", "orchestrator"] as const;
const VIRTUAL_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function loadChildLaunchFixtures(path = new URL("./child-launch-fixtures.json", import.meta.url)): ChildLaunchFixture[] {
	const fixtures = JSON.parse(readFileSync(path, "utf8")) as ChildLaunchFixture[];
	if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error("child-launch fixtures must be a non-empty array");
	return fixtures;
}

/** The id pi-subagents records for an extension path in `launchResolvedExtensions.effective`. */
export function extensionHash(extensionPath: string): string {
	return `sha256:${createHash("sha256").update(normalize(extensionPath.trim())).digest("hex").slice(0, 16)}`;
}

export function fixtureFailures(
	fixture: ChildLaunchFixture,
	snapshot: readonly RequiredSnapshotEntry[],
	plan: LaunchPlan,
	projection: LaunchProjection,
	split: { baseModel: string; thinkingSuffix: string },
): string[] {
	const failures: string[] = [];
	const router = snapshot.find((entry) => entry.id === "pi-cuttle");
	if (!router) failures.push("registry snapshot has no pi-cuttle entry");
	if (!plan.requiredExtensions.some((entry) => entry.id === "pi-cuttle")) failures.push("launch plan dropped the required router");
	if (router && !plan.extensionArgs.includes(router.path)) failures.push("child extension args do not include the router path");
	if (!projection.required.includes("pi-cuttle")) failures.push(`launchResolvedExtensions.required=${JSON.stringify(projection.required)}`);
	if (router && !projection.effective.includes(extensionHash(router.path))) {
		failures.push(`effective extensions ${JSON.stringify(projection.effective)} do not include ${extensionHash(router.path)}`);
	}
	const flavor = split.baseModel.startsWith("cuttle/") ? split.baseModel.slice("cuttle/".length) : "";
	if (!VIRTUAL_FLAVOR_IDS.includes(flavor as (typeof VIRTUAL_FLAVOR_IDS)[number])) {
		failures.push(`thinking suffix did not resolve to a registered flavor: ${split.baseModel}`);
	}
	const level = split.thinkingSuffix.startsWith(":") ? split.thinkingSuffix.slice(1) : "";
	if (!VIRTUAL_THINKING.includes(level as (typeof VIRTUAL_THINKING)[number])) {
		failures.push(`thinking suffix ${split.thinkingSuffix || "(none)"} is not a level the virtual model advertises`);
	}
	if (split.baseModel === fixture.model) failures.push("the child would still look up the suffixed model id");
	return failures;
}

function installedPackage(): string | undefined {
	const candidate = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "package.json");
	return existsSync(candidate) ? dirname(candidate) : undefined;
}

async function loadSubagents(): Promise<SubagentsLaunch> {
	const root = installedPackage();
	if (!root) throw new Error("pi-subagents is not installed under ~/.pi/agent/npm");
	const registry = await import(pathToFileURL(join(root, "src/shared/required-child-extensions.js")).href);
	const plan = await import(pathToFileURL(join(root, "src/runs/shared/child-tool-plan.js")).href);
	const models = await import(pathToFileURL(join(root, "src/shared/model-info.js")).href);
	return {
		registerRequiredChildExtensions: registry.registerRequiredChildExtensions,
		resolveRequiredChildExtensions: registry.resolveRequiredChildExtensions,
		resolvePiLaunchToolPlan: plan.resolvePiLaunchToolPlan,
		projectLaunchResolvedChildExtensions: plan.projectLaunchResolvedChildExtensions,
		splitKnownThinkingSuffix: models.splitKnownThinkingSuffix,
	};
}

export async function checkChildLaunchFixtures(fixtures = loadChildLaunchFixtures()): Promise<string[]> {
	const subagents = await loadSubagents();
	const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const controller = createRequiredChildExtensionController({
		importer: async () => subagents,
	});
	const failures: string[] = [];
	try {
		for (const fixture of fixtures) {
			await controller.register(fixture.parentSessionId, extensionPath);
		}
		for (const fixture of fixtures) {
			const snapshot = subagents.resolveRequiredChildExtensions(fixture.parentSessionId);
			if (snapshot.length === 0) {
				failures.push(`${fixture.id}: registering a later session dropped this one`);
				continue;
			}
			const plan = subagents.resolvePiLaunchToolPlan({
				model: fixture.model,
				agentName: fixture.agent,
				requiredExtensions: snapshot,
				cwd: dirname(extensionPath),
			});
			const projection = subagents.projectLaunchResolvedChildExtensions(plan);
			const split = subagents.splitKnownThinkingSuffix(fixture.model);
			for (const failure of fixtureFailures(fixture, snapshot, plan, projection, split)) {
				failures.push(`${fixture.id}: ${failure}`);
			}
		}
	} finally {
		controller.dispose();
	}
	return failures;
}

async function main(): Promise<void> {
	const fixtures = loadChildLaunchFixtures();
	let failures: string[];
	try {
		failures = await checkChildLaunchFixtures(fixtures);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exit(1);
	}
	console.log(`child-launch fixtures: ${fixtures.length} pass (pi-subagents projection, no child started)`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
	main();
}
