# pi-cuttle routing enhancements: product impact

Plain-language description of what the routing, subagent and reasoning-level work in the
0.5.x line actually does for you, and what it does not.

Every claim below was checked against the code on the branch you are reading. Where a
capability exists but is **off until you switch it on**, it says so: a feature you have to
configure is not a feature you have. Where a capability does not exist at all, it is listed
under [Not implemented](#not-implemented--listed-so-nobody-re-ships-it-as-a-claim) rather
than quietly dropped, so the next reader does not rediscover the gap the hard way.

## Elevator pitch

pi-cuttle picks a model per turn instead of per session. It reads the request, judges how
hard it is, and spends either your hardware or a cloud provider's. On a machine with a good
local model, most mechanical turns stay home; the turns that genuinely need a bigger brain
go get one. Subagents and reasoning effort are steerable separately from the main session.

## What you get, and whether it is on

| Capability | State | Turned on by |
|---|---|---|
| Per-turn routing (`cuttle/auto`) | On | Default when you select a `cuttle/*` model |
| `/cuttle why` — explain the last routing choice | On | Default |
| Per-role flavour assignment for subagents | On | pi's `subagents.agentOverrides`, if you set it |
| Child sessions keep the model they were launched with | On | Default |
| Subagent-only routing policy (`policy.subagent`) | **Opt-in** | Unset by default |
| Thinking-level scaling (`policy.thinkingLevels`) | **Opt-in** | `enabled: false` by default |
| Local bias (`policy.localBias`, `policy.mode: "cost"`) | **Opt-in** | Defaults keep the plain complexity bar |
| Per-session cloud spend cap | **Does not exist** | — |
| Prefer models already resident in memory | **Does not exist** | — |

## Outcomes that work on a default install

### Routing decides per turn, not per session

Selecting a `cuttle/*` model routes each turn on its own difficulty. The default policy is
`complexity` with a threshold of `0.5`: a turn scored above the bar goes to a cloud model,
below it stays local. The decision is made once per user turn and held for continuations, so
a session does not change horses mid-task.

**Result:** you stop paying for a top-tier model on turns that never needed one.

### `/cuttle why` tells you what was chosen and why

Run `/cuttle why` after a turn. It prints the flavour, the tier, the resolved model, the
thinking level, the decision source and its score, which signal path produced it, whether the
turn ran in a subagent, and the reason string.

The signal path is shown deliberately: it names what the router was *actually* given, so a
heuristic or pinned decision reads honestly instead of implying the classifier ran.

**Result:** a routing choice that looks wrong is a two-second investigation, not a log dig.

### A subagent keeps the model it was launched with

Child processes launched with a pinned physical model are left alone — `autoSelect` is skipped
for `PI_SUBAGENT_CHILD=1` sessions and for anything carrying a `parentSession` header.
Children launched with a `cuttle/*` flavour still route. This was the fix in 0.5.0 for
subagent runs failing pi's model verification (#95).

**Result:** pinning a model per role in `pi-subagents` config stops breaking at launch.

### Per-role flavours, with a mapping that works today

Assign a Cuttle flavour per subagent role through pi's own `subagents.agentOverrides`
setting; `cuttle/auto` is the global default for anything you do not override. A mapping that
matches how the flavours behave right now:

| Role | Flavour | Why |
|---|---|---|
| `worker` | `cuttle/big-local` | Largest local model that fits; never spends cloud. |
| `scout` | `cuttle/fast-local` | Smallest, fastest local model; never spends cloud. |
| `oracle` | `cuttle/cloud` | Always cloud, for work genuinely beyond local hardware. |
| `reviewer` | `cuttle/local` | Smallest model that can do the job; never spends cloud. |
| `architect` | `cuttle/big-local` **or** `cuttle/cloud` | See the caveat below. |

> **Caveat on `cuttle/orchestrator`.** It is documented elsewhere as "quality-first" and used
> to be recommended for `architect`. It is not: `flavorBias()` forces the `orchestrator`
> flavour to the **local** tier, so a planning agent mapped to it never reaches a cloud model.
> Use `cuttle/big-local` if you want the largest local model, or `cuttle/cloud` if you want a
> guaranteed cloud model, until
> [#122](https://github.com/saman-mb/pi-cuttle/issues/122) settles whether the flavour gets its
> documented behaviour or its documentation gets corrected.

`cuttle/local`, `cuttle/fast-local` and `cuttle/big-local` are hard-pinned local. When local
is genuinely unavailable they fail with an error naming the cause and the remedy rather than
silently spending cloud (0.5.1, #112).

**Result:** role-aware routing without tuning, and no surprises about which roles cost money.

## Outcomes you have to switch on

### Subagents can run a cheaper policy than the main session

`policy.subagent` overrides mode, threshold and the other policy knobs for turns running
inside a pi-subagents child. Background children set `PI_SUBAGENT_CHILD=1`; the main agent
does not, which is how the two are told apart.

**It is unset by default.** Without it, subagents route with your main policy. To get the
local-biased fan-out behaviour, write the block:

```json
"policy": {
  "mode": "complexity",
  "threshold": 0.5,
  "subagent": { "mode": "cost", "threshold": 0.5 }
}
```

`cost` mode raises the cloud bar to at least `0.75`, so a subagent turn has to look genuinely
hard before it leaves your hardware. Foreground subagents run inside the parent pi process and
do not reload ambient extensions, so they use the parent's policy regardless.

**Result:** lower cloud spend on mechanical fan-out — once you configure it.

### Reasoning effort can scale with the task

`policy.thinkingLevels` maps complexity scores onto thinking levels, and the router only ever
*lowers* your `/thinking` selection — it never raises it. The clamped level is held for
continuations, so a session does not oscillate.

**It is off by default** (`enabled: false`). Set `enabled: true` to get it.

**Result:** faster, cheaper answers on trivial turns, at your option.

### Cost levers you can pull today

There is no spend cap, but routing already has two dials that push traffic toward local
hardware: `policy.localBias` (raises the cloud bar by up to 0.5) and `policy.mode: "cost"`
(raises it to at least 0.75). Decision telemetry writes every routing choice, with pricing
where you have configured it, to `~/.pi/agent/pi-cuttle/decisions.jsonl` — that is where a
cloud-share or cost-per-session number would come from.

## Not implemented — listed so nobody re-ships it as a claim

Two capabilities appeared in an earlier draft of this document as though they had shipped.
Neither exists in the code, and neither is on the roadmap by itself:

- **No per-session cloud budget.** There is no `sessionCloudBudget` setting, and no code path
  that tracks cumulative cloud spend or biases routing as a cap approaches. Long sessions are
  not cost-capped. The knobs above are the only cost control.
- **No preference for already-loaded models.** Model selection weighs cost and context-window
  fit. It never asks LM Studio, llama.cpp, Ollama or MTPLX which models are currently resident
  in memory, and it cannot manage how many your server keeps loaded — see the governor notes in
  [CONFIG.md](CONFIG.md). A mid-turn model-load delay is still possible.

If you need either, that is a feature request, not a config mistake.

## Target users

| User | Benefit |
|---|---|
| Solo developers with a fast Mac/GPU | Point mechanical work at hardware already paid for |
| Teams with cloud API keys | Cap and audit what fan-out costs, once configured |
| Power users running `pi-subagents` | Role-aware routing with less manual tuning |
| Anyone using reasoning models | Trim thinking on easy turns, on purpose |

## Success metrics — defined, none measured yet

These are the measurements that would show whether the routing work paid off. **None has been
run.** Treat them as the definition of "we should check", not as results.

- **Cloud share:** share of subagent turns routed to cloud, before and after enabling
  `policy.subagent`.
- **Local utilization:** LM Studio / MTPLX load during fan-out.
- **User steering:** manual model switches after a routing decision.
- **Cost per session:** cloud spend for equivalent output.
- **Failure rate:** task failures caused by under-powered local routing.

The material risk on the last one is real and unmeasured: routing a hard turn to hardware that
cannot do it is a silent quality loss, and nothing yet detects it.

## In one sentence

pi-cuttle moves the choice of model from your session settings to the request in front of it,
and costs less on subagents as soon as you switch the subagent policy on.