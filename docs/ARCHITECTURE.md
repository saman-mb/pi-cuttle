# Architecture

## Goal

Route each turn of a pi session to a local or cloud physical model, chosen by a
local classifier, without thrashing the prompt cache and without letting subagent
fanout exhaust local memory.

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
| LM Studio `GET /api/v1/models` exposes `loaded_instances[].id` (+ `config.parallel`, `remaining_ttl_seconds`); `POST /api/v1/models/unload` takes `instance_id` | live probe of LM Studio on `:1235` |
| ollama `GET /api/tags` / `GET /api/ps` / `POST /api/generate {keep_alive}` / `POST /api/chat` | documented ollama API; adapter unit-tested with a fake client (no live install on the build machine) |

## Invariants

1. **Decide once per session (default), not per request.** Continuations, retries,
   and tool-result follow-ups keep the previous model, preserving the prompt cache.
   `policy.reclassify: "turn"` opts into per-turn re-classification. Two evidence-driven
   exceptions keep the decision honest: struggle escalation (#41) moves a flailing local
   session to cloud mid-turn and steps back down after `cleanTurns` clean user turns;
   a failure-driven escalation (#37) re-decides on the next user turn.
2. **`route()` is self-contained.** It may call `ctx.modelRegistry`, the configured
   local host over HTTP, and the filesystem. It may not rely on another extension's hooks: a
   foreground subagent child shares the parent process but does not reload ambient
   extensions.
3. **The memory cap is on disk.** Async children run in separate processes; an
   in-memory counter is meaningless across them. `LocalGovernor` reads and writes
   slot files under `local.slotDir`.
4. **Release is approximate.** Slots are freed on `message_end`, on process exit,
   and by stale reaping on every acquire. Correctness rests on reaping.
5. **The heuristic never throws.** When the local host or the classifier is unavailable,
   `decideTier` returns a deterministic answer.
6. **Hosts are pluggable; capabilities are explicit.** All local-inference calls go through
   `LocalHost` (`src/host.ts`). Each host declares `canListLoaded`, `canLoadUnload`,
   `hasDecisionModels`, `hasModelSizes`; the governor and classifier degrade per flag
   rather than assuming LM Studio. A host with no loaded-model introspection still gets
   cross-process slot accounting — the cap that prevents fanout OOMs — but no ceiling
   enforcement.

## Components

| File | Responsibility |
|---|---|
| `src/config.ts` | Load and merge `model-router.json` over defaults. |
| `src/host.ts` | `LocalHost` interface + capabilities; `createHost` picks by `config.host`. |
| `src/lmstudio.ts` | LM Studio adapter (native `/api/v1` management API, System One decisions). |
| `src/ollama.ts` | ollama adapter (`/api/tags`, `/api/ps`, `keep_alive` load/unload). |
| `src/openai-host.ts` | Generic OpenAI-compatible adapter (capability floor). |
| `src/governor.ts` | Cross-process slot broker + loaded-model cooperation (capability-gated). |
| `src/classifier.ts` | `decideTier`: classifier call via the local host or pi, with heuristic fallback. |
| `src/virtual-models.ts` | Register `router/auto`, `router/local`, `router/cloud`, `router/fast-local`; `route()` policy + spill. |
| `src/commands.ts` | `/router` command. |
| `src/index.ts` | Extension factory; wires the above; `message_end` release hook. |

## Verification results

All five questions were answered by running pi 1.2.0. Full evidence is on the closed issues.

| Question | Answer | Consequence |
|---|---|---|
| `defaultModel: "router/auto"` resolves at startup? | **No** | Select it on `session_start` via `pi.setModel` (#24). |
| `message_end` once per provider request? | **Yes** | Slot release is exact; stale reaping is a safety net (#25). |
| Extension flags readable in the factory? | **No** | Read `--router-force` lazily in `route()` (#26). |
| LM Studio load accepts a TTL? | **No** | Unload by `instance_id`; TTL is server-side (#27). |
| Children inherit virtual models? | **Not reliably** | Load the extension via `subagentOnlyExtensions` (#28). |
