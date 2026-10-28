/**
 * The #131 Langfuse crashes, checked as fixtures rather than a live child.
 *
 * The assertion rules always run. The projection through the installed pi-subagents runs only
 * when that package is on the machine; CI without it does not get a false pass from a skip of
 * the rules themselves.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkChildLaunchFixtures, fixtureFailures, loadChildLaunchFixtures } from "../eval/child-launch.ts";

const piSubagentsInstalled = existsSync(
	join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "package.json"),
);

test("child-launch fixtures cover the suffixed models that died in Langfuse", () => {
	const fixtures = loadChildLaunchFixtures();
	const models = fixtures.map((fixture) => fixture.model).sort();
	assert.deepEqual(models, ["cuttle/auto:high", "cuttle/local:high", "cuttle/local:medium"]);
});

test("a launch that omits the router fails the fixture", () => {
	const [fixture] = loadChildLaunchFixtures();
	assert.ok(fixture);
	const failures = fixtureFailures(
		fixture,
		[],
		{ extensionArgs: [], requiredExtensions: [] },
		{ required: [], effective: [] },
		{ baseModel: fixture.model, thinkingSuffix: "" },
	);
	assert.ok(failures.length > 0);
	assert.match(failures.join("\n"), /pi-cuttle/);
});

test("installed pi-subagents projects every child-launch fixture onto the router", { skip: !piSubagentsInstalled }, async () => {
	const failures = await checkChildLaunchFixtures();
	assert.deepEqual(failures, [], failures.join("\n"));
});
