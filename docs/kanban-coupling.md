# The kanban and the 3D office: one world, two views

Back to the [README](../README.md). See also [kanban-architecture.md](kanban-architecture.md).

The kanban is **another UI of the same office**, not a separate app. A kanban task is carried out by
an ordinary worker at a desk; whatever happens to that worker in 3D is an event on the task, and
whatever happens to the task shows on the worker. This page is the contract between the server
(engine), the 3D client and the kanban page.

## Identity

- `WorkerInfo.kanban` links a worker to its task:
  `{ taskId, role: 'implementer' | 'reviewer', title?, status?, phase?, round?, rounds?, waitingReason?, retryAt? }`.
  The engine keeps the summary current (`WorkerManager.setKanbanSummary`), so it reaches every 3D and
  /lite client through the ordinary `worker.update` — the 3D client needs no kanban subscription for it.
- A task has at most one implementer and one reviewer at a time. Most workers have no task; a worker
  gets one only on opt-in (the hire toggle, an issue card turned into a task, or the kanban's Start).

## 3D actions → task events

| 3D action | Rule |
|---|---|
| **X** send home (any path: WS `worker.kill`, HTTP/CLI home, queue recycle, meetings, leave-on-merge, engine releases) | One path: the intent `{ by, done?, reason }` is recorded on the worker before it goes and read by the engine's `removed()`. Exactly one status comment per departure. |
| … implementer, no live run | `kanban.done === true` → task **done**. Otherwise it keeps its column (in_progress without a run → waiting). Only X (`reason: 'sent-home'`) clears `retryAt`: a release (the Release button, a move to done) or the office's own recycling leaves a usage-limit auto-resume due, and the sweep hires a new worker for it. |
| … implementer, live run | The run is **stopped** ("<by> sent <name> home"), task → waiting with Retry — or done when `done === true`. |
| … reviewer | The round is abandoned; queued messages are delivered, otherwise task → review. |
| … leave-on-merge (`reason: 'merged'`) | Task → done only when every linked PR is merged and none is open or draft. Workers of in_progress tasks or tasks with a live run are never picked. |
| Worktree cleanup | Forced to `keep` while another worker of the same task sits in that worktree or a run is live. When the worktree was deleted, the task's workspace is dropped; its branch is kept only if it still exists locally or on origin. |
| **P** / issue card drop / Ask onto the implementer | Only while the task is in progress, waiting or in review: the fork's dialogs (P's "💬 Message task #N", Ask → that worker, the task's own issue card dropped on its desk) send `asComment: true`, and it becomes a task comment (the engine follows the turn and reviews it; the card's issue is still claimed). "Type straight into the terminal instead", the terminal's own say box and every other caller send upstream's plain prompt, typed in. For a task in To do, done or archived the client offers upstream's plain prompt, and the server refuses an `asComment` prompt with a clear message (nothing is stored). A reviewer refuses `asComment` prompts only. |
| **R** on a task worker whose task waits | `engine.retry`. |
| **O** | The task's PR phase (unchanged). |
| **C** / 🌿 Changes | Upstream's `openChanges()` hands a task worker over to the task's Changes window (`kanban/changesview.ts`, `openTaskChanges`): every repository of the task as a tab, All changes / Per commit / Uncommitted; upstream's live data (`changes.watch`, commit, discard, PR) while the worker is on the page's floor and the repository is in its workspace, else the office's `GET /api/kanban/tasks/<id>/changes|commits|commit` (read-only); Per commit and Uncommitted (the worktree against HEAD) always read over HTTP, again when the live state changes (`ChangesState.head` notices an amend). If the worker goes while it's open, it carries on from HTTP. Ordinary workers keep upstream's window. |
| **E** | The worker window has tabs **🖥️ Terminal** / **🗂️ Task #N** (opening on the Task tab): the task tab is the same task view as the kanban page (description, conversation with composer and history, plan, runs and verdicts, PRs, actions) without its Changes tab; the window's 🌿 Changes button opens the task's Changes window (above). Files dropped on the task pane go to its composer's attachments, never into the terminal. |
| Hire at a desk with "🗂️ Run as a kanban task" | `kanban.task.create {…, start: true, deskId}`: the task starts at that desk. The toggle starts off in every new dialog. |
| 📋 Task queue with "🗂️ Run as a kanban task" | `kanban.task.create {…, start: true}` without `deskId`: the engine seats it at the next free desk or queues it (tasks at once, desks, the worker limit). The queue's *workers at once* doesn't count it, and upstream's queue never holds it. The toggle starts off each time the board opens. |
| J | Facing a task worker's desk: `/kanban?project=<floor>&task=<id>`; elsewhere: the board. |

## Whose account a hire runs as

Every hire for a task runs as the task's **creator** (`tasks.created_by_account`), whoever set it off:
Start, a comment, Continue, Approve, Retry, the queue's drain or the usage-limit sweep. A commenter only
authors the comment; the new hire runs on the creator's sign-ins and resumes the creator's session.
A task with no creator account (made on the shared password, or migrated) runs as the caller's
account, or on the office's own sign-in when there's no caller account either. Upstream's sign-in
rule stays: when the creator isn't signed in to Claude, nothing is hired on the office's sign-in
instead; the task waits (failed) with upstream's reason, naming whose sign-in is missing
("Task #14 runs as its creator, Ada, whose Claude sign-in is missing. …").

## Task events → 3D

- Moving a card to done or archived sends the task's idle workers home with cleanup `keep`. A run still
  live then (its agent asking in its terminal, worker `needs_input`) is finished as `stopped` with a status
  line, and that worker goes home the same way (reason `released`); the task keeps no run state, worker or
  queued run. A worker that is really working has its task in progress, which can't be moved.
- A task that can't get a desk, or finds the office's worker limit full, is **queued** (runState
  `queued`) and starts when a desk or capacity frees, as its creator's account. A task counts once
  against the worker limit: its reviewer is hired past it while its own implementer is at its desk
  (`SpawnExtra.countsWith`), and counted once there. Moving it to done,
  archived or To do (or the auto-archive) takes it out of the queue (runState `idle`, no `queuedRun`),
  and the drain looks at the task's column again before it hires: a task out of the process is
  dropped from the queue, never hired for.
- The desk card and worker label show `🗂️ #14 · <status/phase> <round>/<rounds> · <waiting reason>`.
  N ("next waiting") includes task workers waiting on a person.
- "📍 Show in 3D" on the kanban opens `/?floor=<id>&worker=<workerId>&desk=<deskId>`; the 3D client
  goes to that floor and that desk.
- The 📋 queue board's form can make a kanban task (above), and its "🗂️ Kanban on this floor" section
  lists the floor's task workers and the started tasks waiting their turn (`runState: 'queued'`, no worker
  at a desk yet), read with `kanban.snapshot` while the board is open (never `kanban.subscribe`, which
  would take the connection's one delta filter). Upstream's queue itself is unchanged.

## Messages (additive)

- `worker.kill {workerId, cleanup?, kanban?: {done?: boolean}}`
- `worker.prompt {workerId, prompt, issue?, asComment?: true, issueKey?}`: typed in as upstream by default;
  `asComment` makes it a comment on a task worker's task. The earlier `raw` flag is gone: an older
  client's `raw: true` is ignored and types in, which is what it asked for.
- `issueKey?` on `carry`, `worker.spawn`, `worker.prompt` and `queue.add` (and `CarriedIssue.key`,
  `QueueTask.issueKey`): the ticket key of a card from the project's issue sources on the 3D issues board
  (`issue` is then only for one of the floor's own GitHub issues). A card dropped on a task worker is its
  task's own when the task's ticket is that key.
- `kanban.task.create {…KanbanTaskInput, deskId?}`, `kanban.task.start {id, deskId?}`
- `kanban.task.update` accepts tool/model/effort (and the review override) whenever no run is live.

## The shared task view

`src/client/kanban/taskview.ts` exports `mountTaskView(container, { net, taskId, embedded })`, the task
detail used by both the kanban page's side panel and the 3D worker window's 🗂️ Task tab. It fetches
with `kanban.task.get`, follows `kanban.*` deltas for that task (it subscribes to the task's project
itself and unsubscribes on unmount) and returns `{ destroy() }`. Embedded, it hides what the worker
window already has (its own terminal) and keeps everything else; the worker window also passes
`changesTab: false`, since its header's 🌿 Changes opens the same Changes view (`kanban/changesview.ts`)
that the task view's Changes tab mounts (`mountChangesView`; destroyed when another tab opens, so its
live watch ends with it). An agent asking a question in its terminal gets
the **Answer the agent** box in both (typed into its terminal, the same run carrying on; a permission
prompt only says to answer it in the terminal); its **⌨️ Open
its terminal** is the window's 🖥️ Terminal tab in 3D (the task's other worker: a toast says to open it
at its desk).
