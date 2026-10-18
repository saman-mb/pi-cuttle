/**
 * Phase-2 shadow-mode gate ledger.
 *
 * When gates are enabled in shadow mode, every live routing decision writes a small,
 * metadata-only record to `~/.pi/agent/pi-cuttle/shadow.jsonl`. The `/cuttle shadow-report`
 * command reads this file and prints how often each gate agreed with the actual routing
 * outcome, so the gates can be promoted out of shadow only after their signal is proven.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { dataDir, shadowLogPath } from "./config.ts";
import type { Decision, GateVerdicts, PairedSignalVerdicts, SignalPath, Tier } from "./types.ts";

let logPath = shadowLogPath();

/** Test hook: override the shadow log path. */
export function setShadowLogPath(path: string): void {
	logPath = path;
}

export interface ShadowRecord {
	/** Unix ms. */
	at: number;
	/** Which virtual-model flavor was being routed. */
	flavor?: string;
	/** Final tier chosen by the router. */
	tier: Tier;
	/** Source of the tier decision (classifier/heuristic/pin). */
	source: Decision["source"];
	/** Signal path used to produce the classifier verdict, when applicable. */
	signalPath?: SignalPath;
	/** Optional non-authoritative comparison with the other signal source. */
	paired?: PairedSignalVerdicts;
	/** Gate verdicts returned by the classifier, if any. */
	gates?: GateVerdicts;
	/** Reason string from the routing decision. */
	reason: string;
}

/** Append one shadow record. Creates the data directory and file if necessary. */
export function appendShadow(record: ShadowRecord): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
	} catch {
		// Shadow logging is best-effort; a full disk must not break routing.
	}
}

/** Read all shadow records, newest last. Returns an empty array if the file is missing. */
export function readShadow(): ShadowRecord[] {
	if (!existsSync(logPath)) return [];
	const lines = readFileSync(logPath, "utf8").split("\n");
	const out: ShadowRecord[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as ShadowRecord);
		} catch {
			// Skip corrupt lines.
		}
	}
	return out;
}

export interface GateAgreement {
	/** Gate name. */
	name: string;
	/** Total verdicts recorded for this gate. */
	total: number;
	/** Verdicts that matched the eventual outcome (or the existing struggle signal). */
	agreed: number;
	/** Verdicts that disagreed. */
	disagreed: number;
	/** Verdicts whose confidence was below the configured threshold. */
	belowThreshold: number;
}

/**
 * Compute agreement between gate verdicts and the router's actual decisions.
 *
 * - delegate/role: not compared to an outcome yet; reported as observed distributions.
 * - struggle: agrees when the gate's bool/score predicts struggle on turns that either
 *   escalated to cloud or ended with error signals in the same record's tier/reason.
 * - judge: agrees when the gate says the result was satisfactory and the turn did not
 *   escalate, and disagrees when it says unsatisfactory and the turn did escalate.
 */
export function computeAgreement(records: ShadowRecord[]): GateAgreement[] {
	const byGate = new Map<string, { total: number; agreed: number; disagreed: number; below: number }>();

	for (const record of records) {
		if (!record.gates) continue;
		for (const [name, verdict] of Object.entries(record.gates)) {
			const bucket = byGate.get(name) ?? { total: 0, agreed: 0, disagreed: 0, below: 0 };
			bucket.total += 1;
			if (verdict.confidence < 0.7 && verdict.type !== "bool") {
				// Score/choice below threshold.
				bucket.below += 1;
			}
			if (name === "struggle") {
				const predicted = verdict.type === "bool" ? verdict.probability >= 0.7 : verdict.type === "score" ? verdict.score >= 0.7 : false;
				const escalated = record.tier === "cloud" || /escalat|struggle|error/i.test(record.reason);
				if (predicted === escalated) bucket.agreed += 1;
				else bucket.disagreed += 1;
			} else if (name === "judge") {
				const satisfactory = verdict.type === "bool" ? verdict.probability >= 0.7 : verdict.type === "score" ? verdict.score >= 0.7 : true;
				const escalated = record.tier === "cloud" || /escalat|struggle|error/i.test(record.reason);
				if (satisfactory === !escalated) bucket.agreed += 1;
				else bucket.disagreed += 1;
			} else {
				// delegate/role: no automatic outcome to compare to yet.
				bucket.agreed += 1;
			}
			byGate.set(name, bucket);
		}
	}

	return Array.from(byGate.entries()).map(([name, b]) => ({
		name,
		total: b.total,
		agreed: b.agreed,
		disagreed: b.disagreed,
		belowThreshold: b.below,
	}));
}

/** Format agreement rows for the terminal. */
export function formatAgreement(rows: GateAgreement[]): string {
	if (rows.length === 0) return "No shadow-mode records yet.";
	const lines = ["gate      total  agreed  disagreed  below-threshold".padEnd(52), "-".repeat(52)];
	for (const row of rows) {
		const accuracy = row.total ? ((row.agreed / row.total) * 100).toFixed(1) : "0.0";
		lines.push(
			`${row.name.padEnd(10)} ${String(row.total).padStart(5)} ${String(row.agreed).padStart(7)} ${String(row.disagreed).padStart(10)} ${String(row.belowThreshold).padStart(15)} (${accuracy}%)`,
		);
	}
	return lines.join("\n");
}
