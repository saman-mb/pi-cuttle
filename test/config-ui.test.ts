/**
 * Tests for the config-panel pure functions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildNonTuiText,
	buildPanelRows,
	checkCatalogRefs,
	checkClassifier,
	CLASSIFIER_UNSET_SENTINEL,
	classifierPatchForSelection,
	configPathsForPanel,
	determineSectionSources,
	shadowedSections,
	STATE,
	validateMaxConcurrent,
} from "../src/config-ui.ts";
import { DEFAULTS } from "../src/config.ts";
import { showConfigPanel } from "../src/commands.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { RouterRuntime } from "../src/virtual-models.ts";

// Region: the config panel wires pi's SettingsList into a command handler. These tests cover the
// fallback paths; they deliberately never reach `refresh()`, so no test writes a real user config.

function panelRuntime(): RouterRuntime {
	return {
		config: { ...DEFAULTS },
		governor: { status: async () => ({ slots: [], localMax: DEFAULTS.local.maxConcurrent }) } as unknown as RouterRuntime["governor"],
		pins: new Map(),
		previousModels: new Map(),
		sizes: new Map(),
	} as unknown as RouterRuntime;
}

function panelContext(mode: string) {
	const notifications: string[] = [];
	let customCalls = 0;
	const ctx = {
		mode,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			// `custom()` resolving undefined is what RPC mode does, and also the path taken when
			// the SettingsList import fails.
			custom: async () => {
				customCalls += 1;
				return undefined;
			},
		},
		modelRegistry: {
			findOfType: () => undefined,
			find: () => undefined,
			getAvailable: () => [],
			getModelsOfType: () => [],
		},
	};
	return { ctx, notifications, customCalls: () => customCalls };
}

const loadedStub = () => ({ config: DEFAULTS, sources: [], warnings: [] });

// Stub find functions for tests
const findNothing = () => undefined;
const findClassifier = (type: "classifier", provider: string, id: string) =>
	type === "classifier" && provider === "llama.cpp" && id === "kev" ? { provider, id, type } : undefined;
const findModel = (provider: string, id: string) =>
	provider === "lmstudio" && id === "a" ? { provider, id } : undefined;

test("checkCatalogRefs counts resolvable and unresolved entries", () => {
	const refs = ["lmstudio/a", "garbage/b"];
	const check = checkCatalogRefs(refs, findModel);
	assert.equal(check.total, 2);
	assert.equal(check.resolvable, 1);
	assert.equal(check.unresolved, 1);
});

test("checkCatalogRefs reports empty catalog", () => {
	const check = checkCatalogRefs([], findModel);
	assert.equal(check.total, 0);
	assert.equal(check.resolvable, 0);
	assert.equal(check.unresolved, 0);
});

test("formatCatalogValue shows EMPTY for zero total", () => {
	const check = checkCatalogRefs([], findModel);
	// We test this via buildPanelRows below
	assert.equal(check.total, 0);
});

test("checkClassifier returns UNSET (heuristic) when no model configured", () => {
	const result = checkClassifier(undefined, findClassifier);
	assert.equal(result.value, STATE.UNSET_HEURISTIC);
});

test("checkClassifier returns UNRESOLVED for invalid ref", () => {
	const result = checkClassifier("nocolon", findClassifier);
	assert.equal(result.value, STATE.UNRESOLVED);
	assert.ok(result.description?.includes("Invalid"));
});

test("checkClassifier returns UNRESOLVED when classifier not in registry", () => {
	const result = checkClassifier("lmstudio/unknown", findClassifier);
	assert.equal(result.value, STATE.UNRESOLVED);
	assert.ok(result.description?.includes("not registered"));
});

test("checkClassifier returns ref when classifier is found", () => {
	const result = checkClassifier("llama.cpp/kev", findClassifier);
	assert.equal(result.value, "llama.cpp/kev");
	assert.equal(result.description, undefined);
});

test("validateMaxConcurrent rejects non-numeric input", () => {
	const result = validateMaxConcurrent("abc");
	assert.equal(result.valid, false);
	assert.ok(result.error?.includes("whole number"));
});

test("validateMaxConcurrent rejects negative numbers", () => {
	const result = validateMaxConcurrent("-1");
	assert.equal(result.valid, false);
	assert.ok(result.error?.includes("whole number"));
});

test("validateMaxConcurrent accepts 0", () => {
	const result = validateMaxConcurrent("0");
	assert.equal(result.valid, true);
	assert.equal(result.value, 0);
});

test("validateMaxConcurrent accepts positive integers", () => {
	const result = validateMaxConcurrent("3");
	assert.equal(result.valid, true);
	assert.equal(result.value, 3);
});

test("validateMaxConcurrent rejects decimals", () => {
	const result = validateMaxConcurrent("1.5");
	assert.equal(result.valid, false);
});

test("shadowedSections extracts top-level keys except $schema", () => {
	const raw = { classifier: { model: "x" }, catalog: { local: [] }, $schema: "http://example.com" };
	const shadowed = shadowedSections(raw);
	assert.deepEqual(shadowed, ["classifier", "catalog"]);
});

test("shadowedSections returns empty for non-object", () => {
	assert.deepEqual(shadowedSections(null), []);
	assert.deepEqual(shadowedSections([]), []);
	assert.deepEqual(shadowedSections("string"), []);
});

test("configPathsForPanel returns user and project paths", () => {
	const paths = configPathsForPanel("/some/cwd");
	assert.ok(paths.userPath.includes("pi-cuttle.json"));
	assert.ok(paths.projectPath.startsWith("/some/cwd"));
	assert.ok(paths.projectPath.includes(".pi/pi-cuttle.json"));
});

test("determineSectionSources identifies defaults-only sections", () => {
	const sources = determineSectionSources(DEFAULTS, undefined, undefined, []);
	for (const s of sources) {
		assert.equal(s.source, "defaults");
	}
});

test("determineSectionSources marks shadowed sections as project", () => {
	const sources = determineSectionSources(DEFAULTS, undefined, { classifier: {} }, ["classifier"]);
	const classifierSource = sources.find((s) => s.section === "classifier");
	assert.equal(classifierSource?.source, "project");
});

test("determineSectionSources marks user-provided sections", () => {
	const userRaw = { catalog: { local: ["x"] } };
	const sources = determineSectionSources(DEFAULTS, userRaw, undefined, []);
	const catalogSource = sources.find((s) => s.section === "catalog");
	assert.equal(catalogSource?.source, "user");
});

test("buildPanelRows shows UNSET (heuristic) for unset classifier", () => {
	const classifierCheck = checkClassifier(undefined, findClassifier);
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck,
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	const classifierRow = rows.find((r) => r.id === "classifier");
	assert.equal(classifierRow?.currentValue, STATE.UNSET_HEURISTIC);
});

test("buildPanelRows shows SHADOWED for shadowed classifier section", () => {
	const classifierCheck = checkClassifier("llama.cpp/kev", findClassifier);
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck,
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: ["classifier"],
		paths: configPathsForPanel("/tmp"),
	});
	const classifierRow = rows.find((r) => r.id === "classifier");
	assert.equal(classifierRow?.currentValue, STATE.SHADOWED);
	assert.ok(classifierRow?.description?.includes("SHADOWED"));
});

test("buildPanelRows shows EMPTY for empty catalogs", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	const localRow = rows.find((r) => r.id === "local-catalog");
	const cloudRow = rows.find((r) => r.id === "cloud-catalog");
	assert.equal(localRow?.currentValue, STATE.EMPTY);
	assert.equal(cloudRow?.currentValue, STATE.EMPTY);
});

test("buildPanelRows shows N refs; M unresolved for populated catalogs", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs(["lmstudio/a", "garbage/b"], findModel),
		cloudCatalogCheck: checkCatalogRefs(["lmstudio/a"], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	const localRow = rows.find((r) => r.id === "local-catalog");
	const cloudRow = rows.find((r) => r.id === "cloud-catalog");
	assert.equal(localRow?.currentValue, "1 refs; 1 unresolved");
	assert.equal(cloudRow?.currentValue, "1 refs; 0 unresolved");
});

test("buildPanelRows has exactly 7 rows", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	assert.equal(rows.length, 7);
});

test("buildPanelRows row order matches spec", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	assert.equal(rows[0]?.id, "classifier");
	assert.equal(rows[1]?.id, "local-catalog");
	assert.equal(rows[2]?.id, "cloud-catalog");
	assert.equal(rows[3]?.id, "policy");
	assert.equal(rows[4]?.id, "max-concurrent");
	assert.equal(rows[5]?.id, "source-lock");
	assert.equal(rows[6]?.id, "last-change");
});

test("buildPanelRows last-change starts as NO CHANGES", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	const lastChangeRow = rows.find((r) => r.id === "last-change");
	assert.equal(lastChangeRow?.currentValue, STATE.NO_CHANGES);
});

test("buildPanelRows policy row has cycle values", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	const policyRow = rows.find((r) => r.id === "policy");
	assert.deepEqual(policyRow?.values, ["complexity", "cost", "phase"]);
});

test("buildPanelRows shadowed catalog sections show SHADOWED", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs(["lmstudio/a"], findModel),
		cloudCatalogCheck: checkCatalogRefs(["lmstudio/a"], findModel),
		shadowed: ["catalog"],
		paths: configPathsForPanel("/tmp"),
	});
	const localRow = rows.find((r) => r.id === "local-catalog");
	const cloudRow = rows.find((r) => r.id === "cloud-catalog");
	assert.equal(localRow?.currentValue, STATE.SHADOWED);
	assert.equal(cloudRow?.currentValue, STATE.SHADOWED);
});

test("buildNonTuiText includes all seven values and JSON keys", () => {
	const text = buildNonTuiText({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	assert.ok(text.includes("Classifier model"));
	assert.ok(text.includes("Local catalog"));
	assert.ok(text.includes("Cloud catalog"));
	assert.ok(text.includes("Policy mode"));
	assert.ok(text.includes("Local max concurrent"));
	assert.ok(text.includes("classifier.model"));
	assert.ok(text.includes("catalog.local"));
	assert.ok(text.includes("catalog.cloud"));
	assert.ok(text.includes("policy.mode"));
	assert.ok(text.includes("local.maxConcurrent"));
});

test("buildNonTuiText mentions next-turn apply semantics", () => {
	const text = buildNonTuiText({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	assert.ok(text.includes("Changes apply from the next user turn"));
});

test("buildNonTuiText lists both config paths", () => {
	const text = buildNonTuiText({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	assert.ok(text.includes("User config"));
	assert.ok(text.includes("Project config"));
});

test("shadowed classifier row has no values or submenu — cannot be changed", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier("llama.cpp/kev", findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: ["classifier"],
		paths: configPathsForPanel("/tmp"),
	});
	const classifierRow = rows.find((r) => r.id === "classifier");
	assert.equal(classifierRow?.values, undefined);
	assert.equal(classifierRow?.submenu, undefined);
	assert.equal(classifierRow?.currentValue, STATE.SHADOWED);
});

test("shadowed max-concurrent row has no values or submenu — cannot be changed", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: ["local"],
		paths: configPathsForPanel("/tmp"),
	});
	const maxConcurrentRow = rows.find((r) => r.id === "max-concurrent");
	assert.equal(maxConcurrentRow?.values, undefined);
	assert.equal(maxConcurrentRow?.submenu, undefined);
	assert.equal(maxConcurrentRow?.currentValue, STATE.SHADOWED);
});

test("catalog rows have no values or submenu — read-only with /cuttle models hint", () => {
	const rows = buildPanelRows({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs(["lmstudio/a"], findModel),
		cloudCatalogCheck: checkCatalogRefs(["lmstudio/a"], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	const localRow = rows.find((r) => r.id === "local-catalog");
	const cloudRow = rows.find((r) => r.id === "cloud-catalog");
	// Catalog rows should not be editable via the panel
	assert.equal(localRow?.values, undefined);
	assert.equal(localRow?.submenu, undefined);
	assert.equal(cloudRow?.values, undefined);
	assert.equal(cloudRow?.submenu, undefined);
	// But they should mention how to change them
	assert.ok(localRow?.description?.includes("/cuttle models"));
	assert.ok(cloudRow?.description?.includes("/cuttle models"));
});

test("non-TUI fallback text includes all configurable fields", () => {
	// This verifies the non-TUI path has all the information needed
	const text = buildNonTuiText({
		config: DEFAULTS,
		classifierCheck: checkClassifier(undefined, findClassifier),
		localCatalogCheck: checkCatalogRefs([], findModel),
		cloudCatalogCheck: checkCatalogRefs([], findModel),
		shadowed: [],
		paths: configPathsForPanel("/tmp"),
	});
	// Should include all five configurable values
	assert.ok(text.includes("Classifier model"));
	assert.ok(text.includes("Local catalog"));
	assert.ok(text.includes("Cloud catalog"));
	assert.ok(text.includes("Policy mode"));
	assert.ok(text.includes("Local max concurrent"));
	// Should mention edit path
	assert.ok(text.includes("Edit ~/.pi/agent/pi-cuttle.json"));
});

// Region: classifier sentinel mapping.
//
// Regression guard: the classifier picker's "Unset" option used to complete the submenu with
// `undefined`, which `SettingsList` treats as a cancel — it skips `onChange` entirely
// (`pi-tui/dist/components/settings-list.js`, `activateItem`). "Unset" was therefore a silent
// no-op. The sentinel must be a real string, and must map to `model: undefined` here.

test("classifierPatchForSelection maps the unset sentinel to an undefined model", () => {
	assert.equal(CLASSIFIER_UNSET_SENTINEL, "Unset");
	assert.deepEqual(classifierPatchForSelection(CLASSIFIER_UNSET_SENTINEL), { classifier: { model: undefined } });
});

test("classifierPatchForSelection passes a real model ref through unchanged", () => {
	assert.deepEqual(classifierPatchForSelection("llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0"), {
		classifier: { model: "llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0" },
	});
});

test("the unset sentinel is not undefined — SettingsList would swallow it as a cancel", () => {
	assert.notEqual(CLASSIFIER_UNSET_SENTINEL, undefined);
	assert.equal(typeof CLASSIFIER_UNSET_SENTINEL, "string");
});

// Region: non-TUI fallback (the path every headless / RPC user takes).

test("showConfigPanel outside TUI mode prints the text panel and never opens a custom component", async () => {
	const { ctx, notifications, customCalls } = panelContext("print");

	await showConfigPanel(panelRuntime(), ctx as never, loadedStub() as never);

	assert.equal(customCalls(), 0, "must not attempt a custom component outside TUI mode");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0] ?? "", /classifier/i);
	assert.match(notifications[0] ?? "", /next user turn/i);
});

test("showConfigPanel falls back to text when custom() is unavailable in TUI mode", async () => {
	// The panel's theme comes from pi's ambient theme, which a real TUI session initializes at
	// startup. Without this the component build throws and the test would only exercise the
	// catch-all, not the intended `custom()` fallback — proving less than it claims.
	initTheme();
	const { ctx, notifications, customCalls } = panelContext("tui");

	await showConfigPanel(panelRuntime(), ctx as never, loadedStub() as never);

	assert.equal(customCalls(), 1, "TUI mode must attempt the custom component");
	const text = notifications.join("\n");
	assert.ok(notifications.length >= 1, "an unavailable custom component must still tell the user the values");
	assert.match(text, /next user turn/i);
	assert.doesNotMatch(text, /TUI component unavailable/, "the intended fallback ran, not the catch-all");
});

// Region: panel lifecycle.
//
// Regression guard: `ctx.ui.custom()` resolves only when the component calls the supplied `done`.
// SettingsList reports Escape through `onCancel`, which the first implementation left as a no-op —
// so the panel opened and could never be closed.

test("the config panel closes on cancel instead of trapping the user", async () => {
	initTheme();
	let resolved = 0;
	let component: { handleInput?: (data: string) => void } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			notify: () => {},
			custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: unknown) => void) => unknown) => {
				component = factory({}, {}, {}, () => {
					resolved += 1;
				}) as typeof component;
				return undefined;
			},
		},
		modelRegistry: { findOfType: () => undefined, find: () => undefined, getAvailable: () => [], getModelsOfType: () => [] },
	};

	await showConfigPanel(panelRuntime(), ctx as never, loadedStub() as never);

	assert.ok(component, "the panel component must be constructed in TUI mode");
	component?.handleInput?.("\x1b"); // Escape
	assert.equal(resolved, 1, "Escape must resolve the custom UI so the panel can close");
});
