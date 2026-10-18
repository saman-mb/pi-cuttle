# CI

pi-cuttle runs two kinds of validation in CI. They have different requirements and
different trust levels — keeping them separate is deliberate (see #84).

## Workflows

| Workflow | File | Runner | What it runs |
|---|---|---|---|
| **CI** | `.github/workflows/ci.yml` | `ubuntu-latest` | `npm test`, `npm run typecheck` |
| **Eval** | `.github/workflows/eval.yml` | `ubuntu-latest` | `npm run eval:promptfoo` (routing-policy layer) |
| **Publish** | `.github/workflows/publish.yml` | `ubuntu-latest` | npm publish on release |

Both the CI and Eval workflows trigger on push to `main` and on every pull request.

## The two eval layers

### Layer 1 — routing policy (hosted, every PR)

Exercises the router's deterministic machinery — policy, thresholds, thinking-level
clamping, subagent override, flavor selection, gates, `/cuttle why` — through a mocked
model registry (`eval/pi-cuttle-provider.ts`).

- **Needs no model server.** It passes with nothing listening on any port (~1.5 s for 56 fixtures).
- Runs on GitHub-hosted runners. No infrastructure to register.
- This is the per-PR gate.

### Layer 2 — decision model (self-hosted, not per PR)

Scores the **real classifier** against `eval/corpus.jsonl` and reports accuracy plus the
confusion matrix.

- **Needs a reachable classifier host** — LM Studio, llama.cpp, or ollama with a decision
  model loaded.
- Runs on a **self-hosted runner**, because GitHub-hosted runners cannot reach a local model.
- **Not implemented yet** — tracked in #97. The self-hosted runner itself is tracked in #84.
- Not run on every PR: a live model is nondeterministic, and blocking every PR on it turns
  CI into flake. See the determinism requirements in #97.

> **Do not put `runs-on: self-hosted` in a workflow before a runner is registered.** With no
> runner online the job queues indefinitely and every PR check hangs in "pending" — worse
> than no check at all. Verify with:
>
> ```bash
> gh api repos/saman-mb/pi-cuttle/actions/runners --jq '.total_count'
> ```

## Self-hosted runner setup (Layer 2)

Only needed once #97 lands. On the machine that can reach the classifier host:

```bash
mkdir actions-runner && cd actions-runner
curl -o actions-runner-osx-arm64.tar.gz -L \
  https://github.com/actions/runner/releases/latest/download/actions-runner-osx-arm64.tar.gz
tar xzf ./actions-runner-osx-arm64.tar.gz
./config.sh --url https://github.com/saman-mb/pi-cuttle --token <TOKEN>
./svc.sh install && ./svc.sh start
```

Get `<TOKEN>` from **Settings → Actions → Runners → New self-hosted runner** (requires repo admin).
The runner must have Node.js ≥ 22.6 and network access to the classifier host.

## Accuracy gate

`eval/run.ts` exports `ACCURACY_FLOOR` (currently `0.8`) and exits non-zero below it. The
floor is applied to `eval/corpus.jsonl`.

Because the corpus is what the heuristic was tuned against, this floor catches
**regressions**, not generalisation. #98 adds a holdout set so the number means more.

## Adding a fixture

Add it to `eval/promptfoo.yaml` under a commented section, run `npm run eval:promptfoo`,
and commit only when all fixtures pass. See `docs/EVAL.md` for the fixture format.
