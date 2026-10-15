# pi-model-router

**Hybrid local/cloud model routing for [pi](https://github.com/earendil-works/pi-coding-agent).**

Type one prompt. A local classifier decides whether the work belongs on a local model
(free, private) or a cloud model (expensive, capable). The decision is made **once per
turn**, not per request, so it does not thrash the prompt cache. A cross-process memory
governor stops subagent fanout from loading ten local models at once.

> **Status: scaffold.** The architecture is verified against the pi docs and the
> installed `pi-subagents` source. Nothing here routes a live request yet. See
> [Verification gaps](#verification-gaps) and the [issue backlog](https://github.com/saman-mb/pi-model-router/issues).

---

## What changes / why it matters / who it affects

- **What changes** — Instead of picking one model for a whole session, you select a single
  virtual model (`router/auto`). Each new user turn is classified locally and dispatched to
  the right physical model. Choose local, cloud, or let it decide.
- **Why it matters** — Cloud tokens cost money and local GPUs sit idle. Most turns in a coding
  session are mechanical (renames, lookups, small edits) and do not need a frontier model.
  The classifier itself runs locally, so the *decision* costs nothing.
- **Who is affected** — Anyone running pi against a local model server (LM Studio, llama.cpp,
  Ollama) alongside a paid cloud provider. Especially anyone using `pi-subagents`, where a
  fanout of children can silently exhaust VRAM.

---

## How it works

```
you select:   router/auto                (one model in /model, --model, settings)
                 │
                 ▼
        ┌──────────────────┐
        │  route(request)  │  once per user turn; continuations stay put
        └────────┬─────────┘
                 │
   ┌─────────────┴─────────────┐
   ▼                           ▼
local classifier           heuristic fallback
(LM Studio or Jev)         (no model call)
   │                           │
   └─────────────┬─────────────┘
                 ▼
        ┌──────────────────┐
        │  memory governor │  filesystem slot broker (cross-process)
        └────────┬─────────┘
                 │
   ┌─────────────┴─────────────┐
   ▼                           ▼
lmstudio/… (free)        opencode-go/… (metered)
```

Key mechanics, all verified against pi's docs/source (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

1. **Virtual models** (`pi.registerVirtualModel`) select a physical model per request.
   They appear in `/model`, `--model`, scoped models, and settings like any other model.
2. **Router state** is stored on the session branch and survives compaction and forks.
3. **Subagents inherit the virtual model.** `pi-subagents` explicitly copies
   extension-registered virtual models into child sessions, so one router covers the main
   agent and every child.
4. **Foreground children do not reload ambient extensions**, so `route()` must not depend on
   a sibling extension's session hooks — it talks to LM Studio over plain HTTP.

---

## Configuration

A single file, `~/.pi/agent/model-router.json` (project `.pi/model-router.json` overrides):

```json
{
  "classifier": { "model": "lmstudio/openjev-2b", "fallback": "heuristic" },
  "catalog": {
    "local": ["lmstudio/deepseek/deepseek-v4-flash"],
    "cloud": ["opencode-go/deepseek-v4.1-flash"]
  },
  "policy": { "mode": "complexity", "threshold": 0.5 },
  "local": { "maxConcurrent": 1, "onFull": "spill" }
}
```

See [docs/CONFIG.md](docs/CONFIG.md) for every field. Interactive editing:

```
/router              # status + pick models, policy, pins
/router local        # pin this session to local
/router cloud        # pin this session to cloud
```

---

## Install

Scaffold, not yet published. To try the extension from a checkout:

```bash
pi -e /path/to/pi-model-router
```

Once there is a working release, install as a package:

```bash
pi install git:github.com/saman-mb/pi-model-router
```

---

## Verification gaps

These are **not** assumptions — they are open questions with tests assigned in the backlog:

| # | Question | Why it matters |
|---|---|---|
| 1 | Does `defaultModel: "router/auto"` resolve at startup? | The "by default" promise. Docs promise it for `registerProvider`, not `registerVirtualModel`. |
| 2 | Does `message_end` fire exactly once per provider request? | Slot release precision. If not, stale reaping must carry the load. |
| 3 | Are extension-registered CLI flags honoured on the same invocation? | `--router-force` UX. |
| 4 | Does virtual-model propagation to children hold on supported `pi-subagents` versions? | Main+subagent coverage. Code-verified locally, not doc-guaranteed. |
| 5 | Does LM Studio's load endpoint accept a TTL parameter? | Idle-memory reclamation; not in the local API reference. |

---

## License

MIT
