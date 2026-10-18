# Spike #92: LangGraph for routing

Decision: reject LangGraph. Do not add @langchain/langgraph. Do not rewire routeRequest.

This spike measured `@langchain/langgraph@1.5.1` outside the repo and compared it to `routeRequest()`. The package loads. The rejection is structural: zero runtime dependencies, no build step in front of pi, and a hot path that does not need a graph runner. Measurements that cut against a "it failed to load" story are stated below, not smoothed over.

## Premise

The issue described `routeRequest()` as about 200 lines and treated a rewrite as premature until the function passed 300. Counted in this worktree, `export async function routeRequest` starts at `src/virtual-models.ts:290-655` and the closing `}` is line 655. That span is 366 lines (`655 - 290 + 1`). The issue's own >300-line trigger to re-evaluate had already fired. The spike is not premature.

The issue's claim that "TS support is newer" is stale. `@langchain/langgraph@1.5.1` publishes ESM and `.d.ts` files. On Node v22.23.3 it imported under `node --experimental-strip-types` with no build step, and `tsc --noEmit --module NodeNext --moduleResolution NodeNext` exited 0. Waiting on TypeScript support is not a live reason to defer, and a passing typecheck is not a reason to adopt the package.

## What was rejected

Rewriting `routeRequest` as a `StateGraph`. Not "LangGraph cannot run here." It ran.

pi loads `./src/index.ts` directly (`package.json` `"pi.extensions"`). `AGENTS.md` says no runtime dependencies unless unavoidable, because the extension runs inside pi's process. `route()` is invoked on every model request (`src/virtual-models.ts:678`). A dependency that is avoidable does not become unavoidable because a function is 366 lines.

## Measurements

Probe directory: `/tmp/spike92-probe` (deleted after this write). Nothing was installed in the worktree.

Seed:

```bash
rm -rf /tmp/spike92-probe && mkdir -p /tmp/spike92-probe
cd /tmp/spike92-probe && npm init -y && npm install @langchain/langgraph@1.5.1
```

Node v22.23.3, npm 10.9.9. Install output included `added 22 packages, and audited 23 packages in 2s`.

`npm init -y` does not set `"type": "module"`. This repo's `package.json` does. The first import run is the typeless probe; the re-run adds `"type": "module"` so the module context matches the repo. Both exited 0.

### 1. Import test

`import-test.ts` (3 lines):

```typescript
import { StateGraph } from "@langchain/langgraph";

console.log("import-ok", typeof StateGraph);
```

Command (first run, no `"type": "module"`):

```bash
cd /tmp/spike92-probe && node --experimental-strip-types import-test.ts
```

Node v22.23.3, npm 10.9.9. Output:

```
import-ok function
(node:10068) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///private/tmp/spike92-probe/import-test.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /private/tmp/spike92-probe/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
```

Exit 0. The warning is from `npm init -y`, not from LangGraph. Re-run after adding `"type": "module"`:

```
import-ok function
```

Exit 0. No warning.

Typecheck, using this worktree's TypeScript because the probe did not install `typescript` (`node_modules/.bin/tsc`, Version 5.9.3):

```bash
tsc --noEmit --module NodeNext --moduleResolution NodeNext import-test.ts
```

No stdout. Exit 0. NodeNext plus no build step did not reject the import.

### 2. Cold import cost

Informational, not a gate. Twelve separate `node` processes. `performance.now()` wraps only the dynamic `import()`, not process startup.

`cold-one.ts`:

```typescript
import { performance } from "node:perf_hooks";

const which = process.argv[2];
const t0 = performance.now();
if (which === "lg") {
	await import("@langchain/langgraph");
} else if (which === "fs") {
	await import("node:fs");
} else {
	throw new Error(`unknown target ${which}`);
}
console.log((performance.now() - t0).toFixed(4));
```

Command:

```bash
cd /tmp/spike92-probe
for target in lg fs; do
  echo "-- $target --"
  for i in $(seq 1 12); do
    node --experimental-strip-types cold-one.ts "$target"
  done
done
```

Node v22.23.3, npm 10.9.9. Output (milliseconds):

```
-- lg --
123.2818
122.5409
123.4479
128.4378
120.4066
123.4746
125.4255
122.2884
131.3172
126.6981
122.3050
121.9240
-- fs --
1.1149
1.3365
1.0815
1.0705
1.0902
1.1343
1.0772
1.2538
1.1523
1.2127
1.1575
1.1363
```

Median of the 12 samples (average of the 6th and 7th after sort), computed with `node` from those numbers:

```
langgraph n=12 min=120.4066 median=123.3649 max=131.3172
node:fs n=12 min=1.0705 median=1.1353 max=1.3365
```

Cold import of `@langchain/langgraph` was about 123 ms median, versus about 1.1 ms for `node:fs`. That cost is once per process, not once per turn. It is still the cost of evaluating the package and its closure inside pi, with no build step to trim it.

### 3. Invoke cost

The prototype below was compiled once and invoked 1000 times per case, after 20 warmup calls, in one process. Stub nodes only. The "four direct awaits" baseline calls the same four stub functions; it is not a timing of `routeRequest()` itself.

Command:

```bash
cd /tmp/spike92-probe && node --experimental-strip-types --no-warnings prototype.ts
```

Node v22.23.3, npm 10.9.9. Output:

```
fresh-invoke {"reason":"fresh","tier":"local","ref":"local/stub","held":true,"released":false,"thinking":"medium"}
direct-invoke {"reason":"direct","tier":"cloud","ref":"cloud/direct","held":false,"released":false,"thinking":"medium"}
compiled-without-checkpointer true
nodes gate,decide,place,emit
static-edges START->gate, decide->place, place->emit, emit->END
conditional-edges gate->emit|place|decide
graph-fresh-4nodes n=1000 min=0.4772 median=0.5614 max=2.4555
graph-direct-early-exit n=1000 min=0.2878 median=0.3024 max=1.0767
four-direct-awaits n=1000 min=0.0007 median=0.0008 max=0.0114
graph-fresh-median-ms 0.5614
graph-direct-median-ms 0.3024
four-direct-awaits-median-ms 0.0008
fresh-over-direct-ratio 748.53
```

Read this in absolute terms as well as ratios. A fresh-path invoke median of 0.5614 ms, and a direct early-exit median of 0.3024 ms, will not dominate a model call. The printed ratio 748.53 is fresh-graph median divided by four empty awaits (0.0008 ms). Those awaits are a floor, not the current router. The useful comparison is: the graph tax is sub-millisecond, and it is still paid on the early-exit path (0.3024 ms median) where today's code returns before `decideTier`. A graph which pays a per-invoke cost on the common path is paying it on the fast path. That tax is not, by itself, a reason the router would become unusable.

### 4. API shape (from the prototype that ran)

Exports used by `prototype.ts`: `Annotation`, `END`, `START`, `StateGraph`. The import test used `StateGraph` only. The interrupt probe also used `interrupt`.

- Nodes: 4, in order `gate`, `decide`, `place`, `emit`.
- Edges: 4 static (`START → gate`, `decide → place`, `place → emit`, `emit → END`) plus 1 conditional (`gate → emit | place | decide`).
- `compile()` is separate from `invoke()`. The run compiled once, then invoked.
- A checkpointer is not mandatory for `invoke()`. `compile()` was called with no arguments and both invokes returned state.
- Early-exit did require conditional edges. A static-only chain (`static-edges.ts`, 21 lines) still visited every node for `reason: "direct"`:

```bash
node --experimental-strip-types --no-warnings static-edges.ts
```

```
static-edges-direct-visited gate>decide>place>emit
```

An early `return` inside `gate` does not skip later nodes. The successor is the edge, not the return value. Conditional edges can skip; static edges did not.

### 5. `interrupt()` vs pi's `route()`

Signature from the temp install, `node_modules/@langchain/langgraph/dist/interrupt.d.ts`:

```typescript
declare function interrupt<I = unknown, R = any>(value: I, options?: InterruptOptions): R;
```

The same file's comment says it pauses a node and returns the `resume` value when the graph is re-invoked with `Command`. If no resume value is available it throws `GraphInterrupt`. It does not return a model route.

Runtime check in `dist/interrupt.js`:

```javascript
if (!conf["__pregel_checkpointer"]) throw new GraphValueError("No checkpointer set", { lc_error_code: "MISSING_CHECKPOINTER" });
```

Empirical, `interrupt-probe.ts` (22 lines), `compile()` with no checkpointer:

```bash
node --experimental-strip-types --no-warnings interrupt-probe.ts
```

```
interrupt-without-checkpointer-threw GraphValueError MISSING_CHECKPOINTER No checkpointer set
```

So `interrupt()` needs a checkpointer, and it returns control to the graph caller as a thrown interrupt plus a later `Command` resume. It does not return a route.

pi `@earendil-works/pi-coding-agent@1.2.0`, installed in this worktree:

`dist/core/model-runtime.d.ts:135-141` asks the router for a model and resolves a `Promise<ModelRoute>`. The comment says the router must return a physical catalog model, and throws when routing fails. Options are `reason`, `thinkingLevel`, `signal?`, `failed?`, `state?`. No interrupt, no resume command.

`dist/core/extensions/types.d.ts:1411`:

```typescript
route(request: ModelRouteRequest<TState>, ctx: ExtensionContext): ModelRoute<TState> | Promise<ModelRoute<TState>>;
```

`dist/core/virtual-models.d.ts:33-68` defines `ModelRouteRequest` (`model`, `thinkingLevel`, `reason`, `previous?`, `failed?`, `state?`, `messages`, `signal?`) and `ModelRoute` (`model`, `thinkingLevel`, `state?`). `state` must be JSON-serializable. There is no suspension field.

`docs/virtual-models.md` in that package says if `route()` throws, the request ends with an error response. A thrown `GraphInterrupt` would be that failure, not a human pause.

pi's `route()` has no suspension hook for a human-in-the-loop pause. `ExtensionUIContext` has `select` / `confirm` / `input` (`dist/core/extensions/types.d.ts:74-78`). Those are blocking dialogs on the extension context, not a resume token on `route()`, and `routeRequest` does not call them. This spike does not propose a pi fork.

### 6. Transitive closure

Command:

```bash
cd /tmp/spike92-probe && npm ls --all
```

Node v22.23.3, npm 10.9.9. Output:

```
spike92-probe@1.0.0 /private/tmp/spike92-probe
└─┬ @langchain/langgraph@1.5.1
  ├─┬ @langchain/core@1.2.18
  │ ├── @cfworker/json-schema@4.1.1
  │ ├── @standard-schema/spec@1.1.0 deduped
  │ ├─┬ js-tiktoken@1.0.21
  │ │ └── base64-js@1.5.1
  │ ├─┬ langsmith@0.11.0
  │ │ ├── UNMET OPTIONAL DEPENDENCY @opentelemetry/api@*
  │ │ ├── UNMET OPTIONAL DEPENDENCY @opentelemetry/exporter-trace-otlp-proto@*
  │ │ ├── UNMET OPTIONAL DEPENDENCY @opentelemetry/sdk-trace-base@*
  │ │ ├── UNMET OPTIONAL DEPENDENCY openai@*
  │ │ ├── p-queue@6.6.2 deduped
  │ │ └── UNMET OPTIONAL DEPENDENCY ws@>=7
  │ ├── mustache@4.2.0
  │ ├─┬ p-queue@6.6.2
  │ │ ├── eventemitter3@4.0.7
  │ │ └─┬ p-timeout@3.2.0
  │ │   └── p-finally@1.0.0
  │ └── zod@4.6.7 deduped
  ├─┬ @langchain/langgraph-checkpoint@1.2.0
  │ └── @langchain/core@1.2.18 deduped
  ├─┬ @langchain/langgraph-sdk@1.12.5
  │ ├── @langchain/core@1.2.18 deduped
  │ ├── @langchain/protocol@0.0.19 deduped
  │ ├── @types/json-schema@7.0.15
  │ ├─┬ p-queue@9.3.5
  │ │ ├── eventemitter3@5.0.4
  │ │ └── p-timeout@7.0.2
  │ ├─┬ p-retry@7.1.1
  │ │ └── is-network-error@1.3.2
  │ ├── UNMET OPTIONAL DEPENDENCY react-dom@^18 || ^19
  │ └── UNMET OPTIONAL DEPENDENCY react@^18 || ^19
  ├── @langchain/protocol@0.0.19
  ├── @standard-schema/spec@1.1.0
  └── zod@4.6.7
```

`npm ls --all --parseable | wc -l` printed 23: the probe root plus 22 installed packages. The four direct dependencies are present: `@langchain/protocol@0.0.19`, `@standard-schema/spec@1.1.0`, `@langchain/langgraph-sdk@1.12.5`, `@langchain/langgraph-checkpoint@1.2.0`.

npm also installed the peers `@langchain/core@1.2.18` and `zod@4.6.7`. This repo has neither. The closure includes `langsmith` and `js-tiktoken`, which a router does not call. Unmet optional dependencies (`@opentelemetry/*`, `openai`, `ws`, `react`, `react-dom`) were not installed; they are still declared.

Native addons: `find node_modules -name '*.node' -o -name 'binding.gyp' -o -name '*.wasm'` printed nothing, exit 0. No native addon in the installed tree.

### 7. LOC

`src/virtual-models.ts` lines 290-655 inclusive: 366. The prototype that ran is `prototype.ts`, 104 lines (`wc -l`). That count includes the timing harness. It is a stub, not a port of the 366-line function.

## Prototype that ran

104 lines. Stub nodes. Not wired to `routeRequest`, the governor, or pi.

```typescript
/**
 * Spike #92 prototype. Stub nodes only — not a rewrite of routeRequest.
 * Four nodes, in order: gate, decide, place, emit.
 * Early-exit (direct/retry) skips decide and place via a conditional edge.
 * Sticky still places a slot, matching ensureLocalSlot on the sticky arm.
 */
import { performance } from "node:perf_hooks";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

type Reason = "direct" | "retry" | "sticky" | "fresh";

const State = Annotation.Root({
	reason: Annotation<Reason>,
	tier: Annotation<string>,
	ref: Annotation<string>,
	held: Annotation<boolean>,
	released: Annotation<boolean>,
	thinking: Annotation<string>,
});

type GraphState = typeof State.State;

async function gate(state: GraphState): Promise<Partial<GraphState>> {
	if (state.reason === "direct") return { tier: state.tier || "cloud", ref: "cloud/direct" };
	if (state.reason === "retry") return { tier: "cloud", ref: "cloud/retry" };
	return {};
}

function afterGate(state: GraphState): "emit" | "place" | "decide" {
	if (state.reason === "direct" || state.reason === "retry") return "emit";
	if (state.reason === "sticky") return "place";
	return "decide";
}

async function decide(_state: GraphState): Promise<Partial<GraphState>> {
	return { tier: "local" };
}

async function place(state: GraphState): Promise<Partial<GraphState>> {
	if (state.tier === "cloud") return { held: false, ref: state.ref || "cloud/stub" };
	return { held: true, ref: "local/stub" };
}

async function emit(state: GraphState): Promise<Partial<GraphState>> {
	return { thinking: "medium", ref: state.ref || "cloud/stub", released: false };
}

const builder = new StateGraph(State)
	.addNode("gate", gate)
	.addNode("decide", decide)
	.addNode("place", place)
	.addNode("emit", emit)
	.addEdge(START, "gate")
	.addConditionalEdges("gate", afterGate, ["emit", "place", "decide"])
	.addEdge("decide", "place")
	.addEdge("place", "emit")
	.addEdge("emit", END);

const compiled = builder.compile();

const fresh = { reason: "fresh" as const, tier: "", ref: "", held: false, released: false, thinking: "" };
const direct = { ...fresh, reason: "direct" as const };

function median(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function time(label: string, fn: () => Promise<unknown>, n = 1000): Promise<number> {
	for (let i = 0; i < 20; i++) await fn();
	const samples: number[] = [];
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		await fn();
		samples.push(performance.now() - t0);
	}
	const med = median(samples);
	console.log(`${label} n=${n} min=${Math.min(...samples).toFixed(4)} median=${med.toFixed(4)} max=${Math.max(...samples).toFixed(4)}`);
	return med;
}

const freshResult = await compiled.invoke(fresh);
const directResult = await compiled.invoke(direct);
console.log("fresh-invoke", JSON.stringify(freshResult));
console.log("direct-invoke", JSON.stringify(directResult));
console.log("compiled-without-checkpointer", true);
console.log("nodes", ["gate", "decide", "place", "emit"].join(","));
console.log("static-edges", "START->gate, decide->place, place->emit, emit->END");
console.log("conditional-edges", "gate->emit|place|decide");

const graphFresh = await time("graph-fresh-4nodes", () => compiled.invoke(fresh));
const graphDirect = await time("graph-direct-early-exit", () => compiled.invoke(direct));
const directCalls = await time("four-direct-awaits", async () => {
	const g = await gate(fresh);
	const d = await decide({ ...fresh, ...g });
	const p = await place({ ...fresh, ...g, ...d });
	await emit({ ...fresh, ...g, ...d, ...p });
});

console.log("graph-fresh-median-ms", graphFresh.toFixed(4));
console.log("graph-direct-median-ms", graphDirect.toFixed(4));
console.log("four-direct-awaits-median-ms", directCalls.toFixed(4));
console.log("fresh-over-direct-ratio", (graphFresh / directCalls).toFixed(2));
```

The sticky comment in that file overclaims relative to the real function. Sticky in `routeRequest` still runs struggle escalation before placement. The stub sends sticky straight to `place` and does not model escalation. That is a gap in the stub, not a property of the library.

## Four nodes, mapped to the current function

The function is not already four sequential nodes. These names are a reading of the branches. A graph that always ran `gate → decide → place → emit` would run `decide` on the common path. The prototype avoided that only by conditional edges.

### `gate`

The early-exit arms. These are the common path: continuations and retries keep the previous model (invariant 1).

- `direct` at `src/virtual-models.ts:316`. Compaction and other non-loop requests skip the governor and the context guard, then `resolveModel` at line 335. Holding a slot here would leak it: there is no completion hook to release it.
- `retry` at `src/virtual-models.ts:339`. Local-only flavors release one slot and throw. Otherwise a local failure may switch to cloud (line 356) or stay on the same model (line 361). No acquire.
- Sticky `state && !reclassify` at `src/virtual-models.ts:377`. This is the continuation path. It is not a pure skip: struggle escalation is nested inside it (line 378), and the arm still calls `ensureLocalSlot` before `resolveModel`.

A per-invoke graph cost on these arms is a cost on the fast path. The direct early-exit median above was 0.3024 ms with two stub nodes and a conditional edge.

### `decide`

- `applyPolicy` at `src/virtual-models.ts:525`, after `decideTier` at line 503, on the path that is not an early exit (`reclassify`, recovery, or no state).
- Struggle escalation at `src/virtual-models.ts:378`, which today lives inside the sticky arm, not after it. De-escalation bookkeeping is the next branch (lines 396-402). The fresh path does not re-run that check; it re-decides.

Putting escalation in `decide` is a decomposition, not a description of the current order. A sticky edge that skips `decide`, as the stub does, drops escalation unless that branch stays on the sticky arm.

### `place`

Local slot reserve: the comment at `src/virtual-models.ts:227-230`, then `ensureLocalSlot` at line 231. Callers are the phase-flip arm (line 419), the sticky arm (line 450), the fresh local path (line 534), and the cloud-unavailable fallback (lines 464 and 551).

Release-on-throw is the reliability edge a naive graph rewrite drops. The fresh path is `src/virtual-models.ts:649-653`:

```typescript
try {
	return resolveModel(ctx, ref, effectiveThinking, next);
} catch (error) {
	if (held) rt.governor.release(held);
	throw error;
}
```

The same catch is at lines 434-440 (phase flip) and 485-490 (sticky). `held` is in the function's scope, next to the `return`. A graph runner that swallows that throw leaks a governor slot.

Measured separately (`throw-probe.ts`, 33 lines): default `invoke()` did not swallow the throw. `emit` threw `Error: resolveModel failed`, and the error's own keys were `pregelTaskId` — not `held`. The closed-over flag stayed true only because the probe kept it outside graph state. A rewrite that stores the reservation only in graph state, and catches `invoke()` without that closed-over handle, has nothing to release. LangGraph did not provide the release. The current catch does.

### `emit`

Thinking clamp, then `resolveModel`. The clamp sequence is `src/virtual-models.ts:558-586` (`scoreToThinkingLevel`, `clampToSupportedLevel`, `applyUserCeiling`, `applyContextPressure`). `resolveModel` is defined at line 213 and called at line 650 (also at the early returns above). Ledger, `/cuttle why`, and the LangFuse trace sit between the clamp and that call. They are side effects of the same exit, not extra routing stages.

### Why `confirmWithUser` is not a node

There is no `confirmWithUser` in this repo. `routeRequest` never asks the user to approve a tier. The imagined node would be LangGraph `interrupt()`, which needs a checkpointer and returns a resume value rather than a `ModelRoute`. pi's `route()` has no suspension hook, and a throw from `route()` fails the request. A blocking `ctx.ui.confirm` is a different API, unused here, and it is not a graph pause. Adding a confirm node would be a product change, not a decomposition of the current function.

### Why `checkRetry`, `checkEscalation`, and `clampThinking` are not extra nodes

- `checkRetry` is the `reason === "retry"` arm inside `gate` (lines 339-361). Retries are an early exit, not a stage every request visits.
- `checkEscalation` is the struggle branch inside the sticky arm (lines 378-402), plus the reclassify flags computed just above line 377. It is not a node the fresh path always enters.
- `clampThinking` is the thinking-level sequence inside `emit` (lines 558-586), immediately before `resolveModel`. It does not choose a successor. The pi-ai helper `clampThinkingLevel` is used from `src/thinking-levels.ts`, not as a routing stage.

Splitting those into nodes would add conditional edges and scheduler hops around branches the function already expresses as `if` / early `return`. The prototype needed a conditional edge to skip nodes at all. More nodes do not make that edge smaller.

## Comparison

Numbers are from this spike. The LangGraph column is the stub that ran, not an equivalent router.

| | Current linear `routeRequest` | LangGraph stub |
|---|---|---|
| LOC | 366 lines, `src/virtual-models.ts:290-655`, including governor, classifier fallback, clamp, ledger | 104-line prototype, stubs only. Not a port. A real port would still have to call `decideTier`, `ensureLocalSlot`, and `resolveModel` |
| Testability | `test/routing.test.ts` exercises the function with an injected fake client. No graph runtime | Not shown to be easier to test. A runner is another surface. An in-file extraction can keep the same assertions |
| Cold-start | No extra import. The extension is already loaded by pi | `@langchain/langgraph` dynamic import median 123.3649 ms (min 120.4066, max 131.3172) vs `node:fs` median 1.1353 ms, 12 processes. Once per process. Informational |
| Per-invoke | Not timed here. The stub floor of four awaited calls was median 0.0008 ms | Fresh 4-node median 0.5614 ms (min 0.4772, max 2.4555). Direct early-exit median 0.3024 ms (min 0.2878, max 1.0767). Sub-millisecond. Paid on the common path |
| Dependency count | No `dependencies` key. Zero runtime packages | 22 installed packages (23 `npm ls --all --parseable` lines including the probe). 4 direct deps, plus peers `@langchain/core` and `zod`. No native addon found |
| Reversibility | Nothing to undo | Not adopted, so nothing landed. Adopting it would put that closure in pi's process with no build step to trim it |

## ADR

**Status:** rejected.

**Context.** Issue #92 asked whether `routeRequest` should become a LangGraph state machine. The function is 366 lines, so the issue's size trigger had already fired. `@langchain/langgraph@1.5.1` was installed only under `/tmp/spike92-probe`.

**Considered.** A `StateGraph` with nodes `gate`, `decide`, `place`, `emit`, conditional edges for the early exits, and `interrupt()` for a human confirm.

**Decision:** reject LangGraph. Do not add @langchain/langgraph. Do not rewire routeRequest.

**Rejected alternative.** Rewriting `routeRequest` as a `StateGraph`.

**Why that alternative lost.**

- The package is avoidable. Convention is no runtime dependency unless unavoidable. Import and typecheck succeeded; that removes "it does not load under NodeNext" as a reason, and it does not create a need.
- pi evaluates `./src/index.ts` with no build step. The installed closure is 22 packages, including `@langchain/core`, `zod`, `langsmith`, and `js-tiktoken`. Nothing in the probe tree-shook that.
- `route()` at `src/virtual-models.ts:678` runs on every model request. The common path is the early-exit arms. Conditional edges can skip `decide`, and the direct stub still took 0.3024 ms median. That is small next to a model call, and it is not free.
- `interrupt()` is the wrong shape for `route()`. It requires a checkpointer, throws `GraphInterrupt`, and resumes via `Command`. pi's `route()` must return `ModelRoute` or fail the request. There is no suspension hook. No pi fork.
- Release-on-throw is lexical (`src/virtual-models.ts:649-653`, and the same catch at 434-440 and 485-490). The throw probe's error did not carry `held`. A naive graph rewrite drops that edge. A graph runner that swallows that throw leaks a governor slot.

**What would change the answer.** A second caller that actually needs a shared runner, together with an explicit decision to take a runtime dependency. Or pi growing a suspend/resume hook on `route()` that a checkpointer can host — not a fork proposed here. A faster `invoke()` would not change it: the measured invoke cost is already sub-millisecond, and the decision does not rest on that cost being unacceptable. "TS support is newer" would not change it either: 1.5.1 already typechecks here. Line count alone would not change it: 366 is already past 300, and the follow-up is an in-file extraction, not a library.

## Measurements that argue against rejecting on capability grounds

These are real. They do not overturn the decision. They do mean the decision must not be sold as "LangGraph failed."

- Import passed, including under NodeNext `tsc`, with no build step.
- `compile()` without a checkpointer invoked successfully. A checkpointer is mandatory for `interrupt()`, not for `invoke()`.
- No native addon in the installed tree.
- Per-invoke medians were 0.5614 ms (fresh) and 0.3024 ms (direct early-exit). That is fast in absolute terms. The 748.53 ratio is against four empty awaits, not against an LLM turn.
- TypeScript support at `@langchain/langgraph@1.5.1` is real. The stale-TS correction cuts against waiting, not against the dependency objection.

## Decomposition plan (not a LangGraph migration)

The follow-up idea is to extract the `direct` / `retry` / sticky arms into named functions inside `src/virtual-models.ts`. That is a readability change, not a runner.

Constraints:

- Do not add a new module until a second caller exists.
- Do not wrap `decideTier` / `applyPolicy` / `ensureLocalSlot` / `resolveModel` in a runner.
- Do not change `RouterState` (`src/types.ts:221-222` — persisted on the session branch, must stay JSON-serializable) or the `route` callback.
- Future acceptance is `npm test` green with zero assertion edits in `test/routing.test.ts`.

This ticket does not implement that extraction. LangGraph adoption is not owed because the package is not adopted.
