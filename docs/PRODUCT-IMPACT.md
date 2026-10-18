# pi-cuttle routing enhancements: product impact

This document describes what pi-cuttle users get from the routing, subagent, and
reasoning-level enhancements shipped in 0.5.0.

## Elevator pitch

pi-cuttle now routes like a smart engineering manager: it puts the right brain on
the right task, saves money on subagents, and adapts reasoning effort to the work.
The main agent orchestrates with quality; subagents execute on your hardware.

## User outcomes

### 1. Subagents stop quietly burning cloud tokens

**Before:** A `/ship-issue` or background worker subagent could route to a cloud
model even when a large local model could handle it.

**After:** Background subagents automatically use a local-first policy. They only
go to cloud when the task is genuinely beyond your local hardware.

**Result:** Lower cloud bills, more GPU utilization, faster subagent fan-out.

### 2. The main agent gets the quality headroom it needs

**Before:** The main agent used the same routing logic as subagents, so complex
orchestration work could land on a small local model.

**After:** The main session uses a balanced, quality-aware policy by default.
Planning, architecture, and delegation lean toward larger local or cloud models.

**Result:** Better plans, fewer "this model is too small for this task" moments.

### 3. Reasoning effort scales automatically

**Before:** Whatever `/thinking` level you set applied to every turn. A `high`
setting made even trivial turns slow and expensive.

**After:** pi-cuttle maps task complexity to thinking level. Low-risk prompts use
minimal/no reasoning; hard prompts use the level you selected.

**Result:** Faster responses on simple tasks, preserved quality on hard ones.

### 4. Transparency into why a model was chosen

**Before:** When Cuttle picked a model, you had to read a debug log to understand
why.

**After:** `/cuttle why` shows the exact reasoning: classifier score, subagent
context, applied policy, selected model, and thinking level.

**Result:** Trust and faster debugging when a routing choice looks wrong.

### 5. Role-based model assignment works out of the box

**Before:** You had to guess which Cuttle flavor to assign to which subagent role.

**After:** Documented recommended mappings ship with the release:

| Role | Recommended flavor |
|---|---|
| `architect` | `cuttle/orchestrator` |
| `worker` | `cuttle/big-local` |
| `scout` | `cuttle/fast-local` |
| `oracle` | `cuttle/cloud` |

**Result:** Sensible defaults, less config tuning.

### 6. Already-loaded local models are preferred

**Before:** Cuttle could ask LM Studio for an unloaded model, causing a GPU load
delay mid-turn.

**After:** Models already resident in LM Studio memory are preferred.

**Result:** Snappier first-token latency, especially during subagent fan-out.

### 7. Cloud spend is capped per session

**Before:** A long session with many cloud turns could run up an unexpected bill.

**After:** A soft `sessionCloudBudget` gradually biases routing toward local as
spend approaches the cap.

**Result:** Cost predictability without hard cutoffs.

## Target users

| User | Benefit |
|---|---|
| Solo developers with a fast Mac/GPU | Use their hardware instead of paying cloud providers |
| Teams with cloud API keys | Cut token spend on mechanical subagent work |
| Power users running `pi-subagents` | Better role-aware routing with less manual tuning |
| Anyone using reasoning models | Automatic thinking-level optimization |

## Success metrics

- **Cloud share:** % of subagent turns routed to cloud drops for typical tasks.
- **Local utilization:** LM Studio / MTPLX load increases.
- **User steering:** Fewer manual model switches after routing decisions.
- **Cost per session:** Cloud spend decreases for equivalent output.
- **Failure rate:** No increase in task failures due to under-powered local routing.

## In one sentence

pi-cuttle becomes an intelligent load-balancer between your hardware and cloud
providers, cutting costs on subagents while keeping the main agent sharp.
