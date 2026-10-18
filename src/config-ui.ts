/**
 * Pure configuration-panel helpers for `/cuttle config`.
 *
 * Everything here is testable without a terminal or pi runtime.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { RouterConfig } from "./types.ts";
import { splitRef } from "./classifier.ts";

/** Paths used by the config panel. */
export interface ConfigPaths {
	userPath: string;
	projectPath: string;
}

export function configPathsForPanel(cwd: string): ConfigPaths {
	return {
		userPath: join(homedir(), ".pi", "agent", "pi-cuttle.json"),
		projectPath: join(cwd, ".pi", "pi-cuttle.json"),
	};
}

/** Which top-level sections are locked by a project config file. */
export function shadowedSections(projectRaw: unknown): string[] {
	if (!projectRaw || typeof projectRaw !== "object" || Array.isArray(projectRaw)) return [];
	const keys = Object.keys(projectRaw);
	return keys.filter((k) => k !== "$schema");
}

/** State strings — exact vocabulary per spec. */
export const STATE = {
	UNSET_HEURISTIC: "UNSET (heuristic)",
	EMPTY: "EMPTY",
	SHADOWED: "SHADOWED: project file",
	UNRESOLVED: "UNRESOLVED",
	SAVED: "SAVED",
	WRITE_FAILED: "WRITE FAILED",
	NO_CHANGES: "NO CHANGES",
} as const;

/** A single row in the SettingsList — matches SettingItem from @earendil-works/pi-tui. */
export interface PanelRow {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
	submenu?: (currentValue: string, done: (selectedValue?: string, options?: { navigateTo?: string }) => void) => import("@earendil-works/pi-tui").Component;
}

/** Result of checking catalog entries against the model registry. */
export interface CatalogCheck {
	total: number;
	resolvable: number;
	unresolved: number;
}

/** Check how many catalog refs resolve via the registry find function. */
export function checkCatalogRefs(
	refs: readonly string[],
	find: (provider: string, id: string) => unknown,
): CatalogCheck {
	let resolvable = 0;
	let unresolved = 0;
	for (const ref of refs) {
		const parsed = splitRef(ref);
		if (parsed && find(parsed.provider, parsed.id)) {
			resolvable++;
		} else {
			unresolved++;
		}
	}
	return { total: refs.length, resolvable, unresolved };
}

/** Format the catalog display value. */
export function formatCatalogValue(check: CatalogCheck): string {
	if (check.total === 0) return STATE.EMPTY;
	return `${check.resolvable} refs; ${check.unresolved} unresolved`;
}

/** Check classifier validity against the classifier registry. */
export function checkClassifier(
	ref: string | undefined,
	findOfType: (type: "classifier", provider: string, id: string) => unknown,
): { value: string; description?: string } {
	if (!ref) return { value: STATE.UNSET_HEURISTIC };
	const parsed = splitRef(ref);
	if (!parsed) return { value: STATE.UNRESOLVED, description: `Invalid ref '${ref}'` };
	const model = findOfType("classifier", parsed.provider, parsed.id);
	if (!model) return { value: STATE.UNRESOLVED, description: `'${ref}' is not registered as a classifier in pi` };
	return { value: ref };
}

/** Validate integer input for maxConcurrent. */
export function validateMaxConcurrent(input: string): { valid: boolean; value?: number; error?: string } {
	const trimmed = input.trim();
	if (trimmed === "") return { valid: false, error: "Enter a whole number ≥ 0." };
	const num = Number(trimmed);
	if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
		return { valid: false, error: "Enter a whole number ≥ 0." };
	}
	return { valid: true, value: num };
}

/**
 * Sentinel shown for "no classifier" in the picker.
 *
 * It must be a real string, not `undefined`: `SettingsList` skips its `onChange` callback
 * entirely when a submenu completes with `undefined`, so an undefined sentinel would make
 * "Unset" a silent no-op (`pi-tui/dist/components/settings-list.js`, `activateItem`).
 */
export const CLASSIFIER_UNSET_SENTINEL = "Unset";

/** Map a classifier picker selection onto the config patch that expresses it. */
export function classifierPatchForSelection(selection: string): { classifier: { model: string | undefined } } {
	return {
		classifier: { model: selection === CLASSIFIER_UNSET_SENTINEL ? undefined : selection },
	};
}

/** Determine which scope provides each section's effective value. */
export interface SectionSource {
	section: string;
	source: "defaults" | "user" | "project";
}

export function determineSectionSources(
	config: RouterConfig,
	userRaw: unknown,
	projectRaw: unknown,
	shadowed: string[],
): SectionSource[] {
	const sections = ["classifier", "catalog", "policy", "local"];
	const sources: SectionSource[] = [];

	for (const section of sections) {
		if (shadowed.includes(section)) {
			sources.push({ section, source: "project" });
		} else if (userRaw && typeof userRaw === "object" && !Array.isArray(userRaw) && section in userRaw) {
			sources.push({ section, source: "user" });
		} else {
			sources.push({ section, source: "defaults" });
		}
	}
	return sources;
}

/** Build the main panel rows. Pure — no side effects. */
export function buildPanelRows(input: {
	config: RouterConfig;
	classifierCheck: ReturnType<typeof checkClassifier>;
	localCatalogCheck: CatalogCheck;
	cloudCatalogCheck: CatalogCheck;
	shadowed: string[];
	paths: ConfigPaths;
	availableClassifiers?: string[];
}): PanelRow[] {
	const { config, classifierCheck, localCatalogCheck, cloudCatalogCheck, shadowed, paths, availableClassifiers } = input;
	const rows: PanelRow[] = [];

	// Row 1: Classifier model
	const classifierShadowed = shadowed.includes("classifier");
	rows.push({
		id: "classifier",
		label: "Classifier model",
		description: classifierShadowed
			? `${STATE.SHADOWED}: edit ${paths.projectPath}`
			: classifierCheck.description ?? "The decision model that scores complexity",
		currentValue: classifierShadowed ? STATE.SHADOWED : classifierCheck.value,
	});

	// Row 2: Local catalog (read-only — use `/cuttle models` to change)
	const catalogShadowed = shadowed.includes("catalog");
	rows.push({
		id: "local-catalog",
		label: "Local catalog",
		description: catalogShadowed
			? `${STATE.SHADOWED}: edit ${paths.projectPath}`
			: "Read-only — use `/cuttle models` to change",
		currentValue: catalogShadowed ? STATE.SHADOWED : formatCatalogValue(localCatalogCheck),
	});

	// Row 3: Cloud catalog (read-only — use `/cuttle models` to change)
	rows.push({
		id: "cloud-catalog",
		label: "Cloud catalog",
		description: catalogShadowed
			? `${STATE.SHADOWED}: edit ${paths.projectPath}`
			: "Read-only — use `/cuttle models` to change",
		currentValue: catalogShadowed ? STATE.SHADOWED : formatCatalogValue(cloudCatalogCheck),
	});

	// Row 4: Policy mode
	const policyShadowed = shadowed.includes("policy");
	rows.push({
		id: "policy",
		label: "Policy mode",
		description: policyShadowed ? `${STATE.SHADOWED}: edit ${paths.projectPath}` : "How routing decisions are made",
		currentValue: policyShadowed ? STATE.SHADOWED : config.policy.mode,
		...(policyShadowed ? {} : { values: ["complexity", "cost", "phase"] }),
	});

	// Row 5: Local max concurrent
	const localShadowed = shadowed.includes("local");
	rows.push({
		id: "max-concurrent",
		label: "Local max concurrent",
		description: localShadowed ? `${STATE.SHADOWED}: edit ${paths.projectPath}` : "Max concurrent local requests across all processes",
		currentValue: localShadowed ? STATE.SHADOWED : String(config.local.maxConcurrent),
	});

	// Row 6: Config source / lock
	const hasProject = shadowed.length > 0;
	const lockedSections = shadowed.length > 0 ? `project: ${shadowed.join(", ")}` : "none";
	rows.push({
		id: "source-lock",
		label: "Config source / lock",
		description: `User: ${paths.userPath}\nProject: ${paths.projectPath}\nLocked sections: ${lockedSections}`,
		currentValue: hasProject ? `project: ${shadowed.join(", ")}` : "user",
	});

	// Row 7: Last change
	rows.push({
		id: "last-change",
		label: "Last change",
		currentValue: STATE.NO_CHANGES,
	});

	return rows;
}

/** Build non-TUI fallback text. */
export function buildNonTuiText(input: {
	config: RouterConfig;
	classifierCheck: ReturnType<typeof checkClassifier>;
	localCatalogCheck: CatalogCheck;
	cloudCatalogCheck: CatalogCheck;
	shadowed: string[];
	paths: ConfigPaths;
}): string {
	const { config, classifierCheck, localCatalogCheck, cloudCatalogCheck, shadowed, paths } = input;
	const lines: string[] = [
		"Configuration (non-TUI mode — edit JSON directly):",
		"",
		`Classifier model: ${classifierCheck.value}`,
		`  JSON key: classifier.model`,
		`Local catalog: ${formatCatalogValue(localCatalogCheck)}`,
		`  JSON key: catalog.local`,
		`Cloud catalog: ${formatCatalogValue(cloudCatalogCheck)}`,
		`  JSON key: catalog.cloud`,
		`Policy mode: ${config.policy.mode}`,
		`  JSON key: policy.mode`,
		`Local max concurrent: ${config.local.maxConcurrent}`,
		`  JSON key: local.maxConcurrent`,
		"",
		`User config: ${paths.userPath}`,
		`Project config: ${paths.projectPath}`,
	];

	if (shadowed.length > 0) {
		lines.push(`Shadowed sections (edit project file): ${shadowed.join(", ")}`);
	}

	lines.push("");
	lines.push("Edit ~/.pi/agent/pi-cuttle.json; project sections in .pi/pi-cuttle.json override user sections.");
	lines.push('Changes apply from the next routing decision: a new session, or the next user turn when policy.reclassify is "turn".');

	return lines.join("\n");
}
