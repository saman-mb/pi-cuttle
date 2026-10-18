# Architecture

## Goal

Route each turn of a pi session to a local or cloud physical model, chosen by a
local classifier, without thrashing the prompt cache and without letting subagent
fanout exhaust local memory.

## Relationship to Cuttle

This package is the pi extension for [Cuttle](https://github.com/saman-mb/cuttle), and it is
where Cuttle's routing was prototyped. The two share a design, not a code path:

- Nothing here imports Cuttle or Python.
- Nothing here requires Cuttle to be installed, running, or even present.
- The overlap that must be kept honest: the complexity classes, the escalate-on-struggle rule,
  and the decision-ledger shape. If one side changes those and the other does not, that is
  drift, not a variant.

## Verified pi mechanics

Everything here was checked against the pi docs and the installed `pi-subagents`
source. File paths are relative to the pi install
(`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent`)
or the `pi-subagents` package.

| Mechanic | Evidence |
|---|---|
| `pi.registerVirtualModel({ provider, id, name, thinkingLevels, contextWindow, maxTokens, input, route })` | `dist/core/extensions/types.d.ts:1402,1409` |
| `route(request, ctx)` receives `reason`, `previous`, `failed`, `state`, `messages`, `thinkingLevel`, `signal` | `docs/virtual-models.md`, `dist/core/model-runtime.d.ts:135` |
| Virtual models appear in `/model`, `--model`, scoped models, settings | `docs/virtual-models.md:5` |
| Router state is stored on the session branch (entry `pi.virtual-model-state`), survives forks/compaction | `docs/session-format.md:174` |
| Compaction uses the limits of the model each request routes to | `docs/virtual-models.md` |
| A retry can switch models via `request.failed` / `errorMessage` | `docs/virtual-models.md` |
| Subagent children inherit extension-registered virtual models | `pi-subagents/src/runs/shared/child-session.js:226-247` |
| Foreground children do **not** load ambient extensions; background children do | `pi-subagents/docs/agents.md:520`; `src/runs/shared/child-launch.js:199` |
| `subagents.defaultModel` / `agentOverrides.<name>.model` precedence | `pi-subagents/docs/models.md` |
| No builtin agent pins a model | all 13 files in `pi-subagents/agents/*.md` |
| `pi.registerCommand`, `ctx.ui.select`, `pi.registerFlag`, `pi.getFlag`, `ctx.getContextUsage`, `pi.getSettings` | `dist/core/extensions/types.d.ts` |
| `message_end` delivers the authoritative `AssistantMessage` with `provider`, `model`, `stopReason`, `errorMessage`, `usage` | `docs/extensions.md:106`; `@earendil-works/pi-ai dist/types.d.ts:357` |
| `ctx.sessionManager.getSessionId()` | `dist/core/session-manager.d.ts:178` |
| `ctx.modelRegistry.findOfType("classifier", provider, id)` and `ctx.modelRegistry.classify(model, context, options)` | `dist/core/extensions/types.d.ts` |

## Invariants

1. **Decide once per session (default), not per request.** Continuations, retries,
   and tool-result follow-ups keep the previous model, preserving the prompt cache.
   `policy.reclassify: "turn"` opts into per-turn re-classification. Two evidence-driven
   exceptions keep the decision honest: struggle escalation (#41) moves a flailing local
   session to cloud mid-turn and steps back down after `cleanTurns` clean user turns;
   a failure-driven escalation (#37) re-decides on the next user turn. Both exceptions apply
   to sessions that may route cloud (`cuttle/auto`, `cuttle/cloud`, `cuttle/orchestrator`): the always-local flavors
   (`cuttle/local`, `cuttle/fast-local`, `cuttle/big-local`) are hard-pinned and never escalate
   to cloud — when local is unavailable they fail with an actionable error instead (#112).
2. **All models come from pi's registry.** `route()` resolves every physical model and
   every classifier through `ctx.modelRegistry`. It does not talk to any local server
   directly, so it works with any provider pi already supports (LM Studio, llama.cpp router,
   MTPLX, ollama, vLLM, …) without host-specific code.
3. **The concurrency cap is on disk.** Async children run in separate processes; an
   in-memory counter is meaningless across them. `LocalGovernor` reads and writes
   slot files under `local.slotDir`.
4. **Release is approximate.** Slots are freed on `message_end`, on process exit,
   and by stale reaping on every acquire. Correctness rests on reaping.
5. **The heuristic never throws.** When the classifier is unavailable,
   `decideTier` returns a deterministic answer and records the failure in the reason.
6. **No silent fallback.** A classifier failure is always visible in the decision reason,
   the debug log, and `/cuttle status`.
7. **Gates are one forward pass.** Phase-2 gates (`delegate`, `role`, `judge`, `struggle`)
   are asked alongside the complexity question in a single `ctx.modelRegistry.classify()`
   call. They start in shadow mode and only affect routing after `/cuttle shadow-report`
   proves agreement.

## Components

| File | Responsibility |
|---|---|
| `src/config.ts` | Load and merge `pi-cuttle.json` over defaults. |
| `src/governor.ts` | Cross-process slot broker (concurrency cap only). |
| `src/classifier.ts` | `decideTier`: classifier call via pi's registry, with heuristic fallback. |
| `src/virtual-models.ts` | Register `cuttle/auto`, `cuttle/local`, `cuttle/cloud`, `cuttle/fast-local`, `cuttle/big-local`, `cuttle/orchestrator`; `route()` policy + local-only pin. |
| `src/telemetry.ts` | Decision ledger + `/cuttle stats` aggregation (metadata only). |
| `src/commands.ts` | `/cuttle` command family (on/off, status, init, models, policy, limit, doctor, stats, shadow-report). |
| `src/shadow.ts` | Phase-2 shadow-mode gate ledger and `/cuttle shadow-report` aggregation. |
| `src/index.ts` | Extension factory; wires the above; `message_end` release hook. |

## Evaluation

`eval/corpus.jsonl` is ground truth for "which tier should serve this work" — 112
labeled prompts scored by `npm run eval` with a recorded baseline in
[eval/BASELINE.md](../eval/BASELINE.md). CI fails when heuristic accuracy drops below
the floor. Add a prompt that exposed a real misroute before changing heuristics.

## Verification results

| Question | Answer | Consequence |
|---|---|---|
| `defaultModel: "cuttle/auto"` resolves at startup? | **No** | Select it on `session_start` via `pi.setModel`; `autoSelect` defaults to `false`, so this is opt-in (#24). |
| `message_end` once per provider request? | **Yes** | Slot release is exact; stale reaping is a safety net (#25). |
| Extension flags readable in the factory? | **No** | Read `--cuttle-force` lazily in `route()` (#26). |
| Children inherit virtual models? | **Not reliably** | Load the extension via `subagentOnlyExtensions` (#28). |

## Decision: reject LangGraph (#92)

Decision: reject LangGraph. Do not add @langchain/langgraph. Do not rewire routeRequest.

`routeRequest()` is 366 lines (`src/virtual-models.ts:290-655`), not the ~200 the issue claimed, so the issue's own >300-line trigger to re-evaluate had already fired. The issue's claim that "TS support is newer" is stale. `@langchain/langgraph@1.5.1` imports and typechecks under NodeNext with no build step (measured outside this repo); that does not make it a dependency this extension should take.

Invariants unchanged. Routing still decides once per user turn, `route()` stays self-contained, and the governor stays on the filesystem. No component was added.

Evidence, the rejected `StateGraph` alternative, and what would change the answer: [spikes/92-langgraph-routing.md](spikes/92-langgraph-routing.md).

