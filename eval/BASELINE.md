# Routing baseline

`eval/corpus.jsonl` is ground truth for one question: **which tier should serve this
work?** Scores are `node --experimental-strip-types eval/run.ts`.

| Heuristic | Accuracy | local -> cloud | cloud -> local | Date |
|---|---|---|---|---|
| Two regexes + length (original) | **70.5%** | 0 | 33 | 2026-10-16 |
| Signal-based (`MECHANICAL_HINTS` / `CLOUD_HINTS`) | **100%** | 0 | 0 | 2026-10-16 |

### Decision-model baseline

| Classifier | Model matcher | Accuracy | local -> cloud | cloud -> local | Date |
|---|---|---|---|---|---|
| pi classifier (`llama-cpp-classify`) | `llama.cpp/ggml-org/Kev-9B-GGUF:Q8_0` | **93.8%** (105/112) | 1 | 6 | 2026-10-18 |

The classifier row is measured by `npm run eval --live` (`PI_LIVE_EVAL_BASE_URL=http://127.0.0.1:9931/v1`).
It is **worse than the tuned heuristic on this corpus**, and the misses are concentrated in the
risky direction:

| Missed prompt | Score | Direction |
|---|---|---|
| `audit the extension for security issues before we publish it` | 0.49 | cloud -> local |
| `write a spike to determine whether pi reloads extensions in child processes` | 0.33 | cloud -> local |
| `evaluate whether the heuristic should use embeddings` | 0.32 | cloud -> local |
| `review docs/ARCHITECTURE.md and tell me what's missing or wrong` | 0.24 | cloud -> local |
| `the local model keeps producing invalid JSON, why?` | 0.44 | cloud -> local |
| `is it safe to delete the slot files while pi is running?` | 0.05 | cloud -> local |
| `check whether every error path is covered by a test` | 0.54 | local -> cloud |

**Read this honestly:** the corpus was tuned so the *heuristic* scores 100%, so 93.8% vs 100%
is not a like-for-like generalisation comparison — the corpus is biased toward the heuristic.
What the number does show is that the decision model under-rates judgement work (`cloud->local`,
the quality-risk direction) far more often than it over-rates mechanical work. The model id is
recorded here as the determinism pin; pi's `ClassifierModel` does not expose a weight digest.

**Read this honestly:** the improved heuristic was tuned against this corpus, so 100%
is a regression benchmark, not evidence of generalisation to unseen prompts. The CI
floor (`ACCURACY_FLOOR = 0.8` in `eval/run.ts`) exists to catch regressions, and the
corpus is meant to grow — add prompts that expose a real misroute (from the telemetry
ledger, a bug report, or your own sessions) before changing heuristics, and record the
before/after here. #98 adds a holdout set so the number reflects generalisation rather
than tuning.

`eval/pi-cuttle-provider.ts` runs with `classifier.model: undefined` (the heuristic), so
neither the Layer 1 fixtures nor `npm run eval` exercise the classifier. Layer 2 is available
through `npm run eval --live`; see the measured classifier row above. The standalone eval
resolves the classifier from pi's catalog when possible, and otherwise from
`PI_LIVE_EVAL_BASE_URL` — a `llama.cpp` classifier is registered by a runtime extension that a
standalone script cannot load, even though pi resolves it normally at runtime.

The asymmetry that matters: `cloud -> local` risks *quality* (a weak model on a hard
task), `local -> cloud` only risks *money*. Mixed signals lean cloud for that reason.
