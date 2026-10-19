// The committed score taxonomy — the single source of truth for production routing scores.
//
// A test pins every name and data type here (test/scores.test.ts). Renaming or retyping a score
// silently resets its history in Langfuse, so the pin exists to make that change fail loudly.
// Adding a score means adding it here and updating the pin in the same change.

import { isLocalRef } from "./subagent-audit.ts";
import { isLocalOnlyFlavor } from "./virtual-models.ts";
import type { RouterFlavor } from "./types.ts";

export type ScoreDataType = "numeric" | "categorical" | "boolean";

export interface ScoreDefinition {
	name: string;
	dataType: ScoreDataType;
	/** The exact rule that produces the score, in words. */
	rule: string;
}

export const SCORE_TAXONOMY: readonly ScoreDefinition[] = [
	{
		name: "flavor_compliance",
		dataType: "boolean",
		rule: "Emitted for every routing decision whose flavor is local, fast-local, or big-local. false when the serving modelId is not a ref in catalog.local; true otherwise. Not emitted for other flavors.",
	},
	{
		name: "routed",
		dataType: "boolean",
		rule: "Emitted on the child-bypass path (#130) with value false. A routing decision is definitionally routed and emits no routed score.",
	},
];

/** A score ready to ingest: the taxonomy entry plus its computed value. */
export interface ScoreEntry {
	name: string;
	value: boolean;
	dataType: "BOOLEAN";
}

/**
 * Scores for a routing decision.
 *
 * `flavor_compliance` is emitted only for a local-only flavor, and is false when the serving model
 * is not in the local catalog. Under route()'s #112 pin that false case is unreachable through
 * route() itself, so the score is a tripwire: always true today, false if the pin regresses or a
 * trace is emitted outside route()'s guard.
 */
export function decisionScores(
	flavor: string,
	modelId: string,
	localCatalog: readonly string[],
): ScoreEntry[] {
	if (!isLocalOnlyFlavor(flavor as RouterFlavor)) return [];
	return [
		{
			name: "flavor_compliance",
			value: isLocalRef(modelId, localCatalog),
			dataType: "BOOLEAN",
		},
	];
}

/** Scores for a child that never entered the router (#130). */
export function bypassScores(): ScoreEntry[] {
	return [{ name: "routed", value: false, dataType: "BOOLEAN" }];
}
