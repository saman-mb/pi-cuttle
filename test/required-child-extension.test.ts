/**
 * Required-child-extension registration tests (#131).
 *
 * The point of this module is that it is *optional*: pi-cuttle has no dependency on pi-subagents,
 * so the interesting cases are the failure paths. A fake importer stands in for the real subpath
 * export, which is not installed in this repo — and that absence is itself the production fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	REQUIRED_CHILD_EXTENSION_ID,
	createRequiredChildExtensionController,
	registerRequiredChildExtension,
	type RequiredChildExtensionEntry,
	type RequiredChildExtensionsModule,
} from "../src/required-child-extension.ts";

interface Recorded {
	sessionId: string;
	extensions: readonly RequiredChildExtensionEntry[];
}

/** A fake pi-subagents registry that records calls and tracks dispose. */
function fakeModule(): { module: RequiredChildExtensionsModule; calls: Recorded[]; disposed: number[] } {
	const calls: Recorded[] = [];
	const disposed: number[] = [];
	let next = 0;
	return {
		calls,
		disposed,
		module: {
			registerRequiredChildExtensions(input) {
				calls.push({ sessionId: input.sessionId, extensions: input.extensions });
				const index = next++;
				return {
					dispose() {
						disposed.push(index);
					},
				};
			},
		},
	};
}

describe("registerRequiredChildExtension", () => {
	it("registers the router path under the pi-cuttle id", async () => {
		const { module, calls } = fakeModule();
		const handle = await registerRequiredChildExtension({
			sessionId: "session-1",
			extensionPath: "/opt/pi-cuttle/src/index.ts",
			importer: async () => module,
		});
		assert.ok(handle, "a handle is returned on success");
		assert.deepEqual(calls, [
			{ sessionId: "session-1", extensions: [{ id: REQUIRED_CHILD_EXTENSION_ID, path: "/opt/pi-cuttle/src/index.ts" }] },
		]);
	});

	it("returns undefined and logs when pi-subagents is not installed", async () => {
		const logged: string[] = [];
		const handle = await registerRequiredChildExtension({
			sessionId: "session-1",
			extensionPath: "/opt/pi-cuttle/src/index.ts",
			importer: async () => {
				throw new Error("Cannot find module 'pi-subagents/required-child-extensions'");
			},
			log: (message) => logged.push(message),
		});
		assert.equal(handle, undefined);
		assert.match(logged.join("\n"), /registration failed: Cannot find module/);
	});

	it("returns undefined when the export is missing or drifted", async () => {
		const logged: string[] = [];
		const handle = await registerRequiredChildExtension({
			sessionId: "session-1",
			extensionPath: "/opt/pi-cuttle/src/index.ts",
			importer: async () => ({}) as RequiredChildExtensionsModule,
			log: (message) => logged.push(message),
		});
		assert.equal(handle, undefined);
		assert.match(logged.join("\n"), /not a function/);
	});

	it("swallows a rejection from the registry itself", async () => {
		const logged: string[] = [];
		const handle = await registerRequiredChildExtension({
			sessionId: "session-1",
			extensionPath: "/opt/pi-cuttle/src/index.ts",
			importer: async () => ({
				registerRequiredChildExtensions() {
					throw new Error("Required child extensions are already registered for session 'session-1'");
				},
			}),
			log: (message) => logged.push(message),
		});
		assert.equal(handle, undefined);
		assert.match(logged.join("\n"), /already registered/);
	});

	it("skips registration when there is no session id", async () => {
		const { module, calls } = fakeModule();
		const logged: string[] = [];
		const handle = await registerRequiredChildExtension({
			sessionId: "",
			extensionPath: "/opt/pi-cuttle/src/index.ts",
			importer: async () => module,
			log: (message) => logged.push(message),
		});
		assert.equal(handle, undefined);
		assert.equal(calls.length, 0, "the registry is never called without a session id");
		assert.match(logged.join("\n"), /no session id/);
	});

	it("never throws, whatever the importer does", async () => {
		await assert.doesNotReject(async () =>
			registerRequiredChildExtension({
				sessionId: "session-1",
				extensionPath: "/opt/pi-cuttle/src/index.ts",
				importer: async () => {
					throw new Error("boom");
				},
			}),
		);
	});
});

describe("createRequiredChildExtensionController", () => {
	it("replaces the previous registration when a new session starts", async () => {
		const { module, calls, disposed } = fakeModule();
		const controller = createRequiredChildExtensionController({ importer: async () => module });
		await controller.register("session-1", "/opt/pi-cuttle/src/index.ts");
		await controller.register("session-2", "/opt/pi-cuttle/src/index.ts");
		assert.deepEqual(
			calls.map((call) => call.sessionId),
			["session-1", "session-2"],
		);
		assert.deepEqual(disposed, [0], "the first registration is disposed, not leaked");
	});

	it("disposes the live registration on request, and is idempotent", async () => {
		const { module, disposed } = fakeModule();
		const controller = createRequiredChildExtensionController({ importer: async () => module });
		await controller.register("session-1", "/opt/pi-cuttle/src/index.ts");
		controller.dispose();
		controller.dispose();
		assert.deepEqual(disposed, [0], "dispose runs once and tolerates being called again");
	});

	it("survives a failed registration and still disposes cleanly", async () => {
		const controller = createRequiredChildExtensionController({
			importer: async () => {
				throw new Error("not installed");
			},
		});
		await controller.register("session-1", "/opt/pi-cuttle/src/index.ts");
		assert.doesNotThrow(() => controller.dispose());
	});
});
