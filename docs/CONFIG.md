# Configuration

`pi-cuttle` reads `pi-cuttle.json` from:

1. `~/.pi/agent/pi-cuttle.json` (user)
2. `<cwd>/.pi/pi-cuttle.json` (project, overrides user)

Merge is per top-level section: a project file that sets only `local` leaves the
user's `classifier`, `catalog`, and `policy` intact. Missing file means defaults.
Worked example: [`examples/pi-cuttle.example.json`](../examples/pi-cuttle.example.json).

> Legacy: an existing `~/.pi/agent/cuttle.json` and `~/.pi/agent/cuttle/` directory are
> moved to the new `pi-cuttle` names automatically on first load.

## Interactive config panel

Run `/cuttle config` for a single searchable panel showing the routing knobs with their current values:

- **Classifier model** — pick from pi's registered classifiers or unset (heuristic)
- **Local catalog** — read-only; use `/cuttle models` to change
- **Cloud catalog** — read-only; use `/cuttle models` to change
- **Policy mode** — cycle through complexity, cost, phase
- **Local max concurrent** — pick from 1, 2, 3, 4, 6, 8

In TUI mode the panel is interactive (Enter to select, Esc to cancel). In non-TUI modes
(print, JSON, RPC) it falls back to a text view showing all values and which file to edit.

Changes are written immediately to `~/.pi/agent/pi-cuttle.json` and take effect from the next
**routing decision** — a new session, or the next user turn when `policy.reclassify` is `"turn"`.
The default is `"session"`, so classifier and policy edits usually land in a new session; a turn
that already decided keeps its model. Sections locked by a project config file
(`.pi/pi-cuttle.json`) are shown as SHADOWED and cannot be changed via the panel.

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
| `stateChars` | number | `16000` | Characters of the prompt handed to the classifier. Applies **only** when `contextSource` is `"last-message"` (the default); ignored otherwise. |
| `backoffAfterFailures` | number | `3` | Consecutive failures before the classifier is skipped. |
| `backoffMs` | number | `60000` | Cooldown after the failure threshold is crossed. |
| `contextSource` | `"last-message"` \| `"conversation"` \| `"off"` | `"last-message"` | What the classifier is shown. `last-message` is today's behaviour: the newest user message, truncated by `stateChars`. `conversation` sends a structured view of the session instead. `off` skips the classifier entirely and uses the heuristic. **The default has not changed.** |
| `contextBudget` | number | `8192` | Hard character cap for the `conversation` signal. Clamped to 64 000; values outside 1–64 000 are clamped rather than rejected. |
| `conversationWindow` | number | `3` | How many recent assistant turns the `conversation` signal includes. |
| `contextShadow` | boolean | `false` | When `true`, also classify with the *other* signal source and record both verdicts in the shadow log. Observability only — the alternate verdict never routes. Pair it with `policy`-level debugging before trusting the comparison. |

Example: `{ "model": "llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0", "fallback": "heuristic" }`.

A second example enabling the conversation signal:

```json
{
  "classifier": {
    "model": "llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0",
    "contextSource": "conversation",
    "contextBudget": 8192,
    "conversationWindow": 3
  }
}
```

### Conversation context (`contextSource`)

By default the classifier sees **only the newest user message**, truncated to `stateChars`
characters. In a long session a terse follow-up ("do the other thing") is then classified on
those few words alone.

Setting `contextSource: "conversation"` sends a structured signal instead: the latest user
message in full, the last `conversationWindow` assistant turns (role-tagged, each capped),
a tool-usage digest, and session size — all inside `contextBudget`.

The latest user message is never dropped in favour of history. Older assistant turns are dropped
first when the budget is tight. Only text content is included — images and binary blocks are
filtered out. The signal is deterministic.

The path falls back to `last-message` (with the reason logged) when the formatter cannot produce
usable context, and when the latest message alone is larger than `contextBudget` — so opting in
never shows the classifier *less* text than the default would.

**Known limitations of this signal** (do not read it as a strict improvement):

- it includes recent **assistant** turns, but not earlier **user** requests — a follow-up like
  "do the other thing" may still miss its referent when that referent was an earlier user message;
- it omits tool *results* (only a usage digest), so the substance of a long tool output is not seen;
- it has not been shown on real sessions to improve routing yet. That is exactly what
  `contextShadow` exists to measure.

**Rollout status.** `conversation` is **opt-in** and the default remains `last-message`. The
default will only be changed after `contextShadow` comparison data from real sessions shows the
conversation signal wins on terse follow-ups without regressing other cases. That evidence does
**not** exist yet. Until it does, no default has changed, and no claim is made here that
`conversation` routes better than `last-message`.

**JSON-only for now.** The `contextSource`, `contextBudget`, `conversationWindow` and
`contextShadow` fields are **not** editable through the `/cuttle config` panel in this release —
set them in `pi-cuttle.json`. The panel shows the effective `contextSource` under `/cuttle status`
instead of editing it.

**Timing.** This changes only what the classifier is shown, never when it runs. Routing still
decides once per user turn; with the default `policy.reclassify: "session"` the decision is taken
once and kept unless the session is recovering or de-escalating.

`/cuttle doctor` checks that the classifier resolves and answers a trivial probe.
Set `PI_CUTTLE_DEBUG` to a file path to log each routing decision and any classifier
failure. The router is otherwise silent, so this is the only turn-level record that the
classifier fell back to the heuristic.

## `catalog`

Ordered candidate lists. Catalog order is the final tiebreaker; the router normally
reorders candidates by ability to handle the turn and, for cloud, by cost.

- If a candidate is missing from the model registry, over its context window, or out
  of slots, the next resolvable candidate is used before spilling to cloud (except the
  always-local flavors, which error instead — see [Virtual model flavors](#virtual-model-flavors)).
- When the cloud catalog resolves nothing, the turn falls back to a local candidate
  rather than failing; only when nothing at all resolves does routing raise a clear error.

| Field | Type | Default |
|---|---|---|
| `local` | string[] | `[]` |
| `cloud` | string[] | `[]` |

### Model selection by complexity

When the classifier returns a complexity score, the router uses each candidate's
context window (read from pi's model registry) as a capacity proxy. Within the local
tier it picks the smallest model whose capacity is at least the complexity score. If no
candidate reaches the score, it picks the largest. This keeps cheap/small models on easy
work without hard-coding capacities.

Within the cloud tier, among models that fit the score, the router picks the cheapest
(using pi's registry cost). Catalog order only breaks ties.

### `cuttle/fast-local`

`cuttle/fast-local` orders local candidates by the optional `capabilities` map below,
lowest capability first. Without `capabilities`, it keeps catalog order.

## `capabilities`

Optional per-model capability overrides as a flat map of `provider/model -> [0,1]`.
Higher means the model can handle harder work. When set for a model, this value is used
instead of the context-window ratio for "smallest adequate model" selection and for
`cuttle/fast-local` ordering.

Use this when context window is a poor proxy for ability — for example, a 32k-context
30B model is usually more capable than a 128k-context 4B model, or when you want
`fast-local` to prefer a specific small model regardless of window size.

```json
{
  "capabilities": {
    "mtplx/mtplx-flash-next-optimized-speed": 0.3,
    "mtplx/mtplx-qwen38-27b-optimized-quality": 0.8,
    "opencode-go/deepseek-v4.1-flash": 0.6,
    "opencode-go/qwen3.7-plus": 0.85
  }
}
```

## `policy`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"complexity"` \| `"phase"` \| `"cost"` | `"complexity"` | How the tier is chosen. |
| `threshold` | number 0–1 | `0.5` | Complexity at or above this routes cloud. |
| `reclassify` | `"session"` \| `"turn"` | `"session"` | When to re-evaluate the routing decision. |
| `localBias` | number 0–0.5 | `0` | Added to the cloud threshold to bias toward local. Higher = more local. |
| `subagent` | `SubagentPolicy` | unset | Policy override when running in a subagent (see below). |
| `thinkingLevels` | `ThinkingLevelsPolicy` | unset | Adaptive thinking-level mapping based on complexity score (see below). |
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

### Subagent policy override (`subagent`)

When `cuttle/auto` runs inside a pi-subagents child process, it automatically applies
the `subagent` policy override. Background subagents set `PI_SUBAGENT_CHILD=1` in their
environment; the main agent does not.

A child session is never re-claimed by `autoSelect`: the launcher's model wins. Subagent
children (`PI_SUBAGENT_CHILD=1`) and any session with a `parentSession` header — foreground
children and forks — keep the model chosen for them, so pinning a physical model per agent
does not trip pi-subagents' model verification (#95). Children still route when launched
with a `cuttle/*` model.

```json
"policy": {
  "mode": "complexity",
  "threshold": 0.5,
  "subagent": {
    "mode": "cost",
    "threshold": 0.5
  }
}
```

This lets you keep a balanced policy for the main agent while subagents use a cheaper,
local-biased policy. Foreground subagents run inside the parent Pi process and do not
reload ambient extensions, so they use the parent's policy.

### Local bias (`localBias`)

A number 0–0.5 added to the cloud threshold. Higher values make the router prefer local
more strongly. With `localBias: 0.2` and `threshold: 0.5`, the effective cloud bar is 0.7.

```json
"policy": {
  "mode": "complexity",
  "threshold": 0.5,
  "localBias": 0.2
}
```

This is a softer knob than switching to `cost` mode, which raises the bar to `max(threshold, 0.75)`.

### Adaptive thinking levels (`thinkingLevels`)

Maps classifier complexity scores to thinking/reasoning levels. The user's `/thinking`
selection acts as a ceiling — the router may reduce it, never raise it.

```json
"thinkingLevels": {
  "enabled": true,
  "map": [
    { "score": 0.15, "level": "off" },
    { "score": 0.35, "level": "minimal" },
    { "score": 0.55, "level": "low" },
    { "score": 0.75, "level": "medium" }
  ],
  "default": "high",
  "contextThreshold": 0.7
}
```

- `map`: Sorted score thresholds. The first threshold whose `score` exceeds the classifier
  score wins.
- `default`: Level used when score is above all thresholds.
- `contextThreshold` (optional): When context usage exceeds this fraction of the model's
  window, drop thinking by one step to leave room for the answer.

The clamped level is stored in router state and reused for continuations, so a session
does not flip levels mid-turn.

### Virtual model flavors

| Flavor | Behavior |
|---|---|
| `cuttle/auto` | Classifier decides local vs cloud. Main agent default. |
| `cuttle/local` | Always local, smallest model that fits. Never routes to cloud. |
| `cuttle/big-local` | Always local, **largest** model that fits. For orchestration work. Never routes to cloud. |
| `cuttle/orchestrator` | Quality-first. Uses a lower effective cloud threshold so planning/delegation leans toward larger models. |
| `cuttle/fast-local` | Always local, fastest/smallest model. Never routes to cloud. |
| `cuttle/cloud` | Always cloud. |

`cuttle/local`, `cuttle/fast-local`, and `cuttle/big-local` are hard-pinned to local: they
never route to cloud. When local is genuinely unavailable they fail with an actionable error
naming the cause and remedy, rather than silently spilling the turn to cloud.

Direct requests (compaction summaries and extension `streamSimple()` calls) are outside the
local governor and the context guard by design: they are pi's out-of-loop path, have no slot
release hook, and compaction is what reduces context. Their capacity governance is tracked
in [#119](https://github.com/saman-mb/pi-cuttle/issues/119).

### Recommended subagent role mapping

```json
{
  "subagents": {
    "agentOverrides": {
      "architect": { "model": "cuttle/orchestrator" },
      "worker": { "model": "cuttle/big-local" },
      "scout": { "model": "cuttle/fast-local" },
      "oracle": { "model": "cuttle/cloud" },
      "reviewer": { "model": "cuttle/local" }
    }
  }
}
```

## `local`

Cross-process concurrency governance. See [ARCHITECTURE.md](ARCHITECTURE.md) for why this
is filesystem-based.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxConcurrent` | number | `1` | Max concurrent local requests across all pi processes. |
| `maxConcurrentPerModel` | number | `1` | Max concurrent requests per local model. |
| `maxConcurrentByFlavor` | object | unset | Per-virtual-model budgets, e.g. `{ "local": 1, "fast-local": 1 }`. |
| `onFull` | `"spill"` \| `"wait"` | `"spill"` | For flavours that may route cloud (`cuttle/auto`, `cuttle/orchestrator`): route to cloud immediately, or wait for a slot. The always-local flavors (`cuttle/local`, `cuttle/fast-local`, `cuttle/big-local`) never spill; they error when local is unavailable. |
| `waitMs` | number | `20000` | Wait budget when `onFull: "wait"`. On timeout `cuttle/auto` spills to cloud; the always-local flavors error. |
| `slotDir` | string | `~/.pi/agent/pi-cuttle/slots` | Where slot files live. `~` expands. |
| `staleSlotMs` | number | `300000` | A slot older than this is reaped. |
| `providers` | string[] | `["lmstudio", "llama.cpp", "ollama", "mtplx"]` | Provider ids treated as local for retry-to-cloud decisions. |

This cap counts **in-flight turns**, not loaded models. pi-cuttle no longer talks to local
servers directly, so it cannot manage how many models your server keeps resident in memory.
Configure that in the server itself (LM Studio's memory settings, llama.cpp router presets,
etc.).

## `delegation`

What the parent does when a subagent launch would put a child on a cloud model while the session is on
a local-only flavor (`cuttle/local`, `cuttle/fast-local`, `cuttle/big-local`). See
[SUBAGENTS.md](SUBAGENTS.md) for the rule and what it does not cover.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"block"` \| `"warn"` \| `"off"` | `"block"` | `block` refuses the launch before the child starts. `warn` allows it and counts it. `off` does not evaluate the call. |

```json
{ "delegation": { "mode": "warn" } }
```

An unrecognised `mode`, or a `delegation` value that is not an object, resolves to `block`. A typo in
this file must not turn the local-only guarantee off by accident. `/cuttle status` reports how many
launches the guard blocked and how many it allowed, once it has seen one.

## `gates` (phase 2, all off by default)

Optional routing gates asked in the **same single forward pass** as the complexity
question. They are designed to start in shadow mode: they record a verdict but do not
change routing until you have evidence that they agree with live outcomes.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `delegate.enabled` | boolean | `false` | Ask whether this turn should be delegated to a subagent. |
| `delegate.shadow` | boolean | `true` | When true, log only; never act on the delegate verdict. |
| `delegate.threshold` | number 0–1 | `0.7` | Confidence required before the verdict is considered binding. |
| `delegate.choices` | string[] | `["inline", "scout", "worker", "oracle", "driver"]` | Roles the classifier may pick when delegating. |
| `role.enabled` | boolean | `false` | Ask which role this turn should play. |
| `role.shadow` | boolean | `true` | When true, log only. |
| `role.choices` | string[] | `["scout", "worker", "oracle", "driver"]` | Roles the classifier may assign. |
| `judge.enabled` | boolean | `false` | After a subagent or tool returns, ask whether the result satisfied the request. |
| `judge.shadow` | boolean | `true` | When true, log only. |
| `judge.threshold` | number 0–1 | `0.7` | Confidence required before the verdict is considered binding. |
| `struggle.enabled` | boolean | `false` | Predict whether the request is likely to cause struggle before any tool errors occur. |
| `struggle.shadow` | boolean | `true` | When true, compare to the existing error-driven escalation rather than triggering it. |
| `struggle.threshold` | number 0–1 | `0.7` | Confidence required before the verdict is considered binding. |

When a gate is enabled, its verdict is appended to the decision reason and written to
`~/.pi/agent/pi-cuttle/shadow.jsonl`. Use `/cuttle shadow-report [days]` to see how often
each gate's prediction agreed with the actual routing outcome. Promote a gate out of
shadow only after its agreement is consistently high.

```json
"gates": {
  "delegate": { "enabled": true, "shadow": true, "choices": ["scout", "worker", "oracle"] },
  "role": { "enabled": true, "shadow": true },
  "judge": { "enabled": true, "shadow": true },
  "struggle": { "enabled": true, "shadow": true }
}
```

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

## `observability`

Send routing decisions to an observability backend. Only LangFuse is supported today.
Traces are written best-effort and never block a turn.

Set up LangFuse locally with `npm run langfuse:up` (see `docs/LANGFUSE.md`), then add
its credentials to your user config:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Emit routing traces. |
| `provider` | string | `"langfuse"` | Backend type; only `"langfuse"` supported. |
| `baseUrl` | string | `"http://localhost:3000"` | LangFuse API base URL. |
| `publicKey` | string | — | LangFuse project public key. |
| `secretKey` | string | — | LangFuse project secret key. |

```json
"observability": {
  "enabled": true,
  "provider": "langfuse",
  "baseUrl": "http://localhost:3000",
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-..."
}
```

Each routing decision creates a LangFuse trace containing the chosen tier, model,
flavor, complexity score, thinking level, and whether a subagent policy override
was active. Annotate misroutes in the LangFuse UI; they can be exported back into
the eval corpus (see `docs/EVAL.md` and #90).

## Precedence summary

```
project .pi/pi-cuttle.json
  > user ~/.pi/agent/pi-cuttle.json
    > built-in DEFAULTS
```

`/cuttle status` prints the contributing files and any warnings.
