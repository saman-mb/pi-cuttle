# pi-cuttle — user guide

This document walks through what the decision model does once `pi-cuttle` is installed,
how to turn it on, and how to read what it decided.

## What the decision model does

Once routing is enabled, every time pi is about to generate an assistant response it
asks the decision model **one question in a single forward pass** and uses the answer
to pick a physical model.

```
user prompt
    │
    ▼
┌─ classifier (pi model registry) ─┐
│  "Is this turn standard or       │
│   complex?" → p(complex) ∈ [0,1] │
└──────────────┬───────────────────┘
               │
        p(complex) < threshold?
         yes /          \ no
           ▼            ▼
        local          cloud
           │            │
           ▼            ▼
     smallest model   cheapest model
     whose context    that fits the
     window ≥ score   score
```

- **The question** is a `choice` between `standard` (mechanical, well-scoped,
  informational) and `complex` (design judgement, cross-cutting change, hard
  debugging).
- **The answer** is `p(complex)` in `[0, 1]`. It is written into the decision reason
  verbatim — you will see `classifier p(complex)=0.86`.
- **The tier** is decided by comparing `p(complex)` to `policy.threshold` (default
  `0.5`). Above → cloud. Below → local.
- **The specific local model** is picked from `catalog.local` by capacity: the router
  reads each candidate's context window from pi's registry and picks the smallest
  model whose capacity is at least the complexity score. If none fits, it picks the
  largest. Use the optional `capabilities` map when context window is a poor proxy
  for ability.
- **The specific cloud model** is picked from `catalog.cloud` by cost: among models
  that fit the score, the cheapest (per pi's registry cost) wins. Catalog order is
  only the final tiebreaker.
- **Classifier failure** is never silent. If the classifier is missing, unavailable,
  or times out, routing falls back to the deterministic regex heuristic and the
  failure text is written into the decision reason, the debug log, and surfaced by
  `/cuttle status`.

### Phase-2 gates (optional, shadow by default)

The same forward pass can ask up to four additional questions:

| Gate | Question | Shadow default |
|---|---|---|
| `delegate` | Should this turn be delegated to a subagent? | `shadow: true` |
| `role` | What role should this turn play? | `shadow: true` |
| `judge` | Did the last subagent/tool result satisfy the request? (only asked when the last message is a tool result) | `shadow: true` |
| `struggle` | Is this request likely to cause the model to struggle? | `shadow: true` |

In shadow mode they are recorded but never change routing. After a few days, run
`/cuttle shadow-report [days]` and promote any gate with high agreement by setting
`shadow: false`. See [`docs/CONFIG.md`](CONFIG.md) for the full schema.

## Enabling routing

```bash
pi install npm:pi-cuttle
```

1. **Configure the local providers through pi** (one time, not through cuttle).
   Inside an interactive pi session, `/login llama.cpp` and enter the router URL.
   Repeat for MTPLX, LM Studio, or any other local server. `pi --list-models` shows
   chat models; decision models like Kev are silently available as classifiers.

2. **Write `~/.pi/agent/pi-cuttle.json`** — or run `/cuttle init` for the wizard.

    ```json
    {
      "autoSelect": true,
      "classifier": {
        "model": "llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0",
        "fallback": "heuristic",
        "timeoutMs": 4000
      },
      "catalog": {
        "local": ["mtplx/mtplx-qwen38-27b-optimized-quality"],
        "cloud": ["opencode-go/deepseek-v4.1-flash"]
      },
      "policy": {
        "mode": "complexity",
        "threshold": 0.5,
        "reclassify": "session"
      }
    }
    ```

    Model refs are whatever pi knows. `pi --list-models` and `pi auth check --provider
    <name>` confirm them; `/cuttle doctor` probes the classifier and catalog live.

3. **Turn it on.** In a pi session, run `/cuttle on`. This sets `autoSelect: true`
   and switches the session to the virtual model `cuttle/auto`. From that point on,
   every user turn is classified and routed.

4. **Turn it off.** `/cuttle off` disables routing and restores the previous model.

## Reading what happened

- **`/cuttle status`** — current config, catalog, last classifier failure (if any),
  warnings, contributing config files.
- **`/cuttle stats [days]`** (default 7) — local share, token split, estimated $ saved
  vs the all-cloud baseline. Missing prices degrade to counts rather than inventing
  numbers.
- **`/cuttle shadow-report [days]`** — agreement statistics for any enabled Phase-2
  gates.
- **`PI_CUTTLE_DEBUG=/path/to/file`** — every routing decision and every classifier
  failure, one line each. This is the only turn-level record that the classifier
  fell back to the heuristic.

## Example log lines

```
factory cwd=/private/tmp autoSelect=true local=mtplx/mtplx-qwen38-27b-optimized-quality cloud=opencode-go/deepseek-v4.1-flash sources=/Users/saman/.pi/agent/pi-cuttle.json warnings=
session_start autoSelect=true explicit=true current=cuttle/auto
route result tier=cloud ref=opencode-go/deepseek-v4.1-flash reasons=classifier p(complex)=0.86
route result tier=local ref=mtplx/mtplx-qwen38-27b-optimized-quality reasons=classifier p(complex)=0.04
route result tier=cloud ref=opencode-go/deepseek-v4.1-flash reasons=classifier p(complex)=0.96 gates=struggle:p=0.81(shadow),judge:p=0.12(shadow)
```

- The first line is the factory boot.
- The second shows `session_start` switched the session to `cuttle/auto`.
- The third and fourth are real routing decisions — high complexity went cloud, low
  complexity went local MTPLX.
- The fifth shows Phase-2 gate verdicts in shadow mode alongside the complexity
  score.

## What does not happen

- No host-specific adapter. pi-cuttle never talks HTTP to LM Studio, llama.cpp,
  MTPLX, or ollama. Those are opaque providers known to pi.
- No loaded-model ceiling. The router caps in-flight turns across all pi processes
  via a filesystem slot broker; your server's own memory settings govern what is
  resident.
- No per-turn re-classification by default. `policy.reclassify: "session"` means the
  first user turn classifies once and the decision sticks for the session. A
  failure-driven escalation or a struggle trigger flips it back to local; a
  failure-driven step-down re-decides on the very next user turn.
- No silent fallback. Classifier failures are visible in the decision reason, the
  debug log, and `/cuttle status`.
