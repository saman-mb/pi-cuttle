import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULTS } from "../src/config.ts";
import modelRouter from "../src/index.ts";

test("autoSelect defaults to false so installs never hijack the session model", () => {
	assert.equal(DEFAULTS.autoSelect, false);
});

interface MockPI {
	pi: ExtensionAPI;
	events: Record<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>>;
	calls: { setModel: unknown[]; registerVirtualModel: unknown[] };
}

function createMockPI(): MockPI {
	const events: Record<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>> = {};
	const calls: { setModel: unknown[]; registerVirtualModel: unknown[] } = { setModel: [], registerVirtualModel: [] };
	const pi = {
		registerFlag: () => {},
		registerVirtualModel: (model: unknown) => {
			calls.registerVirtualModel.push(model);
		},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
			(events[event] ??= []).push(handler);
		},
		setModel: (model: unknown) => {
			calls.setModel.push(model);
			return Promise.resolve();
		},
		getFlag: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, events, calls };
}

function createContext(model?: { provider: string; id: string }): ExtensionContext {
	return {
		model,
		modelRegistry: {
			find: (provider: string, id: string) => {
				if (provider === "cuttle" && id === "auto") {
					return { provider, id, contextWindow: 100_000 };
				}
				return undefined;
			},
		},
	} as unknown as ExtensionContext;
}

async function withTempConfig(config: Record<string, unknown>, fn: () => void | Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "cuttle-index-test-"));
	const configDir = join(dir, ".pi");
	const originalCwd = process.cwd();
	mkdirSync(configDir);
	writeFileSync(join(configDir, "cuttle.json"), JSON.stringify(config));
	process.chdir(dir);
	try {
		await fn();
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("session_start does not switch model when autoSelect is false", async () => {
	await withTempConfig({ autoSelect: false, local: { preload: false, pinClassifier: false } }, async () => {
		const { pi, events, calls } = createMockPI();
		modelRouter(pi);
		const handlers = events["session_start"] ?? [];
		assert.equal(handlers.length, 1);
		const handler = handlers[0];
		assert.ok(handler);
		handler({}, createContext({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
		assert.equal(calls.setModel.length, 0, "setModel must not be called when autoSelect is false");
	});
});

test("session_start does not switch model when catalog is empty, even if autoSelect is true", async () => {
	await withTempConfig(
		{
			autoSelect: true,
			local: { preload: false, pinClassifier: false },
			catalog: { local: [], cloud: [] },
		},
		() => {
			const { pi, events, calls } = createMockPI();
			modelRouter(pi);
			const handlers = events["session_start"] ?? [];
			assert.equal(handlers.length, 1);
			const handler = handlers[0];
			assert.ok(handler);
			handler({}, createContext({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
			assert.equal(
				calls.setModel.length,
				0,
				"setModel must not be called when no catalog is configured",
			);
		},
	);
});

test("session_start switches to cuttle/auto when autoSelect is true and a catalog exists", async () => {
	await withTempConfig(
		{
			autoSelect: true,
			local: { preload: false, pinClassifier: false },
			catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
		},
		async () => {
			const { pi, events, calls } = createMockPI();
			modelRouter(pi);
			const handlers = events["session_start"] ?? [];
			assert.equal(handlers.length, 1);
			const handler = handlers[0];
			assert.ok(handler);
			await handler({}, createContext({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
			assert.equal(calls.setModel.length, 1, "setModel must be called once");
			assert.equal((calls.setModel[0] as { id: string }).id, "auto");
		},
	);
});

test("session_start respects an explicit --model flag even when autoSelect is true", async () => {
	const originalArgv = process.argv;
	process.argv = ["node", "pi", "--model", "opencode-go/deepseek-v4.1-flash"];
	await withTempConfig(
		{
			autoSelect: true,
			local: { preload: false, pinClassifier: false },
			catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
		},
		() => {
			const { pi, events, calls } = createMockPI();
			modelRouter(pi);
			const handlers = events["session_start"] ?? [];
			assert.equal(handlers.length, 1);
			const handler = handlers[0];
			assert.ok(handler);
			handler({}, createContext({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
			assert.equal(calls.setModel.length, 0, "setModel must not override an explicit --model");
		},
	);
	process.argv = originalArgv;
});
