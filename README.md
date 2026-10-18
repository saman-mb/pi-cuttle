# pi-cuttle

<p align="center">
  <img src="docs/assets/logo.gif" width="140" alt="Cuttle — animated pixel-art cuttlefish with cycling chromatophore colours" />
</p>

[![tests](docs/badges/tests.svg)](https://github.com/saman-mb/pi-cuttle/actions) [![version](docs/badges/version.svg)](CHANGELOG.md) [![license](docs/badges/license.svg)](LICENSE)

**Hybrid local/cloud model routing for [pi](https://github.com/earendil-works/pi-coding-agent).**

Type one prompt. A local classifier decides whether the work belongs on a local model
(free, private) or a cloud model (expensive, capable). The decision is made **once per
session by default**, not per request, so it does not thrash the prompt cache. A
cross-process concurrency governor stops subagent fanout from swamping your local server.

pi-cuttle has **no opinion about which local server you run**. It reads whatever models pi
already knows about — LM Studio, llama.cpp router, MTPLX, ollama, vLLM — so you configure
the server once in pi and the router just uses it.

- **What changes** — You toggle routing on (`/cuttle on`); the router selects the right
  physical model for each turn.
- **Why it matters** — Most coding turns are mechanical and do not justify frontier-model cost.
  The classifier runs locally, so the *decision* is free.
- **Who is affected** — Anyone running pi against a local model server alongside a paid
  provider, especially with `pi-subagents`.

Status: **working core, live-verified.** See [Verification](#verification).

Full user guide: [`docs/GUIDE.md`](docs/GUIDE.md) — what the decision model does per turn,
how to enable routing, and how to read what it decided.

---

## Part of Cuttle

This is the pi extension for [**Cuttle**](https://github.com/saman-mb/cuttle) — the local-first
agent that gives every piece of work to the cheapest model likely to get it right. It is where
Cuttle's routing (`decide()`) was prototyped, and it is the supported way to run Cuttle-style
routing inside pi.

It is **standalone**. No Cuttle install, no Python, no engine process — everything it needs
lives in this package and talks through pi's own model registry.

---

## How it works

```
you: /cuttle on
        │
        ▼
cuttle/auto  (virtual model)
        │
        ▼
┌──────────────────┐
│  route(request)  │  once per session by default; continuations stay put
└────────┬─────────┘
         │
┌────────┴────────┐
▼                 ▼
classifier    heuristic fallback
(pi registry) (no model call)
         │
         ▼
┌──────────────────┐
│  concurrency cap │  filesystem slot broker (cross-process)
└────────┬─────────┘
         │
┌────────┴────────┐
▼                 ▼
local/… (free)   cloud/… (metered)
```

1. **Virtual models** (`pi.registerVirtualModel`) select a physical model per request.
2. **`/cuttle on` selects `cuttle/auto`** — this is how automatic routing is enabled.
   `autoSelect` defaults to `false`; installs never hijack the session model.
3. **Router state** lives on the session branch and survives compaction and forks.
4. **All models are resolved through pi's model registry.** The router never talks to a
   local server directly.

---

## Install

```bash
pi install npm:pi-cuttle
# or from git:
pi install git:github.com/saman-mb/pi-cuttle
```

To run a checkout instead of installing it, use `-e` — but only when the package is **not**
already installed. `pi` loads both, and the second registration of the `--cuttle-force` flag is
rejected, which stops the extension loading at all. Remove an installed copy first:

```bash
pi remove git:github.com/saman-mb/pi-cuttle   # or: pi remove npm:pi-cuttle
pi -e /path/to/pi-cuttle
```

## Configuration

A single file, `~/.pi/agent/pi-cuttle.json` (project `.pi/pi-cuttle.json` overrides):

```json
{
  "autoSelect": true,
  "classifier": {
    "model": "llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0",
    "fallback": "heuristic",
    "timeoutMs": 4000,
    "stateChars": 16000
  },
  "catalog": {
    "local": ["mtplx/mtplx-qwen38-27b-optimized-quality"],
    "cloud": ["opencode-go/deepseek-v4.1-flash"]
  },
  "policy": { "mode": "complexity", "threshold": 0.5, "reclassify": "session" },
  "local": { "maxConcurrent": 1, "maxConcurrentPerModel": 1, "onFull": "spill" }
}
```

### Migrating from `cuttle.json`

The extension now uses `~/.pi/agent/pi-cuttle.json` and stores runtime state under
`~/.pi/agent/pi-cuttle/`. On first load, an existing `cuttle.json` and `cuttle/` directory
are moved to the new names automatically.

### Fields

| Field | Meaning |
|---|---|
| `autoSelect` | Opt in to selecting `cuttle/auto` at session start. Default `false` so installs never hijack the session model. Never applies inside a subagent child or a forked session: the model chosen by the launcher or parent is kept. |
| `classifier.model` | `provider/model` of a pi-registered classifier. Examples: `llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0`, `opencode-go/some-classifier`. |
| `classifier.fallback` | `heuristic` \| `local` \| `cloud` when the classifier is unavailable. |
| `classifier.timeoutMs` | How long to wait for the classifier answer. |
| `classifier.stateChars` | Max characters of prompt sent to the classifier. |
| `catalog.local` / `catalog.cloud` | Candidate models. Local picks the smallest model that fits the complexity score; cloud picks the cheapest fitting model. Catalog order is the final tiebreaker. |
| `capabilities` | Optional `provider/model -> [0,1]` map that overrides the context-window proxy for model selection and `cuttle/fast-local` ordering. |
| `policy.mode` | `complexity` \| `cost` (bias local) \| `phase` (plan vs implement). |
| `policy.reclassify` | `session` (default) or `turn`. |
| `local.*` | Cross-process concurrency cap. See [docs/CONFIG.md](docs/CONFIG.md). |

> Model ids must be exact `provider/model` refs that pi's model registry can resolve. Use
> `pi --list-models` to check. `/cuttle doctor` verifies the classifier and catalog entries.
>
> Set `PI_CUTTLE_DEBUG=<path>` to log every routing decision, plus any classifier failure, to
> that file. The router is otherwise silent, so that file and `/cuttle doctor` are the only
> places a classifier fallback becomes visible.

### Commands

```
/cuttle              # status: models, policy, routing state, slots, last classifier failure
/cuttle on           # enable auto-routing for this and future sessions
/cuttle off          # disable auto-routing and restore the previous model
/cuttle init         # first-run wizard: pick classifier, local, and cloud models
/cuttle doctor       # probe the classifier and catalog entries
/cuttle models       # pick the local, cloud, or decision model
/cuttle policy       # complexity | cost | phase
/cuttle limit        # max concurrent local requests
/cuttle config       # interactive settings panel (TUI) or text view (non-TUI)
/cuttle stats [days] # local share, tokens, estimated $ saved vs all-cloud
/cuttle shadow-report [days] # phase-2 gate agreement (when gates are enabled)
```

Tier pins (`/cuttle local`, `/cuttle cloud`, `/cuttle auto`, `/cuttle fast-local`) have been
replaced by the on/off toggle. You can still select the individual virtual models through
pi's model picker if you want to override a session.

One-off override: `pi --cuttle-force=cloud`.

The `/cuttle` commands report through the terminal UI. For headless use, set
`PI_CUTTLE_DEBUG` and read the decision ledger.

## Subagents

A subagent only routes if it loads this extension. Add it to the pi-subagents defaults so
every child does:

```json
{
  "subagents": {
    "defaultModel": "cuttle/auto",
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/pi-cuttle/src/index.ts"]
  }
}
```

Then choose a policy per role with pi's native mapping — no router code changes:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout":  { "model": "cuttle/fast-local" },
      "worker": { "model": "cuttle/cloud" },
      "oracle": { "model": "cuttle/cloud" }
    }
  }
}
```

## Governor gap

The cross-process concurrency cap (`local.maxConcurrent`) counts in-flight turns. It does
**not** manage how many models your local server keeps loaded in memory, because different
servers expose that differently and pi-cuttle no longer talks to any server directly. If you
need a loaded-model ceiling, configure it in the server itself (e.g. LM Studio's memory
settings or the llama.cpp router's presets).

## Verification

Phase 1 verification (llama.cpp router classifier + MTPLX local):

- `/cuttle doctor` — classifier and catalog entries resolve.
- A decision with `source: classifier` and `p(complex)` in the reason.
- A decision with a >10k-character state, still classifier-sourced.
- A coding turn routed to `mtplx/...` and completed.

See `docs/ARCHITECTURE.md` for design invariants, `docs/CONFIG.md` for all options, `docs/EVAL.md` for the eval pipeline guide, and `docs/EVAL-IMPACT.md` for what the pipeline gives you as a developer and product owner.

---

## License

MIT
