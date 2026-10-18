/**
 * The parent-side local-only guard for subagent launches (#130).
 *
 * The defect: a session on `cuttle/local` (or `fast-local`/`big-local`) delegated to a child that
 * was explicitly launched on a cloud model. The child never entered the router, so the local-only
 * contract its parent was under was broken invisibly. The cause is settled: an explicit per-run
 * model override (`subagent({agent, model})`), not inheritance.
 *
 * The guard runs in the *parent* process at `tool_call`, where a `{ block, reason }` result stops
 * the child before it starts (verified on this machine: two probe runs, zero child sessions). Three
 * rules the tests below pin, because each was measured rather than assumed:
 *
 *   - the requested child model is readable at `event.input.model`; `event.args` is the shape
 *     `docs/extensions.md` and `dist/core/extensions/types.d.ts` promise. Guard both, `input` first.
 *   - a block reason that reads like data gets mistaken for the child's answer, so the reason text
 *     is a deliverable and its shape is pinned here.
 *   - anything the guard cannot determine fails **open**. A guard bug must never cost a session.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	createDelegationGuard,
	evaluateDelegationCall,
	recordDelegationCall,
	runDelegationGuard,
	statusDelegationLines,
	type DelegationCallInput,
	type DelegationGuard,
} from "../src/delegation-guard.ts";
import type { DelegationMode } from "../src/types.ts";
import { registerCuttleCommand } from "../src/commands.ts";
import { DEFAULTS } from "../src/config.ts";
import modelRouter from "../src/index.ts";

const CLOUD_MODEL = "opencode-go/deepseek-v4.1-flash";

/** The default fixture: local-only parent, explicit cloud child, guard in its default mode. */
function call(over: Partial<DelegationCallInput> = {}): DelegationCallInput {
	return {
		toolName: "subagent",
		event: { toolName: "subagent", toolCallId: "t1", input: { agent: "scout", model: CLOUD_MODEL } },
		model: { provider: "cuttle", id: "local" },
		mode: "block",
		localProviders: ["lmstudio", "mtplx"],
		...over,
	};
}

/** A guard plus one run of the full hook, which is what the mode and counter tests need. */
function runWith(
	mode: DelegationMode,
	event: unknown = { toolName: "subagent", toolCallId: "t1", input: { agent: "scout", model: CLOUD_MODEL } },
	model: { provider: string; id: string } | undefined = { provider: "cuttle", id: "local" },
): { guard: DelegationGuard; result: { block?: boolean; reason?: string } | undefined } {
	const guard = createDelegationGuard({ getMode: () => mode, localProviders: ["lmstudio"] });
	const ctx = { model } as unknown as ExtensionContext;
	return { guard, result: runDelegationGuard(guard, event, ctx) };
}

function counters(guard: DelegationGuard): { blocked: number; allowed: number } {
	return { blocked: guard.blocked, allowed: guard.allowed };
}

// Region: the decision rule. Block only when a local-only flavor meets a cloud model in `block`
// mode; every other combination passes, and anything unresolvable fails open.

test("blocks a cloud child while the parent is on a local-only flavor", () => {
	for (const flavor of ["local", "fast-local", "big-local"]) {
		const outcome = evaluateDelegationCall(call({ model: { provider: "cuttle", id: flavor } }));
		assert.equal(outcome.verdict, "cloud", `${flavor} promises never to reach cloud`);
		assert.equal(outcome.action, "block");
	}
});

test("allows a cloud child under flavors that may route cloud", () => {
	for (const id of ["auto", "cloud", "orchestrator"]) {
		const outcome = evaluateDelegationCall(call({ model: { provider: "cuttle", id } }));
		assert.equal(outcome.verdict, "skipped", `${id} makes no local-only promise`);
		assert.equal(outcome.action, "allow");
	}
});

test("allows a delegation that names no model", () => {
	// The inherit path is its own question. Folding it in here would block every default
	// delegation, including the ones pi-subagents resolves from the parent's registry.
	const outcome = evaluateDelegationCall(call({
		event: { toolName: "subagent", toolCallId: "t1", input: { agent: "scout", task: "read the repo" } },
	}));
	assert.equal(outcome.verdict, "skipped");
	assert.equal(outcome.action, "allow");
});

test("allows a child launched on a local provider", () => {
	for (const model of ["lmstudio/meta/muse-glimmer", "mtplx/mtplx-flash-next-optimized-speed"]) {
		const outcome = evaluateDelegationCall(call({
			event: { toolName: "subagent", toolCallId: "t1", input: { model } },
		}));
		assert.equal(outcome.verdict, "local", `${model} is served by a configured local provider`);
		assert.equal(outcome.action, "allow");
	}
});

test("a cuttle/* child request is not blocked here", () => {
	// A child that cannot resolve `cuttle/*` never loaded the router: that is #131, not this gate.
	const outcome = evaluateDelegationCall(call({
		event: { toolName: "subagent", toolCallId: "t1", input: { model: "cuttle/fast-local" } },
	}));
	assert.equal(outcome.verdict, "skipped");
	assert.equal(outcome.action, "allow");
});

test("fails open when the session flavor cannot be determined", () => {
	const noModel = evaluateDelegationCall(call({ model: undefined }));
	assert.equal(noModel.verdict, "skipped");
	assert.equal(noModel.failOpen, true, "an unknown flavor is a fail-open, not a silent pass");
	assert.equal(noModel.action, "allow");

	const nonCuttle = evaluateDelegationCall(call({ model: { provider: "opencode-go", id: "gpt-6-luna" } }));
	assert.equal(nonCuttle.verdict, "skipped", "a session off the router carries no local-only contract");
});

test("fails open when the event carries no readable input", () => {
	for (const event of [undefined, {}, "nonsense", []]) {
		const outcome = evaluateDelegationCall(call({ event }));
		assert.equal(outcome.action, "allow", `${JSON.stringify(event)} must not block`);
		assert.equal(outcome.verdict, "skipped");
	}
});

test("only the subagent launch tools are inspected", () => {
	const other = evaluateDelegationCall(call({
		toolName: "bash",
		event: { toolName: "bash", toolCallId: "t1", input: { model: CLOUD_MODEL } },
	}));
	assert.equal(other.verdict, "skipped", "a `model` field on another tool is not a delegation");

	for (const toolName of ["subagent", "subagent_supervisor"]) {
		const outcome = evaluateDelegationCall(call({
			toolName,
			event: { toolName, toolCallId: "t1", input: { model: CLOUD_MODEL } },
		}));
		assert.equal(outcome.verdict, "cloud", `${toolName} starts children`);
		assert.equal(outcome.action, "block");
	}
});

// Region: event shapes. The runtime emits `input`; the published types say `args`. Both must work.

test("reads the requested model from `input` first and `args` as fallback", () => {
	const fromArgs = evaluateDelegationCall(call({
		event: { toolName: "subagent", toolCallId: "t1", args: { agent: "scout", model: CLOUD_MODEL } },
	}));
	assert.equal(fromArgs.verdict, "cloud", "the documented `args` shape must work too");

	const both = evaluateDelegationCall(call({
		event: {
			toolName: "subagent",
			toolCallId: "t1",
			input: { model: CLOUD_MODEL },
			args: { model: "lmstudio/local-model" },
		},
	}));
	assert.equal(both.verdict, "cloud", "`input` is the real runtime shape and wins");
	assert.match(both.reason ?? "", new RegExp(CLOUD_MODEL));
});

// Region: modes. `block` and `warn` count the occurrence; only `block` blocks it; `off` is off.

test("`warn` records the occurrence but lets the launch through", () => {
	const { guard, result } = runWith("warn");
	assert.equal(result, undefined, "warn must never block a launch");
	assert.deepEqual(counters(guard), { blocked: 0, allowed: 1 });
});

test("`off` does not evaluate the call at all", () => {
	const { guard, result } = runWith("off");
	assert.equal(result, undefined);
	assert.deepEqual(counters(guard), { blocked: 0, allowed: 0 }, "off means off: no counting, no work");
});

test("`block` blocks, by default and when counted", () => {
	const { guard, result } = runWith("block");
	assert.equal(result?.block, true);
	assert.deepEqual(counters(guard), { blocked: 1, allowed: 0 });
});

// Region: the reason text, which is a deliverable. Fact 4: a reason that reads like data gets
// quoted back as the child's answer, so it must name itself a notice and offer a next action.

test("the block reason reads as a notice, not as a result", () => {
	const reason = evaluateDelegationCall(call()).reason ?? "";

	assert.match(reason, /not a subagent result|not a result/i, "must say it is a block notice");
	assert.match(reason, /cuttle\/local/, "must name the active flavor");
	assert.match(reason, new RegExp(CLOUD_MODEL), "must name the refused model");
	assert.match(reason, /without (a|an explicit) model/i, "remedy 1: re-launch without a model");
	assert.match(reason, /local model/i, "remedy 2: name a local model");

	const order = ["notice", "cuttle/local", CLOUD_MODEL, "without a model"].map((needle) => reason.indexOf(needle));
	assert.ok(order.every((index) => index >= 0), `every part must be present, got: ${reason}`);
	assert.deepEqual([...order].sort((a, b) => a - b), order, "notice, flavor, model, remedies — in that order");
	assert.ok(!/^[A-Z0-9 -]+$/.test(reason.trim()), "never a bare token the model can quote back as data");
});

// Region: counters, which is how `/cuttle status` shows what the guard saw in each mode.

function guardIn(mode: DelegationMode): DelegationGuard {
	const guard = createDelegationGuard({ getMode: () => mode, localProviders: ["lmstudio"] });
	recordDelegationCall(guard, {
		verdict: "cloud",
		action: mode === "block" ? "block" : "allow",
	});
	return guard;
}

test("the status line shows what the guard saw in every mode", () => {
	assert.deepEqual(statusDelegationLines(guardIn("block")), ["delegation: 1 blocked (mode block)"]);
	assert.deepEqual(statusDelegationLines(guardIn("warn")), ["delegation: 1 allowed (mode warn)"]);
	assert.deepEqual(statusDelegationLines(guardIn("off")), [], "off prints nothing");

	const quiet = createDelegationGuard({ getMode: () => "block", localProviders: ["lmstudio"] });
	assert.deepEqual(statusDelegationLines(quiet), [], "nothing seen, nothing printed");
});

test("the status line separates blocked from allowed, and the log carries the model", () => {
	const logged: string[] = [];
	const guard = createDelegationGuard({
		getMode: () => "block",
		localProviders: ["lmstudio"],
		log: (message) => logged.push(message),
	});
	recordDelegationCall(guard, { verdict: "cloud", action: "block", model: CLOUD_MODEL });
	recordDelegationCall(guard, { verdict: "cloud", action: "block", model: CLOUD_MODEL });
	recordDelegationCall(guard, { verdict: "cloud", action: "allow", model: "mtplx/other" });
	const lines = statusDelegationLines(guard);
	assert.equal(lines.length, 1, "one line, however many launches");
	assert.match(lines[0] ?? "", /2 blocked, 1 allowed/);
	assert.doesNotMatch(lines[0] ?? "", /deepseek/, "status counts; per-launch detail belongs in the log");
	assert.equal(logged.length, 3, "every launch is logged");
	assert.match(logged[2] ?? "", /model=mtplx\/other/);
	assert.match(logged[2] ?? "", /delegation allow/);
});

// Region: wiring. The guard must be registered on `tool_call`, return the shape pi expects, and
// never throw — a throw in this hook reads as a broken extension, not as a block.

interface MockPI {
	pi: ExtensionAPI;
	events: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	commands: Record<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
}

function createMockPI(): MockPI {
	const events: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>> = {};
	const commands: Record<string, (args: string, ctx: ExtensionContext) => Promise<void>> = {};
	const pi = {
		registerFlag: () => {},
		registerVirtualModel: () => {},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands[name] = options.handler;
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			(events[event] ??= []).push(handler);
		},
		setModel: () => Promise.resolve(),
		getFlag: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, events, commands };
}

function toolCallHandlers(pi: MockPI): Array<(event: unknown, ctx: ExtensionContext) => unknown> {
	return pi.events["tool_call"] ?? [];
}

function contextWith(model: { provider: string; id: string } | undefined): ExtensionContext {
	return {
		...(model ? { model } : {}),
		sessionManager: { getSessionId: () => "s1" },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

async function withTempConfig(config: Record<string, unknown>, fn: () => void | Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "cuttle-guard-test-"));
	const originalCwd = process.cwd();
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "pi-cuttle.json"), JSON.stringify(config));
	process.chdir(dir);
	try {
		await fn();
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The verified runtime payload: `type, toolName, toolCallId, input` — `args` only in the docs. */
function guardEvent(model: string | undefined, shape: "input" | "args" = "input"): Record<string, unknown> {
	const payload: Record<string, unknown> = { agent: "scout" };
	if (model !== undefined) payload[shape === "input" ? "input" : "args"] = { model };
	return { type: "tool_call", toolName: "subagent", toolCallId: "t1", ...payload };
}

test("the extension registers one tool_call handler returning { block, reason }", async () => {
	await withTempConfig(
		{ catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] }, local: { providers: ["lmstudio"] } },
		() => {
			const mock = createMockPI();
			modelRouter(mock.pi);
			const handlers = toolCallHandlers(mock);
			assert.equal(handlers.length, 1, "exactly one tool_call handler must be registered");
			const handler = handlers[0];
			assert.ok(handler);

			const result = handler(guardEvent(CLOUD_MODEL), contextWith({ provider: "cuttle", id: "local" })) as
				| { block?: boolean; reason?: string }
				| undefined;
			assert.equal(result?.block, true, "a cloud child under a local-only parent must be blocked");
			assert.match(result?.reason ?? "", /not a subagent result/i);
			assert.match(result?.reason ?? "", new RegExp(CLOUD_MODEL));
		},
	);
});

test("the same call is allowed when the parent is not on a local-only flavor", async () => {
	await withTempConfig({ catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] } }, () => {
		const mock = createMockPI();
		modelRouter(mock.pi);
		const handler = toolCallHandlers(mock)[0];
		assert.ok(handler);
		assert.equal(handler(guardEvent(CLOUD_MODEL), contextWith({ provider: "cuttle", id: "auto" })), undefined);
	});
});

test("the wiring reads the `args` shape too", async () => {
	await withTempConfig({ catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] } }, () => {
		const mock = createMockPI();
		modelRouter(mock.pi);
		const handler = toolCallHandlers(mock)[0];
		assert.ok(handler);
		const result = handler(guardEvent(CLOUD_MODEL, "args"), contextWith({ provider: "cuttle", id: "big-local" })) as
			| { block?: boolean }
			| undefined;
		assert.equal(result?.block, true, "the documented `args` shape must still be caught");
	});
});

test("the wiring fails open on a missing model, missing input, or junk event", async () => {
	await withTempConfig({ catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] } }, () => {
		const mock = createMockPI();
		modelRouter(mock.pi);
		const handler = toolCallHandlers(mock)[0];
		assert.ok(handler);

		const local = contextWith({ provider: "cuttle", id: "local" });
		assert.equal(handler(guardEvent(CLOUD_MODEL), {} as ExtensionContext), undefined, "no model, no gate");
		assert.equal(handler(guardEvent(undefined), local), undefined, "no requested model, no gate");
		for (const junk of [undefined, null, {}, "nope", [], 42]) {
			assert.equal(handler(junk, local), undefined, `must allow, never crash on ${JSON.stringify(junk)}`);
		}
	});
});

test("the handler leaves non-delegation tools alone without touching them", async () => {
	await withTempConfig({ catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] } }, () => {
		const mock = createMockPI();
		modelRouter(mock.pi);
		const handler = toolCallHandlers(mock)[0];
		assert.ok(handler);
		const ctx = contextWith({ provider: "cuttle", id: "local" });
		assert.equal(handler({ type: "tool_call", toolName: "bash", toolCallId: "t2", input: { command: "ls" } }, ctx), undefined);
		assert.equal(handler({ type: "tool_call", toolName: "read", toolCallId: "t3", input: { path: "src/index.ts" } }, ctx), undefined);
	});
});

test("`delegation.mode` in config replaces the default", async () => {
	await withTempConfig(
		{ delegation: { mode: "warn" }, catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] } },
		() => {
			const mock = createMockPI();
			modelRouter(mock.pi);
			const handler = toolCallHandlers(mock)[0];
			assert.ok(handler);
			assert.equal(handler(guardEvent(CLOUD_MODEL), contextWith({ provider: "cuttle", id: "local" })), undefined);
		},
	);
});

test("`delegation.mode: off` registers no work at all", async () => {
	await withTempConfig(
		{ delegation: { mode: "off" }, catalog: { local: ["lmstudio/local-model"], cloud: [CLOUD_MODEL] } },
		() => {
			const mock = createMockPI();
			modelRouter(mock.pi);
			const handler = toolCallHandlers(mock)[0];
			assert.ok(handler);
			assert.equal(handler(guardEvent(CLOUD_MODEL), contextWith({ provider: "cuttle", id: "local" })), undefined);
		},
	);
});

/** A command context that only needs to collect `ui.notify` output. */
function statusContext(notifications: string[]): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => "s1" },
		ui: { notify: (text: string) => notifications.push(text) },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
	} as unknown as ExtensionContext;
}

// Region: `/cuttle status`. The guard has to be readable, not just armed, or a blocked launch is
// invisible after the fact — which is the half of #130 that the audit could only see retrospectively.

test("/cuttle status prints what the guard saw", async () => {
	const guard = createDelegationGuard({ getMode: () => "block", localProviders: ["lmstudio"] });
	recordDelegationCall(guard, { verdict: "cloud", action: "block", model: CLOUD_MODEL });

	const notifications: string[] = [];
	const mock = createMockPI();
	const rt = {
		config: structuredClone(DEFAULTS),
		governor: { status: async () => ({ slots: [], localMax: 1 }) },
		pins: new Map(),
		previousModels: new Map(),
	};
	registerCuttleCommand(
		mock.pi,
		rt as unknown as Parameters<typeof registerCuttleCommand>[1],
		{ config: rt.config, sources: [], warnings: [] },
		undefined as never,
		guard,
	);

	await mock.commands.cuttle?.("status", statusContext(notifications));

	const printed = notifications.join("\n");
	assert.match(printed, /delegation: 1 blocked \(mode block\)/, `status must show the guard line, got: ${printed}`);
});

test("/cuttle status stays silent when the guard saw nothing", async () => {
	const guard = createDelegationGuard({ getMode: () => "block", localProviders: ["lmstudio"] });
	const notifications: string[] = [];
	const mock = createMockPI();
	const rt = {
		config: structuredClone(DEFAULTS),
		governor: { status: async () => ({ slots: [], localMax: 1 }) },
		pins: new Map(),
		previousModels: new Map(),
	};
	registerCuttleCommand(
		mock.pi,
		rt as unknown as Parameters<typeof registerCuttleCommand>[1],
		{ config: rt.config, sources: [], warnings: [] },
		undefined as never,
		guard,
	);
	await mock.commands.cuttle?.("status", statusContext(notifications));
	assert.doesNotMatch(notifications.join("\n"), /delegation:/, "no occurrence, no line");
});

test("the guard line does not crowd out the lines that were already there", async () => {
	// The #53 failure line and the warning lines share this panel; the guard must be added to them,
	// not replace them.
	const guard = createDelegationGuard({ getMode: () => "warn", localProviders: ["lmstudio"] });
	recordDelegationCall(guard, { verdict: "cloud", action: "allow", model: CLOUD_MODEL });
	const notifications: string[] = [];
	const mock = createMockPI();
	const rt = {
		config: structuredClone(DEFAULTS),
		governor: { status: async () => ({ slots: [], localMax: 1 }) },
		pins: new Map(),
		previousModels: new Map(),
		lastClassifierError: { ref: "llama.cpp/kev", message: "connection refused", turn: 3, at: Date.now() },
	};
	registerCuttleCommand(
		mock.pi,
		rt as unknown as Parameters<typeof registerCuttleCommand>[1],
		{ config: rt.config, sources: [], warnings: ["no models configured"] },
		undefined as never,
		guard,
	);
	await mock.commands.cuttle?.("status", statusContext(notifications));
	const printed = notifications.join("\n");
	assert.match(printed, /failure:  turn 3 llama\.cpp\/kev/);
	assert.match(printed, /warning:  no models configured/);
	assert.match(printed, /delegation: 1 allowed \(mode warn\)/);
});
/**
 * Pins the documented contract (#130). A doc that stops saying the guard blocks, or that stops
 * naming the inheritance rule, fails here rather than drifting silently — the acceptance criteria
 * for this fix are docs claims, and a claim with no pin is not a claim.
 */
test("the docs state the delivered inheritance rule and the parent-side guard (#130)", () => {
	const subagents = readFileSync(new URL("../docs/SUBAGENTS.md", import.meta.url), "utf8");
	const config = readFileSync(new URL("../docs/CONFIG.md", import.meta.url), "utf8");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

	// The inheritance rule, as delivered: a foreground child without the extension errors out.
	assert.match(subagents, /errors out/, "SUBAGENTS.md must say the unresolved child errors, not falls through");
	assert.doesNotMatch(subagents, /falls through to an unrelated provider/, "the old, wrong fall-through claim must not return");
	assert.match(subagents, /#131/, "the crash case must point at its own ticket");

	// What the guard does, and the two things it deliberately does not.
	assert.match(subagents, /refused before the child starts|Blocked/, "must state that the launch is blocked");
	assert.match(subagents, /none \(inherits\)/, "must state that an inheriting launch is not this gate's business");
	assert.match(subagents, /delegation\.mode/, "must name the knob");

	// The knob is documented where config lives, and the README names the guarantee.
	assert.match(config, /## `delegation`/, "CONFIG.md must document the delegation section");
	assert.match(config, /"block"/, "CONFIG.md must name the default");
	assert.match(readme, /refused before the child starts/, "README must state the guarantee, not just link to it");
});
