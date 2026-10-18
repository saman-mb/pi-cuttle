/**
 * Thinking-level mapping and clamping for pi-cuttle.
 *
 * Maps classifier complexity scores to thinking levels, clamps to model-supported
 * levels, and applies context-window pressure to reduce thinking on long threads.
 *
 * All functions are pure — no pi imports at runtime — so they are unit-testable
 * without a live ExtensionContext.
 */
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

import { type ThinkingLevelsPolicy } from "./types.ts";

/** pi's full thinking ladder, ascending. */
export const EXTENDED_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Map a complexity score to a target thinking level.
 *
 * Walks the `map` thresholds ascending; the first threshold whose `score` exceeds
 * the classifier score wins. If no threshold matches, returns `policy.default`.
 */
export function scoreToThinkingLevel(score: number, policy: ThinkingLevelsPolicy): ModelThinkingLevel {
	if (!policy.enabled || policy.map.length === 0) return policy.default;
	const sorted = [...policy.map].sort((a, b) => a.score - b.score);
	for (const entry of sorted) {
		if (score < entry.score) return entry.level;
	}
	return policy.default;
}

/**
 * Clamp a thinking level to the levels a model actually supports.
 *
 * Uses pi's exported `clampThinkingLevel` when available; falls back to a minimal
 * implementation that respects the model's `thinkingLevelMap`.
 */
export function clampToSupportedLevel(level: ModelThinkingLevel, model: Model<Api>): ModelThinkingLevel {
	const map = model.thinkingLevelMap ?? {};
	// Exact match.
	if (map[level] !== undefined && map[level] !== null) return level;
	// Walk up, then down the ladder.
	const index = EXTENDED_THINKING_LEVELS.indexOf(level);
	for (let i = index + 1; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i]!;
		if (map[candidate] !== undefined && map[candidate] !== null) return candidate;
	}
	for (let i = index - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i]!;
		if (map[candidate] !== undefined && map[candidate] !== null) return candidate;
	}
	// Last resort: use the first supported level or "off".
	const firstSupported = EXTENDED_THINKING_LEVELS.find((l) => map[l] !== undefined && map[l] !== null);
	return firstSupported ?? "off";
}

/**
 * Apply the user's `/thinking` selection as a ceiling.
 *
 * Returns the lower of `target` and `ceiling` in the thinking ladder. If either
 * is not a recognized level, `target` wins (defensive: never drop below what
 * the model supports).
 */
export function applyUserCeiling(target: ModelThinkingLevel, ceiling: ModelThinkingLevel): ModelThinkingLevel {
	const targetIndex = EXTENDED_THINKING_LEVELS.indexOf(target);
	const ceilingIndex = EXTENDED_THINKING_LEVELS.indexOf(ceiling);
	// If either is not a valid level, return target (defensive).
	if (targetIndex === -1 || ceilingIndex === -1) return target;
	return targetIndex <= ceilingIndex ? target : ceiling;
}

/**
 * Reduce thinking level by one step when context usage is high (#70).
 *
 * Returns the level one step below `level` in the ladder, or `level` if already at the bottom.
 */
export function reduceThinkingLevel(level: ModelThinkingLevel): ModelThinkingLevel {
	const index = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (index <= 0) return level;
	return EXTENDED_THINKING_LEVELS[index - 1] ?? level;
}

/**
 * Check if context usage exceeds the threshold and reduce thinking if so (#70).
 *
 * `contextTokens` is the current usage, `contextWindow` is the model's limit.
 * Returns the (possibly reduced) thinking level.
 */
export function applyContextPressure(
	level: ModelThinkingLevel,
	contextTokens: number | null | undefined,
	contextWindow: number,
	threshold?: number,
): ModelThinkingLevel {
	if (contextTokens == null || contextWindow <= 0) return level;
	const usage = contextTokens / contextWindow;
	const effectiveThreshold = threshold ?? 0.7;
	if (usage <= effectiveThreshold) return level;
	return reduceThinkingLevel(level);
}


