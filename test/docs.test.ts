/**
 * Pins documented examples and verification instructions (#51).
 *
 * #51 was a docs drift: README and `docs/CONFIG.md` advertised decision models that do not
 * work on current LM Studio (`decision-2.0-kai-0.6b` fails to load on every bundled llama.cpp
 * runtime; `openjev-2b` does not exist), so a new user copying the example silently fell back
 * to the regex heuristic. The docs must now tell the user how to verify any ref themselves,
 * and must not resurrect known-broken examples.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULTS } from "../src/config.ts";
import { SCORE_TAXONOMY } from "../src/scores.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const DOCS = ["README.md", "docs/CONFIG.md"];
const EXAMPLE = "examples/pi-cuttle.example.json";

test("the documented classifier example names a model and tells the user how to verify it (#51)", () => {
	for (const path of DOCS) {
		const text = read(path);
		assert.match(text, /cuttle doctor/, `${path} must point at /cuttle doctor`);
		assert.match(text, /pi --list-models|model registry/, `${path} must tell the user how to list pi models`);
	}
	const example = JSON.parse(read(EXAMPLE)) as { classifier?: { model?: string } };
	assert.ok(example.classifier?.model, `the example config must name a classifier`);
	assert.match(example.classifier.model, /\//, "classifier model must be a provider/model ref");
});

test("#132: the Langfuse docs name every routing score, its type, and that scores are not a gate", () => {
	const text = read("docs/LANGFUSE.md");
	for (const score of SCORE_TAXONOMY) {
		assert.match(text, new RegExp(score.name), `docs must name ${score.name}`);
		assert.match(text, new RegExp(score.dataType), `docs must state the ${score.name} data type`);
	}
	assert.match(text, /\/api\/public\/scores/, "docs must name the ingestion path");
	assert.match(text, /not a gate|observational/i, "docs must say scores cannot fail a turn");
});

test("no documented example still names a classifier known not to load (#51)", () => {
	for (const path of [...DOCS, EXAMPLE]) {
		assert.doesNotMatch(read(path), /decision-2\.0-kai|openjev-2b/, `${path} still names a broken example model`);
	}
});

/**
 * Pins the classifier context documentation to the shipped default (#103 story #107).
 *
 * The epic's default flip is gated on real-session shadow evidence. Until that evidence exists,
 * both the code default and every doc must keep saying `last-message`. This test makes the claim
 * checkable in both directions: a doc that advertises `conversation` as the default fails, and so
 * does a premature flip in `DEFAULTS` that leaves the docs behind.
 */
test("docs and code agree that contextSource still defaults to last-message (#103)", () => {
	assert.equal(DEFAULTS.classifier.contextSource, "last-message", "the default must not flip before shadow evidence exists");
	assert.equal(DEFAULTS.classifier.contextShadow, false, "shadow comparison is opt-in");

	for (const path of ["README.md", "docs/CONFIG.md", "CHANGELOG.md"]) {
		const text = read(path);
		assert.match(text, /last-message/, `${path} must name the current default`);
	}
	assert.match(read("docs/CONFIG.md"), /contextSource/, "docs/CONFIG.md must document the field");
});

/**
 * Pins the honesty of the rollout docs (#103 integration board).
 *
 * The board rejected an earlier draft for overclaiming: "can never route worse" and an unexplained
 * "every knob" panel promise. A doc that oversells an unproven signal is a product defect, not a
 * wording preference — these assertions keep the corrected claims from drifting back.
 */
test("the rollout docs do not overclaim the conversation signal (#103)", () => {
	const config = read("docs/CONFIG.md");
	const changelog = read("CHANGELOG.md");

	assert.doesNotMatch(config, /can never route worse/i, "must not promise the opt-in path is strictly better");
	assert.doesNotMatch(changelog, /never delays a turn/i, "must not claim a second classifier call is free");
	assert.doesNotMatch(config, /showing every knob/i, "the panel does not expose every knob");

	// The limitations of the new signal must be stated, not merely implied.
	assert.match(config, /not earlier \*\*user\*\* requests/i, "must name the earlier-user-message gap");
	assert.match(config, /JSON-only for now/i, "must disclose that the new fields are not panel-editable");
	assert.match(config, /does\s+\*\*not\*\*\s+exist yet|not exist yet/i, "must state the evidence does not exist yet");
});

/**
 * Pins the honesty of the product-impact doc (#71).
 *
 * The first version of `docs/PRODUCT-IMPACT.md` shipped with two outcomes describing
 * capabilities the code does not have — a per-session `sessionCloudBudget` and a preference for
 * models already resident in memory (the README's "Governor gap" says the extension cannot
 * manage residency at all) — and described two opt-in knobs, `policy.subagent` and
 * `policy.thinkingLevels`, as automatic. Same failure class as #51 and #103: a doc that
 * oversells is a product defect, not a wording preference.
 *
 * These pins do not restate the doc. They pin the corrections, so a later edit cannot re-promote
 * a missing feature into the shipped section, drop an opt-in label, or restore the claim that
 * `cuttle/orchestrator` is cloud-leaning while `flavorBias()` still forces it local (#122).
 */
const PRODUCT_IMPACT = "docs/PRODUCT-IMPACT.md";

/** Strip blockquote markers and fold whitespace so a wrapped sentence matches as one line. */
const flatten = (text: string): string => text.replace(/^>\s?/gm, "").replace(/\s+/g, " ");

/** Slice out one `##` section, heading to next `##` heading. */
function section(text: string, heading: string): string {
	const start = text.indexOf(heading);
	assert.notEqual(start, -1, `${PRODUCT_IMPACT} must keep a "${heading}" section`);
	const rest = text.slice(start + heading.length);
	const end = rest.search(/\n## /);
	return end === -1 ? rest : rest.slice(0, end);
}

test("the product-impact doc does not advertise a capability that does not exist (#71)", () => {
	const text = read(PRODUCT_IMPACT);

	// The "works today" section is the one a reader acts on, so it must stay free of the two
	// capabilities the code has never had: a per-session cloud budget, and preferring models
	// already resident in memory.
	const works = flatten(section(text, "## Outcomes that work on a default install"));
	assert.doesNotMatch(works, /sessionCloudBudget|cloud budget|spend cap|cost cap/i, "no cloud-spend control ships to advertise");
	assert.doesNotMatch(works, /resident|already.?loaded/i, "the router never queries which models are loaded");

	// Both must be named where a reader will look: the status table marks them absent, and the
	// Not-implemented section explains them. Deleting either is how a missing feature comes
	// back dressed as a shipped one.
	assert.equal(
		(section(text, "## What you get, and whether it is on").match(/Does not exist/g) ?? []).length,
		2,
		"the status table must mark both missing capabilities as not existing",
	);
	const gaps = section(text, "## Not implemented");
	assert.match(gaps, /sessionCloudBudget/, "the missing cloud budget must stay disclosed");
	assert.match(gaps, /resident/i, "the missing residency preference must stay disclosed");
});

test("the product-impact doc labels opt-in knobs as opt-in (#71)", () => {
	const text = flatten(read(PRODUCT_IMPACT));

	// Both default off, so describing either as automatic overstates a default install.
	assert.match(text, /`enabled: false`/, "thinking-level scaling must be labelled off by default");
	assert.match(
		text,
		/policy\.subagent.{0,600}unset by default/is,
		"the subagent policy override must be labelled unset by default",
	);
});

test("the product-impact doc does not repeat the orchestrator overclaim (#122)", () => {
	const text = flatten(read(PRODUCT_IMPACT));

	// `flavorBias()` returns "local" for `orchestrator`, so "quality-first, cloud-leaning" is
	// the opposite of what the flavour does. State that it cannot reach cloud, and point at the
	// open issue that decides whether the code or the prose changes; do not settle it here.
	assert.match(text, /never reaches a cloud model/, "must state that orchestrator cannot reach cloud");
	assert.match(text, /issues\/122/, "must link the open issue that settles the flavour contract");
	assert.doesNotMatch(text, /leans?[^.]{0,40}cloud/i, "must not describe any flavour as cloud-leaning");
});

test("the product-impact doc is reachable from the README (#71)", () => {
	// It shipped unreferenced the first time: a doc no page links to is a doc nobody reads.
	assert.match(read("README.md"), /docs\/PRODUCT-IMPACT\.md/, "the docs index must link the product impact doc");
});
