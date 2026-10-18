import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULTS } from "../src/config.ts";
import modelRouter from "../src/index.ts";
import { SUBAGENT_CHILD_ENV } from "../src/subagent.ts";

// Auto-select is skipped inside pi-subagents children (#95), so clear any inherited marker and
// keep this suite deterministic whether it runs from a shell or inside a subagent.
delete process.env[SUBAGENT_CHILD_ENV];

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

function createContext(
	model?: { provider: string; id: string },
	parentSession?: string,
): ExtensionContext {
	return {
		model,
		sessionManager: {
			getSessionId: () => "s1",
			// A session created by another session carries a parentSession header (#95).
			getHeader: () => (parentSession ? { parentSession } : {}),
		},
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
	writeFileSync(join(configDir, "pi-cuttle.json"), JSON.stringify(config));
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

test("session_start respects an explicit --model=value flag even when autoSelect is true", async () => {
	const originalArgv = process.argv;
	process.argv = ["node", "pi", "--model=opencode-go/deepseek-v4.1-flash"];
	await withTempConfig(
		{
			autoSelect: true,
			catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
		},
		() => {
			const { pi, events, calls } = createMockPI();
			modelRouter(pi);
			const handlers = events["session_start"] ?? [];
			const handler = handlers[0];
			assert.ok(handler);
			handler({}, createContext({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
			assert.equal(calls.setModel.length, 0, "setModel must not override an explicit --model=value");
		},
	);
	process.argv = originalArgv;
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

test("session_start does not claim a subagent child's launch model", async () => {
	const original = process.env[SUBAGENT_CHILD_ENV];
	process.env[SUBAGENT_CHILD_ENV] = "1";
	try {
		await withTempConfig(
			{
				autoSelect: true,
				local: { preload: false, pinClassifier: false },
				catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
			},
			async () => {
				const { pi, events, calls } = createMockPI();
				modelRouter(pi);
				const handler = (events["session_start"] ?? [])[0];
				assert.ok(handler);
				await handler({}, createContext({ provider: "opencode-go", id: "gpt-6-luna" }));
				assert.equal(
					calls.setModel.length,
					0,
					"setModel must not claim a subagent child's launch model",
				);
			},
		);
	} finally {
		if (original === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = original;
	}
});

test("a subagent child on a non-cuttle model is recorded as a router bypass (#130)", async () => {
	const originalSubagent = process.env[SUBAGENT_CHILD_ENV];
	const originalDebug = process.env.PI_CUTTLE_DEBUG;
	const dir = mkdtempSync(join(tmpdir(), "cuttle-bypass-"));
	const debugPath = join(dir, "debug.log");
	process.env[SUBAGENT_CHILD_ENV] = "1";
	process.env.PI_CUTTLE_DEBUG = debugPath;
	try {
		await withTempConfig(
			{
				autoSelect: true,
				local: { preload: false, pinClassifier: false },
				catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
			},
			async () => {
				const { pi, events, calls } = createMockPI();
				modelRouter(pi);
				const handler = (events["session_start"] ?? [])[0];
				assert.ok(handler);
				await handler({}, createContext({ provider: "opencode-go", id: "gpt-6-luna" }));
				assert.equal(calls.setModel.length, 0, "setModel must not claim a subagent child");
				const log = readFileSync(debugPath, "utf8");
				assert.match(
					log,
					/child bypass kind=subagent model=opencode-go\/gpt-6-luna/,
					"a child that never entered the router must be recorded, not silently skipped",
				);
			},
		);
	} finally {
		if (originalSubagent === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = originalSubagent;
		if (originalDebug === undefined) delete process.env.PI_CUTTLE_DEBUG;
		else process.env.PI_CUTTLE_DEBUG = originalDebug;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a subagent child already on cuttle/* is not recorded as a bypass", async () => {
	const originalSubagent = process.env[SUBAGENT_CHILD_ENV];
	const originalDebug = process.env.PI_CUTTLE_DEBUG;
	const dir = mkdtempSync(join(tmpdir(), "cuttle-bypass-"));
	const debugPath = join(dir, "debug.log");
	process.env[SUBAGENT_CHILD_ENV] = "1";
	process.env.PI_CUTTLE_DEBUG = debugPath;
	try {
		await withTempConfig(
			{
				autoSelect: true,
				local: { preload: false, pinClassifier: false },
				catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
			},
			async () => {
				const { pi, events } = createMockPI();
				modelRouter(pi);
				const handler = (events["session_start"] ?? [])[0];
				assert.ok(handler);
				await handler({}, createContext({ provider: "cuttle", id: "local" }));
				const log = existsSync(debugPath) ? readFileSync(debugPath, "utf8") : "";
				assert.doesNotMatch(log, /child bypass/, "a routed child is already covered by its routing trace");
			},
		);
	} finally {
		if (originalSubagent === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = originalSubagent;
		if (originalDebug === undefined) delete process.env.PI_CUTTLE_DEBUG;
		else process.env.PI_CUTTLE_DEBUG = originalDebug;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session_start does not claim a session that has a parent (fork or foreground child)", async () => {
	await withTempConfig(
		{
			autoSelect: true,
			local: { preload: false, pinClassifier: false },
			catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
		},
		async () => {
			const { pi, events, calls } = createMockPI();
			modelRouter(pi);
			const handler = (events["session_start"] ?? [])[0];
			assert.ok(handler);
			await handler(
				{},
				createContext({ provider: "opencode-go", id: "gpt-6-luna" }, "/parent/session.jsonl"),
			);
			assert.equal(calls.setModel.length, 0, "setModel must not override a session that has a parent");
		},
	);
});

test("a subagent child launched on cuttle/auto is left to route through its message hooks", async () => {
	const original = process.env[SUBAGENT_CHILD_ENV];
	process.env[SUBAGENT_CHILD_ENV] = "1";
	try {
		await withTempConfig(
			{
				autoSelect: true,
				local: { preload: false, pinClassifier: false },
				catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
			},
			async () => {
				const { pi, events, calls } = createMockPI();
				modelRouter(pi);
				const handler = (events["session_start"] ?? [])[0];
				assert.ok(handler);
				await handler({}, createContext({ provider: "cuttle", id: "auto" }));
				assert.equal(
					calls.setModel.length,
					0,
					"an already-virtual child selection must be left alone",
				);
			},
		);
	} finally {
		if (original === undefined) delete process.env[SUBAGENT_CHILD_ENV];
		else process.env[SUBAGENT_CHILD_ENV] = original;
	}
});

test("session_start still completes when pi-subagents is not installed (#131)", async () => {
	// The repo does not depend on pi-subagents, so the real dynamic import fails here — exactly
	// the production fallback path. The router must log it and keep going, never fail the session.
	const debugPath = join(tmpdir(), `cuttle-required-child-${process.pid}-${Date.now()}.log`);
	const originalDebug = process.env.PI_CUTTLE_DEBUG;
	process.env.PI_CUTTLE_DEBUG = debugPath;
	try {
		await withTempConfig(
			{
				autoSelect: true,
				local: { preload: false, pinClassifier: false },
				catalog: { local: ["lmstudio/local-model"], cloud: ["cloud/big-model"] },
			},
			async () => {
				const { pi, events, calls } = createMockPI();
				modelRouter(pi);
				const handler = (events["session_start"] ?? [])[0];
				assert.ok(handler);
				await assert.doesNotReject(async () =>
					handler({}, createContext({ provider: "opencode-go", id: "deepseek-v4.1-flash" })),
				);
				assert.equal(
					calls.setModel.length,
					1,
					"routing still works when the optional integration is missing",
				);
				assert.ok(existsSync(debugPath), "the soft failure is logged, not swallowed silently");
				const logged = readFileSync(debugPath, "utf8");
				assert.match(logged, /required-child-extension registration failed/);
			},
		);
	} finally {
		if (originalDebug === undefined) delete process.env.PI_CUTTLE_DEBUG;
		else process.env.PI_CUTTLE_DEBUG = originalDebug;
		rmSync(debugPath, { force: true });
	}
});

test("session_shutdown disposes the required-child-extension registration (#131)", async () => {
	await withTempConfig({ autoSelect: false, local: { preload: false, pinClassifier: false } }, () => {
		const { pi, events } = createMockPI();
		modelRouter(pi);
		const shutdown = (events["session_shutdown"] ?? [])[0];
		assert.ok(shutdown, "the extension registers a session_shutdown handler");
		assert.doesNotThrow(() => shutdown({}, createContext()));
	});
});
