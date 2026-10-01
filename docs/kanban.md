# The kanban

Back to the [README](../README.md). How it's built: [kanban architecture](kanban-architecture.md).
Coming from ai-kanban: [migration](migration.md).

The kanban is a task board beside the 3D office. A task goes through a fixed process run by agents
at desks on the project's floor: **plan → implement → review rounds ⇄ fix → Review column → Done**.
Every agent is an ordinary office worker with a live terminal, so you can watch it, type into it or
walk up to its desk in the 3D office.

## Opening it

- In the 3D office: **🗂️ Kanban** in the **☰** menu (Tab), or press **J**. It opens on the project of
  the floor you're on.
- From the 2D view (`/lite`): **🗂️ Kanban** in the top bar.
- Directly: `/kanban` (the project you picked last), `/kanban?project=<floor id>`, `/kanban?task=14`
  (opens task #14's detail; `&tab=changes` on that tab: `conversation`, `plan`, `runs`, `terminal`,
  `changes`, `prs`), `/kanban?settings=1` (opens ⚙️ Settings on **🗂️ Kanban**).
- **🏢 3D** in the kanban's top bar goes back to the 3D office, on the floor of the project you're
  looking at.

Signed out, `/kanban` sends you to the sign-in page and back.

The top bar has the project picker (or **All projects**), a search box (`#12`, words, a ticket id, a
repository; **/** focuses it), counts (🗂️ on the board, 🚧 running, 🙋 waiting on you, 👀 ready for
review), **📌 Issues**, **＋ New task** (**N**), filters (repository, state: running / needs you /
waiting to retry / has a PR, agent, ticket or not), **🗄️ Archive** (shows archived tasks as a
column) and **⚙️** Settings (the office's own window, as in the 3D office). Keys: see [Controls](controls.md#in-the-kanban-view).

## Columns and moves

| Column | Means |
|---|---|
| **To do** | Not started. Can still be edited. |
| **In progress** | The engine is running a phase (plan, implement, review, fix…), or the task is queued for a slot. |
| **Waiting** | Needs you: the plan has questions, the plan waits for approval, the agent asks in its terminal, it was stopped, a phase failed or was interrupted, or a usage limit (it retries by itself, with a countdown). |
| **Review** | The automation is finished. Read the result, comment, run another review round, open PRs, or move it to Done. |
| **Done** | Accepted by you: you move it here, send its implementer home with *the task is done*, or leave-on-merge sends it home once every PR of the task has merged. |
| **Archive** | Done tasks after the archive days, and tasks archived by hand; off the board (**🗄️ Archive** shows them). |

Drag a card, use its **⋯** button, or press **M** on a focused card. Columns a card can't go to are
greyed out with the reason. What you can do by hand:

- **To do → In progress** starts the task.
- **Waiting / Review → Done**, **Done → Review**, **Archive → Done**.
- **Waiting / Review → To do** starts over: the automation's state (phase, round, sessions, worker ids,
  queued comments, retries) and the workspace are cleared; the branch stays, and the next start gets
  a fresh worktree whose agent checks that branch out first. Not while it runs, and not while a worker
  is still attached (**🏠 Release worktree** first).
- **Anything → Archive**, except while it runs.
- Not allowed: To do ↔ Done, and moving into In progress, Waiting or Review any other way (use
  Continue, Retry or a comment).

Done tasks go to the archive by themselves after the *archive after* days in the settings.
Moving a task to Done or to the archive (by hand or by itself) sends its workers that are at rest
home, worktree kept. An agent still asking in its terminal (the task waits with *the agent is asking*)
goes home too: its run is stopped, with a line saying so, and nothing of the task stays running.

## Creating a task

**＋ New task** (or make one from an issue: see *Issue sources*). Fields left unset take the project's
and the office's defaults.

- **What**: title (required), description (Markdown; paste or drop screenshots and files, up to 20
  files of 20 MB each), ticket (`UYT-1415`, `gh:owner/repo#12`) and ticket link.
- **Where**: the project (fixed once made) and which of its repositories (all by default; the primary
  one is always included).
- **How**: type **Implement** or **Investigate** (read-only: writes a report instead of changing code;
  no plan, review or PRs), **Plan first** and **Plan approval** (implement straight away, or wait for
  your approval), **Review rounds** on/off, **Choose the reviewer** (agent, model, effort, 1–10
  rounds, review the last fix too) and **🎯 Acceptance criteria** (the agents check the work against
  them).
- **Who**: the agent (**Claude** or **Codex**), model and effort.

**Create** puts it in To do; **▶️ Create and start** starts it at once. A task in To do can be edited
(**✏️ Edit**); its repositories only before its first start. From the first start the description is
locked (add to it with a comment), and a task moved back to To do can be edited again apart from
those two.

In the office, a hire at a desk and the **📋 Task queue**'s form can tick **🗂️ Run as a kanban task**
(type, plan, review rounds and repositories; the agent is the form's own, Claude Code or Codex): the
task is made and started at once, at that desk or, from the queue, at the next free one.

## The process

1. **Plan** (when *Plan first* is on): the agent plans read-only. It ends with the plan (the line
   `PLAN READY`), or with `QUESTIONS:`. Questions put the task in Waiting: answer in the box and
   **Send the answer**, or **▶️ Continue without answering** (the agent makes and names its assumptions).
   With plan approval *wait for approval* a finished plan waits for **✅ Approve the plan** or
   **✍️ Request changes** (the Plan tab); *implement straight away* accepts it by itself. The answer
   box and the change request take files too (📎, paste or drop): they go to the planner as their paths.
2. **Implement**: the agent works in its own worktree (a workspace with a worktree of each repository,
   on the same branch), commits, and says what it did. If nothing differs from the base branch in any
   repository, there's nothing to review and the task goes to Review.
3. **Review rounds**: a reviewer (its own worker, tool, model and effort, sharing the task's worktree)
   reviews and ends with `REVIEW: APPROVED` or `REVIEW: CHANGES_REQUESTED` (no verdict counts as
   changes requested). Only the reviewer's final answer counts, and only a verdict line of its own at
   its end: one quoted (`>`) or in a code block, or said in an earlier message, is none. Changes requested → the implementer **fixes** → the next round. After the last
   round's fix the reviewer looks once more if *review the last fix too* is on; otherwise the task goes
   to Review. In the 3D office the reviewer takes no desk: it walks in and stands behind the
   implementer's chair, looking over its shoulder at its screen (E there opens the reviewer's terminal),
   so a review round never needs a free desk. Only when the task has no desk yet (its implementer never
   sat down) does the reviewer take the next free seat.
4. **Review column**: read the result. **🔍 Run a review round** runs one more round by hand (it ends
   in Review). **🔀 Create PRs** / **🛠️ Fix PRs** start the PR phase (see below). **🗜️ Compact**
   compacts the agent's session. **🏠 Release worktree** sends the task's workers home and keeps the
   worktree for later. Move it to **Done** when you accept it.

When the agent asks something in its terminal (Waiting, *the agent is asking*), answer it there, or,
when it asks a question, in the **Answer the agent** box (**⌨️ Open its terminal** is next to it): the
answer is kept as your comment and typed into its terminal, as if you typed it there, and the same run
carries on (the task is In progress again once the agent goes on; a question with several parts keeps
it waiting until the last is answered). The box takes files like a comment: their paths are typed in
after your answer. A comment on the task does the same (its files' paths too). When it asks for a
permission (or the office can't tell what it waits on), the task says *answer it in its terminal*
with **⌨️ Open its terminal** and no answer box: nothing is typed for you, since Enter would pick the
prompt's highlighted option. A comment then is kept and goes to the agent once that turn is over.
There is no Continue without an answer then: its run is still going.

A task stays In progress while the agent's background helper agents still work, until the agent has
answered after them (at most 3 hours, then it goes on with what the agent said). ⏹️ Stop during that wait
sends the worker home, worktree kept, which stops its helper agents too.

**⏹️ Stop** interrupts a running turn (Esc into its terminal; the worker goes home, worktree kept, if
it doesn't stop in a few seconds). A failed or interrupted phase waits with **🔁 Retry** (run it again)
and **▶️ Continue**. After an office restart a run is picked up again when its worker is still at
its desk; a run whose worker went away (or exited) is marked interrupted.

### Sending a task's worker home

A task's worker is an ordinary worker at a desk: **X** (or the CLI's `office-workers home`, the queue
making room, a meeting, leave-on-merge, 🏠 Release) sends it home, and the task hears about it. Each
departure puts exactly one line in the task's conversation, saying who sent it home and what that
did:

- **The implementer, nothing running**: the task stays in its column. Sent home with *the task is
  done*, it goes to Done. A task in In progress with nothing running waits with Retry, and one waiting
  out a usage limit no longer carries on by itself (Retry when it should).
- **The implementer mid-run**: the run is stopped and the task waits with **🔁 Retry** (or goes to Done
  with *the task is done*).
- **The reviewer**: its review round is dropped. Comments that came in while it reviewed go to the
  agent now; otherwise the task goes to Review.
- **Leave-on-merge** never picks a worker of a task in In progress or with a run going. When it sends
  one home, the task goes to Done only if every pull request linked to it has merged (none open or a
  draft).
- **The worktree**: whatever you pick, it stays while another worker of the task sits in it or a run
  of the task is going (a Retry carries on there). When it was deleted, the task forgets it and its
  sessions, and keeps its branch if git still has it here or on origin: the next run gets a fresh
  worktree on that branch.

A task done this way sends its other workers at rest home too, as moving it to Done does.

A project runs at most *tasks at once* tasks (default 2); more are **queued** in In progress and start
when a slot frees up. A task made from the office's 📋 Task queue with **🗂️ Run as a kanban task** starts
the same way, at the next free desk (the queue's own *workers at once* doesn't count it), and the queue
board lists it under *🗂️ Kanban on this floor* while it waits. A hire also needs a free desk on the project's floor and room under the office's
worker limit (`--max-workers`, ⚙️ Settings): when there's none, the start or the phase (a reviewer's
hire, say) is **queued** too, with a line saying why, and starts by itself as soon as a worker goes
home anywhere in the office (or at the next minute's look). A task counts once against the worker
limit: its reviewer never waits for the place its own implementer (still at its desk for the fixes)
holds, though it counts while it's there, so other hires still find the office full. A queued run
keeps its task's slot of *tasks at once*, so more tasks don't start meanwhile and take the desks it's
waiting for. A queued start keeps the desk it was
started at; when that desk is taken by then, its worker sits at the next free one and the conversation
says so. Later hires (after 🏠 Release, a Retry) prefer the task's desk when it's free. ⏹️ Stop takes a
task out of the queue, and so does moving it to Done (or the archive, or back to To do): a task out of
the process is never hired for. 🏠 Release keeps a usage-limit wait's auto-resume: the task still
carries on by itself when the limit resets, on a new hire; only **X** in the office turns it off.

Every hire for a task runs as **the account that made the task**, on its own sign-ins, whoever set it
off: a comment, Continue, Approve, Retry, the queue or the usage-limit resume. Someone else's comment
is theirs, but the hire it causes is the creator's (and resumes the creator's session). A task with
no creator account (made on the shared password, or migrated) runs as whoever set it off, else on the
office's own sign-in. When the creator isn't signed in to Claude, the task waits (failed) with
upstream's sign-in message, saying whose sign-in is missing, instead of starting on the office's
sign-in: they sign in under ☰ → 🔐 Your sign-ins, then Retry. Every
hire that cuts a worktree fetches the base branch first (each repository's), as upstream's hires do.
A repository with a *base branch* in the project's settings (the primary one included) gets its
worktree cut from that branch on origin, else from the local one, whatever its checkout is on; the
first prompt names it. When that branch is in neither, the start fails and says so. A repository
without one starts from the branch its checkout is on, as upstream.

When a task waits on a person, the office's team notifications (the Slack / Discord webhook of ⚙️
Settings or `--webhook`) get one line per transition: "🗂️ #14 <title> needs plan approval / has
questions / is ready for review in <project>".

### Settings

The kanban's settings are part of the office's ⚙️ Settings (from the ☰ menu in the 3D office, or ⚙️ in
the kanban's top bar, which opens the same window): **🗂️ Kanban** holds the office-wide ones (*New
tasks*, *Reviews*, *Resume*, *Archive*, the secrets and the skills the office found), **📁 Projects**
those of the project picked at its top, in the tabs **⚙️ Project**, **📌 Issue sources**, **🧩 Skills**
and **📝 Prompts**. Admins change them; everyone else sees them read-only. Changes apply to
tasks from their next phase. The review setting that applies to a task is the office's, the project's
over it, and the task's own over both.

| Setting | Where | Default | What it does |
|---|---|---|---|
| Agent, model, effort | 🗂️ Kanban → New tasks | Claude, its default | The implementer of new tasks. The default model applies only when the task uses the default agent. |
| Plan first | 🗂️ Kanban → New tasks | on | New tasks start with a plan. |
| Plan approval | 🗂️ Kanban → New tasks; 📁 Projects; per task | implement straight away | *implement straight away* (`auto`) or *wait for approval* (`manual`). Set on a task when it's made. |
| Review rounds | 🗂️ Kanban → New tasks | on | New tasks get reviewed. |
| Implementation runs | 🗂️ Kanban → New tasks; 📁 Projects | without permission prompts | How implement, fix, resume and PR phases run. *In Codex's workspace sandbox* (`-s workspace-write -a never`) only changes Codex; Claude always runs these phases in bypass mode. |
| Reviewer: agent, model, effort | 🗂️ Kanban → Reviews; 📁 Projects; per task | Claude | Who reviews. |
| Rounds | 🗂️ Kanban → Reviews; 📁 Projects; per task | 2 | 1–10 review rounds. |
| Review the last fix too | 🗂️ Kanban → Reviews; 📁 Projects; per task | on | One more review after the last round's fix. |
| Keep the reviewer off the web | 🗂️ Kanban → Reviews; 📁 Projects | on | Claude reviewers get no WebFetch/WebSearch (Bash keeps the network, for `gh`). A Codex review round always runs in Codex's read-only sandbox (no network); a Codex multi-PR review in its workspace sandbox with the network on, for `gh`. |
| Resume after a usage limit or a network break | 🗂️ Kanban | on, 5 tries, 6 hours | A turn cut short by a usage limit or a lost connection is retried by itself: at the reset time the message names (plus a minute), else after 5, 10, 20… minutes (at most an hour apart). It gives up after *tries at most* or *waits at most (hours)*; then it waits for Retry. |
| Archive done tasks after (days) | 🗂️ Kanban | 30 | 0 keeps them on the board. Checked at start-up and hourly. |
| Project name | 📁 Projects → ⚙️ Project (admin) | the repository's or folder's name | See *Projects and repositories*. The id, folder and repository don't change. |
| Repositories, instructions, tasks at once | 📁 Projects → ⚙️ Project | — | See *Projects and repositories*. |

## Comments

The Conversation tab holds your comments, the agents' results, plans, questions, review findings and
the office's status lines. A comment on a task in **In progress, Waiting or Review** puts the agent
back to work:

- The agent is at rest: the comment is its next turn (typed into its terminal, or a worker is hired
  again with the task's session and worktree). In Waiting on the plan, it's an answer or a change
  request for the plan.
- The agent is asking a question in its terminal: the comment is the answer, typed in there now (see
  above). Asking for a permission: the comment is queued until that turn is over.
- The agent is busy (a review included): the comment is queued (marked *waiting*) and delivered at its
  next rest. Comments that came in during a review are worked on when the review cycle ends, and that
  work is reviewed again when the task has review on.

On To do, Done and archived tasks a comment is just kept. Comments take attachments too,
and so do the answer box and the plan's **Request changes** (**Ctrl/⌘ + Enter** sends); files alone are enough. An agent can read only its own task's files (copies in `kanban/grants/task-<id>/`). After upgrading, a live agent session started before this change is relaunched once at its next turn (its launch arguments change); until then a file sent into it may need a permission prompt.

In the 3D office, what you tell a task's **implementer** while the task is in progress, waiting or in
review is a comment too: **P** ("💬 Message task #N"), the task's issue card dropped on its desk, and
**Ask** → that worker post it as a comment from you (`worker.prompt` with `asComment`), and the engine
follows and reviews the turn as above. Anything else typed at a worker (its terminal's say box, "Type
straight into the terminal instead", upstream's own prompts) goes into its terminal as keys and is not a
comment. For a task in To do, Done or the archive the office offers the ordinary prompt, and the server
refuses a comment sent there. A task's **reviewer** refuses comments ("… is reviewing task #N"). **R** on a task worker whose task waits with
Retry (stopped, failed, interrupted, a usage limit) is the task's 🔁 Retry. The task's agent, model,
effort and review override can be changed whenever no run is going; the next phase picks them up, and a
new tool starts a fresh session with the task's handoff.

## The detail panel

Click a card (or Enter on it). The panel's tab is kept in the page's link (`&tab=`). Its head has
**📍 Show in 3D**: the 3D office at the task's worker's desk (`/?floor=<project>&worker=<id>&desk=<id>`),
or on its floor when it has no worker. Its tabs:

- **Overview**: what it waits for (with the answer box), the actions, summary, description,
  acceptance criteria, **📑 Reports** (an investigation's report files: shown in place, Markdown
  rendered, or downloaded), attachments and details (type, agent, plan, review rounds, branch,
  workspace, queued comments, who made it). **✏️ Change the agent** there picks the task's agent,
  model and effort whenever nothing runs; the office may refuse it (the reason shows as a message).
  The next phase runs on the new ones: a new agent is hired for another agent, and the worker at the
  desk is restarted on its session with the new model and effort.
  **🔍 Run a review round** is offered in Review, and in Waiting too when the task has a worktree and
  isn't waiting on its plan.
- **Conversation**: see *Comments*.
- **Plan**: every version (draft, accepted, superseded), with approve and request-changes on the
  latest.
- **Runs**: each phase run (phase, round, role, agent, status, verdict), and the task's history.
- **Terminal**: the task worker's live terminal, as at its desk (you can type in it). A task on
  another project's floor takes you to that floor first.
- **Changes**: what the task changed, read by the office from git, with or without a worker: a
  repository picker, **Whole change** (the branch against its base, `origin/<base>` or the local base)
  or **Per commit**, and, while the task has a worktree, **✏️ Uncommitted** (its edits and new files).
  Each file's diff opens on its own; a diff over 2 MB is cut. It reads the task's worktree while there
  is one, else the task's branch in the project's checkout (fetched from origin in the background now
  and then, never waited for). While a worker is at its desk, **🔴 Open the live Changes window**
  opens upstream's window on its checkout.
- **PRs**: the task's pull requests with their state, **Create/Push & update PRs**, **Fix PRs**, and
  **🔍 Review these N PRs together**.

The panel is the **shared task view** (`src/client/kanban/taskview.ts`), which the 3D office uses too
(a window of its own, or a tab of the worker window). There it has no Terminal tab (the worker
window has the terminal), no Edit or Move, and a **🗂️ Open in the kanban** link instead of Show in 3D.

## Projects and repositories

A project is a floor of the building. The floor's own checkout is the **primary** repository; a floor
without more repositories is a one-repository project, as in upstream agent-office.

An admin can rename a project: ⚙️ Settings → **📁 Projects** → **⚙️ Project** → **Project name** →
**Rename** (1-100 characters, not another project's name, in any case). The name shows in the elevator,
the top bar, the board and the agents' prompts; the project's id, folder and GitHub repository stay.
Agents already running keep the old name in the prompts they were sent; the next phase uses the new
one. A primary repository called after the project (as it is until someone names it otherwise) is
renamed with it, unless one of the project's other repositories already has the new name.

⚙️ Settings → **📁 Projects** (pick the project at the top) → **⚙️ Project** → **Repositories**: **＋ Add a local
repository** with its absolute folder, then name, kind (git or folder), GitHub `owner/name`, base
branch and instructions for work in it, and **Save repositories**. At most 8 besides the primary.
The primary's folder is changed from the elevator in the 3D office, not here. When the floor knows
its GitHub repository (it was added from GitHub, or its checkout has one), that is the primary's
`owner/name`, shown read-only: saving another is refused ("The floor's own repository is
owner/name; add another repository instead, or re-add the floor"). A floor without one (a local
checkout not on GitHub) takes the `owner/name` saved for the primary, and the kanban uses it
everywhere it needs the primary's repository: the issue sources' repositories, the PR bundles and
reviews, linking the agent's `PR:` lines, and the prompts' list of repositories.

A task gets a worktree of each git repository it works in, all on the same branch (named by the
project's *Branch naming* instructions, else `kanban/<ticket or task id>-<slug>`). A *folder*
repository has no worktree: the agent works in the folder itself. The same page has the project's
general and testing instructions (they go into the prompts), *tasks at once*, and the project's own
plan approval, implementation mode and review settings.

With several repositories, the floor's issues and PR boards show every repository's cards with a
repository chip and a repository filter.

## Issue sources

⚙️ Settings → **📁 Projects** → **📌 Issue sources**, per project: **GitHub repositories**, a **GitHub project** (Projects
v2) or **Jira**, up to 10 per project. **📌 Issues** on the board lists them (search, and filter by
source, status, label and assignee); **＋ Create task** makes a task in To do from one (title, body
plus a *Source:* link, the ticket key and link). An issue already made into a task shows its number
instead, and is never made twice.

| Source | Filters | Needs |
|---|---|---|
| GitHub repositories | repositories (none picked: every repository of the project with a GitHub remote), assignee (`@me` or a login), labels (all of them), state (open, closed, all) | `gh` signed in on the office's machine |
| GitHub project | owner (user or organisation), project number, assignee (`@me` or a login), status, iteration | `gh auth refresh -s read:project` on the office's machine: `gh` doesn't ask for that scope by default |
| Jira | site (`yourteam.atlassian.net`), project keys, assignee (`me`, an account id or e-mail), epic, labels, status categories to leave out (default *Done*), extra JQL (no ORDER BY) | ⚙️ Settings → **🗂️ Kanban** → **Jira**: site, e-mail and API token (id.atlassian.com → Security → API tokens). The token is used only for the site it was given for. |

Issues are fetched again every 90 seconds while someone looks at them, every 10 minutes otherwise, and
with **Refresh**. Keys: `gh:owner/repo#12` (GitHub issues), `ghp:<owner>/<number>#<item>` (project
draft issues), the Jira key.

### On the 3D issues board

A floor whose project has issue sources shows *their* issues on its 📌 Issues board (the cork on the
wall, **E** there, and the ☰ search) instead of its own repository's; a project without any keeps the
floor's GitHub issues, as upstream. Each note says what it is: `#12` for one of the floor's own
issues, `api#12` for another GitHub repository's, the Jira key (`UYT-1415`) or `draft …` for a
project's draft, and **🗂️ #N** once it has been made into a task. The list is the same as in
**📌 Issues** on the kanban (its filters, its 90-second / 10-minute refresh); someone on the floor
counts as looking at it.

Every card works like upstream's: **E** at a note takes it off the cork, **O** opens it, and in your
hands it goes to an empty desk (E hires a worker for it, **P** makes it a kanban task there), to a
worker, to the 📋 queue, to the herald or to the meeting room. The worker's prompt names the issue's
source and link (a GitHub issue of another repository: `gh issue view N -R owner/name`); a card made
into a task is never made twice (the office looks for one with its key, archived too, and makes the task
from the source's whole text). **🔄 Refresh** on the issues window fetches the sources again. One of the project's GitHub issues opens in the office's issue window
(comments, labels, close); any other card opens a window with what the source says and the same
actions. Taking a card assigns it on GitHub when it's a GitHub issue (to your own GitHub sign-in, or
the office's); a Jira or project card isn't assigned anywhere: its kanban task is what links it. The
office only takes a card that is on the floor's board: a key the board doesn't show is ignored.

Mind what the sources hold: whoever can write a Jira issue, a project item or an issue of a
repository outside the project writes text that reaches a coding agent that can run commands. A
worker handed such a card gets its link and its description quoted between markers as data, told not
to follow instructions in it beyond the issue; a GitHub issue is read with `gh issue view`, as upstream
reads its own. A kanban task made from a card keeps the description as its own, as the kanban's
**📌 Issues** always has: pick sources whose writers you trust.

## Pull requests

- **O at a desk** (3D office) has an agent write the pull request instead of the office drafting one.
  As upstream, the worker needs a worktree of its own and must be at rest. A kanban task's worker runs
  the task's PR phase. Any other agent worker gets the *Open pull requests* prompt typed in, and
  pushes and opens (or updates) a PR in every repository of its workspace with commits. Only a shell worker falls back to upstream's draft PR. Once a worker has a
  PR, **O** shows it.
- **PR phase** (a task in Waiting, Review or Done): **🔀 Create PRs** (or **Push & update PRs**) has
  the implementer push and open or update a PR in every repository of the task with commits, each
  listing the others. It reports each as a `PR: <url>` line, which the office links to the task; the
  task goes to Review. Linked PRs keep their state (open, draft, merged, closed) from the floor's PR
  board.
- **Fix PRs** (a task with an open PR): the agent addresses the review comments and failing checks.
- **Reviewing several PRs together**: 🔍 **Review** or 🤝 **Review panel…** in a PR window first asks
  which PRs go with it. PRs on the same branch in the project's other repositories, or of the same task,
  come ticked; any other open PR of the project can be added (at most 20). **Just this PR** keeps
  upstream's single-PR flow. The PRs tab's **Review these N PRs together** does the same for a task's
  open PRs.
  - 🔍 with several PRs: a reviewer is hired in a worktree of its own (never the floor's checkout, never
    the task's) and reads them with `gh pr view` / `gh pr diff`. With no free desk, or the office at its
    worker limit, the review's task is queued like any other hire and starts by itself when there's
    room (⏹️ Stop, or moving the task to Done, takes it out of the queue; a queued run stopped that way is
    listed as stopped before it started, and 🔁 Retry runs that one, the PR review or review round). The review is written into the task
    the PRs belong to when every one of them is that task's (linked to it, or opened from its branch);
    PRs of different tasks, or of no task (one of the *other open PRs*, say), get a new **investigate**
    task *PR review: owner/repo#1, …* (with the ticket they share, if any, and a line naming the tasks
    involved), which goes to Review with the reviewer's findings and verdict. Retry reviews them again.
  - 🤝 with several PRs: the floor's meeting room reviews them as one change set; the brief (the
    *Review panel of several pull requests* prompt) lists every PR. The combined review is posted on
    one of them, which must be in the project's primary repository.

## Prompts

Every prompt the kanban sends is editable: plan, replan, branch naming, checkout, implement,
implement (folder project), investigate, review, next review round, fix, comment, acceptance
criteria, open PRs, fix PRs, review PRs together, the review panel of several PRs, carry on, compact, language, reading other tasks
and handoff, and the smaller texts they're built from (Continue without answers, what the user said
since, the ticket line, attached files, the project's instructions and their parts, the referenced
tasks file, the accepted plan, what the task did, and the handoff's summary and comments). Each lists
its `{{placeholders}}`.

- **Office-wide**: ⚙️ Settings → 🤖 Workers → **📝 Edit the prompts…**, group **🗂️ Kanban tasks**
  (kept in the office's `prompts.json`, like upstream's prompts).
- **Per project**: ⚙️ Settings → **📁 Projects** → **📝 Prompts** (or the *For* picker above a kanban prompt in
  the office's editor). A project's text wins over the office's; **Back to the office's** drops it.
  Saving the office's own text for a project stores nothing.
- The layers, lowest first: the default → the office's → the project's.
- **Contract blocks** (🔒, shown read-only under the prompt) are appended by the office and can't be
  changed: the `PLAN READY` / `QUESTIONS:` markers, the `REVIEW:` verdict line and the reviewer's
  rules, the implementer's and the investigation's safety rules, and the `PR:` lines. A rewritten
  prompt can't break the process.

Only admins save prompts.

## Skills

⚙️ Settings → **🗂️ Kanban** → **Skills** lists every skill the office finds, with where it's from and installed and which
projects use it:

- the office's own (`skills/claude`, `skills/codex` in this install),
- the machine's (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`; `$CODEX_HOME/skills`, default
  `~/.codex/skills`),
- each signed-in account's Claude home (`<data>/homes/<id>/claude/skills`),
- each project repository's `.claude/skills`.

Per project (**📁 Projects** → **🧩 Skills**), pick which skills each phase (plan, implement, review, pull requests) is told to use,
per agent (Claude, Codex). The phase prompt names them.

- **Claude**: the picked office and repository skills go into a generated plugin
  (`<data>/kanban/skills/plugin-<hash>/`) passed with `--plugin-dir`; nothing is copied into anyone's
  Claude home. Skills in the worker's own home load as always.
- **Codex** has no such flag: the office's own skills are copied into `$CODEX_HOME/skills/` with a
  `.office-skill.json` marker. **🔄 Sync** (admins) installs or updates them; a copy someone changed
  by hand, or a same-named skill the office didn't put there, is left alone and reported.
- **office-task-refs** (bundled) is given to every task worker, Claude and Codex, whatever is picked:
  it tells the agent how to read another task it's pointed at.

## Agents reading other tasks

A task often builds on another ("like #14 planned", "tehtävä 17", "the rest of UYT-1415"). Agents
read the real task instead of guessing:

- **`office-tasks`** is on every worker's PATH: `office-tasks get 14` (a number, `#14`, a ticket id or
  part of a title; `--tail` adds the end of its worker's terminal, `--json` the raw answer) and
  `office-tasks search <words>`. It calls the hook server's `/office/tasks/reference` and
  `/office/tasks/search` with the worker's own `AGENT_OFFICE_WORKER_ID` and `AGENT_OFFICE_HOOK_TOKEN`.
- **MCP tools** `get_task` and `search_tasks` on the office's `agent-office` MCP server, listed to task
  workers (Claude workers are allowed them without asking).
- A task's plan phase, which can't run anything, gets the tasks its text refers to written into
  `<data>/kanban/refs/task-<id>/referenced-tasks.md` beforehand.
- What an agent gets: description, accepted plan, summary, runs and review verdicts, the latest
  comments, repositories and branches, PRs and an investigation's report files.

**ai-kanban compatibility**: task workers also get `AIKANBAN_API_BASE` (the hook server,
`http://127.0.0.1:<port>`) and `AIKANBAN_TASK_ID`, so existing skills and scripts keep working:

- `GET $AIKANBAN_API_BASE/api/tasks/reference?ref=14`: ai-kanban's answer shape. No key; read-only;
  never a terminal tail.
- A minimal `/api/v1`: `GET /api/v1/projects`, `GET /api/v1/tasks` (`scope=active|all`, `status`,
  `projectId`, `ticketId`, `q`, `limit`, `offset`), `GET /api/v1/tasks/:id`, `POST /api/v1/tasks`
  (`title`, `description`, `projectId`, `ticketId`, `taskType`, `usePlan`, `start`; idempotent by
  `ticketId`), `POST /api/v1/tasks/:id/start`.

Rules for both: the hook server listens on 127.0.0.1 only, and requests from anywhere else are
refused. The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` with the hook server's port (no
DNS rebinding); an `Origin` must be that same host, and `Sec-Fetch-Site`, when sent, `same-origin` or
`none` (no web pages); `OPTIONS` is refused and no CORS headers are ever sent; a `POST` must be
`Content-Type: application/json` and at most 256 KB. Once an **API key** is set (⚙️ Settings → 🗂️ Kanban;
at least 16 characters; only its SHA-256 is kept), every `/api/v1` request must send it as
`Authorization: Bearer <key>` or `X-API-Key: <key>`. **Starting a task** over `/api/v1` (`start: true`,
or `/start`) is refused until a key is set, since it runs an agent as the office's user.

**Scripts outside the office** (jira-loop, the old ai-kanban skills run by hand) find the hook server
at `http://127.0.0.1:<port>`, where `<port>` is in the file `<data>/hook-port` (for an office in
`~/agent-office`: `~/agent-office/.agent-office/hook-port`), rewritten at every start. The office keeps
the last start's port when it's free. To pin it, start the office with `--hook-port <n>` (or
`AGENT_OFFICE_HOOK_PORT=<n>`): then `AIKANBAN_API_BASE=http://127.0.0.1:<n>` can be set once in the
script's environment. When the pinned port is taken, the office says so and listens elsewhere, and the
file has the port it got.

## Where the data is

`<data>` is the office's data folder: `~/agent-office/.agent-office` (move `~/agent-office` with
`--home` or `AGENT_OFFICE_HOME`), or `<project>/.agent-office` for an office started in a project
(`kanban3d <dir>`). See [Configuration](configuration.md#where-the-office-keeps-things).

| Path | What |
|---|---|
| `<data>/kanban.sqlite` (+ `-wal`, `-shm`) | Tasks, comments, runs, plans, attachments' records, history, PR links. |
| `<data>/kanban-settings.json` | The kanban's settings, per project too (mode 600). |
| `<data>/kanban-secrets.json` | Jira site, e-mail and token; the API key's hash (mode 600). Never sent to a browser. |
| `<data>/kanban/uploads/` | Attached files (mode 600); ones never attached are removed after a day. |
| `<data>/kanban/grants/task-<id>/` | Copies of a task's attached files, the one folder its agents may read (mode 700); removed with the task. |
| `<data>/kanban/reports/task-<id>/` | An investigation's report files. |
| `<data>/kanban/refs/task-<id>/` | The plan phase's referenced tasks. |
| `<data>/kanban/skills/` | Generated Claude skill plugins. |
| `<data>/kanban/legacy/` | ai-kanban's stream logs, when migrated with `--with-stream-logs`. |
| `<data>/floors.json` | The floors, with each project's repositories. |
| `<data>/claude-hooks-kanban.json`, `<data>/bin/office-tasks` | Task workers' Claude settings; the `office-tasks` command. |
| `<data>/hook-port` | The hook server's port (upstream's file), for scripts outside the office; see `--hook-port`. |

Worktrees are upstream's: under the floor's checkout, `.agent-office/worktrees/` (a multi-repository
task's workspace folder there holds a worktree of each of its repositories).

## Limitations

- The kanban process drives **Claude Code and Codex** only; other providers stay ordinary office
  workers (though **O** works for any agent worker).
- Every phase runs in an interactive worker. Claude's implement, fix, resume, PR and compact phases,
  and investigations, run with `--permission-mode bypassPermissions`; an investigation needs it to
  write its report files, and only its contract keeps it off the repositories. Codex runs these
  phases with `--dangerously-bypass-approvals-and-sandbox` unless the project picks its workspace
  sandbox (an investigation always gets the sandbox, with the report folder writable).
- Reviewers can't use editing tools (Claude: no Edit, Write or NotebookEdit; Codex review rounds: its
  read-only sandbox), but a Claude reviewer still has Bash, and a Codex multi-PR reviewer runs in the
  workspace sandbox of its own throwaway worktree (it needs the network for `gh`). That a reviewer runs
  read-only commands only, and never edits, commits, checks out or pushes, is a rule of its contract,
  not a sandbox.
- Plan and review markers are read from the agent's final text; a review without a verdict counts as
  changes requested.
- A task's repositories, agent and review settings are fixed once it leaves To do; its description
  once it starts.
- A task can't run while its project's floor is closed, and needs a free desk and room under the
  office's worker limit.
- Folder projects (no git) have no worktrees, change checks or PRs; a folder repository in a git
  project has no worktree of its own.
- A 🤝 review panel of several PRs posts its review on a PR of the project's primary repository.
- GitHub Projects need `gh`'s `read:project` scope; Jira takes one site's token per office.
