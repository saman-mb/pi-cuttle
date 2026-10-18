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
