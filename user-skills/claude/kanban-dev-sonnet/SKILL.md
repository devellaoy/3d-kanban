---
name: kanban-dev-sonnet
description: Enforces that non-trivial implementation work is planned and executed by a task-specific agent team that always includes a devil's advocate with a fixed output contract, two review checkpoints (plan and result), a decision log, and a hard round limit. Fixes the model per role (devil's advocate and visual/UI work on the main session model, implementers on the latest Sonnet) and requires the main session to delegate the substance of the change to an implementer. Use this skill whenever you are in plan mode, and whenever you are about to implement, build, refactor, migrate, or design something that touches multiple files or systems, involves real design decisions, or would be costly to unwind if an early assumption is wrong. Trigger it even if the user does not mention an "agent team", "devil's advocate", "review", "pre-mortem", or which model to use — any medium-or-larger implementation task should go through this skill.
---

# kanban-dev-sonnet

Meaningful implementation work is never carried by a single, unchallenged line of reasoning. It is carried by an **agent team** designed for the task, in which exactly one member is a **devil's advocate (DA)** whose job is to break the result before it is declared done — and, when the user has asked for a plan, to break the plan before it is executed. The DA is a mechanism, not a ceremony: it has a required output format, it runs at fixed checkpoints, its findings are logged with a decision, and it has a round limit so it cannot stall the work.

**The user decides whether a plan is made.** This skill never forces a planning step. A plan — and the DA's review of it — happens only when the user asks for a plan or the session is in plan mode. Otherwise the work goes straight to implementation, and the DA reviews the result.

## 1. Sizing — decide whether the team is needed

Use the same rule in plan mode and outside it.

**Use the team** when one or more hold:
- Touches multiple files, components, or systems.
- Involves a design or architecture decision, not just a mechanical edit.
- Would take more than a few discrete steps.
- A wrong early assumption would be costly to unwind.
- The user is asking to build, implement, refactor, migrate, or design something substantial.

**Skip the team** for quick one-offs: a single small edit, a rename, a lookup, a short answer, a tiny snippet. In plan mode a trivial plan still gets a two-line DA check (see §5 "Light mode") rather than the full process.

When genuinely unsure, use the team in light mode.

## 2. Team design — derive it from the task

There is no fixed roster. For every task, choose the smallest set of roles that covers it well:
- A focused task: one implementer + DA.
- A broad task: a few specialised implementers (e.g. backend, frontend, data, tests) + DA.
- A task with a visual/UI part: split it so the UI work is its own member (see §3).
- Never add a role that does not clearly earn its place.

Three invariants:
- The team is always composed by you, from this task — never a copied default.
- Exactly one member is the DA, kept as a distinct perspective and never merged into another role.
- **No nested teams.** Only the main session runs this skill. Subagents — implementers, UI member, DA, researchers — do not invoke `kanban-dev`, do not form their own agent team, and do not spawn their own devil's advocate. Every brief states this explicitly: *"Do not use the kanban-dev skill and do not form a sub-team; do the work described here directly."* If a member finds its task is bigger than briefed, it reports back rather than delegating further.

**Independence matters more than headcount.** The DA gets *only the task statement and the plan or result* — not the reasoning that produced them, and not the session's working context. A DA that reads the author's justification anchors on it. Concretely: spawn the DA as a fresh subagent with a self-contained brief; do **not** use `subagent_type: "fork"` for the DA. If subagents are not available, simulate: write the plan or result, then do the DA pass in a clearly labelled block, deliberately using the pre-mortem frame in §4 rather than "any concerns?".

## 3. Model selection — fixed by role

The model of each member is decided by the role, never by how hard the task looks.

- **Devil's advocate → the main session's model.** Leave the `model` override out so the subagent inherits the session model. The critique must carry the same reasoning strength as the session that produced the plan — never a cheaper model. (Inherit the *model*, not the context: no `fork`, see §2.)
- **Visual / UI work → the main session's model.** Leave the `model` override out. Layout, spacing, typography, colour, responsive behaviour, visual states and "does this look right" judgement need the stronger model. If a task has both UI and non-UI work, split it so the UI part is its own member on the main model.
- **Implementers → the latest Sonnet** (`model: "sonnet"`). Every member that writes code or edits files, whatever its speciality is called.
- **Other non-implementing roles** (research, exploration, verification) → the latest Sonnet, unless the role is the DA or UI work.

"UI work" means the result's look or feel: styles, layout, markup that carries the layout, component appearance, visual states. Wiring a button to an existing handler, renaming a prop or moving a file is ordinary implementation → Sonnet.

## 4. The devil's advocate — output contract

The DA always uses the **pre-mortem** frame: *"Assume this shipped and failed. What was the cause?"* Then it produces exactly this structure. Every field is mandatory; "none" is acceptable only with a one-line reason.

```
DA REVIEW — <plan | result> — round <n>

1. Top risks (max 3, ranked)
   R1: <risk> — why it fails, how likely, how costly
   R2: ...
   R3: ...

2. Alternative approach (exactly one)
   <approach> — what it trades off vs. the current plan

3. Cheapest disproof
   <the smallest test, check, or experiment that would show the plan/result is wrong>

4. Project specifics not accounted for
   <build, deploy, data, users, conventions, existing code — things this project has that the plan ignores; dig them out of the repo/conversation, don't assume>

5. Verdict: PROCEED | PROCEED WITH CHANGES | STOP
   <one sentence>
```

Depth scales with risk: in light mode each field is one line; in full mode the DA may write more, but never exceeds one screen per round.

At the **result** checkpoint the DA is encouraged to make field 3 empirical: write the failing test, the reproduction command, or the input that breaks it, and actually run it if tools allow. An empirical finding outranks an opinion.

## 5. Process — checkpoints, logged decisions, round limit

Two checkpoints exist. **Checkpoint A runs only when the user asked for a plan or the session is in plan mode.** Checkpoint B always runs for a team-sized task.

| Situation | Checkpoints |
|---|---|
| Plan mode, or user asked for a plan | A (plan) → user approves → implement → B (result) |
| Not in plan mode, no plan requested | implement → B (result) |

Outside plan mode the main session still writes briefs for the implementers — that is delegation, not a plan, and gets no DA review. Do not draft a plan document, and do not run a plan review, that the user didn't ask for.

### Checkpoint A — plan review (only when a plan was requested)

1. The main session (or a planning implementer) drafts the plan.
2. DA delivers a `DA REVIEW — plan — round 1`.
3. The plan author responds to **every** item with a decision log entry (see below).
4. If the verdict was STOP or an R1/R2 risk is unresolved, DA may do **one** more round (round 2). That is the limit.
5. If after round 2 a STOP-level finding still stands, do not proceed: surface it to the user with the DA's finding and the author's counter-argument, and ask how to proceed.

### Checkpoint B — result review (after implementation, before declaring done)

1. DA reviews the actual diff / output, not the plan, using the same contract.
2. The main session logs decisions for every item and routes accepted fixes to the right member (implementer for substance, itself for glue — see §6).
3. Same limit: max 2 rounds. Unresolved STOP → surface to the user.

### Decision log

Every DA item gets exactly one line:

```
DECISIONS
R1: ACCEPTED — <what changed>
R2: REJECTED — <one-sentence reason>
Alt: REJECTED — <reason>  |  ACCEPTED — <how the plan changed>
Disproof: RAN — <outcome>  |  NOT RUN — <reason>
Specifics: <addressed how>
```

The log is not optional and is not private: it goes into the plan (Checkpoint A) and into the final summary (Checkpoint B). A rejected item with no reason counts as unresolved.

### Light mode

For small-but-not-trivial tasks (and for trivial plans in plan mode): one DA round per active checkpoint, each field a single line, decision log in a single line per item. Total DA overhead should be under ~150 words. Model rules in §3 still apply.

## 6. The main session delegates the substance — but may still touch the code

Whenever the team is in play, the **substance of the change** — the actual feature, fix or refactor — is delegated to an implementer. "I could do it faster myself" is not a reason to keep it; the default is to delegate.

The main session's own job is everything around the change:
- designing the team and writing self-contained briefs for each member,
- reading and searching to prepare those briefs,
- running the DA at both checkpoints and maintaining the decision log,
- integrating the implementers' work, verifying the result, and reporting.

The main session may edit directly when it is plainly cheaper than briefing an agent:
- a one-line fix, a typo, a rename, an import, a version bump,
- integration glue when merging two implementers' work,
- a small, obvious, local correction found while verifying or accepted from the DA,
- its own briefing artefacts (notes, plan files, scratch scripts).

The line is **substance, not size in lines**: if the edit needs its own reasoning about how to solve the problem, it belongs to an implementer. If it is a mechanical follow-through of work already reasoned about, the main session can do it. On a coin flip, delegate.

## 7. Plan mode — what the plan must contain

This section applies only in plan mode or when the user explicitly asked for a plan. Do not execute anything in plan mode. The plan is produced through Checkpoint A, and it must end with a short **Team** section instead of a boilerplate line:

```
## Team
Roles: <e.g. backend implementer (sonnet), UI implementer (main model), devil's advocate (main model)>
DA plan review — top findings:
  R1: <finding> → <what changed / why rejected>
  R2: ...
Alternative considered: <one line>
Execution: same team; substance delegated to implementers; DA reviews the result before completion.
```

Write the section in the language of the plan (Finnish or English). Its purpose is to let whoever approves the plan see that a real challenge happened and what it changed.

## 8. Seeing the UI — one browser owner, hard timeout

Verifying a web UI visually (dev server, screenshots, mobile emulation, before/after
comparisons) is **not** part of this skill. The separate **`kanban-ui-screenshots`** skill
owns that and ships the browser automation script. Never build your own browser driver.

**Exactly one member per task owns the browser.** If the team has a UI member, it is the owner;
otherwise the main session is. Nobody else starts a dev server or runs the screenshot script:
- Implementers, researchers and the DA get this line in their brief: *"Do not use the
  kanban-ui-screenshots skill and do not start a dev server."*
- The DA at Checkpoint B receives the owner's screenshots and `--measure` output as part of its
  brief instead of capturing its own.
- If the main session also needs the server while a UI member owns it, the main session assigns
  port offsets (`KANBAN_PORT_BASE + n`) in the brief so they don't collide.

**The owner's brief has a mandatory field:** `UI verification: capture-only | functional
(user asked: "<quote>")`. A missing field means capture-only. Functional UI testing (assertion
flows) is never inferred from "make sure it works" in a brief — only from the user's own
explicit request, quoted through.

**Five-minute server timeout.** If the dev server has not responded within 5 minutes of
starting it (install, build and boot included), stop trying: kill the process, report *what*
was attempted and *why* it failed (last error lines), and continue with code-based verification
— type checks, lint, unit/component tests, reading the rendered markup/CSS. State clearly in the
final report that visual verification was not done. Do not spend the rest of the task budget
debugging the dev environment unless the user asks you to.

## 9. Quick decision summary

- **Trivial task, not in plan mode** → the main session just does it.
- **Trivial plan, in plan mode** → light-mode DA + Team section.
- **Medium or larger, plan mode or plan requested** → design the team; Checkpoint A (plan) → user approves → implementers build, main session integrates → Checkpoint B (result).
- **Medium or larger, no plan requested** → design the team; implementers build, main session integrates → Checkpoint B (result). No plan document, no plan review.
- Decision log at every active checkpoint; max 2 DA rounds per checkpoint; unresolved STOP goes to the user.
- **Which model?** → DA and UI work = main session's model (no `model` override, no `fork` for the DA). Everyone else = `model: "sonnet"`.
- **Who edits?** → Substance goes to an implementer; the main session does glue and obvious small fixes only.
- **DA output** → always the contract in §4, never a free-form "some concerns".
- **Nesting** → subagents never run kanban-dev or form their own team.
- **Browser** → one owner per task (UI member, else main session); capture-only unless the user explicitly asked for functional tests; server not up in 5 min → report and fall back to code-based verification.