# Configuration

`pi-model-router` reads `model-router.json` from:

1. `~/.pi/agent/model-router.json` (user)
2. `<cwd>/.pi/model-router.json` (project, overrides user)

Merge is per top-level section: a project file that sets only `local` leaves the
user's `classifier`, `catalog`, and `policy` intact. Missing file means defaults.
Worked example: [`examples/model-router.example.json`](../examples/model-router.example.json).

## `classifier`

The decision model. May be local or cloud.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | unset | `provider/model`. A `lmstudio/...` ref is called over local HTTP; anything else is resolved as a pi classifier via `ctx.modelRegistry`. |
| `fallback` | `"heuristic"` \| `"local"` \| `"cloud"` | `"heuristic"` | What to use when the classifier is unavailable or times out. |
| `timeoutMs` | number | `4000` | Classifier timeout before falling back. |
| `stateChars` | number | `16000` | Characters of the prompt handed to the classifier. |

Example: `{ "model": "lmstudio/openjev-2b", "fallback": "heuristic" }`.

## `catalog`

Ordered candidate lists. The first entry is used; ordering by size for
`router/fast-local` is a backlog item.

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

## `local`

Memory governance. See [ARCHITECTURE.md](ARCHITECTURE.md) for why this is filesystem-based.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxConcurrent` | number | `1` | Max concurrent local requests across all pi processes. |
| `maxConcurrentPerModel` | number | `1` | Max concurrent requests per local model. |
| `maxLoadedModels` | number | `1` | Cooperative ceiling on models loaded in LM Studio. |
| `onFull` | `"spill"` \| `"wait"` | `"spill"` | Route to cloud immediately, or wait for a slot. |
| `waitMs` | number | `20000` | Wait budget before spilling when `onFull: "wait"`. |
| `idleUnloadMs` | number | `300000` | Reserved; LM Studio owns the TTL (see #27). |
| `slotDir` | string | `~/.pi/agent/model-router/slots` | Where slot files live. `~` expands. |
| `staleSlotMs` | number | `300000` | A slot older than this is reaped. |

**Local classifier:** if `classifier.model` is an `lmstudio/…` model, set `maxLoadedModels`
to **at least 2**. At `1` the classifier and the target model evict each other every turn —
the classifier is unloaded to make room for the target, then reloaded for the next decision.
When the ceiling is reached and the target is not loaded, the governor unloads other models
(all instances of them) to free a slot; `/router doctor` warns when this is misconfigured.

## `lmstudio`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:1235` | LM Studio server. |
| `apiToken` | string | unset | Bearer token if the server enables tokens. |
| `timeoutMs` | number | `8000` | HTTP timeout. |

## Precedence summary

```
project .pi/model-router.json
  > user ~/.pi/agent/model-router.json
    > built-in DEFAULTS
```

`/router status` prints the contributing files and any warnings.
