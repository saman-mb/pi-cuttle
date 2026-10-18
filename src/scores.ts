// The committed score taxonomy — the single source of truth for production routing scores.
//
// A test pins every name and data type here (test/scores.test.ts). Renaming or retyping a score
// silently resets its history in Langfuse, so the pin exists to make that change fail loudly.
// Adding a score means adding it here and updating the pin in the same change.

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
