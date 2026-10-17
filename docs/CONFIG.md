# Configuration

`pi-cuttle` reads `pi-cuttle.json` from:

1. `~/.pi/agent/pi-cuttle.json` (user)
2. `<cwd>/.pi/pi-cuttle.json` (project, overrides user)

Merge is per top-level section: a project file that sets only `local` leaves the
user's `classifier`, `catalog`, and `policy` intact. Missing file means defaults.
Worked example: [`examples/pi-cuttle.example.json`](../examples/pi-cuttle.example.json).

> Legacy: an existing `~/.pi/agent/cuttle.json` and `~/.pi/agent/cuttle/` directory are
> moved to the new `pi-cuttle` names automatically on first load.

## Model refs

Every model ref is `provider/model` as pi's model registry understands it. The
`provider` is whatever pi lists — `llama.cpp`, `mtplx`, `lmstudio`, `ollama`,
`opencode-go`, etc. Use `pi --list-models` to check. The `model` part may contain
slashes (`llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0`).

## `classifier`

The decision model. Must be a classifier pi can resolve via `ctx.modelRegistry`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | unset | `provider/model` of the classifier. Examples: `llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0`, `opencode-go/some-classifier`. |
| `fallback` | `"heuristic"` \| `"local"` \| `"cloud"` | `"heuristic"` | What to use when the classifier is unavailable or times out. |
| `timeoutMs` | number | `4000` | Classifier timeout before falling back. |
| `stateChars` | number | `16000` | Characters of the prompt handed to the classifier. |

Example: `{ "model": "llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0", "fallback": "heuristic" }`.

`/cuttle doctor` checks that the classifier resolves and answers a trivial probe.
Set `PI_CUTTLE_DEBUG` to a file path to log each routing decision and any classifier
failure. The router is otherwise silent, so this is the only turn-level record that the
classifier fell back to the heuristic.

## `catalog`

Ordered candidate lists, tried in order. The first entry is preferred; if it is
missing from the model registry, over its context window, or out of slots, the next
resolvable candidate is used before spilling to cloud. When the cloud catalog
resolves nothing, the turn falls back to a local candidate rather than failing; only
when nothing at all resolves does routing raise a clear error. `cuttle/fast-local`
orders local candidates by a configured size map if one is supplied; otherwise it keeps
catalog order.

| Field | Type | Default |
|---|---|---|
| `local` | string[] | `[]` |
| `cloud` | string[] | `[]` |

### Model selection by complexity

When the classifier returns a complexity score, the router uses each candidate's
context window (read from pi's model registry) as a capacity proxy. Within the chosen
tier it picks the smallest model whose capacity is at least the complexity score. If no
candidate reaches the score, it picks the largest. This keeps cheap/small models on easy
work without hard-coding capacities.

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

Cross-process concurrency governance. See [ARCHITECTURE.md](ARCHITECTURE.md) for why this
is filesystem-based.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxConcurrent` | number | `1` | Max concurrent local requests across all pi processes. |
| `maxConcurrentPerModel` | number | `1` | Max concurrent requests per local model. |
| `maxConcurrentByFlavor` | object | unset | Per-virtual-model budgets, e.g. `{ "local": 1, "fast-local": 1 }`. |
| `onFull` | `"spill"` \| `"wait"` | `"spill"` | Route to cloud immediately, or wait for a slot. |
| `waitMs` | number | `20000` | Wait budget before spilling when `onFull: "wait"`. |
| `slotDir` | string | `~/.pi/agent/pi-cuttle/slots` | Where slot files live. `~` expands. |
| `staleSlotMs` | number | `300000` | A slot older than this is reaped. |

This cap counts **in-flight turns**, not loaded models. pi-cuttle no longer talks to local
servers directly, so it cannot manage how many models your server keeps resident in memory.
Configure that in the server itself (LM Studio's memory settings, llama.cpp router presets,
etc.).

## `telemetry`

The decision ledger behind `/cuttle stats`. One JSONL line per assistant turn —
provider, model, tier, tokens. Metadata only; prompt and response content are never
written.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Record decisions and enable `/cuttle stats`. |
| `path` | string | `~/.pi/agent/pi-cuttle/decisions.jsonl` | Ledger file. `~` expands. |
| `pricing` | object | `{}` | USD per million tokens, keyed by `provider/model`: `{ "input": 3, "output": 15 }`. |
| `baseline` | string | unset | Model ref the all-cloud baseline is priced at; usually `catalog.cloud[0]`. |

`/cuttle stats [days]` (default 7) prints turns, the local share, token split, and —
when pricing is complete — spent vs the all-cloud baseline and the estimated saving.
Missing prices degrade to counts rather than inventing numbers.

```json
"telemetry": {
  "enabled": true,
  "baseline": "opencode-go/deepseek-v4.1-flash",
  "pricing": { "opencode-go/deepseek-v4.1-flash": { "input": 0.14, "output": 0.56 } }
}
```

## Precedence summary

```
project .pi/pi-cuttle.json
  > user ~/.pi/agent/pi-cuttle.json
    > built-in DEFAULTS
```

`/cuttle status` prints the contributing files and any warnings.
