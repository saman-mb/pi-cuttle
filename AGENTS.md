# AGENTS.md

Guidance for agents working in this repository.

## What this is

A pi extension (TypeScript, loaded by pi's own loader) that registers virtual models to
route each turn between local and cloud physical models, with a cross-process memory
governor for local models.

## Commands

```bash
npm install
npm test          # node --experimental-strip-types --test test/*.test.ts
npm run typecheck # tsc --noEmit
```

Type-checking must pass. There is no build step: pi loads `./src/index.ts` directly.

## Architecture

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing routing or governor code.
The invariants there are load-bearing:

- **Decide once per user turn.** Continuations and retries keep the previous model.
- **`route()` must be self-contained.** Never depend on another extension's hooks; foreground
  subagent children do not reload ambient extensions.
- **The governor is filesystem-based.** Async subagent children run in separate processes, so
  an in-memory counter caps nothing.
- **Release is approximate.** Always keep stale-slot reaping correct.

## Conventions

- No runtime dependencies unless unavoidable; the extension runs inside pi's process.
- Talk to LM Studio over plain HTTP (`src/lmstudio.ts`); do not assume pi's provider layer
  is available in a child.
- Every routing decision that reads external state must have a deterministic fallback.
- Tests use `node:test` and must not require a live LM Studio server; inject a fake client.

## Verification discipline

Claims about pi's behaviour must cite a doc path or a source file path in this repo's docs
or PR description. The five open questions in the README are empirical — run them on a real
pi install and record the command and result; do not answer them by reading docs alone.

## Git

Commits: `type(scope): summary` (e.g. `feat(governor): reap stale slots`).
