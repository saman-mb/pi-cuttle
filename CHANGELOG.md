# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **Decision-model classifiers are no longer bypassed silently** (#50). `classifier.stateChars`
  defaults to 16000, but a decision model answers in a single forward pass and LM Studio
  evaluates the whole prompt in one physical batch (512 tokens by default, not settable over
  REST). Anything longer was rejected, and the turn fell back to the regex heuristic without a
  signal. The decision path now trims its state to the model's real batch capacity, retries once
  at half size if the model rejects the prompt, logs trims and failures, and reports the
  effective capacity in `/router doctor`. The `stateChars` default is unchanged: chat and cloud
  classifiers have no single-pass batch limit.
- **The documented classifier examples point at a model that loads** (#51). `decision-2.0-kai-0.6b`
  fails to load on current LM Studio and `openjev-2b` does not exist; README, `docs/CONFIG.md`
  and the example config now use `lmstudio/vllm-d3-nano`, and both docs state the id must be a
  `key` from `GET /api/v1/models` and that `/router doctor` verifies it.

### Added

- `PI_MODEL_ROUTER_DEBUG` is now documented. Set it to a file path to log routing decisions and
  any classifier trim or failure; it is the only turn-level record that the classifier fell back.

## [0.1.0] — 2026-10-16

First tagged release. The router works end to end on LM Studio, with ollama and any
OpenAI-compatible host behind the same abstraction.

### Added

- **Plugglable local hosts** — `LocalHost` abstraction with capability flags and three
  adapters: LM Studio (native management API + System One decision models), ollama
  (`/api/ps`, `keep_alive` load/unload), and any OpenAI-compatible server (llama.cpp,
  vLLM) at the capability floor. The governor degrades explicitly per capability (#31–#35).
- **Struggle-based escalation** — a locally-routed session that starts flailing (error
  tool results, errored turns) moves to cloud mid-turn and steps back down after clean
  user turns. "Cheap without sacrificing accuracy" as structure, not a promise (#41).
- **Decision telemetry and `/router stats`** — one JSONL line per turn (metadata only)
  and a savings receipt against an all-cloud baseline (#42).
- **Routing evaluation harness** — `eval/corpus.jsonl` (112 labeled prompts),
  `npm run eval`, a CI accuracy floor, and recorded baseline numbers (#43).
- **Cold-start work** — local model and classifier preloaded at session start,
  classifier pinned against loaded-ceiling eviction (#44).
- **Graceful catalog fallback** — ordered candidates are actually tried; a broken cloud
  catalog falls back to local instead of failing the turn (#45).
- **`/router init`** first-run wizard — probes hosts, lists their models, writes a
  working config (#46).
- **CI** — tests and typecheck on every push and PR; typecheck now passes on a fresh
  clone via pinned pi devDependencies (#40).
- Per-host capability matrix and escalation/telemetry documentation in
  [docs/CONFIG.md](docs/CONFIG.md) and [README](README.md).

### Fixed

- Phase policy was dead: nothing ever set `phase: "implementation"`, so `policy.mode:
  "phase"` silently routed everything to the plan tier. Planning now ends at the first
  file-mutating tool call (#36).
- One transient local failure pinned a session to cloud prices forever; failure-driven
  escalations now re-decide on the next user turn (#37).
- Governor slots leaked for non-LM-Studio local providers and when target resolution
  threw after a slot was acquired (#38, #39).
- `RouterRuntime` declared no `log` member while using it — latent typecheck failure
  that surfaced on first real typecheck run (#40).
- The heuristic scored 70.5% on the routing corpus (33 cloud prompts misrouted to
  local); rewritten as signal-based scoring, measured at 100% on the corpus (#43).

[0.1.0]: https://github.com/saman-mb/pi-model-router/releases/tag/v0.1.0
