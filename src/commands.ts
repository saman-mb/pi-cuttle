/**
 * `/cuttle` — inspect and edit routing without hand-editing JSON.
 *
 * Edits are persisted to the user config file (#17) via `saveUserConfig`, which
 * preserves unknown keys.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { saveUserConfig, type LoadedConfig } from "./config.ts";
import { splitRef } from "./classifier.ts";
import { formatStats, type Telemetry } from "./telemetry.ts";
import { computeAgreement, formatAgreement, readShadow } from "./shadow.ts";
import type { RouterRuntime } from "./virtual-models.ts";
import type { GovernorStatus, PolicyMode, RouterConfig, Tier } from "./types.ts";
import { VIRTUAL_PROVIDER } from "./types.ts";

function refresh(rt: RouterRuntime, patch: Record<string, unknown>): string {
	const path = saveUserConfig(patch);
	// Apply in-memory so the change takes effect without a restart.
	const next = patch as Record<string, Record<string, unknown>>;
	if (typeof patch.autoSelect === "boolean") rt.config.autoSelect = patch.autoSelect;
	if (next.classifier) Object.assign(rt.config.classifier, next.classifier);
	if (next.catalog) Object.assign(rt.config.catalog, next.catalog);
	if (next.policy) Object.assign(rt.config.policy, next.policy);
	if (next.local) Object.assign(rt.config.local, next.local);
	return path;
}

async function editModels(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const slot = await ctx.ui.select("Which model slot?", ["local", "cloud", "decision model"]);
	if (!slot) return;

	const all = [...new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`))].slice(0, 80);
	const manual = "<type a model id>";
	const chosen = await ctx.ui.select(`Set ${slot} model`, [...all, manual]);
	if (!chosen) return;
	const ref = chosen === manual ? (await ctx.ui.input("Model id (provider/model)"))?.trim() : chosen;
	if (!ref) return;

	const patch =
		slot === "local"
			? { catalog: { local: [ref] } }
			: slot === "cloud"
				? { catalog: { cloud: [ref] } }
				: { classifier: { model: ref } };
	const path = refresh(rt, patch);
	ctx.ui.notify(`cuttle: ${slot} -> ${ref}\nwritten to ${path}`, "info");
}

async function editPolicy(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const mode = await ctx.ui.select("Routing policy", ["complexity", "cost", "phase"]);
	if (!mode) return;
	const path = refresh(rt, { policy: { mode: mode as PolicyMode } });
	ctx.ui.notify(`cuttle: policy -> ${mode}\nwritten to ${path}`, "info");
}

async function editLocalLimit(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const raw = await ctx.ui.input("Max concurrent local requests", String(rt.config.local.maxConcurrent));
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		ctx.ui.notify("cuttle: not a number, unchanged", "warning");
		return;
	}
	const path = refresh(rt, { local: { maxConcurrent: Math.floor(value) } });
	ctx.ui.notify(`cuttle: maxConcurrent -> ${Math.floor(value)}\nwritten to ${path}`, "info");
}

/**
 * Partition catalog entries into the ones pi's registry resolves and the ones it does not.
 *
 * Routing skips unresolvable entries and uses the next candidate, so a tier is usable as
 * long as at least one entry resolves. `/cuttle doctor` reports the missing entries without
 * failing the whole tier (see `doctor`). Exported so the partition is pinned by tests.
 */
export function checkCatalog(
	refs: readonly string[],
	find: (provider: string, id: string) => unknown,
): { resolvable: string[]; missing: string[] } {
	const resolvable: string[] = [];
	const missing: string[] = [];
	for (const ref of refs) {
		const parsed = splitRef(ref);
		if (parsed && find(parsed.provider, parsed.id)) resolvable.push(ref);
		else missing.push(ref);
	}
	return { resolvable, missing };
}

async function doctor(rt: RouterRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const lines: string[] = [];

	const ref = rt.config.classifier.model;
	if (!ref) {
		lines.push("classifier: none configured -> heuristic");
	} else {
		const parsed = splitRef(ref);
		if (!parsed) {
			lines.push(`classifier: FAIL invalid ref '${ref}'`);
		} else {
			const model = ctx.modelRegistry.findOfType("classifier", parsed.provider, parsed.id);
			if (!model) {
				lines.push(`classifier: FAIL '${ref}' is not a registered classifier in pi`);
			} else {
				const start = Date.now();
				try {
					await ctx.modelRegistry.classify(
						model,
						{
							state: { prompt: "doctor probe" },
							questions: {
								complexity: {
									type: "choice",
									instructions: "Trivial probe.",
									criteria: { standard: "the probe", complex: "the probe" },
								},
							},
						},
						{ signal: AbortSignal.timeout(rt.config.classifier.timeoutMs) },
					);
					lines.push(`classifier: PASS ${ref} ${Date.now() - start}ms`);
				} catch (error) {
					lines.push(`classifier: FAIL ${ref} — ${error instanceof Error ? error.message : String(error)}`);
					lines.push("  fix: load the model in its server, pick another classifier, or remove classifier.model for heuristic");
				}
			}
		}
	}

	for (const tier of ["local", "cloud"] as const) {
		const list = tier === "local" ? rt.config.catalog.local : rt.config.catalog.cloud;
		const { resolvable, missing } = checkCatalog(list, (provider, id) => ctx.modelRegistry.find(provider, id));
		if (list.length > 0 && resolvable.length === 0) {
			lines.push(`${tier}: FAIL none of these are in pi's catalog: ${list.join(", ")}`);
			lines.push(`  fix: register the model in pi, or update catalog.${tier} in pi-cuttle.json`);
		} else if (missing.length > 0) {
			lines.push(`${tier}: OK ${resolvable.join(", ")}`);
			lines.push(`  skipped (not in pi catalog): ${missing.join(", ")}`);
		} else {
			lines.push(`${tier}: OK ${list.join(", ") || "(none)"}`);
		}
	}

	const gov = await rt.governor.status();
	lines.push(`slots: ${gov.slots.length}/${gov.localMax} used`);
	lines.push(`slotDir: ${rt.config.local.slotDir}`);
	lines.push("turn-level classifier failures are logged to $PI_CUTTLE_DEBUG when set (see README)");
	ctx.ui.notify(lines.join("\n"), "info");
}

/** Collapse a possibly multi-line error into one status line (#53). */
export function oneLine(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max - 1) + "\u2026" : flat;
}

/** Pure status rendering; pinned by tests so the failure line cannot drift (#53). */
export function buildStatusLines(input: {
	rt: RouterRuntime;
	loaded: LoadedConfig;
	effectiveChars: number;
	governor: GovernorStatus;
}): string[] {
	const { rt, loaded, effectiveChars, governor } = input;
	const lines = [
		`models:   local=${rt.config.catalog.local.join(", ") || "(none)"}`,
		`          cloud=${rt.config.catalog.cloud.join(", ") || "(none)"}`,
		`decision: ${rt.config.classifier.model ?? "heuristic only"} (fallback ${rt.config.classifier.fallback})`,
		`stateChars: ${effectiveChars} (configured ${rt.config.classifier.stateChars})`,
		`policy:   ${rt.config.policy.mode} (threshold ${rt.config.policy.threshold}, reclassify ${rt.config.policy.reclassify})`,
		`routing:  ${rt.config.autoSelect ? "enabled" : "disabled"}`,
		`local:    ${governor.slots.length}/${governor.localMax} slots used`,
		`config:   ${loaded.sources.join(" -> ") || "(defaults only)"}`,
	];
	if (rt.lastClassifierError) {
		const failure = rt.lastClassifierError;
		lines.push(`failure:  turn ${failure.turn} ${failure.ref} \u2014 ${oneLine(failure.message)}`);
	}
	for (const warning of loaded.warnings) lines.push(`warning:  ${warning}`);
	return lines;
}

async function status(rt: RouterRuntime, loaded: LoadedConfig, ctx: ExtensionCommandContext): Promise<void> {
	const governor = await rt.governor.status();
	const lines = buildStatusLines({ rt, loaded, effectiveChars: rt.config.classifier.stateChars, governor });
	ctx.ui.notify(lines.join("\n"), "info");
}

export function registerCuttleCommand(pi: ExtensionAPI, rt: RouterRuntime, loaded: LoadedConfig, telemetry: Telemetry): void {
	pi.registerCommand("cuttle", {
		description: "Toggle and inspect local/cloud model routing",
		handler: async (args, ctx) => {
			const [sub = "status", extra] = args.trim().split(/\s+/);
			const sessionId = ctx.sessionManager.getSessionId();

			if (sub === "stats") {
				const days = Number.isFinite(Number(extra)) && Number(extra) > 0 ? Math.floor(Number(extra)) : 7;
				ctx.ui.notify(formatStats(telemetry.stats(days), rt.config.telemetry.baseline), "info");
				return;
			}

			if (sub === "shadow-report") {
				const days = Number.isFinite(Number(extra)) && Number(extra) > 0 ? Math.floor(Number(extra)) : 7;
				const cutoff = Date.now() - days * 86_400_000;
				const records = readShadow().filter((r) => r.at >= cutoff);
				ctx.ui.notify(formatAgreement(computeAgreement(records)), "info");
				return;
			}

			if (sub === "on" || sub === "off") {
				const enable = sub === "on";
				refresh(rt, { autoSelect: enable });
				if (enable) {
					const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					if (current && !current.startsWith(`${VIRTUAL_PROVIDER}/`)) {
						rt.previousModels.set(sessionId, current);
					}
					const auto = ctx.modelRegistry.find(VIRTUAL_PROVIDER, "auto");
					if (auto) await pi.setModel(auto);
				} else {
					const previous = rt.previousModels.get(sessionId);
					rt.previousModels.delete(sessionId);
					if (previous) {
						const parsed = splitRef(previous);
						if (parsed) {
							const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
							if (model) await pi.setModel(model);
						}
					}
				}
				ctx.ui.notify(`cuttle: routing ${enable ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (sub === "auto" || sub === "local" || sub === "cloud" || sub === "fast-local") {
				ctx.ui.notify(
					"cuttle: tier pins are replaced by a simple toggle. Use `/cuttle on` to route automatically, `/cuttle off` for default pi behavior.",
					"warning",
				);
				return;
			}
			if (sub === "models") return editModels(rt, ctx);
			if (sub === "policy") return editPolicy(rt, ctx);
			if (sub === "limit") return editLocalLimit(rt, ctx);
			if (sub === "doctor") return doctor(rt, ctx);
			return status(rt, loaded, ctx);
		},
	});
}
