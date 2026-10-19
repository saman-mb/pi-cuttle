/**
 * Export LangFuse misroute annotations into eval fixtures (#90).
 *
 * Usage:
 *   node --experimental-strip-types eval/export-misroutes.ts [days]
 *
 * Looks for LangFuse traces tagged `misroute` in the last N days (default 7),
 * reads their routing metadata, and appends them to eval/misroutes.jsonl.
 *
 * Requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars, or a
 * pi-cuttle.json with observability credentials in the current working directory.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { LangFuseClient } from "../src/langfuse.ts";
import type { ObservabilityConfig } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = join(here, "misroutes.jsonl");

function loadConfigFromDisk(cwd: string): ObservabilityConfig | undefined {
	const paths = [join(cwd, ".pi", "pi-cuttle.json"), join(homedir(), ".pi", "agent", "pi-cuttle.json")];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { observability?: ObservabilityConfig };
			if (parsed.observability?.enabled) return parsed.observability;
		} catch {
			// ignore malformed config
		}
	}
	return undefined;
}

function observabilityFromEnv(): ObservabilityConfig | undefined {
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY;
	if (!publicKey || !secretKey) return undefined;
	return {
		enabled: true,
		provider: "langfuse",
		baseUrl: process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000",
		publicKey,
		secretKey,
	};
}

interface MisrouteFixture {
	prompt: string;
	expectedTier: string;
	actualTier: string;
	actualModel: string;
	flavor: string;
	score?: number;
	reason: string;
	notes: string;
	source: string;
}

export interface TraceScore {
	name: string;
	value: boolean | number | string;
}

export interface ScoredTrace {
	id: string;
	timestamp: string;
	metadata?: Record<string, unknown>;
	tags?: string[];
	scores?: TraceScore[];
}

/** True when a trace was flagged as a misroute, by tag or by a failing score. */
export function isMisroute(trace: ScoredTrace): boolean {
	if (trace.tags?.includes("misroute")) return true;
	return trace.scores?.some((s) => s.name === "flavor_compliance" && s.value === false) ?? false;
}

function traceToFixture(trace: ScoredTrace): MisrouteFixture | undefined {
	const md = trace.metadata ?? {};
	const prompt = typeof md.prompt === "string" ? md.prompt : undefined;
	const tier = typeof md.tier === "string" ? md.tier : undefined;
	const modelId = typeof md.modelId === "string" ? md.modelId : undefined;
	const flavor = typeof md.flavor === "string" ? md.flavor : "auto";
	const correctTier = typeof md.correctTier === "string" ? md.correctTier : tier;
	if (!prompt || !correctTier || !modelId) return undefined;
	return {
		prompt,
		expectedTier: correctTier,
		actualTier: tier ?? correctTier,
		actualModel: modelId,
		flavor,
		score: typeof md.score === "number" ? md.score : undefined,
		reason: typeof md.reason === "string" ? md.reason : "",
		notes: [
			`Exported from LangFuse trace ${trace.id} at ${trace.timestamp}`,
			...(trace.scores?.some((s) => s.name === "flavor_compliance" && s.value === false)
				? ["flagged by flavor_compliance=false"]
				: []),
		].join("; "),
		source: typeof md.source === "string" ? md.source : "unknown",
	};
}

/** The traces worth turning into fixtures. Pure, so the selection is testable without Langfuse. */
export function selectMisroutes(traces: readonly ScoredTrace[]): MisrouteFixture[] {
	return traces.filter(isMisroute).map(traceToFixture).filter((f): f is MisrouteFixture => f !== undefined);
}

async function main() {
	const days = Number(process.argv[2] ?? "7");
	if (!Number.isFinite(days) || days <= 0) {
		console.error("Usage: node --experimental-strip-types eval/export-misroutes.ts [days]");
		process.exit(1);
	}

	const cfg = observabilityFromEnv() ?? loadConfigFromDisk(process.cwd());
	if (!cfg) {
		console.error("No LangFuse credentials found. Set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY, or enable observability in pi-cuttle.json.");
		process.exit(1);
	}

	const client = new LangFuseClient(cfg);
	const to = new Date();
	const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

	console.log(`Fetching misroute traces from ${from.toISOString()} to ${to.toISOString()}...`);
	// Tagged traces, plus every trace in the window — a failing score flags a trace that carries no tag.
	const tagged = await client.fetchTraces(from, to, ["misroute"]);
	const all = await client.fetchTraces(from, to);
	const seen = new Set(tagged.map((t) => t.id));
	const candidates = [...tagged, ...all.filter((t) => !seen.has(t.id))];

	const scored: ScoredTrace[] = [];
	for (const trace of candidates) {
		const scores = await client.fetchScores(trace.id).catch(() => [] as TraceScore[]);
		scored.push({ ...trace, scores });
	}
	const fixtures = selectMisroutes(scored);

	if (fixtures.length === 0) {
		console.log("No misroute annotations found.");
		return;
	}

	const lines = fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n";
	appendFileSync(outputPath, lines);
	console.log(`Appended ${fixtures.length} misroute fixture(s) to ${outputPath}`);
}

// Only when run directly. Importing this module for its pure selection must not exit the process,
// which is exactly what a missing-credentials run does — and what broke the test in CI.
const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isDirectRun) {
	main().catch((error) => {
		console.error("Export failed:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
