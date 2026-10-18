/**
 * Pins the #92 spike: LangGraph was measured and rejected, and the rejection
 * must stay honest. The package is not installed in CI; this file does not
 * import it, open a network connection, or touch a temp directory.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const DECISION = "Decision: reject LangGraph. Do not add @langchain/langgraph. Do not rewire routeRequest.";
const STALE_TS = 'The issue\'s claim that "TS support is newer" is stale.';

test("the spike and the architecture note reject LangGraph with the same pinned lines (#92)", () => {
	const spike = read("docs/spikes/92-langgraph-routing.md");
	const architecture = read("docs/ARCHITECTURE.md");

	assert.equal(spike.startsWith("# Spike #92: LangGraph for routing\n"), true);
	for (const text of [spike, architecture]) {
		assert.ok(text.includes(DECISION), "decision line must be verbatim");
		assert.ok(text.includes(STALE_TS), "stale-TS correction must be verbatim");
		assert.ok(text.includes("src/virtual-models.ts:290-655"));
		assert.ok(text.includes("366"));
	}

	assert.ok(spike.includes("@langchain/langgraph@1.5.1"));
	assert.ok(spike.includes("## Decomposition plan (not a LangGraph migration)"));
	assert.ok(architecture.includes("## Decision: reject LangGraph (#92)"));
	assert.ok(architecture.includes("spikes/92-langgraph-routing.md"));
	assert.ok(architecture.includes("Invariants unchanged"));
	assert.equal(architecture.lastIndexOf("\n## "), architecture.lastIndexOf("\n## Decision: reject LangGraph (#92)"));
	assert.ok(architecture.includes("## Invariants"));
});

test("routeRequest is still the 366-line span the spike cites (#92)", () => {
	const lines = read("src/virtual-models.ts").split("\n");
	assert.match(lines[289] ?? "", /export async function routeRequest/);
	assert.equal(lines[654], "}");
	assert.equal(655 - 290 + 1, 366);
});

test("package.json did not gain a LangGraph dependency (#92)", () => {
	const text = read("package.json");
	const pkg = JSON.parse(text) as { dependencies?: unknown };
	assert.equal(Object.hasOwn(pkg, "dependencies"), false);
	assert.equal(pkg.dependencies, undefined);
	assert.doesNotMatch(text, /@langchain/);
});
