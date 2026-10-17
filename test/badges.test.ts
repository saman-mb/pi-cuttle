/**
 * Pins the committed badge claims (#55).
 *
 * docs/badges/*.svg are the most-read documentation this project has — README, npm
 * page, gallery card — and nothing checked them. `tests.svg` claimed "80 passing"
 * for a 109-test suite, was corrected by hand to 109, and was stale again by 112 the
 * next time anyone looked. A badge is a claim; this file makes each claim checkable.
 *
 * Decisions, stated so they are not re-litigated:
 *   - The tests badge carries NO count. A count cannot be pinned without either a
 *     recursive suite run or brittle static counting, and it drifts on every added
 *     test. "passing" is the claim; CI enforces it; this file stops anyone quietly
 *     putting a number back.
 *   - The version badge is pinned to package.json, the shipped version. Whether the
 *     CHANGELOG carries a matching release heading is asserted in test/changelog.test.ts
 *     instead: #55 left that unpinned on the reasoning that release notes may lag a cycle,
 *     and that reasoning is what #65 turned out to be — a version advertised on the README
 *     with no release notes anywhere, which no gate looked at.
 *
 * Rendering is deterministic (same claim -> byte-identical SVG), so a failure here
 * is fixed by one command: `npm run badges`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const RERENDER = "re-render with `npm run badges`";

interface Badge {
	label: string;
	message: string;
	aria: string;
}

/** The two text segments a badge renders: grey label, coloured message. */
function badge(path: string): Badge {
	const svg = read(path);
	const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1] ?? "");
	const aria = /aria-label="([^"]*)"/.exec(svg)?.[1] ?? "";
	const label = texts[0];
	const message = texts.at(-1);
	assert.ok(label && message, `${path} does not look like a rendered badge; ${RERENDER}`);
	return { label, message, aria };
}

/** A hand edit that misses the accessibility label is still a hand edit. */
function assertInternallyConsistent(path: string, b: Badge): void {
	assert.equal(b.aria, `${b.label}: ${b.message}`, `${path} aria-label disagrees with its text segments; ${RERENDER}`);
}

const pkg = JSON.parse(read("package.json")) as { version: string; license: string };

test("the tests badge makes no counted claim, so it cannot go stale (#55)", () => {
	const b = badge("docs/badges/tests.svg");
	assertInternallyConsistent("docs/badges/tests.svg", b);
	assert.equal(
		b.message,
		"passing",
		"the tests badge must not carry a count (it drifted from 80 to 109 to stale again); " + RERENDER,
	);
	assert.doesNotMatch(b.message, /\d/, `a number here will go stale; ${RERENDER}`);
});

test("the version badge is pinned to package.json, the shipped version (#55)", () => {
	const b = badge("docs/badges/version.svg");
	assertInternallyConsistent("docs/badges/version.svg", b);
	assert.equal(b.message, `v${pkg.version}`, `package.json is the source of truth for the shipped version; ${RERENDER}`);
});

test("the license badge matches the packaged license (#55)", () => {
	const b = badge("docs/badges/license.svg");
	assertInternallyConsistent("docs/badges/license.svg", b);
	assert.equal(b.message, pkg.license, `package.json declares ${pkg.license}; ${RERENDER}`);
});

test("the README links every committed badge (#55)", () => {
	const readme = read("README.md");
	for (const file of ["docs/badges/tests.svg", "docs/badges/version.svg", "docs/badges/license.svg"]) {
		assert.ok(readme.includes(file), `README does not reference ${file}; ${RERENDER}`);
	}
});
