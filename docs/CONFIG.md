# Configuration

`pi-model-router` reads `model-router.json` from:

1. `~/.pi/agent/model-router.json` (user)
2. `<cwd>/.pi/model-router.json` (project, overrides user)

Merge is per top-level section: a project file that sets only `local` leaves the
user's `classifier`, `catalog`, and `policy` intact. Missing file means defaults.
Worked example: [`examples/model-router.example.json`](../examples/model-router.example.json).

## `host`

Which local-inference server serves `catalog.local` and a local `classifier.model`.

The router talks to the *native management API* of the host, not just its
OpenAI-compatible endpoint, because the memory governor needs to know what is
loaded and to evict under a ceiling. Hosts differ in what they expose, and the
router degrades explicitly per capability instead of assuming:

| Host | `host` | Inventory | Loaded list | Load/unload | Model sizes | Decision models |
|---|---|---|---|---|---|---|
| LM Studio | `lmstudio` | ✅ | ✅ | ✅ | ✅ | ✅ System One |
| ollama | `ollama` | ✅ | ✅ `/api/ps` | ✅ `keep_alive` | ✅ | ✖ (chat prompt instead) |
| llama.cpp, vLLM, other OpenAI-compatible | `openai` | ✅ | ✖ | ✖ | ✖ | ✖ |

On a host without loaded-model introspection the governor still caps concurrency
cross-process via slot files (the invariant that matters); it simply cannot
cooperate with the host's own memory policy. `maxLoadedModels` and
`router/fast-local` size ordering apply only where the host supports them.

See the per-host sections below for URLs and tokens.

## `classifier`

The decision model. May be local or cloud.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | unset | `provider/model`. A ref whose provider is a local host (`lmstudio/…`, `ollama/…`, `openai/…`) is called over local HTTP for free; anything else is resolved as a pi classifier via `ctx.modelRegistry`. |
| `fallback` | `"heuristic"` \| `"local"` \| `"cloud"` | `"heuristic"` | What to use when the classifier is unavailable or times out. |
| `timeoutMs` | number | `4000` | Classifier timeout before falling back. |
| `stateChars` | number | `16000` | Characters of the prompt handed to the classifier. |

Example: `{ "model": "lmstudio/vllm-d3-nano", "fallback": "heuristic" }`.

The model part must be an exact `key` from LM Studio's `GET /api/v1/models` catalog (not a
display name). `/router doctor` checks that it is in the catalog, loads and answers, and
reports the character budget prompts are trimmed to. Decision models run the whole prompt as
a single physical batch (default 512 tokens), so `stateChars` is capped to that batch at
call time regardless of the configured value.

## `catalog`

Ordered candidate lists, tried in order. The first entry is preferred; if it is
missing from the model registry, over its context window, or out of slots, the next
resolvable candidate is used before spilling to cloud (#45). When the cloud catalog
resolves nothing, the turn falls back to a local candidate rather than failing; only
when nothing at all resolves does routing raise a clear error. `router/fast-local`
orders local candidates by on-disk size when the host reports it (LM Studio, ollama).

| Field | Type | Default |
|---|---|---|
| `local` | string[] | `[]` |
| `cloud` | string[] | `[]` |

Refs are `provider/model`; the model part may contain slashes
(`lmstudio/deepseek/deepseek-v4-flash`).

## `policy`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"complexity"` \| `"phase"` \| `"cost"` | `"complexity"` | How the tier is chosen. |
| `threshold` | number 0–1 | `0.5` | Complexity at or above this routes cloud. |
| `phase.plan` / `phase.implement` | `"local"` \| `"cloud"` | `cloud` / `local` | Tier per phase when `mode: "phase"`. |
| `reclassify` | `"session"` \| `"turn"` | `"session"` | `session` classifies once and stays; `turn` re-classifies each user turn. |
| `escalate.enabled` | boolean | `true` | Allow a local session to escalate to cloud on evidence of struggle. |
| `escalate.toolErrors` | number | `2` | Error tool-results (or errored turns) in the window that trigger escalation. |
| `escalate.window` | number | `8` | Recent messages scanned for struggle signals. |
| `escalate.cleanTurns` | number | `3` | Consecutive clean user turns before a struggle-escalated session steps back down. |

**Escalation is why "cheap without sacrificing accuracy" holds.** A session-sticky local
decision is cheap and cache-friendly, but a local model can start flailing on a turn that
outgrew it. The router watches the conversation it already receives — tool results marked
`isError` and turns that ended in an error — and moves the session to cloud mid-turn when
the evidence says so. Coming back down takes `cleanTurns` consecutive clean user turns, so
it does not oscillate. A failure-driven escalation (#37) instead re-decides on the very
next user turn, because the cause was the environment, not the work.

## `local`

Memory governance. See [ARCHITECTURE.md](ARCHITECTURE.md) for why this is filesystem-based.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxConcurrent` | number | `1` | Max concurrent local requests across all pi processes. |
| `maxConcurrentPerModel` | number | `1` | Max concurrent requests per local model. |
| `maxLoadedModels` | number | `1` | Cooperative ceiling on models loaded in the host (where the host reports loaded state and supports unload). |
| `onFull` | `"spill"` \| `"wait"` | `"spill"` | Route to cloud immediately, or wait for a slot. |
| `waitMs` | number | `20000` | Wait budget before spilling when `onFull: "wait"`. |
| `idleUnloadMs` | number | `300000` | Reserved; LM Studio owns the TTL (see #27). |
| `preload` | boolean | `true` | Warm the local model (and local classifier) at session start, fire-and-forget, so turn one is not a cold JIT load. |
| `pinClassifier` | boolean | `true` | Protect the local classifier from `maxLoadedModels` eviction — evicting it just forces a reload next turn. |
| `slotDir` | string | `~/.pi/agent/model-router/slots` | Where slot files live. `~` expands. |
| `staleSlotMs` | number | `300000` | A slot older than this is reaped. |

**Local classifier:** if `classifier.model` is served by the local host, set
`maxLoadedModels` to **at least 2**. At `1` the classifier and the target model
evict each other every turn — the classifier is unloaded to make room for the
target, then reloaded for the next decision. When the ceiling is reached and the
target is not loaded, the governor unloads other models (all instances of them) to
free a slot; `/router doctor` warns when this is misconfigured. This applies to
hosts that report loaded state (LM Studio, ollama).

## `telemetry`

The decision ledger behind `/router stats`. One JSONL line per assistant turn —
provider, model, tier, tokens. Metadata only; prompt and response content are never
written.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Record decisions and enable `/router stats`. |
| `path` | string | `~/.pi/agent/model-router/decisions.jsonl` | Ledger file. `~` expands. |
| `pricing` | object | `{}` | USD per million tokens, keyed by `provider/model`: `{ "input": 3, "output": 15 }`. |
| `baseline` | string | unset | Model ref the all-cloud baseline is priced at; usually `catalog.cloud[0]`. |

`/router stats [days]` (default 7) prints turns, the local share, token split, and —
when pricing is complete — spent vs the all-cloud baseline and the estimated saving.
Missing prices degrade to counts rather than inventing numbers.

```json
"telemetry": {
  "enabled": true,
  "baseline": "opencode-go/deepseek-v4.1-flash",
  "pricing": { "opencode-go/deepseek-v4.1-flash": { "input": 0.14, "output": 0.56 } }
}
```

## `lmstudio`, `ollama`, `openai`

Connection settings per host; only the one named by `host` is used.

| Section | Field | Default |
|---|---|---|
| `lmstudio` | `baseUrl` | `http://localhost:1235` |
| | `apiToken` | unset |
| `ollama` | `baseUrl` | `http://localhost:11434` |
| `openai` | `baseUrl` | `http://localhost:8080` (llama.cpp default) |
| | `apiKey` | unset |

Every section also accepts `timeoutMs` (default `8000`).

```json
{ "host": "ollama", "catalog": { "local": ["ollama/qwen3:8b"] } }
```

## Precedence summary

```
project .pi/model-router.json
  > user ~/.pi/agent/model-router.json
    > built-in DEFAULTS
```

`/router status` prints the contributing files and any warnings.
