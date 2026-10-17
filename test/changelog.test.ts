/**
 * Pins release coherence between `package.json` and `CHANGELOG.md` (#65).
 *
 * #55 deliberately left the changelog heading unpinned, on the reasoning that "release
 * notes may lag mid-cycle". That reasoning is what #65 turned out to be: `package.json`
 * moved to 0.2.0, the version badge was re-rendered to `v0.2.0` off it, and the changelog
 * still stopped at `0.1.0` — so the most-read page in the project advertised a version with
 * no release notes anywhere, and nothing failed.
 *
 * The rule is therefore reversed: a shipped version must have a release heading. The
 * supposed cost — a version bump now fails until the notes are cut — is the discipline that
 * prevents exactly this drift, and the fix when it fires is a heading and a link line.
 *
 * Nothing here reads git tags or the registry: both are unavailable in CI for an arbitrary
 * checkout, so the checkable claim is the document's own internal coherence. The tag and the
 * GitHub release are cut by the release process; this file keeps the changelog honest about
 * the version the package advertises.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const changelog = read("CHANGELOG.md");
const pkg = JSON.parse(read("package.json")) as { version: string };

/** Escape a version for a regex, so `0.2.0` and a future `0.3.0-rc.1` both drop in safely. */
const escapeVersion = (version: string): string => version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A release version, prerelease suffix tolerated: `1.2.3`, `1.2.3-rc.1`. */
const RELEASE_VERSION = "(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)";

/** The separator the changelog uses between version and date; em dash today, hyphen tolerated. */
const SEPARATOR = "\\s*[\u2014-]\\s*";

test("the shipped version has a dated release heading (#65)", () => {
	const pattern = new RegExp(`^## \\[${escapeVersion(pkg.version)}\\]${SEPARATOR}\\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
	assert.match(
		changelog,
		pattern,
		`CHANGELOG.md has no "## [${pkg.version}] — <date>" heading, but package.json ships ${pkg.version}. ` +
			"Cut the release heading (moving the accumulated Unreleased entries under it), or put package.json back " +
			"to the last released version.",
	);
});

test("every release heading has a matching link reference (#65)", () => {
	for (const match of changelog.matchAll(new RegExp(`^## \\[${RELEASE_VERSION}\\]`, "gm"))) {
		const version = match[1] as string;
		const reference = new RegExp(`^\\[${escapeVersion(version)}\\]: (\\S+)\\s*$`, "m");
		const url = reference.exec(changelog)?.[1];
		assert.ok(url, `CHANGELOG.md has a [${version}] heading but no [${version}]: link reference`);
		assert.match(url, new RegExp(`/v${escapeVersion(version)}$`), `[${version}]: must point at its own tag, got ${url}`);
	}
});

test("the Unreleased compare base starts from the shipped version (#65)", () => {
	// If an Unreleased section exists it must compare from the version that just shipped;
	// left pointing at an older base it silently hides everything released in between. Keyed
	// off the heading rather than the link line: a section whose link line was deleted used to
	// pass this test in silence, which is the same "no gate looked at it" failure as #65 itself.
	if (!/^## \[Unreleased\]/m.test(changelog)) return;
	const url = /^\[Unreleased\]: (\S+)\s*$/m.exec(changelog)?.[1];
	assert.ok(url, "CHANGELOG.md has an [Unreleased] section but no [Unreleased]: link line");
	assert.match(
		url,
		new RegExp(`/compare/v${escapeVersion(pkg.version)}\\.\\.\\.HEAD$`),
		`[Unreleased]: must compare from v${pkg.version} (the shipped version), got ${url}`,
	);
});
