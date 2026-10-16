# Routing baseline

`eval/corpus.jsonl` is ground truth for one question: **which tier should serve this
work?** Scores are `node --experimental-strip-types eval/run.ts`.

| Heuristic | Accuracy | local -> cloud | cloud -> local | Date |
|---|---|---|---|---|
| Two regexes + length (original) | **70.5%** | 0 | 33 | 2026-10-16 |
| Signal-based (`MECHANICAL_HINTS` / `CLOUD_HINTS`) | **100%** | 0 | 0 | 2026-10-16 |

**Read this honestly:** the improved heuristic was tuned against this corpus, so 100%
is a regression benchmark, not evidence of generalisation to unseen prompts. The CI
floor (`ACCURACY_FLOOR = 0.9`) exists to catch regressions, and the corpus is meant to
grow — add prompts that expose a real misroute (from the telemetry ledger, a bug
report, or your own sessions) before changing heuristics, and record the before/after
here.

The asymmetry that matters: `cloud -> local` risks *quality* (a weak model on a hard
task), `local -> cloud` only risks *money*. Mixed signals lean cloud for that reason.
