import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS } from "../src/config.ts";
import { lastUserText, pickCloud, pickLocal } from "../src/virtual-models.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { RouterConfig } from "../src/types.ts";

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
	return { ...structuredClone(DEFAULTS), ...overrides };
}

test("fast-local orders local candidates by on-disk size, smallest first", () => {
	const cfg = config({ catalog: { local: ["lmstudio/big", "lmstudio/small"], cloud: ["c/m"] } });
	const sizes = new Map([
		["lmstudio/big", 90_000],
		["lmstudio/small", 2_000],
	]);
	assert.equal(pickLocal(cfg, "fast-local", sizes), "lmstudio/small");
	assert.equal(pickLocal(cfg, "auto"), "lmstudio/big", "auto keeps configured order");
});

test("fast-local with no sizes falls back to configured order", () => {
	const cfg = config({ catalog: { local: ["lmstudio/a", "lmstudio/b"], cloud: [] } });
	assert.equal(pickLocal(cfg, "fast-local", new Map()), "lmstudio/a");
});

test("pickCloud returns the first cloud candidate", () => {
	const cfg = config({ catalog: { local: [], cloud: ["cloud/one", "cloud/two"] } });
	assert.equal(pickCloud(cfg), "cloud/one");
});

test("lastUserText reads the latest user text block", () => {
	const messages = [
		{ role: "user", content: "first" },
		{ role: "assistant", content: [{ type: "text", text: "reply" }] },
		{ role: "user", content: [{ type: "text", text: "latest" }] },
	] as unknown as Message[];
	assert.equal(lastUserText(messages), "latest");
});
