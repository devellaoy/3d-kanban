# Kanban architecture (fork contract)

Back to the [README](../README.md); the user guide is [kanban.md](kanban.md). This fork of agent-office
adds a task process in the style of ai-kanban (plan → implement → review rounds ⇄ fix → review column →
done), a 2D kanban view, multi-repository projects, per-project issue sources, agent-written pull
requests, multi-PR reviews, editable prompts, skill management, cross-task references and a migration
from ai-kanban.

This document is the **contract** every part of the fork codes against. When the code and this
document disagree, fix one of them in the same change.

## 1. Ground rules

- Upstream: `AgentSystemLabs/agent-office` at `665aeec571bc03f76cbd16de8d628dd169a48874`
  (downloaded as a tarball, not a git clone). See [fork.md](fork.md) for the seams and the sync policy.
- Fork code lives only in:
  - `src/shared/kanban/` — types, WS protocol, move rules, prompt defaults (browser + server).
  - `src/server/kanban/` — database, settings, projects, engine, issues, refs, skills, HTTP/WS glue.
  - `src/client/kanban/` + `src/client/kanban.html` — the kanban page.
  - `bin/office-tasks.js`, `scripts/migrate-ai-kanban/`, `skills/`, `tests/kanban-*.test.ts`, `docs/kanban*.md`.
- Upstream files get only small, listed seams (see fork.md). Never reformat or reorder upstream code.
- Style: upstream's — TypeScript strict, ES modules with `.js` import suffixes, `node:test` tests,
  comments explain *why*, no new UI framework (client uses `h()` / `openModal` from `ui/dom.ts`).
- Server code never trusts the browser: validate every WS message field (types, lengths, enums).
- Secrets (Jira tokens, API keys) never leave the server; the browser only sees `configured: true`.

## 2. Concepts

- **Project = floor.** A floor (`FloorDef` in `floors.json`) is a project. `FloorDef.repos?: ProjectRepo[]`
  lists its repositories. The floor's own `dir`/`repo` is always the **primary** repository
  (the floor's `.agent-office/` data stays there, as upstream). A floor without `repos` is a
  one-repository project exactly as upstream has it. The primary's `remote` is `FloorDef.repo` when the
  floor has one (`validateProjectRepos` refuses another: "The floor's own repository is owner/name; add
  another repository instead, or re-add the floor"; the settings form shows it read-only), else the
  one saved for the primary in `repos`. Kanban code reads the primary's owner/name only through
  `projectRepos` (issue sources, PR bundles and reviews, `pr_links` matching, the prompts' `{{repos}}`,
  the refs bundle), never `FloorDef.repo`; upstream's own uses of `FloorDef.repo` are unchanged.
- **Task** (`KanbanTask`): a unit of work on one project, touching the project's repositories
  (all of them by default, or a chosen subset `repoIds`). Ids are integers (`#123`), global across projects.
- **Run**: one phase execution of a task (`plan`, `implement`, `review`, `fix`, `resume`, `pr`, `pr-fix`,
  `compact`, `pr-review`) with its tool, model, session, worker, outcome and verdict. `pr-review` is a
  review of one or more pull requests together by a reviewer in a worktree of its own (see §4).
- **Task worker**: an ordinary upstream worker (PTY, live terminal at a desk on the project's floor)
  hired by the engine for a task. `WorkerInfo.kanban = { taskId, role: 'implementer' | 'reviewer', … }`, with the
  task's card as it is now (see §4, *Worker summary*).

## 3. Columns and state

`TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'review' | 'done' | 'archived'` (fixed; no custom columns).

- `todo` → start → `in_progress`.
- `in_progress`: the engine is running a phase (`task.phase`, `task.runState`).
- `waiting`: needs the user (plan questions, manual plan approval, agent asked in the terminal,
  stopped, failed, usage-limit wait shown as `retryAt`).
- `review`: automation finished; the user reviews, comments (resumes work), asks for a PR, or moves to done.
- `done`: accepted by the user: a manual move, a task worker sent home with `done: true`, or leave-on-merge
  sending one home once every linked PR has merged (see §4, *Departures*). `archived`: old done tasks (not on the board).
- Moving a task to `done` or `archived` (a move, a departure, the auto-archive) sends its task workers at rest
  home with cleanup `keep` (`engine.releaseIdle`, departure reason `released`). A run still live then (the
  agent asking in its terminal: `waiting`/`agent_asking`, worker `needs_input`, which `isBusy` counts as busy)
  is finished as `stopped` with a status line, and its worker goes home the same way; the task is left with
  `runState: 'idle'`, no worker ids, no `queuedRun` and no waiting reason. A worker that is really working
  can't be there: its task is `in_progress`, which the move rules refuse (`It is running: stop it first`).

Manual moves (`src/shared/kanban/moves.ts`, enforced on the server): `todo ↔ done` is not allowed;
allowed: `todo → in_progress` (= start), `waiting|review → done`, `done → review`, `done → archived`,
`archived → done`, `waiting|review → todo` only when no worker is attached (reset), any → `archived` except running.

## 4. Engine (server/kanban/engine)

- `machine.ts`: pure transition function `next(state, event) → { state, effects[] }`. No I/O. Tested exhaustively.
- `orchestrator.ts`: applies effects: hires/prompts/relaunches/sends home workers via `WorkerManager`,
  writes runs/comments/plans, emits WS deltas.
- `adapters/{claude,codex}.ts` implement `TaskAgentAdapter`:
  - `launchArgs(phase, opts)` — per-phase CLI flags:
    - claude plan: `--permission-mode plan`; implement/fix/resume/pr: `--permission-mode bypassPermissions`
      (the kanban worker's `--settings` file also sets `skipDangerousModePermissionPrompt: true`),
      review and pr-review: `--permission-mode bypassPermissions --disallowedTools Edit Write NotebookEdit`
      (+ `WebFetch WebSearch` when the review sandbox is on; Bash keeps the network, which `gh` needs).
    - codex plan/review: `-s read-only -a never`; implement/fix/resume/pr: `--dangerously-bypass-approvals-and-sandbox`
      (project setting may choose `-s workspace-write -a never` instead); pr-review:
      `-s workspace-write -a never -c sandbox_workspace_write.network_access=true` (read-only has no network for `gh`;
      it writes nowhere but its own throwaway worktree, and the contract forbids even that).
    - An investigation keeps `bypassPermissions` (Codex: the workspace sandbox with the report folder added),
      because it must write its report files; its contract keeps it off the repositories.
    - Models: upstream's spawn only takes a Claude alias, so a full id (`claude-opus-5-5[1m]`) is spawned as its
      alias (`opus`) and passed again as `--model <full id>` after it, which the CLI takes.
  - `readTurnResult(worker)` — the **final answer** of the last turn (`TurnResult.text`), which is all that
    markers, verdicts, comments and summaries are read from; what the agent said on the way isn't part of it:
    - claude: transcript JSONL (`WorkerInfo` tracker transcript path from hooks): the `text` blocks of the
      last assistant message after the last real user message (Claude logs one message's blocks as lines
      sharing `message.id`); and, if the last assistant `tool_use` is `ExitPlanMode`, its `input.plan`.
      A last message that calls any other tool is not a final answer (`complete: false`): the Stop hook
      can come before Claude has logged the reply after that tool's result, so the engine reads the log
      again (`readTries` × `readPauseMs`, about 3 s, so a turn that really ends at a tool call, an
      interrupt say, waits that long and isn't hung). If it never catches up, the answer the Stop hook
      carried (`last_assistant_message`, capped) is the turn's text, alone: never while the log's last
      tool call has no result yet (`toolRunning`), because a Stop then didn't come from Claude (anything
      in the agent's shell has the hook token) and could carry a verdict. Without that answer (an older
      CLI, a run re-attached after a restart) the log's last text goes on, and the office logs a warning.
    - codex: rollout JSONL: the last `event_msg` with `payload.type === 'task_complete'` → `payload.last_agent_message`
      (fallback: last `response_item` assistant message).
- Phase changes that need different launch flags **relaunch** the worker (`--resume <sessionId>` +
  new flags + the phase prompt). Every relaunch passes the task's current model and effort, resolved as at
  hire (`adapter.spawnModel/spawnEffort`), to `WorkerManager.relaunch`, which checks them with upstream's
  `validateWorkerModel/Effort` and sets `info.model/effort` (a `worker.update`). Same flags, the same
  model and effort (`info.model/effort`) and an idle/done worker: the prompt is typed into the PTY
  (upstream `WorkerManager.prompt`); a changed model or effort relaunches even with the same flags. A
  changed tool hires a new worker (the handoff).
- Turn end = the worker goes `done` (Stop hook) or `needs_input`. `needs_input` in the plan phase with
  `ExitPlanMode` pending = the plan is finished. `needs_input` otherwise → task `waiting`
  ("the agent is asking in its terminal"), its run still live.
- **What it waits on** (`Live.asks`, `heardAsk`, in memory only): from the worker's hooks, heard before
  the status they cause. A `PreToolUse` of `AskUserQuestion` (Codex: `request_user_input`) is a
  `question`; a `PermissionRequest` or a `permission_prompt` notification is a `permission`; another
  tool's `PreToolUse`, a `PostToolUse(Failure)`, `UserPromptSubmit`, `SessionStart` or the turn's end
  forget it (unknown; so is every run re-attached after an office restart). The task and its card carry
  it as `askingKind` while `agent_asking` (a `KanbanRepository` in-memory map, never stored).
- **Answering it from the kanban** (`waiting`/`agent_asking`, the live run's worker `needs_input`):
  only a `question` is typed into. `continue(answer)` and `commented()` type the text into that
  worker's PTY (upstream's `WorkerManager.prompt`, which answers a TUI question as a person typing
  does) and keep it as a user comment (`continue` adds it; a comment is already stored); nothing goes
  to `pendingMessages` (a queued answer would wait for a turn end that the question holds up). The
  engine does not apply `working` itself: the task stays `waiting`/`agent_asking` until the worker's
  own hooks move it on (`needs_input` → `working`, the machine's `working`, as when it's answered at
  the terminal), so a question with more to answer keeps it asking. The engine follows the same run on.
  A `permission` (or unknown) is never typed into: pasted text plus Enter would pick the prompt's
  highlighted option ("no" would approve). `continue(answer)` is refused ("The agent is asking for a
  permission in its terminal: answer it there (⌨️ Open its terminal)"; unknown: "The agent is waiting
  on something in its terminal: …") and stores nothing; a comment is kept and queued (`pendingMessages`,
  delivered at the turn's end once the prompt is answered in the terminal), with a status note saying
  so. `continue` without text is refused ("Type your answer, or answer in the terminal"). The task view
  shows the answer box only for `askingKind: 'question'`; otherwise "answer it in its terminal" with
  **⌨️ Open its terminal**.
- Markers (appended by the engine as a non-editable contract block, never user-editable):
  - plan: a line `PLAN READY` → ready; a `QUESTIONS:` heading → questions; Claude's `ExitPlanMode` → ready;
    none of these, but ≥ 2 `?` and no absolute `.md` path → questions (replan); otherwise ready.
  - pr: one `PR: <url>` line per pull request opened or updated; each is linked to the task (`pr_links`).
  - review: read from the final answer's last 3 non-empty lines only: the **last** of them matching
    `^\s*REVIEW:\s*(APPROVED|CHANGES_REQUESTED)\s*$` as a line of its own (emphasis allowed) decides; none →
    changes requested.
  - A review verdict never counts inside a fenced code block (```` ``` ```` / `~~~`, an unclosed one runs to
    the end) or in a `>` quote. Plan markers ignore quotes and *closed* code blocks, but an unclosed fence
    hides nothing after it. `PR:` lines ignore only quotes (an agent may list its PRs in a code block).
- Plan approval: `auto` (ready → implement) or `manual` (ready → `waiting` until the user approves).
- Review: `rounds` (1–10), `reReviewLastFix` (default true). A reviewer is a separate worker (its own tool,
  model, effort) sharing the task's worktree (spawned with `reuse`), sent home with cleanup `keep`.
  Round k: review → APPROVED → `review` column; CHANGES_REQUESTED → fix (task worker) → next round.
  After the last round's fix: re-review if `reReviewLastFix`, else straight to `review`.
  The review contracts (`review`, `prReview`) forbid modifying, creating or deleting files and anything that
  changes the repository or its remote (commit, checkout, switch, reset, stash, push): read, diff, read-only
  commands and a report only.
- Comments on `in_progress|waiting|review` tasks resume work: typed into the live worker when it is idle
  (queued in `pendingMessages` while any run works, a review's included, except an agent asking in its
  terminal, which gets it as its answer: see above), or a new worker is hired with
  `reuse` + `--resume`. Comments queued during a review are delivered to the implementer as a resume turn when
  the review cycle ends (approved, or the rounds used up), before the task moves to `review`; that turn is
  reviewed again when the task has review on.
- Pull-request review (`engine.reviewPrs`, phase `pr-review`): on the request's task when **every** PR is that
  task's (a `pr_links` row of it, or its head branch is the task's branch in that repository), else on a new
  `investigate` task ("PR review: owner/repo#1, …", a common ticket when there is one). A `taskId` whose task
  doesn't own them all is ignored: the new task gets a status line naming the task asked for and the tasks the
  other PRs are linked to (or that they're no task's). The picker (`prpicker.ts`, `reviewTaskOf` in `model.ts`)
  sends `taskId` only when every picked PR is a bundle item of that one task. A reviewer worker (role `reviewer`,
  tool/model/effort from the request or the review settings) is hired fresh in a worktree of its own for the
  repositories involved (never the floor's checkout, never the task's worktree) with the `kanban.pr.review` prompt
  and the `prReview` contract, reading the pull requests with `gh pr view` / `gh pr diff`. A reviewer that finds no
  free desk or the worker limit full (`noRoom`) is queued as any hire is (`runState: 'queued'`, `queuedRun` phase
  `pr-review`; the new task is kept, and `reviewPrs` answers with its `taskId` and no `workerId`); the drain's
  `dequeue` runs `launchPrReview` again with the pull requests of the task's `pr.review` event. Only real refusals
  (validation, a missing base branch, sign-in) fail, and a new task that never got its reviewer is deleted. Its final text is an
  agent `review` comment with the verdict on the run; the reviewer goes home with cleanup `all` (its own worktree
  only) and the task goes to `review`. The request is kept as a `pr.review` task event, so Retry reviews again.
- A worktree that is gone (leave-on-merge sent its worker home, or it was pruned) is never reused: before a run
  the engine checks the workspace folders, drops the workspace and its sessions (never `task.branch`) and hires a
  fresh worktree, whose agent gets `kanban.checkout` (check out the task's existing branch in every repository)
  with the handoff. A task that already has a branch (a migrated one) keeps it on its first hire the same way.
  A reviewer isn't seated without the task's worktree; a manual review is refused until the agent has set one up.
- A worker that exits (or can't start because its folder is gone) during a run interrupts it: task `waiting`
  (`interrupted`), with Retry offered.
- **Departures** ([kanban-coupling.md](kanban-coupling.md)): every send-home path passes an intent
  `DepartureIntent { by, done?, reason: 'sent-home'|'queue'|'meeting'|'merged'|'released'|'engine' }` to
  `Floor.sendHome` / `WorkerManager.kill` (WS `worker.kill {kanban: {done}}`, HTTP/CLI home, the queue's recycle,
  meetings, leave-on-merge, the engine). It is kept on the worker and arrives with the `removed` observation, so
  the engine's `removed()` needs no second event. `engine` departures only finish what the engine was doing
  (a Stop that timed out is `stopped`). Every other one writes exactly one status comment and applies:
  implementer with a live run → run `stopped`, task `waiting` (`stopped`, Retry), or `done` with `done`;
  implementer without one → `done` with `done`, else it keeps its column (`in_progress` with nothing running →
  `waiting`/`interrupted`; `retryAt` cleared only for `sent-home`, so a release keeps a usage-limit auto-resume); reviewer with a live run → the round is dropped (`reviewAbandoned`):
  pending comments are delivered, else → `review`. With `reason: 'merged'`, `done` means every `pr_links` row is
  `MERGED`. A task made done this way stops its other run and releases its other workers at rest.
- **Worktree guard** (`WorkerManager.addKeepGuard`): cleanup is forced to `keep` while another worker of the
  same task sits in that worktree, or the task has a live run there. When kill did delete it (the `cleaned`
  observation), the task's workspace and sessions are dropped, and `task.branch` too unless git still has the
  branch locally or on origin.
- **Leave-on-merge** (`notLeaving`) skips workers whose `WorkerInfo.kanban` says `in_progress` or a `runState`
  other than `idle`.
- **Worker summary**: on every card change (`pushTask`, `ctx.taskChanged` → `engine.cardChanged`) the engine sets
  each task worker's `WorkerInfo.kanban` (`KanbanWorkerSummary`: taskId, role, title, status, phase, runState,
  round, rounds, waitingReason, retryAt) with `WorkerManager.setKanbanSummary`, which emits `worker.update`.
- **A desk**: `engine.start(id, who, {deskId})` (from `kanban.task.start` / `kanban.task.create` `deskId`) hires the
  first worker at that desk; a desk that's taken, not built (`deskBuilt`), a kiosk or a meeting chair is refused
  and the task stays in `todo`. A queued start takes any free desk when its slot comes.
- Compacting keeps the task's column and, in `waiting`, its `waitingReason`; Retry and Continue go on with the
  last run before the compact.
- Usage limit / network interruption in the final text → `retryAt` + `retryAttempts`, swept every 60 s.
- On start-up, runs left `running` whose worker is gone become `interrupted` (task `waiting`, retry offered);
  a run whose worker is still at its desk is followed again.
- A run that can't start (the floor isn't open, the tool's CLI refuses) fails: task `waiting` (`failed`) with
  the reason as a status comment. The project's `maxConcurrent` queues a start (`runState: 'queued'`). A run
  that needs a new hire and finds no free desk, or the office's worker limit full (`ctx.capacity`, upstream's
  `Capacity.full`), is queued as it is: `runState: 'queued'`, the run in `tasks.queued_run`, its column and
  phase kept (machine events `noRoom` / `dequeue`). A queued run keeps its task's `maxConcurrent` slot
  (`busyCount`); only a start waiting for a slot has none. Every worker removal on any floor, and the minute's
  sweep, drain the queues: queued runs first, then starts under `maxConcurrent`, oldest first.
- **A task counts once against the worker limit.** A reviewer's hire (a review round's or a `pr-review`'s)
  while the task's implementer is still at its desk skips the limit: the engine's own check (`noRoom`, in
  `launch` and the drain) and `WorkerManager.spawn`'s `capacity.full()` (`SpawnExtra.countsWith` = the
  implementer's worker id, honoured only while that worker is there). The reviewer is still counted while
  it's seated (upstream's `Machine.count`), so every other hire, an unrelated task's included, finds the
  office full as before; once the implementer has gone, a reviewer is held to the limit like any hire.
  The desks aren't exempt: a reviewer finding none is queued. Since a queued run keeps its slot, starts
  can't pile up behind it: at most `maxConcurrent` (≤ 20) started tasks of a floor have an implementer
  seated while its reviewer waits, and a floor has at least 28 seats (16 desks, 12 bean bags), so the rest
  are held by workers a person sends home (ordinary workers, tasks in Waiting or Review) or by reviewers
  whose cycle ends. Work a person resumes (a comment, Retry or Continue on a task whose implementer is at
  its desk) doesn't take a slot; only when people set more such tasks going at once than the floor has
  seats can every seat be an implementer waiting on its own reviewer, and then a person frees a desk
  (⏹️ Stop one of those tasks, then 🏠 Release it).
- A new hire runs as `via.owner ?? caller.accountId ?? tasks.created_by_account` (drains, sweeps and Retry
  pass the creator's account). Upstream's sign-in rule applies (`ctx.runAs`): an owner not signed in to
  Claude gets `waiting` (`failed`) with `runAs.why`, never the office's sign-in. A hire that cuts a worktree
  fetches its bases first (`WorkerManager.fetchBase`, `Worktrees.fetch` per repository), as upstream's
  `withFreshBase` and the queue do. A repository with a configured `baseBranch` (`ProjectRepo`, the primary
  included) fetches that branch, and its worktree is cut from `origin/<baseBranch>`, else the local
  `<baseBranch>` (`SpawnExtra.bases`, by checkout folder, → `Worktrees.create`'s `baseBranch`); the workspace
  records it (`from` = the branch, `base` = the commit). A configured base that exists in neither fails the
  hire with that reason (task `waiting`/`failed`), never the checkout's branch instead. Without one, upstream's
  rule stays (the checkout's branch), and ordinary workers never pass `bases`. The first prompt's `{{repos}}`
  names the branch each worktree is cut from (`reposText`). The implementer sits at `tasks.desk_id` (the desk it was started at, then
  wherever it last sat) when that's free, else at the next free seat, with a status line saying so.
- Waiting on a person (plan approval, plan questions) and ready for review are announced once per transition
  through `ctx.notify` (upstream's webhook, `Webhook.announce`).

## 5. Storage

- `<officeData>/.agent-office/kanban.sqlite` (`better-sqlite3`, WAL, foreign keys, migrations numbered by
  `PRAGMA user_version` in `server/kanban/db/migrations.ts`). `<officeData>` is the office data dir upstream
  uses (`~/agent-office` by default).
- `<officeData>/.agent-office/kanban-settings.json` (`schemaVersion`), `kanban-secrets.json` (chmod 600).
- `<officeData>/.agent-office/kanban/uploads/`, `kanban/reports/task-<id>/`, `kanban/refs/task-<id>/`,
  `kanban/skills/plugin-<hash>/` (generated Claude skill plugins), `kanban/legacy/` (migrated stream logs).
- Migration 2 adds `tasks.desk_id`, `tasks.created_by_account` (never sent to browsers) and `tasks.queued_run`.
  Migrations are forward-only (there is no down step): once a build with migration 2 has opened the
  database, an older build refuses it ("newer than this build knows: upgrade 3d-kanban") rather than
  run on columns it doesn't know. Back up `kanban.sqlite` before trying a newer build you may roll back.
- Tables: `tasks`, `task_repos` (optional subset), `comments`, `runs`, `plans`, `attachments`, `task_events`
  (capped at 2000 per task), `pr_links`, `legacy_map`, `meta`. Timestamps are integer ms since epoch.

## 6. WS protocol

All kanban messages are `kanban.*` (`src/shared/kanban/protocol.ts`, `KanbanClientMsg` / `KanbanServerMsg`),
joined into upstream's `ClientMsg` / `ServerMsg` unions. Requests may carry `rid` (string); the server
answers `kanban.ok {rid, ...}` or `kanban.error {rid, message}`. Deltas are pushed to subscribed clients
(`kanban.subscribe {project: floorId | null}`), no polling.

- Every message passes `parseKanbanClientMsg` first. A refused one gets `kanban.error {rid, message}`, with its
  rid when the rid itself was usable. So does a type no plugin handles.
- Each request gets exactly one answer: the typed reply its comment names (`kanban.snapshot`,
  `kanban.task.detail`, `kanban.comments`, `kanban.settings` …), or `kanban.ok`, or `kanban.error`. A mutation
  also pushes its delta to the subscribers, and that includes the asker when it is subscribed.
- `kanban.subscribe {project, includeArchived?}` sets the connection's filter (one per connection) and is
  answered with `kanban.snapshot`. `kanban.unsubscribe` and closing the socket end the deltas. A browser that
  never subscribes gets no kanban deltas (the 3D office's clients).
- Deltas: `kanban.task` (a card changed or appeared), `kanban.task.removed` (deleted; also sent in place of
  an archived card to subscribers without `includeArchived`), `kanban.comment`, `kanban.run`, `kanban.plan`
  (project-scoped), and `kanban.settings` and `kanban.projects` (to every subscriber). The projects list is also
  pushed when floors are added, removed, opened or closed, but only when it changed.
- Rules the server enforces (`src/server/kanban/ws.ts`):
  - `task.create`: the project must exist; `repoIds` must be a subset of the project's repository ids.
    Defaults come from the settings (the default model only when the tool is the default tool). `start: true`
    then runs `engine.start` (at `deskId`, when given); its refusal comes back as `kanban.ok {taskId, startError}`.
    `deskId` (on `task.create` and `task.start`) must be a desk or bean bag of the layout, not a kiosk or a meeting chair.
  - `task.update`: `type, repoIds, usePlan, planApproval, useReview, goal, implementPermission` only while the
    task is in `todo`; `tool, model, effort, review` whenever no run is live (`isRunning` false): the next
    phase hires the new tool, whose fresh session gets the handoff. `repoIds` only before the first start. The
    description is locked from the first start (sending the unchanged text is fine). No edits while archived.
  - `task.move`: `checkMove` (moves.ts), where `hasWorker` means one of the task's workers is still at a desk.
    `start` runs `engine.start`. `reset` clears the automation state (phase, run state, waiting, round,
    sessions, worker ids, pending messages, retries, `finishedAt`, `doneAt`) **and the workspace**; it keeps
    `task.branch` and `startedAt`. The next start seats a fresh worktree whose agent is told to check that
    branch out (`kanban.checkout`), rather than reusing a worktree that may be gone by then.
    `done` sets `doneAt`; `archived` sets `archivedAt`.
  - `task.delete`: only by its creator or an admin. It is refused while running or while a worker is attached.
    Its attachment files are deleted too.
  - `comment.add`: stored, attachments linked, `kanban.comment` pushed and `kanban.ok {commentId}` sent;
    then `engine.commented`.
  - `plan.approve {planId}`: only the latest plan version can be approved.
  - Start, stop, continue, retry, review, plan approve and request-changes, pr, compact and release go to
    `ctx.engine`. A returned string becomes `kanban.error`.
  - `pr.bundle {project, taskId | branch | ticket, includeClosed?}` (integrations/pulls): the PRs that belong
    together across the project's repositories, open and draft ones only unless `includeClosed`; answered with
    `kanban.pr.bundle` (an `error` in it rather than `kanban.error` when the lists couldn't be read).
  - `pr.review {project, prs, taskId?, tool?, model?, effort?, panel?}`: checked by integrations/pulls (the
    project exists, every PR is in one of its GitHub repositories and exists, each once, at most 20, `taskId`
    is the project's), then run by the engine (`engine.reviewPrs`, §4) and answered with
    `kanban.ok {taskId, workerId}`: the review's task (the given one, or a new `investigate` task) and its
    reviewer (no `workerId` when the review is queued for a desk or the worker limit). With `panel: true` it goes to the floor's meeting room instead (upstream's 🤝 review panel;
    its brief, the layered `kanban.pr.panel` prompt (office + project layers), lists every PR, the review is
    posted on one of the primary repository's; a single PR from the office's PR board keeps upstream's `pull.panel`) and is answered with
    `kanban.ok {}` (`taskId` when one was given, which also gets a status comment).
  - `issues.list`, `issues.refresh`, `issues.createTask` (idempotent by ticket, archived tasks included, `kanban.ok {taskId, existed}`; `start` with `deskId` starts it, or the one already made while it waits in To do, at that desk: the 3D office's P with a card; `started` or `startError` says how it went),
    `skills.list` are for anyone signed in.
  - `meta.get` (anyone signed in) is answered with `kanban.meta {projects, settings, secrets, me}`: what a
    snapshot says besides the cards, for ⚙️ Settings on a page without a board (the 3D office).
  - The same cached issues are the 3D issues board of a project with issue sources
    (`integrations/issues/wall.ts`): the floor's upstream `gh.issues` carries them as `GhIssue`s with
    `key`, `source`, `status` and `taskId` (`number` only for a GitHub issue of one of the project's
    repositories, else 0), and falls back to upstream's list without sources. Cards are handed out with
    `issueKey` (see kanban-coupling.md, Messages).
  - Admin only (upstream `meOf(accountId).admin`): `settings.set`, `project.settings.set`, `project.repos.set`,
    `project.prompt.set`, `secrets.set`, `skills.sync`. `secrets.set` is answered with `kanban.settings` (configured flags
    only). The `/api/v1` key is stored as `sha256:<hex>`.
- Auto-archive: done tasks whose `doneAt` (else `updatedAt`) is older than `settings.archiveAfterDays` move to
  `archived`. This runs at start-up and hourly; `0` means never. Unattached uploads older than a day are removed
  in the same sweep.

## 7. Prompts

Every prefilled prompt is a `PromptDef` in `src/shared/kanban/prompts.ts` (group `kanban`), spread into
upstream's `DEFS`, so the upstream prompt editor shows it. Layering: default → office-wide custom
(upstream `prompts.json`) → project override (`kanban-settings.json` `projects[id].prompts`). Contract
blocks (markers, safety rules) are appended by the engine and shown read-only in the editor.

## 8. Agent-facing endpoints

On the loopback hook server (worker bearer token, like `/office/workers`):
`GET /office/tasks/reference?ref=[&tail=1]`, `GET /office/tasks/search?q=`, CLI `office-tasks` (on every
worker's PATH), MCP tools `get_task`, `search_tasks` (listed only when the worker has `AIKANBAN_API_BASE`, i.e.
task workers; Claude task workers get them in `--allowedTools`). A plan phase gets the tasks its text refers to
written to `kanban/refs/task-<id>/referenced-tasks.md` (it can't call anything).

Compatibility for existing ai-kanban skills/scripts (integrations/compat/v1.ts): task workers get env
`AIKANBAN_API_BASE` (the hook server URL) and `AIKANBAN_TASK_ID`.

- `GET /api/tasks/reference?ref=`: ai-kanban's response shape, read-only, no key, never a terminal tail.
- Minimal `/api/v1`: `GET projects`, `GET tasks`, `GET tasks/:id`, `POST tasks` (idempotent on `ticketId`),
  `POST tasks/:id/start`.
- Both: the socket's peer must be loopback; `loopbackRefusal` (integrations/util.ts) refuses a `Host` that
  isn't `127.0.0.1` / `localhost` / `[::1]` with the listening port (DNS rebinding), an `Origin` other than that
  host or a `Sec-Fetch-Site` other than `same-origin`/`none` (web pages), `OPTIONS`, and a `POST` without
  `Content-Type: application/json` or over 256 KB. No CORS headers are ever sent.
- `/api/v1` only: once an API key is set (kept as `sha256:<hex>`), every request needs it as
  `Authorization: Bearer` or `X-API-Key`. Starting a task (`POST tasks` with `start: true`, `POST tasks/:id/start`)
  is refused (`api.startNeedsKey`) while no key is set: it runs an agent as the office's user.

## 9. HTTP routes

For a signed-in browser (the session is checked by server.ts, and non-GET requests must be same-origin):

- `GET /kanban`, `/kanban.html`: the board page. Signed out, it redirects to `/login?next=/kanban`.
- `POST /api/kanban/upload?name=<file name>[&task=<id>]`: the body is the file's raw bytes and `Content-Type`
  is its type (sniffed from the extension when missing). At most 20 MB. It returns `200 {attachment}`, or
  `400/404/405/413 {error}`. The file is stored as `<filesDir>/uploads/<id>-<ascii name>` with mode 600.
  Without `task` it stays unattached until `task.create` / `comment.add` names its id.
- `GET /api/kanban/attachments/<id>`: serves the file with its type, `nosniff` and a sandboxing CSP.
  PNG, JPEG, GIF, WebP, AVIF and BMP are served inline; anything else (SVG and HTML included) as a download.
- `GET /api/kanban/tasks/<id>/changes[?repo=<repoId>]`, `…/commits?repo=`, `…/commit?repo=&hash=`
  (integrations/changes): the task's repositories; one repository's files and unified diff against its base
  (cut at 2 MB, `truncated`) plus the worktree's uncommitted work (`workingTree`, null without a workspace);
  `base..branch` commits; one commit's diff (`hash` must match `^[0-9a-f]{7,40}$` and be in `base..branch`).
  Read from the task's worktrees, else its branch in the project's checkout (`origin/<base>...<branch>`, else
  the local base). git runs with argument lists, no shell, timeouts, `GIT_OPTIONAL_LOCKS=0`; a `git fetch` of
  the checkout runs in the background at most every 5 minutes and is never waited for.
- `GET /api/kanban/tasks/<id>/reports`, `…/reports/<name>[?download=1]` (integrations/reports): the files under
  `kanban/reports/task-<id>/` (no dot files, no links); a name is only looked up in that listing, served as
  `text/markdown` or `text/plain` with `nosniff` and a sandboxing CSP, at most 2 MB.
- Other `/api/kanban/*` paths go to the plugins' `http` routes (longest prefix first); unmatched paths get 404.

## 10. Wiring (`src/server/kanban/index.ts`)

`installKanban` builds the `KanbanContext` (registry.ts): data and files dirs, the repository over
`kanban.sqlite`, settings, secrets, projects through the Building, the office prompts, the hook URL, broadcast
and toast. It then creates `pulls`, `refs` and the engine, and the plugins: the core plugin (ws.ts) plus
`integrationPlugins`. The first plugin to claim a WS type keeps it. `workerExtras` merges the plugins'
`workerArgs`/`workerEnv`, and a plugin that throws loses only its own part. `engine.begin()` and every
`plugin.start()` run once everything exists; `shutdown()` stops the plugins, disposes of the engine and
closes the database.

"O" at a desk (`worker.pr`) goes to `engine.prForWorker` first: a task worker's task gets its `pr` phase
(`engine.pr(taskId, 'create')`); any other agent worker gets the layered `kanban.pr.create` prompt (with the `pr`
contract) typed into its session, or resumed with it when it's asleep. Only a shell worker answers `'fallback'`
(`PR_FALLBACK`), and only then does upstream's own `openPr` (a draft PR without an agent) run. PR states of the
tasks' linked PRs follow the floor's PR board (`floorPulled` → integrations/pulls `syncPrStates`).
