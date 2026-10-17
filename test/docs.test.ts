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
