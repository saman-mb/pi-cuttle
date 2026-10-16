/**
 * Pins the logo asset the README promises.
 *
 * The rename PR added a README reference to an animated pixel-art cuttlefish before
 * the asset existed (and pointed it at a raw URL for a different repo name). This
 * keeps the promise checkable: the GIF is present, is actually animated, and the
 * README points at it relatively so forks and npm renders work.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): Buffer => readFileSync(new URL(`../${path}`, import.meta.url));

test("the README points at the committed logo, not a raw URL for another repo", () => {
	const readme = read("README.md").toString("utf8");
	assert.match(readme, /src="docs\/assets\/logo\.gif"/, "logo must be referenced relatively");
	assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/saman-mb\/cuttle\//, "no stale cross-repo raw URL");
});

test("the logo is a real animated GIF (not a static file with a .gif name)", () => {
	const gif = read("docs/assets/logo.gif");
	assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a", "GIF89a magic");
	// A single-frame GIF has no Netscape looping extension; animation does.
	assert.ok(gif.includes(Buffer.from("NETSCAPE2.0")), "missing animation loop extension");
});

test("the reduced-motion poster is committed alongside", () => {
	assert.ok(existsSync(new URL("../docs/assets/logo_poster.png", import.meta.url)), "logo_poster.png must exist");
});
