/**
 * Configuration loading and merging.
 *
 * pi has no extension settings-contribution API, so the router owns this file.
 * `pi.getSettings()` is available for reading pi's own settings, but our schema
 * lives in `cuttle.json` and is read directly.
 *
 * Precedence: project `.pi/cuttle.json` over user `~/.pi/agent/cuttle.json`
 * over DEFAULTS. Merge is shallow per top-level section.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { HostCapabilities, RouterConfig } from "./types.ts";

export const DEFAULTS: RouterConfig = {
	host: "lmstudio",
	autoSelect: false,
	classifier: { fallback: "heuristic", timeoutMs: 4000, stateChars: 16_000 },
	catalog: { local: [], cloud: [] },
	policy: {
		mode: "complexity",
		threshold: 0.5,
		phase: { plan: "cloud", implement: "local" },
		reclassify: "session",
		escalate: { enabled: true, toolErrors: 2, window: 8, cleanTurns: 3 },
	},
	local: {
		maxConcurrent: 1,
		maxConcurrentPerModel: 1,
		maxLoadedModels: 1,
		onFull: "spill",
		waitMs: 20_000,
		idleUnloadMs: 300_000,
		preload: true,
		pinClassifier: true,
		slotDir: join(homedir(), ".pi", "agent", "cuttle", "slots"),
		staleSlotMs: 300_000,
	},
	telemetry: { enabled: true, path: join(homedir(), ".pi", "agent", "cuttle", "decisions.jsonl"), pricing: {} },
	lmstudio: { baseUrl: "http://localhost:1235", timeoutMs: 8_000 },
	ollama: { baseUrl: "http://localhost:11434", timeoutMs: 8_000 },
	openai: { baseUrl: "http://localhost:8080", timeoutMs: 8_000 },
};

export interface LoadedConfig {
	config: RouterConfig;
	/** Files that contributed, lowest precedence first. */
	sources: string[];
	/** Non-fatal problems, surfaced by `/cuttle status`. */
	warnings: string[];
}

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export function configPaths(cwd: string): string[] {
	return [join(homedir(), ".pi", "agent", "cuttle.json"), join(cwd, ".pi", "cuttle.json")];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge one JSON file over a config, section by section. */
function mergeSection<T extends object>(base: T, patch: unknown): T {
	if (!isRecord(patch)) return base;
	return { ...base, ...(patch as Partial<T>) };
}

/** Merge the `policy` section, keeping nested `phase` and `escalate` defaults. */
function mergePolicy(base: RouterConfig["policy"], patch: unknown): RouterConfig["policy"] {
	if (!isRecord(patch)) return base;
	return {
		...base,
		...patch,
		phase: isRecord(patch.phase) ? { ...base.phase, ...patch.phase } : base.phase,
		escalate: isRecord(patch.escalate) ? { ...base.escalate, ...patch.escalate } : base.escalate,
	} as RouterConfig["policy"];
}

/** Apply one parsed JSON object over a config, section by section. Exported for tests. */
export function applyOverrides(config: RouterConfig, parsed: unknown): RouterConfig {
	if (!isRecord(parsed)) return config;
	const host =
		parsed.host === "lmstudio" || parsed.host === "ollama" || parsed.host === "openai" ? parsed.host : config.host;
	return {
		host,
		autoSelect: typeof parsed.autoSelect === "boolean" ? parsed.autoSelect : config.autoSelect,
		classifier: mergeSection(config.classifier, parsed.classifier),
		catalog: mergeSection(config.catalog, parsed.catalog),
		policy: mergePolicy(config.policy, parsed.policy),
		local: mergeSection(config.local, parsed.local),
		telemetry: mergeSection(config.telemetry, parsed.telemetry),
		lmstudio: mergeSection(config.lmstudio, parsed.lmstudio),
		ollama: mergeSection(config.ollama, parsed.ollama),
		openai: mergeSection(config.openai, parsed.openai),
	};
}

export function loadConfig(cwd: string): LoadedConfig {
	const sources: string[] = [];
	const warnings: string[] = [];
	let config: RouterConfig = structuredClone(DEFAULTS);

	for (const path of configPaths(cwd)) {
		if (!existsSync(path)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			warnings.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		if (!isRecord(parsed)) {
			warnings.push(`${path}: expected a JSON object`);
			continue;
		}
		if ("host" in parsed && !["lmstudio", "ollama", "openai"].includes(parsed.host as string)) {
			warnings.push(`${path}: unknown host '${String(parsed.host)}', expected lmstudio|ollama|openai`);
		}
		config = applyOverrides(config, parsed);
		sources.push(resolve(path));	}

	config.local.slotDir = resolve(expandHome(config.local.slotDir));
	config.telemetry.path = resolve(expandHome(config.telemetry.path));
	config.lmstudio.baseUrl = config.lmstudio.baseUrl.replace(/\/+$/, "");
	config.ollama.baseUrl = config.ollama.baseUrl.replace(/\/+$/, "");
	config.openai.baseUrl = config.openai.baseUrl.replace(/\/+$/, "");

	if (config.catalog.local.length === 0 && config.catalog.cloud.length === 0) {
		warnings.push("no models configured: set catalog.local and catalog.cloud in cuttle.json");
	}
	return { config, sources, warnings };
}

/** Path of the user config file the `/cuttle` command writes to. */
export function userConfigPath(): string {
	return join(homedir(), ".pi", "agent", "cuttle.json");
}

/**
 * Persist a partial update to the user config file, preserving unknown keys.
 * Used by `/cuttle` so interactive edits survive a restart.
 */
export function saveUserConfig(patch: Record<string, unknown>): string {
	const path = userConfigPath();
	let current: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) current = parsed;
		} catch {
			/* overwrite corrupt file rather than refusing to save */
		}
	}
	const merged = { ...current };
	for (const [section, value] of Object.entries(patch)) {
		merged[section] = isRecord(value) && isRecord(merged[section]) ? { ...(merged[section] as object), ...value } : value;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
	return path;
}
