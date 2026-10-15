# pi-model-router

**Hybrid local/cloud model routing for [pi](https://github.com/earendil-works/pi-coding-agent).**

Type one prompt. A local classifier decides whether the work belongs on a local model
(free, private) or a cloud model (expensive, capable). The decision is made **once per
session by default**, not per request, so it does not thrash the prompt cache. A
cross-process memory governor stops subagent fanout from loading ten local models at once.

- **What changes** — You select one virtual model (`router/auto`); the router dispatches each
  turn to the right physical model. Local, cloud, or let the classifier decide.
- **Why it matters** — Most coding turns are mechanical and do not justify frontier-model cost.
  The classifier runs locally, so the *decision* is free.
- **Who is affected** — Anyone running pi against a local model server (LM Studio, llama.cpp)
  alongside a paid provider, especially with `pi-subagents`.

Status: **working core, live-verified.** See [Verification](#verification).

---

## How it works

```
you select:   router/auto                (one model in /model, --model, settings)
                 │
                 ▼
        ┌──────────────────┐
        │  route(request)  │  once per session by default; continuations stay put
        └────────┬─────────┘
                 │
   ┌─────────────┴─────────────┐
   ▼                           ▼
local classifier           heuristic fallback
(System One Jev / chat)    (no model call)
   │                           │
   └─────────────┬─────────────┘
                 ▼
        ┌──────────────────┐
        │  memory governor │  filesystem slot broker (cross-process)
        └────────┬─────────┘
                 │
   ┌─────────────┴─────────────┐
   ▼                           ▼
lmstudio/… (free)        cloud/… (metered)
```

1. **Virtual models** (`pi.registerVirtualModel`) select a physical model per request.
2. **`session_start` selects `router/auto`** — this is how routing becomes the default,
   because `defaultModel` does not resolve an extension virtual model (see spike #24).
3. **Router state** lives on the session branch and survives compaction and forks.
4. **`route()` talks to LM Studio over plain HTTP**, never through another extension's
   hooks, because foreground subagent children do not reload ambient extensions.

---

## Install

```bash
pi install git:github.com/saman-mb/pi-model-router
# or try a checkout without installing:
pi -e /path/to/pi-model-router
```

## Configuration

A single file, `~/.pi/agent/model-router.json` (project `.pi/model-router.json` overrides):

```json
{
  "autoSelect": true,
  "classifier": { "model": "lmstudio/decision-2.0-kai-0.6b", "fallback": "heuristic" },
  "catalog": {
    "local": ["lmstudio/prism-ml/bonsai-27b"],
    "cloud": ["opencode-go/deepseek-v4.1-flash"]
  },
  "policy": { "mode": "complexity", "threshold": 0.5, "reclassify": "session" },
  "local": { "maxConcurrent": 1, "maxLoadedModels": 1, "onFull": "spill" }
}
```

| Field | Meaning |
|---|---|
| `autoSelect` | Select `router/auto` at session start (unless `--model` was passed). |
| `classifier.model` | `provider/model` of the decision model. `lmstudio/…` is called locally. |
| `classifier.fallback` | `heuristic` \| `local` \| `cloud` when the classifier is unavailable. |
| `catalog.local` / `catalog.cloud` | Ordered candidate models. First match wins. |
| `policy.mode` | `complexity` \| `cost` (bias local) \| `phase` (plan vs implement). |
| `policy.reclassify` | `session` (default) or `turn`. |
| `local.*` | The memory governor. See [docs/CONFIG.md](docs/CONFIG.md). |

Interactive editing (persists to the user config file):

```
/router                 # status: slots, loaded models, config sources
/router models          # pick the local, cloud, or decision model
/router policy          # complexity | cost | phase
/router limit           # max concurrent local requests
/router local|cloud|auto  # pin this session
```

One-off override: `pi --router-force=cloud`.

## Subagents

A subagent only routes if it loads this extension. Add it to the pi-subagents defaults so
every child does:

```json
{
  "subagents": {
    "defaultModel": "router/auto",
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/pi-model-router/src/index.ts"]
  }
}
```

Then choose a policy per role with pi's native mapping — no router code changes:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout":  { "model": "router/fast-local" },
      "worker": { "model": "router/cloud" },
      "oracle": { "model": "router/cloud" }
    }
  }
}
```

`router/auto`, `router/local`, `router/cloud`, and `router/fast-local` are all selectable
models. See [docs/SUBAGENTS.md](docs/SUBAGENTS.md) for why `defaultModel` alone is not enough.

---

## Verification

Every mechanic was checked against a live pi 1.2.0 install. Full evidence is on the closed
issues; the results that shape the design:

| Finding | Result |
|---|---|
| `defaultModel: "router/auto"` resolves at startup? | **No.** Use `session_start` + `pi.setModel`. |
| Does `message_end` fire once per request? | **Yes** — once per assistant message, even multi-block. |
| Are extension CLI flags readable in the factory? | **No** — read lazily in handlers. |
| Does LM Studio accept a load TTL? | **No** — unload by `instance_id`; TTL is server-side. |
| Do children inherit virtual models? | **Not reliably** — load the extension via `subagentOnlyExtensions`. |

Live-verified end to end: a mechanical prompt routes local (`lmstudio/prism-ml/bonsai-27b`),
a design prompt routes cloud (`opencode-go/deepseek-v4.1-flash`), and the local slot is
released after the turn.

## Tests

```bash
npm test          # node --experimental-strip-types --test test/*.test.ts
npm run typecheck
```

## License

MIT
