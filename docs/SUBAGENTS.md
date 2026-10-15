# Subagents

## The problem

`pi-subagents` runs children as pi sessions. A child routes through `router/*` only if the
router's virtual models are registered in the child's session. There are three loading paths,
and only one is reliable (verified on pi 1.2.0 + the installed `pi-subagents`):

| Child type | Ambient extensions loaded? | Virtual models resolve? |
|---|---|---|
| Foreground, no `subagentOnlyExtensions` | No | **No** — falls through to an unrelated provider |
| Foreground, with `subagentOnlyExtensions` | Yes (explicitly listed) | **Yes** |
| Background | Yes (detached runner) | Yes |

`pi-subagents` has code that copies `pendingVirtualModelRegistrations` into the child, but by
the time a child launches, an ambient extension's registrations have already been flushed into
the parent's model runtime — the queue the child reads is empty. Do not rely on it.

## The fix

**Install the router as a pi package so the parent has it too.** pi-subagents resolves the
child's model against the **parent's** registry at launch preflight; if the router is only in
`subagentOnlyExtensions` (children-only), the parent cannot resolve `router/auto` and the launch
fails with `Unknown subagent model 'router/auto' in the active Pi model registry`.

```bash
pi install git:github.com/saman-mb/pi-model-router
```

Then add the router to `subagents.defaultSubagentOnlyExtensions` so every child loads it and
its `session_start` handler selects `router/auto`:

```json
{
  "subagents": {
    "defaultModel": "router/auto",
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/pi-model-router/src/index.ts"]
  }
}
```

Use the absolute path. `~` is expanded by pi, but explicit paths avoid ambiguity.

## Per-role policies

Each virtual model is a policy. Map roles to them with pi's native model config; the router
code does not need to know about roles:

| Virtual model | Behaviour |
|---|---|
| `router/auto` | Classifier decides per session |
| `router/local` | Local-preferred; spills to cloud when saturated |
| `router/cloud` | Always cloud |
| `router/fast-local` | Local, smallest model first |

```json
{
  "subagents": {
    "agentOverrides": {
      "scout":    { "model": "router/fast-local" },
      "worker":   { "model": "router/cloud" },
      "oracle":   { "model": "router/cloud" },
      "reviewer": { "model": "router/cloud" }
    }
  }
}
```

Per-run override still works: `subagent({ agent: "scout", model: "router/local" })`.

## Memory safety with fanout

Children run in separate processes, so the local cap is enforced on the filesystem
(`local.slotDir`), not in memory. With `local.maxConcurrent: 1`, a fanout of N children allows
one local request at a time; the rest spill to cloud or wait per `local.onFull`.

Set `local.maxConcurrentByFlavor` to bound a policy independently, e.g.
`{ "fast-local": 1, "local": 1 }`.

## Diagnostics

```
/router          # slots used, models loaded in LM Studio, config sources
```

`/subagents-models` shows the resolved role-to-model mapping on the pi-subagents side.
