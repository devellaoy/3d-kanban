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
  (downloaded as a tarball, not a git clone). See [fork.md](fork.md) for the origin and the sync policy.
- The kanban is part of the project. Its own code lives in:
  - `src/shared/kanban/` — types, WS protocol, move rules, prompt defaults (browser + server).
  - `src/server/kanban/` — database, settings, projects, engine, issues, refs, skills, HTTP/WS glue.
  - `src/client/kanban/` + `src/client/kanban.html` — the kanban page.
  - `src/{shared,server,client}/youtube/` — YouTube on the Office TV (see fork.md).
  - `bin/office-tasks.js`, `scripts/migrate-ai-kanban/`, `skills/`, `user-skills/`, `tests/kanban-*.test.ts`, `docs/kanban*.md`.
  General code (the shoulder camera, the GitHub repo picker, PR file lists and so on) lives where it
  belongs, outside these folders, and any file may be changed where that is the clean solution.
  The registries and the size guard ([Code layout](code-layout.md)) apply to the kanban like to the rest.
- Multiplayer visitors (see [Features](features.md#multiplayer-visit-each-others-offices)) get a filtered,
  read-only view of the kanban: only `kanban.subscribe`, `snapshot`, `task.get`, `comments.page`,
  `meta.get` and `pr.bundle` for projects the owner shared with them, and every other kanban message is refused.
- Style: upstream's — TypeScript strict, ES modules with `.js` import suffixes, `node:test` tests,
  comments explain *why*, no new UI framework (client uses `h()` / `openModal` from `ui/dom.ts`).
- Server code never trusts the browser: validate every WS message field (types, lengths, enums).
- Secrets (Jira tokens, API keys) never leave the server; the browser only sees `configured: true`.

## 2. Concepts

- **Project = floor.** A floor (`FloorDef` in `floors.json`) is a project, a clone of a GitHub repository or a plain folder that was already there (`Building.addDir`: no clone, git optional, admin only; created by `floor.add {dir}` from the elevator and from the kanban settings; a floor decides once whether it is a git floor, by a `.git` in its own folder, and a plain folder runs no git or `gh`); its name (`FloorDef.name`) can be changed (`kanban.project.rename`, admin), its id never. `FloorDef.repos?: ProjectRepo[]`
  lists its repositories. The floor's own `dir`/`repo` is always the **primary** repository
  (the floor's `.agent-office/` data stays there, as upstream). A floor without `repos` is a
  one-repository project exactly as upstream has it. The primary's `remote` is `FloorDef.repo` when the
  floor has one (`validateProjectRepos` refuses another: "The floor's own repository is owner/name; add
  another repository instead, or re-add the floor"; the settings form shows it read-only), else the
  one saved for the primary in `repos`. Kanban code reads the primary's owner/name only through
  `projectRepos` (issue sources, PR bundles and reviews, `pr_links` matching, the prompts' `{{repos}}`,
  the refs bundle), never `FloorDef.repo`; another git repository with no saved `remote` gets it from its
  checkout's `origin` (`checkoutRepo`, github.com only; never written to `floors.json`, and
  `projectInfo` sends it as `detectedRemote`, not `remote`); upstream's own uses of `FloorDef.repo` are unchanged.
- **Task** (`KanbanTask`): a unit of work on one project, touching the project's repositories
  (all of them by default, or a chosen subset `repoIds`). Ids are integers (`#123`), global across projects.
- **Run**: one phase execution of a task (`plan`, `implement`, `review`, `fix`, `resume`, `pr`, `pr-fix`,
  `pr-review`) with its tool, model, session, worker, outcome and verdict. `pr-review` is a
  review of one or more pull requests together by a reviewer in a worktree of its own (see §4). Old runs
  may also say `compact`: the office used to compact a session on request, nothing starts one any more.
- **Task worker**: an ordinary upstream worker (PTY, live terminal at a desk on the project's floor)
  hired by the engine for a task. `WorkerInfo.kanban = { taskId, role: 'implementer' | 'reviewer', … }`, with the
  task's card as it is now (see §4, *Worker summary*).

## 3. Columns and state

`TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'review' | 'on_hold' | 'done' | 'archived'` (fixed; no custom columns).

- `todo` → start → `in_progress`.
- `in_progress`: the engine is running a phase (`task.phase`, `task.runState`).
- `waiting`: needs the user (plan questions, manual plan approval, agent asked in the terminal,
  stopped, failed, usage-limit wait shown as `retryAt`).
- `review`: automation finished; the user reviews, comments (resumes work), asks for a PR, or moves to done. Each automated arrival of a reviewed task (not an investigation, review on) stores the workspace's fingerprint (`tasks.handoff_fingerprint`: HEAD, tracked changes, untracked files' contents, nested repositories and checked-out submodules, per repository; ignored files don't count, and neither do files hidden by `.git/info/exclude` or a global excludes file, nor tracked files marked assume-unchanged or skip-worktree); a `resume` turn is reviewed again only when it differs (`resumed` with `since: 'handoff'`), otherwise the task returns to Review with a note. A task that never reached Review has none and is judged against the base branch; a task moved to Review by hand keeps whatever baseline it had (a stale one only causes extra reviews); only a `start` clears it.
- `on_hold`: put aside from Waiting or Review until something it depends on is there (`src/shared/kanban/hold.ts`).
  `hold {at, by, from, note?, until?, worker?: {name, color}, deskId?}` (`tasks.hold`, on the card too) says why and
  since when. **Putting it on hold** (`task.move` to `on_hold`, `checkMove` action `hold`; only from `waiting`/`review`
  with nothing running; for its creator or an admin, as is a reset of a held task to To do (it drops the session and worktree); `engine.hold`, `engine/hold.ts`): a run live only because the agent
  asks in its terminal is finished as `stopped`; `hold` is recorded (with the implementer's name, colour and desk) and the
  status set to `on_hold`, `runState` `idle`, `queuedRun`, `retryAt`, `retryAttempts` and the waiting reason cleared;
  then the task's workers at rest go home with cleanup `keep` (`all` for a PR review's reviewer in a worktree of its own),
  departure reason `hold`. `sessionId`, `workspace`, `branch` and `deskId` stay on the task, so the worktree is untouched. A status comment
  says who held it, why, until when, where the worktree stays and how to resume. It holds no `maxConcurrent` slot
  (`busyCount` counts `in_progress` only), a comment on it is only stored (nothing starts), the auto-archive only touches `done`, and
  leave-on-merge has no worker to send home. 3D clients get a view-only lounge figure for it (§6).
  A task held while it waited for a plan's approval or answers (`plan_approval`, `plan_questions`) records that
  (`hold.reason`, `text`, `phase`; its worker at the plan's exit prompt may go home too) and is not worked on when resumed: it goes back to
  `waiting` with them and a status line, and approving or answering hires the worker as usual. What was said since the hold (the user's comments, the resume note included, files too) is kept by comment id as `pendingMessages` (marked `held`, exempt from the cap of 50 on queued comments, so nothing is dropped) when the task is resumed, whichever way it goes on; comments typed while the unhold run waits for a desk join them. The next run that resumes the work (`unhold`, a plan's approval `implement` or answer `replan`, a Retry's `continue`, a comment's `resume`) carries them (`ComposeExtra.held`: in the unhold prompt's `comments`, else under "Messages left on the task that you have not seen yet"). They leave the task, and their comments stop being pending, only once an agent has the prompt, by id: a hire on a fresh session has it on its command line and acknowledges at once; a run resumed on a stored session (`--resume`, in a new hire or an in-place relaunch) acknowledges when its agent is first heard from, ignoring the events of the old process still being ended (`Live.armed`). A launch that fails or waits for room keeps them for the Retry or the dequeue, and nothing is delivered twice.
  **A session that is gone.** The engine follows a worker's current run (`KanbanWorkers.follows`, in memory), and for such a worker upstream's silent "No conversation found → fresh Claude with no prompt" is off (`WorkerManager`'s `freshIfResumeFails` branch; other workers, a Stop's relaunch or a manual resume, keep it): an agent that exits before it is heard from, resuming a stored session, is the engine's. Only if Claude's transcript of that session does not exist (`engine/sessions.ts`: `<claude home>/projects/*/<id>.jsonl`, under the home of the task owner's own sign-in, else the office's; Codex and an unreadable folder count as unknown) does `Holds.freshSession` finish the run as interrupted, drop that role's `sessionId`, keep workspace and branch, say which session id was dropped, and launch the same run once more in a fresh session with the handoff and the run's own prompt, the messages still pending. When the session exists, or can't be told, nothing is dropped: the run is interrupted and Retry carries on. The fresh run has no session to lose, so another early exit is an ordinary interrupted run.
  Moving a held task on to Review (`engine.releaseHeld`) queues the messages first, so the next run carries them; to Done or the archive they stay plain comments (nothing runs again), and a reset starts over. Stop on an unhold that waits for a desk (`Holds.cancelUnhold`) puts the task back on hold with its hold intact, and what was said plain comments again.
  **Resuming** (`task.move` to `in_progress`, action `unhold`, `engine.unhold`; its creator or an admin, as the hold was: it spends the creator's sign-in on what they parked; an optional `note` becomes the
  user's comment first): the machine's `unhold` event runs the implementer again (phase `resume`, prompt `unhold`) through
  `launch()`: same worktree and `resumeSessionId`, preferring the worker's old name (when no one else has it) and colour
  (`SpawnExtra.name`/`color`) and its desk; a worktree that is gone takes the existing `dropWorkspace` + `kanban.checkout`
  path. `hold` is cleared with that move (only a queued unhold keeps it, for its prompt). Leaving `on_hold` otherwise: to `review`/`done` only changes the
  status, to `todo` is a reset, to `archived` as from any column (a task running or queued can't be there); each of them clears `hold`.
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
`archived → done`, `waiting|review → todo` only when no worker is attached (reset), any → `archived` except running,
`waiting|review → on_hold` (hold; refused while running), `on_hold → in_progress` (unhold), `on_hold → review|done` (status only), `on_hold → todo` (reset).

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
      `TurnResult.background` counts the run's background agents still working (an async launch or a
      `SendMessage` resume in the log with no task-notification after it, since the run's first office prompt:
      the first real prompt at or after the run's start, so a prompt typed into the worker's terminal
      meanwhile doesn't move it; when that prompt isn't in the read tail (16 MB), the first of the run's prompts still in
      it, else the last office prompt, is used);
      `resuming` says the last prompt is a notification (or a teammate's message) no assistant line has
      answered yet. `background` counts agent-team teammates working too (below). `readTurnResult(file,
      { since, runStart })` takes the start of the agent's Claude process and the run's start; Codex ignores both.
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
- A Claude Stop isn't the turn's end while the run's background agents or commands still work: Claude Code's
  own skills run implementers and reviewers that way, and an implementer starts its full test suite in the
  background, ends the turn with "I'll wait for it" and resumes by itself with a new turn and Stop when
  the agent or command is done. The engine reads the log first and decides on that one
  result (`TurnResult.background`, so a lagging log doesn't end the run on the interim text; `resuming`,
  once: a Stop that raced the notification, which Claude is about to answer). The task stays in progress, and
  the next Stop is heard from the hook (the worker's status stays `done`, so upstream emits nothing). A
  run already held takes a Stop on an unanswered notification as the resumed turn's own, with the Stop
  hook's `last_assistant_message` as the fallback. ExitPlanMode isn't held back. A hold ends after
  `backgroundWaitMs` (3 h) without a Stop: a note says so and the run goes on with what its log says.
  ⏹️ Stop while held ends the run as stopped and restarts the worker on its session at its desk
  (`workers.relaunch`, no prompt; Continue carries on there), which ends its helper agents (only in-process
  background agents are assumed to end with a restart: Bash `run_in_background` children and teammates in
  other processes may outlive it, which only affects how long Continue waits); once the turn has resumed it is Esc as usual, and a Stop hook heard while a
  stop is under way finishes it. Counted are background agents, Bash `run_in_background` commands (also one the
  120 s timeout moved to the background) and non-persistent Monitors, plus teammates. A launch logged before the
  process started died with it and isn't counted, whichever of these it is. A persistent Monitor
  never finishes, so it isn't counted, and a Monitor's per-event notifications (an `<event>`, no
  `<status>`) don't end it. A notification is read from its headers only (the first `<task-id>`, `<status>` and
  `<event>`): the free text in its `<result>`, `<output>`, `<summary>` and `<event>` bodies is cut out first, so
  an answer or a command's output quoting a tag steers nothing. A launch known only by its text (no tool
  result data) counts from an Agent, Task or Bash result, a Bash one only for a call with `run_in_background` or
  the timeout's own words at the start of the text. A command or server the agent forgets running holds the task In progress for at
  most `backgroundWaitMs` (3 h), hence the `STOP_PROCESSES` rule. Codex has no background tracking. Known limit: someone typing a
  prompt into a held worker's terminal starts a new window, so the background agents still working stop
  being counted and the run can end on that prompt's reply (teammates are read whatever the window).
- **Agent-team teammates** (Claude Code's `Agent` call with a `name`) are counted in `TurnResult.background`
  too, from their own transcripts beside the lead's (`<log>/subagents/agent-*.jsonl`, `taskKind:
  in_process_teammate`): one is working when its transcript ends in a message or tool result it hasn't
  answered, a message that isn't text alone, or nothing said yet. They live as long as the Claude process,
  so only a teammate whose last line is newer than `since` counts: the process's start, from the worker's
  `SessionStart` hook (`startup` or `resume`; dropped when the worker exits or goes). Known limit: after an
  office restart that start is unknown until the next `SessionStart`, so the run's start stands in for it
  (a teammate that last wrote between the process's start and the run's is then counted dead). A
  transcript is read from its last 512 KB, and not at all when its file's mtime is older than `since`; of
  several transcripts of one name (a respawn) the one written last speaks; one that can't be read counts as
  working (an error is no rest). The lead's log only covers the lag of theirs: a spawn or a `SendMessage` to
  one (`routing.target`, else the call's `to`; `*` is everyone) wakes it, as does a teammate's message to
  another, read from the sender's own transcript at its own time (the idle notification's `[to Y]` summary
  counts only when the sender's transcript can't be read: such a notification can reach the lead minutes
  late, naming a message already answered); an idle notification, shutdown or termination rests it, dated by
  its own timestamp for the same reason (only for names that are teammates: spawned, or with a transcript; a
  teammate's `[to main]` to the lead wakes nobody), each when newer than the teammate's last line. A
  teammate's message to the lead is no prompt of the office's: it doesn't open a new window (`start`) and
  counts as a prompt to answer (`resuming`), so the background agents launched before it still count.
- A hook whose payload has an `agent_id` comes from a subagent or teammate, which run in the lead's process
  and so reach its worker (upstream may set the worker `working` for them). The engine ignores those for
  its bookkeeping: the plan exit, the Stop text, the end of a hold are the
  lead's alone. Only their ask hooks (`PermissionRequest`, a `permission_prompt` notification, a question
  tool's `PreToolUse`, a `PostToolUse(Failure)`) reach `heardAsk`: a teammate's own question or permission
  prompt is what the worker's `needs_input` waits on, but its `Stop`, prompt, `SessionStart` and other
  tools never clear the lead's.
- A phase that finds its own task's worker busy (a teammate's hook kept it `working` after the run ended:
  a fix after a review, say), or its teammates still at work by their transcripts (they may wake the lead
  again seconds after it rests: the worker stays `done` meanwhile), waits for the worker and its teammates to rest
  (teammates polled every second), at most `busyWaitMs` (10 min), then starts as
  usual; only after that wait does the run fail with "is busy: wait for its turn to end". ⏹️ Stop during the
  wait cancels it (it would otherwise queue behind the task's chain): the run ends as stopped, nothing typed.
- The clients show a task's worker as working for as long as its run is running (upstream's `done` of a
  held turn is not shown); see `docs/kanban.md`.
- **What it waits on** (`Live.asks`, `heardAsk`, in memory only): from the worker's hooks, heard before
  the status they cause. A `PreToolUse` of `AskUserQuestion` (Codex: `request_user_input`) is a
  `question`; a `PermissionRequest` or a `permission_prompt` notification is a `permission`; another
  tool's `PreToolUse`, a `PostToolUse(Failure)`, `UserPromptSubmit`, `SessionStart` or the turn's end
  forget it (unknown; so is every run re-attached after an office restart). The task and its card carry
  it as `askingKind` while `agent_asking` (a `KanbanRepository` in-memory map, never stored).
- **Answering it from the kanban** (`waiting`/`agent_asking`, the live run's worker `needs_input`):
  only a `question` is typed into. `continue(answer)` and `commented()` type the text into that
  worker's PTY (upstream's `WorkerManager.prompt`, which answers a TUI question as a person typing
  does) and keep it as a user comment (`continue` adds it, with its files, only once the answer went in; a comment is already stored); the files
  of that message (`attachmentIds`, or the comment's own) follow on the same line, as paths in the task's grant folder (`Composer.filesInline`: a newline may submit a question picker); nothing goes
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
  - pr: one `PR: <url>` line per pull request opened or updated. The line starts with `PR` or `Pull request`
    (optionally `created`/`opened`/`updated`; a list bullet and bold are allowed) and a colon; the URL is bare,
    `<url>` or a Markdown link, text after it is fine, any http(s) host (`PR_LINE` in `shared/kanban/prompts.ts`
    is the one rule). GitHub URLs are reduced to `…/pull/<n>` (no `/files`, `#…`, `?…`) and duplicates count once
    (case-insensitively). Such a PR is linked to the task (`pr_links`) only when it is a GitHub PR of one of the
    task's repositories and no other task, of any project, has it (by repository, number or URL). A URL anywhere
    else in the answer is not reported at all.
  - Branch linking: whatever the answer says, when the floor's PR board syncs (`syncPrStates`) an open or draft PR
    is linked to the task whose branch is its head branch (the task's per-repository branch; the primary
    repository falls back to the task's `branch`), in any phase. Not linked: merged or closed PRs; PRs created
    before the task; a head that is an integration branch (`main`, `master`, `develop`, `dev`, `trunk`) or the
    repository's default branch (`gh repo view`); a branch owned by several active tasks, in any project (done and
    archived tasks own none); a PR that is already some task's, in any project (by repository, with a link
    lacking one resolved through its repoId, number or URL); a fork's PR with the same branch name (`gh pr view
    --json isCrossRepository` must say false). The gh answers are cached (a PR's head repository never changes),
    a failed question isn't repeated for 5 minutes and links nothing meanwhile. Each such link is a `pr.linked`
    event (`{ repo, number, by: 'branch' }`); the board's `GhPull.isCrossRepository` skips a fork's PR before gh is asked. A `pr`/`pr-fix` turn's end asks the floor's boards for the task's git
    repositories to refresh at once, so the link shows up quickly.
  - review: read from the final answer's last 3 non-empty lines only: the **last** of them matching
    `^\s*REVIEW:\s*(APPROVED|CHANGES_REQUESTED)\s*$` as a line of its own (emphasis allowed) decides; none →
    changes requested.
  - A review verdict never counts inside a fenced code block (```` ``` ```` / `~~~`, an unclosed one runs to
    the end) or in a `>` quote. Plan markers ignore quotes and *closed* code blocks, but an unclosed fence
    hides nothing after it. PR lines ignore only quotes (an agent may list its PRs in a code block).
- Every contract block (plan, review, prReview, implementSafety, investigateSafety, pr, and `panel`, which seals
  the 🤝 review panel's `kanban.pr.panel` brief) starts, right after its `---` line, with `STOP_PROCESSES`: a process
  the agent starts while it works (dev server, watcher, test runner, browser, emulator, container, background job)
  is stopped before it finishes its work, unless the task or the user explicitly asks for it to be left running.
  It is stopped by its PID or job or the tool's own stop command, never by name or port (no pkill or killall), a
  container is stopped but not removed, and nothing the agent didn't start is touched (the office's own processes,
  another worker's or the user's). It also tells the agent that a background command still running when its turn
  ends keeps the task in progress (the hold above). It sits in the fixed block so no rewrite of a prompt can drop it.
- Plan approval: `auto` (ready → implement) or `manual` (ready → `waiting` until the user approves).
- Review: `rounds` (1–10), `reReviewLastFix` (default false). A reviewer is a separate worker (its own tool,
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
- **The reviewer's spot**: a task's reviewer (not a `pr-review` one, which has no implementer) is hired at
  the watch spot behind its implementer's seat (`watch-<seat id>`, `WATCH_SPOTS` in `shared/layout.ts`;
  the implementer's current desk, else `task.deskId` while nobody but the task's own worker sits there), not at a desk: it takes no seat, and neither the
  hire nor the drain waits for a free desk for it (`watchSpotFor`, `noRoom`). Without a desk to stand
  behind, or with that spot taken, it takes the next free seat as before. Only a kanban reviewer can be
  hired at a watch spot (`WorkerManager.spawn`); a start's `deskId` can't be one. Walling up the back
  office counts a reviewer behind one of its desks as someone there. The client builds the spot's view beside
  the watched seat's own, in its frame (`client/kanban/watch3d.ts`), so it stands where that seat is on every
  map and still shows while the seat is hidden (a bean bag put away once its implementer went home).
- A worker that exits (or can't start because its folder is gone) during a run interrupts it: task `waiting`
  (`interrupted`), with Retry offered.
- **Departures** ([kanban-coupling.md](kanban-coupling.md)): every send-home path passes an intent
  `DepartureIntent { by, done?, reason: 'sent-home'|'queue'|'meeting'|'merged'|'released'|'hold'|'engine' }` to
  `Floor.sendHome` / `WorkerManager.kill` (WS `worker.kill {kanban: {done}}`, HTTP/CLI home, the queue's recycle,
  meetings, leave-on-merge, the engine). It is kept on the worker and arrives with the `removed` observation, so
  the engine's `removed()` needs no second event. `engine` departures only finish what the engine was doing
  (a Stop never causes one: Esc is tried first; one that isn't confirmed in `stopGraceMs` (no rest, no Stop hook, no interrupt line in Claude's transcript, which finishes the stop with the worker resting) ends the run as `stopped` and relaunches the worker, see `engine/stopping.ts`, unless the stop had finished by then; a worker that can't be relaunched (no session yet, a process that won't exit) stays at its desk, with its agent process ended in place if it was working, and the comment says so). Every other one writes exactly one status comment and applies:
  implementer with a live run → run `stopped`, task `waiting` (`stopped`, Retry), or `done` with `done`;
  implementer without one → `done` with `done`, else it keeps its column (`in_progress` with nothing running →
  `waiting`/`interrupted`; `retryAt` cleared only for `sent-home`, so any other send-home keeps a usage-limit auto-resume); reviewer with a live run → the round is dropped (`reviewAbandoned`):
  pending comments are delivered, else → `review`. With `reason: 'merged'`, `done` means every `pr_links` row is
  `MERGED`. A task made done this way stops its other run and releases its other workers at rest. `hold` (a task put on
  hold, `engine.hold`) only writes one line ("<name> went to sit in the lounge: the task is on hold"): no `interrupted`, no
  `markDone` (not even for merged PRs), the column stays `on_hold`.
- **Unhold prompt**: `PromptKind` `unhold` (`kanban.unhold`, §7) is typed into the resumed session. `compose.ts` fills `taskId`,
  `heldAt` (the day of `hold.at`), `holdNote` (", because: …" or empty), `comments` (the user's comments since `hold.at`, the
  resume note among them, or "none") and `language`. A fresh worker without a session (it was dropped, or the worktree is gone) gets the handoff
  first, as for `fix`, `resume`, `continue` and `pr.*`. A held task is not fixable and cannot be reviewed through a PR
  review: `canFixPrs`, `pr` and `prReview` refuse with "It is on hold: resume it first".
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
- A compact (queued or running) left by an older office is dropped at start-up: the task goes `idle` in the
  column it was in, and the run is closed `interrupted`. Retry and Continue skip such runs.
- Usage limit / network interruption in the final text → `retryAt` + `retryAttempts`, swept every 60 s. The reset time is the text's own (`resetTime`) or, for a Codex run, `ctx.codexResetAt(codexHome)` (`engine/limitreset.ts`): the latest reset among the account's Codex windows at 100% (or, with the limit reported reached and none at 100%, the fullest window's), from a fresh read by `src/server/codex-limits/` (`fresh`, at most 5 s waiting); unknown or failing → `backoffMs`.
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
  (⏹️ Stop one of those tasks, then send its worker home with **X**).
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
- `<officeData>/.agent-office/kanban/uploads/`, `kanban/grants/task-<id>/`, `kanban/reports/task-<id>/`, `kanban/refs/task-<id>/`,
  `kanban/skills/plugin-<hash>/` (generated Claude skill plugins), `kanban/legacy/` (migrated stream logs).
- Migration 4 adds `tasks.hold` (JSON, see `TaskHold`; parsed defensively like the other JSON columns). It raises
  `user_version` to 4, so a build that knows only 3 refuses the database: back up `kanban.sqlite` before trying
  a build with a hold and rolling back.
- Migration 2 adds `tasks.desk_id`, `tasks.created_by_account` (never sent to browsers) and `tasks.queued_run`.
  Migrations are forward-only (there is no down step): once a build with migration 2 has opened the
  database, an older build refuses it ("newer than this build knows: upgrade 3d-kanban") rather than
  run on columns it doesn't know. Back up `kanban.sqlite` before trying a newer build you may roll back.
- Tables: `tasks`, `task_repos` (optional subset), `comments`, `runs`, `plans`, `attachments`, `task_events`
  (capped at 2000 per task), `pr_links`, `legacy_map`, `meta`. Timestamps are integer ms since epoch.

## 6. WS protocol

All kanban messages are `kanban.*` (`src/shared/kanban/protocol.ts`, `KanbanClientMsg` / `KanbanServerMsg`; the validators are in `validate.ts`, the issue messages in `issueops.ts`),
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
- Lounge: `{t: 'kanban.lounge', floor, figures: LoungeFigure[]}` (`shared/kanban/lounge.ts`; `server/kanban/lounge.ts`) goes to
  everyone on that floor whenever the floor's set of figures changes (sent from `ctx.taskChanged`, which a hold, resume, delete or any
  edit of a held task goes through; compared by a signature per floor, so nothing is sent for an unrelated change). A floor's figures are
  its project's `on_hold` tasks as `{taskId, title, name, color, note?, until?, at}` (name and colour from `hold.worker`, else "Worker" and a neutral grey), oldest hold first (`sortFigures`).
  Whoever arrives gets them in `FloorView.kanbanLounge` (serving it doesn't touch the broadcast cache, which holds what was last sent to the floor; a floor nothing was sent to since the start always gets its first message, even an empty list, so a restart doesn't hide the last figure's removal) (the `views` registry), so the same list reaches the
  welcome and a floor change. Where each figure goes is computed, never sent: `loungePlaces(count, occupied)` fills the free
  lounge seats in order (the seats people on the floor sit on are skipped; `couch:1` is never a figure's), then the standing
  places, so every browser places them the same from the figures and the peers' seats; when someone sits down or gets up,
  only the figures whose place changed move. The `sit` handler (`ws/handlers/presence.ts`) refuses a place a figure holds on
  the office map (`Kanban.loungeSeat`, the same function over the floor's held tasks and everyone else's seats) with
  `sit.refused`, as for a seat someone has; the browser keeps the same places from its own choice (`reserveSeatPlaces` in
  `features/seating`).
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
  - `task.move`: `checkMove` (moves.ts), which only looks at the column and the run state. Workers at rest don't stop a move: the engine sends them
    home first (`engine.sendWorkersHome(id, who, 'reset')`, cleanup `keep` (`all` for a PR review's reviewer in a worktree of its own), reason `released`; a run live only
    because the agent asks in its terminal is finished as `stopped`). A reset of a task with workers is for its creator or an admin (as `task.delete`).
    `start` runs `engine.start`. `reset` clears the automation state (phase, run state, waiting, round,
    sessions, worker ids, pending messages, retries, `finishedAt`, `doneAt`) **and the workspace**; it keeps
    `task.branch` and `startedAt`, and says in a status comment where the worktree stayed and on which branch. The next start seats a fresh worktree whose agent is told to check that
    branch out (`kanban.checkout`), rather than reusing a worktree that may be gone by then.
    `done` sets `doneAt`; `archived` sets `archivedAt`.
    `note?` (at most `HOLD_NOTE_MAX` = 500 characters) goes only with a move to `on_hold` (the reason) or `in_progress` (the message for the agent
    on a resume), `until?` (ms; no more than a day in the past, no more than two years ahead: `validHoldUntil`) only with `on_hold`; anything else is refused by the
    validator. `hold` (`engine.hold(id, who, {note, until})`) is for the task's creator or an admin ("Only whoever made it, or an admin, can put a task on hold"),
    `unhold` for anyone signed in; both resolve to a refusal string. Moves out of `on_hold` clear `hold`.
  - `task.delete`: only by its creator or an admin. It is refused while running; workers at rest go home first
    (`engine.sendWorkersHome(id, who, 'delete')`), their worktree and branches stay. Its attachment files are deleted too.
  - `comment.add`: stored, attachments linked, `kanban.comment` pushed and `kanban.ok {commentId}` sent;
    then `engine.commented`.
  - `plan.approve {planId}`: only the latest plan version can be approved.
  - Start, stop, continue, retry, review, plan approve and request-changes and pr go to
    `ctx.engine`. A returned string becomes `kanban.error`. `task.continue` and `plan.requestChanges` take
    `attachmentIds?` like `comment.add`. The files are resolved first without linking; the message
    (its text plus the files' grant paths, as one `answer` / `text`, so a replan sees which files are new)
    goes to the machine, and only if that is accepted does the engine add the user's comment and link the
    files to the task and the comment, with a single broadcast. A refused request leaves no comment and no
    links. Either may be empty when the other is there. The replan prompt has no `{{attachments}}`.
  - `task.vscode {id}` and `worker.vscode {workerId}` (admins only) open the task's or worker's folder in
    VS Code on the office's machine (`src/server/kanban/vscode.ts`): one worktree, or a generated
    `.code-workspace` of all its repositories' worktrees (in `<data>/kanban/workspaces/`), or the project's
    checkout(s) before the task has run; an ordinary worker's worktree or workspace, else the floor's checkout.
    Answered with `kanban.ok`, or `kanban.error` when VS Code can't be found or started.
  - `pr.bundle {project, taskId | branch | ticket, includeClosed?}` (integrations/pulls): the PRs that belong
    together across the project's repositories, open and draft ones only unless `includeClosed`; answered with
    `kanban.pr.bundle` (an `error` in it rather than `kanban.error` when the lists couldn't be read).
  - `pr.owner {project, repo, number}` (integrations/pulls): which task owns a PR, for the PR window's
    "Fix via task #N". Answered with `kanban.pr.owner {taskId: number | null, title?, fixable, reason?}`:
    the project's tasks linked to the PR (by repository, repoId or URL: `prOwners`), the newest not archived (none: `taskId` null);
    `fixable` is `canFixPrs` (shared/kanban/prs.ts: not running, not asking in its terminal, in Waiting, Review or
    Done, with an open or draft PR that isn't a fork's: the server passes the floor's polled PRs, `isCrossRepository`) and `reason` says why not. The action itself is `pr {id, mode: 'fix'}`.
  - `pr.review {project, prs, taskId?, tool?, model?, effort?, panel?}`: checked by integrations/pulls (the
    project exists, every PR is in one of its GitHub repositories and exists, each once, at most 20, `taskId`
    is the project's), then run by the engine (`engine.reviewPrs`, §4) and answered with
    `kanban.ok {taskId, workerId}`: the review's task (the given one, or a new `investigate` task) and its
    reviewer (no `workerId` when the review is queued for a desk or the worker limit). With `panel: true` it goes to the floor's meeting room instead (upstream's 🤝 review panel;
    its brief, the layered `kanban.pr.panel` prompt (office + project layers), lists every PR, the review is
    posted on one of the primary repository's; a single PR from the office's PR board keeps upstream's `pull.panel`) and is answered with
    `kanban.ok {}` (`taskId` when one was given, which also gets a status comment).
  - `issue.transitions | transition | comments | comment | people | assign` (`{project, issueKey, …}`, defined with the
    `issues.*` messages in `shared/kanban/issueops.ts`; handlers in `integrations/issues/actions.ts`; for anyone signed in) act on one
    issue of an issue source. The reads are answered with `kanban.issueTransitions {current?, transitions, cannot?, note?}`,
    `kanban.issueComments {items, cannot?}` and `kanban.issuePeople {items, cannot?}` (names of their own, so no
    answer is mistaken for a request; `cannot` says why nothing can be offered, `note` that some choices were left
    out); the writes with `kanban.ok`. A transition id is opaque to the browser: Jira's number,
    `p:<projectId>:<itemId>:<fieldId>:<optionId>` (a Projects v2 Status option, checked again against a fresh read before
    it is written) or `gh:close` / `gh:close:not_planned` / `gh:reopen`.
    - Only keys on the project's cached list are accepted. **Routing is by key**, not by `sourceId` (the list keeps one
      source's copy of a key two sources both list): a Jira key goes to Jira (the site of the project's Jira source),
      `ghp:…` to the board's Status, `gh:owner/repo#N` to GitHub for comments and assignees and, for its status, to the Status
      options of the project's `github-project` sources that hold it (`projectItems`) plus GitHub's close / reopen.
    - Identity: Jira always uses the kanban-secrets token; GitHub runs as `KanbanContext.ghAs(accountId)` (wired from
      `signins.ghAs`): `{env}` is the person, `undefined` the office's gh, a string refuses with it. Under a shared identity a
      comment is signed `— <name> via Agent Office`.
    - A write patches the cached issue (an **overlay** per key: status, assignee), pushes `kanban.issues`, tells the
      3D board (`wallChanged`, then a debounced `refreshWall`), toasts the floor and adds a status comment to the issue's task.
      The overlay is dropped when a fetch that started 10 s or more after the write completes without source errors, or after
      2 minutes, so a fetch under way (or Jira's lagging search) can't undo the change.
  - `browse.scopes | options | groups | count | page | children | issue | people` (`{project, scope, …}`, defined in
    `shared/kanban/browse.ts`, joined into the unions by `issueops.ts`; handlers in `integrations/issues/browse/`; for anyone
    signed in) browse **all** of a source's issues, not just its list. `scope` is an `IssueSourceConfig.id` of the project: only a
    `jira` source with project keys and a `github-project` source can be browsed (`kanban.browse.scopes` lists them as
    `kanban.browseScopes {scopes, me?}`; one that can't has `disabled` saying why). Every message is stateless and paged: a
    `cursor` is Jira's `nextPageToken` or GitHub's `endCursor`, opaque to the browser and bounded in the parser. Answers:
    `kanban.browseOptions` (filter choices), `kanban.browseGroups` (the top-level tree nodes, no counts), `kanban.browseCount`
    (one approximate count; `count` is missing when the source couldn't tell), `kanban.browsePage {items, next?, total?}` (for
    `page` and `children`) and `kanban.browseIssue {issue}` (the full record with its `taskId`); `browse.people` is answered
    with `kanban.issuePeople`. Jira JQL is built on the server: the source's project keys come first and are never optional,
    and the user's `jql` is checked (`checkUserJql`: one complete expression, no backslash outside a quoted literal) and AND-ed in
    parentheses. As a second line, every issue a Jira search or read returns must be in the source's projects (its `project`
    field, else the key's prefix) or it is dropped (a single issue is refused), and `browse.count` answers no count for raw JQL.
    - **Sub-tasks and context.** A top-level Jira page is a page of the group's *stories*, with the group's clause as it is
      when nothing narrows (`fixVersion = V`, `parent = E`; no relaxing for sub-tasks), so a page is never empty while `next`
      exists (but for the epics dropped by "No epic", below) and the sub-tasks never decide what is on it. A second scoped search
      then brings the sub-tasks that match the filters for **that page's stories only** (`issuetype in subTaskIssueTypes() AND
      parent in (<page keys>) AND <filters>`, all of them, up to 4 pages of 50), returned after their story; a sub-task has no
      version or epic of its own, so those clauses are left out of it. A search narrowed beyond the status category (text, type,
      status, assignee, labels, sprint, raw JQL) can match a sub-task whose story doesn't. Jira has no "parents of", so the
      matching sub-tasks of the scope (the 100 last updated, key and parent only, cached a minute) are asked for first and the
      page lists the stories that match **or** are one of those parents (`(<filters> OR key in (…))`); a story that doesn't match
      itself (one more `key in (…) AND <filters>` search) is flagged `context: true` (the tree nests the sub-tasks under it; it
      counts as neither done nor total). The trade-off: a sub-task beyond those 100 isn't reached through a story that doesn't
      match (narrow further; the story's own children are one click away), and a sub-task that matches only the status category
      (the default *Not done*) under a story that doesn't is not listed, since the stories decide there (otherwise every open
      sub-task of the project would be a lookup on every page). A page costs 2 searches (the stories, their sub-tasks), 4 with a
      narrowing beyond the category. `browse.count` answers no count (`{}`, no Jira call) for a search narrowed by more than the
      status category (the rows include stories a count can't see) and for raw JQL; otherwise it counts the top-level issues that
      match with the same strict clause the page pages by, as `groupByEpic` counts. "No epic" (`parent is EMPTY`, true of epics too) adds
      `issuetype != Epic` and the page drops what `isEpic` says is one (a renamed type); a site with no `Epic` type 400s on that
      clause, and so does a text like `UTF-8` with the `key = "UTF-8"` clause (it is added only for a project of the scope), so a 400 on
      a page that has either clause is retried once without them (`where.lenient`; the count of such a search is then missing).
      User JQL may call only `currentUser, openSprints, closedSprints, futureSprints, subTaskIssueTypes, standardIssueTypes, now,
      startOf/endOf Day|Week|Month|Year` (`checkUserJql` refuses any other name before a parenthesis, quoted or not): `membersOf`,
      `issueFunction`, the versions functions and so on would read beyond the scope. A context copy of an issue never replaces the matching record when pages are merged
      (`mergeIssues`), so a story that matched on one page keeps its place in the epic's totals. `groupByEpic` nests an item whose `parent.key` is another loaded item under it.
    - **Caches.** In memory per office: counts (Jira and GitHub, `items(query:){totalCount}` with no nodes), a board's iteration and
      Status fields, the Jira versions per source page and the sub-task parents live 60 s (500 entries at most; a failure is never kept); the
      Sprint field id lives until the office restarts (a failed ask is forgotten at once, a site without one is asked again in a
      minute); a person's GitHub login 10 minutes (a failure not at all). `load` (below) remembers a key it found nothing for for 60 s.
    - **Tasks.** Every item of a `browsePage` (and each `parent`) carries `taskId` when a task was made from it.
    - **GitHub scope.** An issue may be opened or expanded when it is an item of the scope's board **or** its parent chain
      (`Issue.parent`, up to 8 levels, GitHub's maximum nesting) reaches one; any other key is refused. A completed iteration named by the `iteration`
      filter comes back as its own group.
    - **Actions and the browsed cache.** `issue.*` and `issues.createTask` accept an issue that is on the project's list, one
      acted on lately, **one opened from Browse** (`kanban.browse.issue` keeps it in a bounded per-project set, 300 issues for
      12 hours, the oldest let go first), or else one the server **loads again** from a source of the project (within that
      source's scope: its project keys, its board; a GitHub issue and its parent chain are read once and tested against each board).
      A key outside every source's scope is still refused, and a key that wasn't found isn't asked for again for a minute. A write patches the
      browsed copy as it does the acted-on one. **An issue opened from Browse can be queued, carried or handed to a worker even if
      the source's filters leave it off the board, so its text can reach an agent's prompt once a person starts it** (accepted: a person acts, and the scope
      is the source's own).
  - `issues.list`, `issues.refresh`, `issues.createTask` (idempotent by ticket, archived tasks included, `kanban.ok {taskId, existed}`; `start` with `deskId` starts it, or the one already made while it waits in To do, at that desk: the 3D office's P with a card; `started` or `startError` says how it went),
    `skills.list` are for anyone signed in.
    - Taking the issue (`integrations/issues/autoassign.ts`), after the answer:
      - when: a new task, or a To do one started from its card (not a start that failed);
      - who: the person, under their own gh sign-in (the office's shared gh, or no sign-in: skipped);
      - only if: an open GitHub issue (not a pull request, a draft or Jira) with no assignee, read fresh;
      - result: a floor toast, a status line on the task and the overlay (as any write above);
      - failure: a warn toast to the person only.
  - `meta.get` (anyone signed in) is answered with `kanban.meta {projects, settings, secrets, me}`: what a
    snapshot says besides the cards, for ⚙️ Settings on a page without a board (the 3D office).
  - The same cached issues are the 3D issues board of a project with issue sources
    (`integrations/issues/wall.ts`): the floor's upstream `gh.issues` carries them as `GhIssue`s with
    `key`, `source`, `status` and `taskId` (`number` only for a GitHub issue of one of the project's
    repositories, else 0), and falls back to upstream's list without sources. Cards are handed out with
    `issueKey` (see kanban-coupling.md, Messages). `Floor.cardKey` accepts a key the wall lists **or** one the project knows
    within its scope (`wallKnows`: on the list, acted on, or browsed, though the filters keep it off the wall), so queueing,
    carrying or handing a browsed issue keeps its `issueKey` (its text can then reach an agent's prompt, see above); any other key is dropped.
  - Admin only (upstream `meOf(accountId).admin`): `settings.set`, `project.settings.set`, `project.repos.set`,
    `project.rename`, `project.prompt.set`, `secrets.set`, `skills.sync`. `secrets.set` is answered with `kanban.settings` (configured flags
    only). The `/api/v1` key is stored as `sha256:<hex>`.
- Auto-archive: done tasks whose `doneAt` (else `updatedAt`) is older than `settings.archiveAfterDays` move to
  `archived`. This runs at start-up and hourly; `0` means never. Unattached uploads older than a day are removed
  in the same sweep.

## 7. Prompts

Every prefilled prompt is a `PromptDef` in `src/shared/kanban/prompts.ts` (group `kanban`), spread into
upstream's `DEFS`, so the upstream prompt editor shows it. Layering: default → office-wide custom
(upstream `prompts.json`) → project override (`kanban-settings.json` `projects[id].prompts`). Contract
blocks (markers, safety rules) are appended by the engine and shown read-only in the editor.

`kanban.unhold` ("Carry on after a hold": `taskId`, `heldAt`, `holdNote`, `comments`, `language`) is the prompt a task taken off hold resumes with (§3, §4).

## 8. Agent-facing endpoints

On the loopback hook server (worker bearer token, like `/office/workers`):
`GET /office/tasks/reference?ref=[&tail=1]`, `GET /office/tasks/search?q=`, CLI `office-tasks` (on every
worker's PATH), MCP tools `get_task`, `search_tasks` (listed when the worker has `AGENT_OFFICE_TASKS` (every agent
worker gets it) or `AIKANBAN_API_BASE`; Claude task workers get them in `--allowedTools`). A plan phase gets the tasks its text refers to
written to `kanban/refs/task-<id>/referenced-tasks.md` (it can't call anything).

`POST /office/tasks/create?worker=` (JSON body `{title?, description?, project?, repos?, issue?, ticket?, ticketUrl?,
provider?, model?, effort?, type?, start?, desk?}`; the same bearer token) creates a task: CLI `office-tasks create`,
MCP tool `create_task` (listed with `AGENT_OFFICE_TASKS`; never pre-approved, so a desk or board Claude agent asks, while a task's
worker runs without prompts). The route is owned by
the issues plugin (integrations/issues/agent-create.ts) and the creation itself is shared with the board's
`kanban.task.create` and the issues board (src/server/kanban/create.ts). The task lands in To do; `start` seats a worker
(or queues), except for a task's own worker, which can't start tasks (the answer's `note`; the parent task gets a `subtask.created` event and a comment).
The creator is the requesting agent's account, else the parent task's creator, else the desk worker's hirer, else the
agent's name; the agent is in the `created` event (`via`) and the toast. An `issue` is claimed like one made from the
issues board, after the answer has gone (as the board does), so a slow GitHub can't time the agent out. See docs/kanban.md "Agents creating tasks".

User skills (integrations/userskills/): a plugin that syncs the repository's `user-skills/claude/*` and
`user-skills/codex/*` into the machine's `<claude home>/skills/` and `<codex home>/skills/` (the same homes
`defaultRoots` finds), marking its copies with `.office-user-skill.json` (the source hash, `skillHash(dir, { exclude: USER_SKILL_EXCLUDES })`):
a marked or ai-kanban (`.aikanban-sync`) copy is overwritten (hand edits too) when the source changed, an unmarked
one or a symlink is left alone. Copies are built in `<home>/.office-user-skills-tmp/<folder>-<pid>` (outside the scanned
`skills/`) and renamed in, the old one set aside and removed, the target's `node_modules` moved over; stale temp
entries of dead pids are removed at the start of a sync. Files removed from the source disappear. `start()` defers the
sync with `setImmediate`. `AGENT_OFFICE_USER_SKILLS=off` disables it; a source whose repository root has `.git` as a file (a
linked worktree) is skipped unless it is `on` (a main checkout or no git at all syncs). The same function guards the
admin's 🔄 Sync: the plugin registers itself with `onSkillsSync` (skills/index.ts) in `start()` and unregisters in `stop()`,
so the dependency runs userskills -> skills only. See docs/kanban.md.

Compatibility for existing ai-kanban skills/scripts (integrations/compat/v1.ts): task workers get env
`AIKANBAN_API_BASE` (the hook server URL) and `AIKANBAN_TASK_ID`.

- `GET /api/tasks/reference?ref=`: ai-kanban's response shape, read-only, no key, never a terminal tail.
- A task on hold shows as "On hold" with its note and date (the reference bundle's `hold`, `office-tasks` and the plan phase's
  `referenced-tasks.md`); in `/api/v1` it is `waiting` (legacy status, so `?status=waiting` lists it too) with `statusTitle` "On hold", and it is not `active` nor in `scope=active`.
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

For a signed-in browser (the session is checked by the route table in `src/server/http/routes/index.ts`, where `kanbanRoutes` from `src/server/kanban/http/routes.ts` sit, and non-GET requests must be same-origin):

- `GET /kanban`, `/kanban.html`: the board page. Signed out, it redirects to `/login?next=/kanban`.
- `POST /api/kanban/upload?name=<file name>[&task=<id>]`: the body is the file's raw bytes and `Content-Type`
  is its type (sniffed from the extension when missing). At most 20 MB. It returns `200 {attachment}`, or
  `400/404/405/413 {error}`. The file is stored as `<filesDir>/uploads/<id>-<ascii name>` with mode 600. Agents never get that shared folder: each task has `<filesDir>/grants/task-<id>/` (mode 700, `uploads.grantFiles`, cloned/copied from the uploads when a launch or a prompt needs them), and every launch of the task gets that one as an `--add-dir`, so files sent later are readable. It goes with the task (`task.delete`). The uploads folder is chmod 700 at start-up.
  Without `task` it stays unattached until `task.create` / `comment.add` names its id.
- `GET /api/kanban/attachments/<id>`: serves the file with its type, `nosniff` and a sandboxing CSP.
  PNG, JPEG, GIF, WebP, AVIF and BMP are served inline; anything else (SVG and HTML included) as a download.
- `GET /api/kanban/tasks/<id>/changes[?repo=<repoId>]`, `…/commits?repo=`, `…/commit?repo=&hash=`, `…/uncommitted?repo=`
  (integrations/changes): the task's repositories; one repository's files and unified diff against its base
  (cut at 2 MB, `truncated`) plus the worktree's uncommitted work (`workingTree`, null without a workspace);
  `base..branch` commits; one commit's diff (`hash` must match `^[0-9a-f]{7,40}$` and be in `base..branch`);
  how many files the worktree has uncommitted against HEAD (`git status` only, null without a workspace).
  Read from the task's worktrees, else its branch in the project's checkout (`origin/<base>...<branch>`, else
  the local base). git runs with argument lists, no shell, timeouts, `GIT_OPTIONAL_LOCKS=0`; a `git fetch` of
  the checkout runs in the background at most every 5 minutes and is never waited for. The list carries the
  task's `project` and each repository's `primary` flag (primary first), so the browser can match a repository
  to upstream's floor id (`<project>~<repoId>`, none for the primary; `shared/kanban/repofloor.ts`). The task's
  Changes view (`client/kanban/changesview.ts`: the task view's Changes tab, and the window C opens at a task
  worker) reads these, and upstream's live `changes.*` WebSocket messages instead for All changes while the
  worker is on the page's floor. Live, what's uncommitted is the `uncommitted` count (the live list's flags
  when the worker works in the shared project folder, or until the count is read again after an update);
  Per commit, and Uncommitted's diff (the worktree against HEAD) while it is open, are read again a moment
  after the live state changes (the commits only when its `head`, count or subject moved: an amend too).
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
closes the database. `startServer` (`src/server/server.ts`) calls `openKanban` (`src/server/kanban/office.ts`) once
the floors are open and keeps the result as `ctx.kanban`; `kanbanHandlers` (WS, `kanban/ws/handlers.ts`) and
`kanbanRoutes` (HTTP, `kanban/http/routes.ts`) join the office's own registries.

"O" at a desk (`worker.pr`, `src/server/ws/handlers/workers.ts`) goes to `engine.prForWorker` first: a task worker's task gets its `pr` phase
(`engine.pr(taskId, 'create')`); any other agent worker gets the layered `kanban.pr.create` prompt (with the `pr`
contract) typed into its session, or resumed with it when it's asleep. Only a shell worker answers `'fallback'`
(`PR_FALLBACK`), and only then does upstream's own `openPr` (a draft PR without an agent) run. PR states of the
tasks' linked PRs follow the floor's PR board (`floorPulled` → integrations/pulls `syncPrStates`): their states, and PRs from an active task's branch that no task has yet (and that aren't a fork's) get linked to it.

## Next merges

Follow-ups not done in #327:

1. The board into the same app shell as the 3D office and lite (`kanban.html`, `kanban/main.ts`, `officecss.ts`).
2. The `KanbanWorkers` base class of `WorkerManager` becomes composition.
3. The two Changes windows become one.
4. The three `git()` helpers, and the two PR-tracking paths (kanban `pr_links`/`pulls` vs GitHub/MergeWatch), become one.
5. The `kanban/registry.ts` and `coupling.ts` indirection layers go.
6. Storage: the task↔worker link lives both in `kanban.sqlite` (`tasks.worker_id` …) and in each project's
   `.agent-office/workers.json` (`WorkerInfo.kanban`), reconciled in `orchestrator.reconcile()`. One owner of the
   link, or the workers in the same SQLite.
