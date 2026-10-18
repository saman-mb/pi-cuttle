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
