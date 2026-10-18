# Subagents

## The problem

`pi-subagents` runs children as pi sessions. A child routes through `cuttle/*` only if the
router's virtual models are registered in the child's session. There are three loading paths
(verified on pi 1.2.0 + the installed `pi-subagents`; the foreground-without-config row was
re-verified end-to-end on pi-subagents 0.79.1 after #131):

| Child type | Ambient extensions loaded? | Virtual models resolve? |
|---|---|---|
| Foreground, no `subagentOnlyExtensions` | No | **Yes** on pi-subagents builds exposing `registerRequiredChildExtensions` (the router registers itself, #131); otherwise **No** — falls through to an unrelated provider |
| Foreground, with `subagentOnlyExtensions` | Yes (explicitly listed) | **Yes** |
| Background | Yes (detached runner) | Yes |

`pi-subagents` has code that copies `pendingVirtualModelRegistrations` into the child, but by
the time a child launches, an ambient extension's registrations have already been flushed into
the parent's model runtime — the queue the child reads is empty. Do not rely on it.

## The fix

**Install the router as a pi package so the parent has it too.** pi-subagents resolves the
child's model against the **parent's** registry at launch preflight; if the router is only in
`subagentOnlyExtensions` (children-only), the parent cannot resolve `cuttle/auto` and the launch
fails with `Unknown subagent model 'cuttle/auto' in the active Pi model registry`.

```bash
pi install git:github.com/saman-mb/pi-cuttle
```

That is the whole setup. Since #131 the router registers **itself** as a required child extension
on `session_start` (`registerRequiredChildExtensions`, using the path pi loaded it from), so every
child loads it with no config. Foreground children stop dying on an inherited `cuttle/local:high`
with `Model "cuttle/local:high" not found`.

That integration is optional and every failure is soft: if `pi-subagents` is absent or its API has
drifted, the router logs to `PI_CUTTLE_DEBUG` and the session still starts. pi-cuttle has no runtime
dependency on pi-subagents.

### Manual fallback

Older `pi-subagents` builds, or a pi that cannot load the extension by path, can list the router
explicitly. This still works and is still honoured — it is simply no longer required:

```json
{
  "subagents": {
    "defaultModel": "cuttle/auto",
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/pi-cuttle/src/index.ts"]
  }
}
```

Use the absolute path. `~` is expanded by pi, but explicit paths avoid ambiguity.

The router never overrides a pinned model in a child: `autoSelect` is skipped in subagent
child processes (`PI_SUBAGENT_CHILD=1`) and in any session with a `parentSession` header
(foreground children and forks). Children route because the launcher chose `cuttle/auto`,
not because `session_start` re-claimed them — so per-agent physical models keep working.

A child that itself delegates registers under its own session id, so a nested subagent gets the
router too; the parent's snapshot is untouched. A second session in the same process is the same:
starting or shutting one down does not drop the other's registration.

One deliberate limit: the registration does not set `requireForAllRunners`, so a child placed on a
remote machine or a non-native runner still surfaces pi's opaque `Model "…" not found` rather than
pi-subagents' clearer "host requires child extensions" diagnostic. Forcing that flag would make such
agents fail to launch at all, which is worse than a confusing message — so the router asks only for
what every local child can honour.

## Per-role policies

Each virtual model is a policy. Map roles to them with pi's native model config; the router
code does not need to know about roles:

| Virtual model | Behaviour |
|---|---|
| `cuttle/auto` | Classifier decides per session |
| `cuttle/local` | Always local; errors when local is unavailable (never spills) |
| `cuttle/cloud` | Always cloud |
| `cuttle/fast-local` | Always local; fastest/smallest model first |
| `cuttle/big-local` | Always local; largest model first |

```json
{
  "subagents": {
    "agentOverrides": {
      "scout":    { "model": "cuttle/fast-local" },
      "worker":   { "model": "cuttle/cloud" },
      "oracle":   { "model": "cuttle/cloud" },
      "reviewer": { "model": "cuttle/cloud" }
    }
  }
}
```

Per-run override still works: `subagent({ agent: "scout", model: "cuttle/local" })`.

## Memory safety with fanout

Children run in separate processes, so the local cap is enforced on the filesystem
(`local.slotDir`), not in memory. With `local.maxConcurrent: 1`, a fanout of N children allows
one local request at a time; the rest wait per `local.onFull` and then error for the
always-local flavors. Only `cuttle/auto` (and other flavours that may route cloud) spill.

Set `local.maxConcurrentByFlavor` to bound a policy independently, e.g.
`{ "fast-local": 1, "local": 1 }`.

## Diagnostics

```
/cuttle          # slots used, models loaded in LM Studio, config sources
```

`/subagents-models` shows the resolved role-to-model mapping on the pi-subagents side.

When observability is enabled, a child that inherits a **non-`cuttle/*`** model is recorded as a
`pi-cuttle child bypass` trace with `routed: false`, `kind`, and the physical `modelId` it landed
on. Such a child never entered the router, so it has no routing trace and would otherwise be
invisible — this is how the fall-through above becomes observable. It is a diagnostic, not an
error: a role deliberately pinned to a cloud model via `agentOverrides` is legitimate and is
recorded, never blocked.

Set `PI_CUTTLE_DEBUG=/path/to/log` to get the same signal as a `child bypass kind=… model=…` line
in the debug log without running LangFuse.

### Auditing real launches

```bash
npm run eval:subagent-audit -- --days 7      # add --json for machine output
```

This reads the `*_meta.json` artifacts pi-subagents writes per run and resolves each run's parent
session to find the model active at launch, then judges the launch against the contract that parent
was under. It classifies every child as `routed`, `bypass-override` (launched on a non-router model
by explicit request), `bypass-inherited` (inherited a non-router model), or `crash` (inherited
`cuttle/*` but never loaded the router — see #131), and exits non-zero when a local-only parent let
a child reach the cloud.

This is the check the offline eval cannot perform: its `subagent-policy` fixtures run `flavor: auto`
on an in-process fake child, so a real launch contract — ambient extensions disabled, a model chosen
by the launcher — never occurs. Run the audit against real history instead.
