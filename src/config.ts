/**
 * Configuration loading and merging.
 *
 * pi has no extension settings-contribution API, so the router owns this file.
 * `pi.getSettings()` is available for reading pi's own settings, but our schema
 * lives in `pi-cuttle.json` and is read directly.
 *
 * Precedence: project `.pi/pi-cuttle.json` over user `~/.pi/agent/pi-cuttle.json`
 * over DEFAULTS. Merge is shallow per top-level section.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { RouterConfig } from "./types.ts";

export const DEFAULTS: RouterConfig = {
	autoSelect: false,
	classifier: { fallback: "heuristic", timeoutMs: 4000, stateChars: 16_000, backoffAfterFailures: 3, backoffMs: 60_000 },
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
		onFull: "spill",
		waitMs: 20_000,
		slotDir: join(homedir(), ".pi", "agent", "pi-cuttle", "slots"),
		staleSlotMs: 300_000,
		providers: ["lmstudio", "llama.cpp", "ollama", "mtplx"],
	},
	telemetry: { enabled: true, path: join(homedir(), ".pi", "agent", "pi-cuttle", "decisions.jsonl"), pricing: {} },
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
	return [join(homedir(), ".pi", "agent", "pi-cuttle.json"), join(cwd, ".pi", "pi-cuttle.json")];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge one JSON file over a config, section by section. */
function mergeSection<T extends object>(base: T, patch: unknown): T {
	if (!isRecord(patch)) return base;
	return { ...base, ...(patch as Partial<T>) };
}

/** Merge the `policy` section, keeping nested `phase` and `escalate` defaults. */
export function mergePolicy(base: RouterConfig["policy"], patch: unknown): RouterConfig["policy"] {
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
	return {
		autoSelect: typeof parsed.autoSelect === "boolean" ? parsed.autoSelect : config.autoSelect,
		classifier: mergeSection(config.classifier, parsed.classifier),
		catalog: mergeSection(config.catalog, parsed.catalog),
		policy: mergePolicy(config.policy, parsed.policy),
		local: mergeSection(config.local, parsed.local),
		telemetry: mergeSection(config.telemetry, parsed.telemetry),
		gates: mergeSection(config.gates ?? {}, parsed.gates),
	};
}

const LEGACY_CONFIG_PATH = join(homedir(), ".pi", "agent", "cuttle.json");
const LEGACY_DATA_DIR = join(homedir(), ".pi", "agent", "cuttle");
const DATA_DIR = join(homedir(), ".pi", "agent", "pi-cuttle");

/** Path of the user config file the `/cuttle` command writes to. */
export function userConfigPath(): string {
	return join(homedir(), ".pi", "agent", "pi-cuttle.json");
}

/** Directory for router state (slots, ledgers, shadow logs). */
export function dataDir(): string {
	return DATA_DIR;
}

/** Path for the phase-2 shadow-mode gate ledger. */
export function shadowLogPath(): string {
	return join(DATA_DIR, "shadow.jsonl");
}

/**
 * One-time migration of pre-rename state. If the old `cuttle.json` or `cuttle/`
 * directory exists and the new `pi-cuttle` equivalent does not, move it. This
 * preserves existing slots, ledger, and user settings without leaving stale data
 * behind.
 */
function migrateLegacyPaths(): void {
	if (existsSync(LEGACY_CONFIG_PATH) && !existsSync(userConfigPath())) {
		try {
			mkdirSync(dirname(userConfigPath()), { recursive: true });
			renameSync(LEGACY_CONFIG_PATH, userConfigPath());
		} catch {
			/* migration is best-effort; loadConfig will fall back if it can */
		}
	}
	if (existsSync(LEGACY_DATA_DIR) && !existsSync(DATA_DIR)) {
		try {
			renameSync(LEGACY_DATA_DIR, DATA_DIR);
		} catch {
			/* best-effort */
		}
	}
}

export function loadConfig(cwd: string): LoadedConfig {
	migrateLegacyPaths();

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
		config = applyOverrides(config, parsed);
		sources.push(resolve(path));	}

	config.local.slotDir = resolve(expandHome(config.local.slotDir));
	config.telemetry.path = resolve(expandHome(config.telemetry.path));

	if (config.catalog.local.length === 0 && config.catalog.cloud.length === 0) {
		warnings.push("no models configured: set catalog.local and catalog.cloud in pi-cuttle.json");
	}
	return { config, sources, warnings };
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
