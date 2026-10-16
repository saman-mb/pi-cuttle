/**
 * Pins the documented classifier example (#51).
 *
 * #51 was a docs drift: README and `docs/CONFIG.md` advertised decision models that do not
 * work on current LM Studio (`decision-2.0-kai-0.6b` fails to load on every bundled llama.cpp
 * runtime; `openjev-2b` does not exist), so a new user copying the example silently fell back
 * to the regex heuristic. Whether a model actually loads is a live fact that only `/cuttle
 * doctor` can check, but "the docs name that model, and say how to verify it" is checkable
 * here — which is what stops the drift from coming back.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The classifier model verified live to load and answer on current LM Studio. */
const VERIFIED_CLASSIFIER = "lmstudio/vllm-d3-nano";

const DOCS = ["README.md", "docs/CONFIG.md"];

test("the documented classifier example names a model verified to load (#51)", () => {
	for (const path of DOCS) {
		assert.ok(read(path).includes(VERIFIED_CLASSIFIER), `${path} must document ${VERIFIED_CLASSIFIER}`);
	}
	const example = JSON.parse(read("examples/cuttle.example.json")) as { classifier?: { model?: string } };
	assert.equal(example.classifier?.model, VERIFIED_CLASSIFIER, "the example config must name the same model");
});

test("both docs say how to verify a classifier id and point at /cuttle doctor (#51)", () => {
	for (const path of DOCS) {
		const text = read(path);
		assert.match(text, /GET \/api\/v1\/models/, `${path} must point at the catalog endpoint for a valid key`);
		assert.match(text, /cuttle doctor/, `${path} must point at /cuttle doctor`);
	}
});

test("no documented example still names a classifier known not to load (#51)", () => {
	for (const path of [...DOCS, "examples/cuttle.example.json"]) {
		assert.doesNotMatch(read(path), /decision-2\.0-kai|openjev-2b/, `${path} still names a broken example model`);
	}
});
