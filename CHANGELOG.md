# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [SemVer](https://semver.org/).

## [0.5.0] — 2026-10-18

### Added

- **`/cuttle config` panel** — a single searchable SettingsList showing all routing knobs at once:
  classifier model (with submenu), policy mode (cycle), `local.maxConcurrent` (submenu), and
  read-only catalog rows that point to `/cuttle models`. Enter cycles values or opens submenus;
  Esc closes without writing. A committed change writes to the user config file and applies from
  the next routing decision — a new session, or the next user turn when `policy.reclassify` is
  `"turn"` (the default is `"session"`, so classify-affecting edits usually land in a new
  session). A turn that already decided keeps its model.
- **Shadow-section detection** — sections present in `<cwd>/.pi/pi-cuttle.json` are shown as
  `SHADOWED: project file` and refuse edits from the panel, directing users to edit the project
  file instead.
- **Non-TUI fallback** — when `ctx.mode !== "tui"` or `ctx.ui.custom()` returns undefined,
  `/cuttle config` prints the same seven values with effective sources, locks, unresolved
  entries, and both config paths. Never claims a headless edit occurred.

### Fixed

- **Subagent runs launched with a pinned physical model no longer fail model verification.**
  `autoSelect` is skipped in subagent child processes (`PI_SUBAGENT_CHILD=1`) and in any
  session with a `parentSession` header (foreground children and forks), so the model chosen
  by the launcher or parent is left alone. Children still route when launched with
  `cuttle/auto`, as `docs/SUBAGENTS.md` documents. Fixes #95.

## [0.4.0] — 2026-10-18

### Added

- **`/cuttle init`** first-run wizard — interactively picks classifier, local, and cloud models
  and writes a working `pi-cuttle.json` (#46).
- **`capabilities`** config map — optional `provider/model -> [0,1]` overrides that replace the
  context-window proxy for "smallest adequate model" selection.
- **Cloud cost ordering** — among cloud models that fit the complexity score, the router now
  picks the cheapest (per pi's registry cost) before falling back to catalog order.
- **Classifier backoff** — after `classifier.backoffAfterFailures` consecutive failures, the
  classifier is skipped for `classifier.backoffMs` and the heuristic is used instead.
- **`local.providers`** config — provider ids treated as local for retry-to-cloud decisions;
  defaults include `lmstudio`, `llama.cpp`, `ollama`, and `mtplx`.
- **`/cuttle stats` registry cost fallback** — cloud spend is priced from pi's model registry
  when `telemetry.pricing` is missing.

### Fixed

- **Local slot leak** — sticky continuations now acquire (or spill) a local slot, matching the
  `message_end` release. Previously local inference ran unguarded after the first turn.
- **Classifier `policy.threshold` ignored** — the classifier path hard-coded `0.5`; it now
  honors the configured threshold.
- **Sticky tier hard-fail** — a local/cloud continuation now falls back to the other tier when
  its catalog becomes unresolvable mid-session instead of throwing.
- **`--model=value` bypass** — auto-select no longer overrides an explicit model pinned with
  the `=` form.
- **Policy edit clobbering** — `/cuttle policy` edits now deep-merge nested `phase` and
  `escalate` subkeys.

## [0.3.1] — 2026-10-18

### Added

- **Phase-2 routing gates** (`delegate`, `role`, `result judge`, `struggle trigger`). Each gate
  is config-gated and starts in shadow mode by default. The classifier asks gate questions in
  the same forward pass as the complexity question, so there is no extra latency per turn.
- **`/cuttle shadow-report [days]`** prints gate agreement statistics from
  `~/.pi/agent/pi-cuttle/shadow.jsonl`, so gates can be promoted out of shadow only after they
  agree with live outcomes.

### Changed

- **The router no longer talks to local servers directly.** Every model and every classifier is
  resolved through pi's model registry (`ctx.modelRegistry`). This removes all host-specific
  code (LM Studio, ollama, OpenAI-compatible adapters) and means pi-cuttle works with any local
  provider pi already supports — llama.cpp router, MTPLX, LM Studio, ollama, vLLM — without
  hard-coding URLs, protocols, or server lifecycles.
- **The config file and state directory are renamed to `pi-cuttle`.** `~/.pi/agent/cuttle.json`
  moves to `~/.pi/agent/pi-cuttle.json` and `~/.pi/agent/cuttle/` moves to
  `~/.pi/agent/pi-cuttle/`. Existing files are migrated automatically on first load.
- **`/cuttle` is now a simple toggle.** `/cuttle on` enables automatic routing, `/cuttle off`
  disables it and restores the previous model. The per-session tier pins
  (`/cuttle local|cloud|auto|fast-local`) are removed; select individual virtual models through
  pi's model picker if you want to override a session.
- **Model selection uses the classifier's complexity score.** Within the chosen tier, the router
  reads each candidate's context window from pi's registry and picks the smallest model that can
  handle the score. This replaces hand-picked tier lists with dynamic, capacity-aware selection.
- **The loaded-model ceiling is removed.** The previous ceiling only worked with LM Studio's
  native API. With the router using pi's registry, the extension no longer has direct visibility
  into what a server keeps loaded. The cross-process concurrency cap (`local.maxConcurrent`) still
  prevents fanout from swamping the server; configure server-side memory limits separately.
- `Decision` now carries an optional `gates` field with normalized verdicts, and the decision
  reason includes a summary when gates are active.

### Fixed

- **Classifier failures are never silent.** The classifier path now always goes through pi's
  registry, and any failure is recorded in the decision reason, the debug log, and `/cuttle status`.

## [0.2.1] — 2026-10-17

### Fixed

- **Installing the extension no longer hijacks every new session** (#67). `autoSelect` defaulted
  to `true`, and because the package is loaded as a personal extension, its `session_start`
  hook switched every session — including subagent children — to `cuttle/auto` even when no
  catalog was configured. The default is now `false` (opt-in), and `session_start` also leaves
  the model alone when `catalog.local` and `catalog.cloud` are both empty.

## [0.2.0] — 2026-10-16

### Changed

- **The package is now `pi-cuttle`** (was `pi-model-router`). Nothing from this repository had
  been published to npm under the old name, so the rename covers every user-facing surface at
  once rather than being a deprecation:
  - the npm package — `npm:pi-model-router` → `npm:pi-cuttle`
  - the config file — `~/.pi/agent/model-router.json` and project `.pi/model-router.json` →
    `cuttle.json`
  - the virtual models — `router/auto`, `router/local`, `router/cloud`, `router/fast-local` →
    `cuttle/…`
  - the command — `/router` → `/cuttle`
  - the one-off flag — `--router-force` → `--cuttle-force`
  - the debug log env var — `PI_MODEL_ROUTER_DEBUG` → `PI_CUTTLE_DEBUG`
  - the runtime state directory — `~/.pi/agent/model-router/` → `~/.pi/agent/cuttle/` (slot
    files and the decision ledger)

  The old config filename is no longer read and the old state directory is not migrated:
  rename an existing `model-router.json` to `cuttle.json`, and update any `router/*` model
  references in `subagents.agentOverrides` or `defaultModel`.
- The README now states the relationship to [Cuttle](https://github.com/saman-mb/cuttle) — this
  extension is standalone and requires no Cuttle or Python install — and `pi.image` is set so
  the package shows the Cuttle mark in the pi package gallery.
- The README no longer offers `pi -e <checkout>` as an alternative to installing without saying
  that an installed copy must be removed first, and no longer repeats pi's `pi -ne` hint for
  that conflict without noting that `-ne` removes local model providers (#60). It also states
  that `/cuttle` commands are terminal-UI only, and names the channels that work headless (#61).
- The README badges are pinned by the suite (#55): `tests.svg` drops its count for "passing"
  (a count went stale twice — 80 on a 109-test suite, 109 on 122), the version badge must match
  `package.json`, and the license badge must match the packaged license. `npm run badges`
  re-renders all three deterministically; `scripts/render-badges.sh` reads the version itself.

### Fixed

- **The decision-model classifier never ran on LM Studio** (#57). `decideTier` detached
  `host.systemOne` from its host, so `this.request` threw on the first call and every turn fell
  back to the regex heuristic — silently, because the fallback is graceful and looks correct.
  Introduced in 52a661b and present in v0.1.0. The method is now bound at the single place it
  is detached, and the regression test uses a class method that reads `this`, which the previous
  arrow-function fakes could never fail.
- **A local model missing from pi's registry was reported as `local full` and quietly billed
  cloud** (#58). A typo in `catalog.local`, an undownloaded model, or a local server that has not
  started all produced the same misleading capacity reason while every turn went to paid cloud.
  The spill reason is now built from what actually happened, naming the offending ref and
  pointing at `catalog.local`.
- **Turns that resolved no model are no longer recorded as cloud spend** (#62). A message pi
  attributes to the virtual provider means routing never resolved a target, but it was written to
  the ledger as a cloud turn — a turn that never happened, counting against the local share and
  the savings figure `/cuttle stats` reports. Slot release is unaffected; only the ledger write is
  skipped.
- **A cold session's first classification no longer times out** (#63). The session-start preload
  loads the warm target alongside the classifier, whose first call then exceeded the default
  budget and silently fell back to the heuristic. A timed-out call is retried once at double the
  budget; `reclassify: session` means that costs at most one wait per session.
- **The preload no longer leaks a model instance per session** (#64). LM Studio creates a new
  instance for every `load` call even when the model is already resident, and the preload calls it
  once per session — so every session added another copy of the local model, and its VRAM. The
  loaded-model ceiling could not see it: it counts distinct keys, not instances, so six instances
  of a 27B model accumulated with `maxLoadedModels` set to 1. A resident model is now left alone.

- **Decision-model classifiers are no longer bypassed silently** (#50). `classifier.stateChars`
  defaults to 16000, but a decision model answers in a single forward pass and LM Studio
  evaluates the whole prompt in one physical batch (512 tokens by default, not settable over
  REST). Anything longer was rejected, and the turn fell back to the regex heuristic without a
  signal. The decision path now trims its state to the model's real batch capacity, retries once
  at half size if the model rejects the prompt, logs trims and failures, and reports the
  effective capacity in `/cuttle doctor`. The `stateChars` default is unchanged: chat and cloud
  classifiers have no single-pass batch limit.
- **The documented classifier examples point at a model that loads** (#51). `decision-2.0-kai-0.6b`
  fails to load on current LM Studio and `openjev-2b` does not exist; README, `docs/CONFIG.md`
  and the example config now use `lmstudio/vllm-d3-nano`, and both docs state the id must be a
  `key` from `GET /api/v1/models` and that `/cuttle doctor` verifies it.
- `/cuttle status` now prints the most recent classifier failure (turn, model, error
  text) and omits the line when the last classification succeeded, so a router running
  on the heuristic fallback no longer looks like it classified successfully (#53).

### Added

- `PI_CUTTLE_DEBUG` is now documented. Set it to a file path to log routing decisions and
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
- **Decision telemetry and `/cuttle stats`** — one JSONL line per turn (metadata only)
  and a savings receipt against an all-cloud baseline (#42).
- **Routing evaluation harness** — `eval/corpus.jsonl` (112 labeled prompts),
  `npm run eval`, a CI accuracy floor, and recorded baseline numbers (#43).
- **Cold-start work** — local model and classifier preloaded at session start,
  classifier pinned against loaded-ceiling eviction (#44).
- **Graceful catalog fallback** — ordered candidates are actually tried; a broken cloud
  catalog falls back to local instead of failing the turn (#45).
- **`/cuttle init`** first-run wizard — probes hosts, lists their models, writes a
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

[Unreleased]: https://github.com/saman-mb/pi-cuttle/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/saman-mb/pi-cuttle/releases/tag/v0.5.0
[0.4.0]: https://github.com/saman-mb/pi-cuttle/releases/tag/v0.4.0
[0.3.1]: https://github.com/saman-mb/pi-cuttle/releases/tag/v0.3.1
[0.2.1]: https://github.com/saman-mb/pi-cuttle/releases/tag/v0.2.1
[0.2.0]: https://github.com/saman-mb/pi-cuttle/releases/tag/v0.2.0
[0.1.0]: https://github.com/saman-mb/pi-cuttle/releases/tag/v0.1.0
