/**
 * Verifies the routing scores against the live Langfuse instance (#132).
 *
 * The classification is pure and tested here. The CLI reads the live instance and prints what it
 * finds; that run is recorded, not gated, because it needs a running Langfuse.
 *
 *   node --experimental-strip-types eval/check-scores.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LangFuseClient } from "../src/langfuse.ts";
import { decisionScores } from "../src/scores.ts";
import type { ObservabilityConfig } from "../src/types.ts";

export interface TraceView {
	id: string;
	metadata?: Record<string, unknown>;
}

export interface ScoreVerdict {
	traceId: string;
	flavor: string;
	modelId: string;
	/** What the code says the score should be. */
	expected: boolean;
	/** What Langfuse actually holds, when a score was recorded. */
	recorded?: boolean;
}

/**
 * Judge each routing trace that carries a flavor and a model. A trace whose recorded score
 * disagrees with the computation is a detection — the thing this check exists to surface.
 */
export function verdicts(
	traces: readonly TraceView[],
	recorded: ReadonlyMap<string, boolean>,
	localCatalog: readonly string[],
): ScoreVerdict[] {
	const out: ScoreVerdict[] = [];
	for (const trace of traces) {
		const flavor = trace.metadata?.flavor;
		const modelId = trace.metadata?.modelId;
		if (typeof flavor !== "string" || typeof modelId !== "string") continue;
		const expected = decisionScores(flavor, modelId, localCatalog).find((s) => s.name === "flavor_compliance");
		if (!expected) continue;
		out.push({ traceId: trace.id, flavor, modelId, expected: expected.value, recorded: recorded.get(trace.id) });
	}
	return out;
}

function loadObservability(): ObservabilityConfig | undefined {
	const path = join(homedir(), ".pi", "agent", "pi-cuttle.json");
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { observability?: ObservabilityConfig };
	return parsed.observability?.enabled ? parsed.observability : undefined;
}

function loadLocalCatalog(): string[] {
	const path = join(homedir(), ".pi", "agent", "pi-cuttle.json");
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { catalog?: { local?: string[] } };
	return parsed.catalog?.local ?? [];
}

async function main(): Promise<void> {
	const cfg = loadObservability();
	if (!cfg) {
		console.error("No Langfuse credentials in ~/.pi/agent/pi-cuttle.json.");
		process.exit(1);
	}
	const client = new LangFuseClient(cfg);
	const traces = await client.fetchTraces();
	const routing = traces.filter((t) => t.name === "pi-cuttle routing decision");

	const recorded = new Map<string, boolean>();
	for (const trace of routing) {
		const scores = await client.fetchScores(trace.id).catch(() => []);
		const compliance = scores.find((s) => s.name === "flavor_compliance");
		if (compliance) recorded.set(trace.id, compliance.value === true || compliance.value === 1);
	}

	const rows = verdicts(routing, recorded, loadLocalCatalog());
	const disagreements = rows.filter((r) => r.recorded !== undefined && r.recorded !== r.expected);
	console.log(`routing traces: ${routing.length} · scored: ${recorded.size} · disagreements: ${disagreements.length}`);
	for (const row of disagreements) {
		console.log(`  ${row.traceId} flavor=${row.flavor} model=${row.modelId} expected=${row.expected} recorded=${row.recorded}`);
	}
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\.\//, ""));
if (isMain) {
	main().catch((error) => {
		console.error("check failed:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
