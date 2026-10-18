/**
 * Subagent detection unit tests.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { isSubagent, SUBAGENT_CHILD_ENV } from "../src/subagent.ts";

describe("isSubagent", () => {
	const originalValue = process.env[SUBAGENT_CHILD_ENV];

	afterEach(() => {
		// Restore original environment.
		if (originalValue === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = originalValue;
	});

	it("returns false when env var is not set", () => {
		delete process.env[SUBAGENT_CHILD_ENV];
		assert.equal(isSubagent(), false);
	});

	it("returns false when env var is set to something other than '1'", () => {
		process.env[SUBAGENT_CHILD_ENV] = "0";
		assert.equal(isSubagent(), false);
		process.env[SUBAGENT_CHILD_ENV] = "true";
		assert.equal(isSubagent(), false);
	});

	it("returns true when env var is '1'", () => {
		process.env[SUBAGENT_CHILD_ENV] = "1";
		assert.equal(isSubagent(), true);
	});
});
