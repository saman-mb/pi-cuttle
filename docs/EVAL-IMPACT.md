# What the Eval Pipeline Gives You

This document summarises the practical benefits of the pi-cuttle eval and observability pipeline that is now operational on `main`.

## As a developer

### 1. Regression-proof routing changes

You can change heuristics, thresholds, or classifier config and immediately know if routing still behaves correctly.

```bash
npm run eval:promptfoo
```

- 56 fixtures covering the routing-policy layer
- Reports `local → cloud` (wasted money) and `cloud → local` (quality risk) misroutes separately

> **What this does and does not cover.** These fixtures exercise the router's *policy*
> machinery (thresholds, clamping, flavors, gates) through a mocked registry. They do
> **not** invoke the decision model, and `eval/corpus.jsonl` scores the heuristic at
> 100% because it was tuned against that corpus. Measuring the real classifier is #97;
> making the number reflect generalisation is #98. See `docs/EVAL.md`.

### 2. Misroutes become reproducible fixtures

When you or a user spots a bad routing decision in LangFuse, you can export it back into the eval corpus instead of filing a vague bug report.

```bash
npm run eval:export-misroutes 7   # last 7 days
npm run eval:convert-misroutes
npm run eval:promptfoo:misroutes
```

Once the new fixture passes, promote it into `eval/promptfoo.yaml` so it is enforced forever.

### 3. Full session visibility

Two complementary traces land in LangFuse for every turn:

| Trace source | What it captures |
|---|---|
| `@langfuse/pi-observability-plugin` | Full pi turn: prompt, response, tool calls, model, tokens, latency |
| `pi-cuttle` | Routing decision: tier, model, flavor, score, thinking level, subagent flag |

Together they let you answer "why did this turn go to that model?" in one view.

### 4. Safe foundation for decision-model work

Tickets #72–78 (confidence scoring, cost prediction, retry strategy, subagent depth, etc.) can now be validated before shipping. Each change is run against the corpus; only changes that pass get merged.

## As a product owner

### 1. Releases are evidence-based

Instead of "we think routing improved", you can say:

> "56/56 eval fixtures pass, including 6 new subagent-policy cases and 4 edge cases."

### 2. Cost and quality risks are measurable

The eval distinguishes two failure modes:

- **Local prompt routed to cloud** → unnecessary spend
- **Cloud prompt routed to local** → quality risk

You can track these over time and prioritise fixes by business impact.

### 3. Continuous improvement is automated

The loop is closed:

```
route → observe in LangFuse → annotate misroutes → export to fixtures → re-evaluate → ship fix
```

Each misroute makes the next version better instead of being forgotten.

### 4. CI-ready quality gate

The routing-policy layer runs on a GitHub-hosted runner on every push and PR
(`.github/workflows/eval.yml`) — no self-hosted runner needed for it:

```bash
npm run typecheck
npm test
npm run eval:promptfoo
```

A PR that regresses the routing *policy* cannot merge green. A PR that regresses the
*decision model* is not caught yet — that is Layer 2 (#97), which needs a self-hosted
runner with a reachable classifier (#84).

## What is live now

| Component | Status | How to use |
|---|---|---|
| Promptfoo fixtures | ✅ 56/56 passing (routing-policy layer) | `npm run eval:promptfoo` |
| Decision-model scoring | 🚧 not implemented | #97 |
| Holdout corpus | 🚧 not implemented | #98 |
| Custom provider | ✅ | `eval/pi-cuttle-provider.ts` |
| LangFuse Docker stack | ✅ running locally | `npm run langfuse:up` |
| pi-cuttle routing traces | ✅ emitting | configured in `~/.pi/agent/pi-cuttle.json` |
| Full pi session traces | ✅ emitting | `@langfuse/pi-observability-plugin` |
| Misroute export | ✅ ready | `npm run eval:export-misroutes` |
| Docs | ✅ | `docs/EVAL.md`, `docs/LANGFUSE.md`, `docs/eval-architecture.md` |

## What is still your task

- **#84 Layer 2 self-hosted runner** — register a runner with a reachable classifier host for the decision-model layer.
- **#97 live decision-model scoring** — implement `--live` so the classifier's accuracy is measured.
- **#98 holdout corpus** — add prompts the heuristic was not tuned on, so accuracy reflects generalisation.

## Quick commands

```bash
# Run eval
npm run eval:promptfoo

# View LangFuse UI
open http://localhost:3000
# Email: admin@example.com
# Password: password

# Export recent misroutes
npm run eval:export-misroutes 7
npm run eval:convert-misroutes
npm run eval:promptfoo:misroutes

# Stop LangFuse
npm run langfuse:down
```

## Dashboards and credentials

- **LangFuse UI:** http://localhost:3000
- **Login:** `admin@example.com` / `password`
- **API keys:** stored in `/Users/saman/dev/pi-model-router/.env` and `~/.pi/agent/langfuse.json`
- **Other services (localhost-only):**
  - PostgreSQL: `5432`
  - ClickHouse: `8123`
  - MinIO API: `9090`
  - Redis: `6379`
