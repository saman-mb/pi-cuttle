/**
 * Audit real subagent launches against the router's local-only contract (#130).
 *
 * Usage:
 *   node --experimental-strip-types eval/subagent-audit.ts [--days N] [--root DIR] [--json]
 *
 * Reads the `*_meta.json` artifacts pi-subagents writes per run, resolves each run's parent
 * session to find the model active at launch, and judges whether a local-only parent let a child
 * reach the cloud. This is the repeatable form of the manual run #130 asked for: it answers which
 * candidate cause fired from evidence already on disk, with no model and no live pi install.
 *
 * Exits 1 when a local-only parent produced a non-local child, so it can gate a release.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { auditRun, pickActiveModel, summarize, type ModelChange, type SubagentRunMeta } from "../src/subagent-audit.ts";

interface Options {
	root: string;
	days: number;
	json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { root: join(homedir(), ".pi", "agent", "sessions"), days: 7, json: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") options.json = true;
		else if (arg === "--days") options.days = Number(argv[++i] ?? options.days);
		else if (arg === "--root") options.root = argv[++i] ?? options.root;
	}
	return options;
}

/** Every `*_meta.json` under the sessions root, newest first. */
function findMetaFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith("_meta.json")) found.push(join(entry.parentPath, entry.name));
	}
	return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Locate a parent session transcript by session id (files are `<timestamp>_<id>.jsonl`). */
function findSessionFile(root: string, sessionId: string): string | undefined {
	if (!sessionId) return undefined;
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
			return join(entry.parentPath, entry.name);
		}
	}
	return undefined;
}

/** `model_change` entries recorded in a session transcript. */
function readModelChanges(sessionPath: string | undefined): ModelChange[] {
	if (!sessionPath) return [];
	const changes: ModelChange[] = [];
	for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; timestamp?: string; provider?: string; modelId?: string };
			if (entry.type === "model_change" && entry.timestamp && entry.provider && entry.modelId) {
				changes.push({ timestamp: entry.timestamp, provider: entry.provider, modelId: entry.modelId });
			}
		} catch {
			// A malformed line is not worth failing the audit over.
		}
	}
	return changes;
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const { config, sources } = loadConfig(process.cwd());
	const localCatalog = config.catalog.local;
	if (localCatalog.length === 0) {
		console.error("warning: catalog.local is empty, so a child's model cannot be judged local");
	}

	const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
	const runs = [];
	for (const metaPath of findMetaFiles(options.root)) {
		const when = statSync(metaPath).mtimeMs;
		if (when < cutoff) continue;
		let meta: SubagentRunMeta;
		try {
			meta = JSON.parse(readFileSync(metaPath, "utf8")) as SubagentRunMeta;
		} catch {
			continue;
		}
		const parentPath = findSessionFile(options.root, meta.parentSessionId ?? "");
		const active = pickActiveModel(readModelChanges(parentPath), new Date(when));
		const parentModel = active ? `${active.provider}/${active.modelId}` : undefined;
		runs.push(auditRun(meta, parentModel, localCatalog));
	}

	const summary = summarize(runs);
	if (options.json) {
		console.log(JSON.stringify({ config: sources, summary, runs }, null, 2));
	} else {
		console.log(`subagent audit — ${summary.total} run(s) in the last ${options.days} day(s)`);
		console.log(`catalog.local: ${localCatalog.join(", ") || "(empty)"}`);
		console.log();
		console.log(`${"agent".padEnd(18)} ${"parent".padEnd(24)} ${"child".padEnd(30)} verdict`);
		console.log("-".repeat(96));
		for (const run of runs) {
			const flag = run.violation ? " <<< VIOLATION" : run.crashUnderLocalOnly ? " <<< #131" : "";
			console.log(
				`${run.agent.slice(0, 18).padEnd(18)} ${(run.parentModel ?? "?").slice(0, 24).padEnd(24)} ${run.model.slice(0, 30).padEnd(30)} ${run.verdict}${flag}`,
			);
		}
		console.log();
		console.log(`routed=${summary.verdicts.routed} bypass-override=${summary.verdicts["bypass-override"]} bypass-inherited=${summary.verdicts["bypass-inherited"]} crash=${summary.verdicts.crash}`);
		console.log(`violations: ${summary.violations.length} | crashes under a local-only parent: ${summary.crashesUnderLocalOnly.length}`);
		console.log(`\ncause: ${summary.cause}`);
	}

	if (summary.violations.length > 0) process.exitCode = 1;
}

main();
