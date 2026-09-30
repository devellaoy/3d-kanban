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
  (opens task #14's detail), `/kanban?settings=1` (opens the kanban settings; ⚙️ Settings → 🤖 Workers
  → **🗂️ Kanban settings…** in the office links there).
- **🏢 3D** in the kanban's top bar goes back to the 3D office, on the floor of the project you're
  looking at.

Signed out, `/kanban` sends you to the sign-in page and back. The page is in English or Finnish: the
browser's language until you pick one with the **EN/FI** selector.

The top bar has the project picker (or **All projects**), a search box (`#12`, words, a ticket id, a
repository; **/** focuses it), counts (🗂️ on the board, 🚧 running, 🙋 waiting on you, 👀 ready for
review), **📌 Issues**, **＋ New task** (**N**), filters (repository, state: running / needs you /
waiting to retry / has a PR, agent, ticket or not), **🗄️ Archive** (shows archived tasks as a
column) and **⚙️** settings. Keys: see [Controls](controls.md#in-the-kanban-view).

## Columns and moves

| Column | Means |
|---|---|
| **To do** | Not started. Can still be edited. |
| **In progress** | The engine is running a phase (plan, implement, review, fix…), or the task is queued for a slot. |
| **Waiting** | Needs you: the plan has questions, the plan waits for approval, the agent asks in its terminal, it was stopped, a phase failed or was interrupted, or a usage limit (it retries by itself, with a countdown). |
| **Review** | The automation is finished. Read the result, comment, run another review round, open PRs, or move it to Done. |
| **Done** | Accepted by you. Only you move tasks here. |
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

## The process

1. **Plan** (when *Plan first* is on): the agent plans read-only. It ends with the plan (the line
   `PLAN READY`), or with `QUESTIONS:`. Questions put the task in Waiting: answer in the box and
   **Send the answer**, or **▶️ Continue** without one (the agent makes and names its assumptions).
   With plan approval *wait for approval* a finished plan waits for **✅ Approve the plan** or
   **✍️ Request changes** (the Plan tab); *implement straight away* accepts it by itself.
2. **Implement**: the agent works in its own worktree (a workspace with a worktree of each repository,
   on the same branch), commits, and says what it did. If nothing differs from the base branch in any
   repository, there's nothing to review and the task goes to Review.
3. **Review rounds**: a reviewer (its own worker, tool, model and effort, sharing the task's worktree)
   reviews and ends with `REVIEW: APPROVED` or `REVIEW: CHANGES_REQUESTED` (no verdict counts as
   changes requested). Changes requested → the implementer **fixes** → the next round. After the last
   round's fix the reviewer looks once more if *review the last fix too* is on; otherwise the task goes
   to Review.
4. **Review column**: read the result. **🔍 Run a review round** runs one more round by hand (it ends
   in Review). **🔀 Create PRs** / **🛠️ Fix PRs** start the PR phase (see below). **🗜️ Compact**
   compacts the agent's session. **🏠 Release worktree** sends the task's workers home and keeps the
   worktree for later. Move it to **Done** when you accept it.

**⏹️ Stop** interrupts a running turn (Esc into its terminal; the worker goes home, worktree kept, if
it doesn't stop in a few seconds). A failed or interrupted phase waits with **🔁 Retry** (run it again)
and **▶️ Continue**. After an office restart a run is picked up again when its worker is still at
its desk; a run whose worker went away (or exited) is marked interrupted.

A project runs at most *tasks at once* tasks (default 2); more are **queued** in In progress and start
when a slot frees up. A hire needs a free desk on the project's floor and room under the office's
worker limit; when there's none the phase fails and the task waits with Retry.

### Settings

⚙️ in the kanban's top bar. Admins change them; everyone else sees them read-only. Changes apply to
tasks from their next phase. The review setting that applies to a task is the office's, the project's
over it, and the task's own over both.

| Setting | Where | Default | What it does |
|---|---|---|---|
| Agent, model, effort | General → New tasks | Claude, its default | The implementer of new tasks. The default model applies only when the task uses the default agent. |
| Plan first | General → New tasks | on | New tasks start with a plan. |
| Plan approval | General → New tasks; Projects; per task | implement straight away | *implement straight away* (`auto`) or *wait for approval* (`manual`). Set on a task when it's made. |
| Review rounds | General → New tasks | on | New tasks get reviewed. |
| Implementation runs | General → New tasks; Projects | without permission prompts | How implement, fix, resume and PR phases run. *In Codex's workspace sandbox* (`-s workspace-write -a never`) only changes Codex; Claude always runs these phases in bypass mode. |
| Reviewer: agent, model, effort | General → Reviews; Projects; per task | Claude | Who reviews. |
| Rounds | General → Reviews; Projects; per task | 2 | 1–10 review rounds. |
| Review the last fix too | General → Reviews; Projects; per task | on | One more review after the last round's fix. |
| Keep the reviewer off the web | General → Reviews; Projects | on | Claude reviewers get no WebFetch/WebSearch (Bash keeps the network, for `gh`). A Codex review round always runs in Codex's read-only sandbox (no network); a Codex multi-PR review in its workspace sandbox with the network on, for `gh`. |
| Resume after a usage limit or a network break | General | on, 5 tries, 6 hours | A turn cut short by a usage limit or a lost connection is retried by itself: at the reset time the message names (plus a minute), else after 5, 10, 20… minutes (at most an hour apart). It gives up after *tries at most* or *waits at most (hours)*; then it waits for Retry. |
| Archive done tasks after (days) | General | 30 | 0 keeps them on the board. Checked at start-up and hourly. |
| Repositories, instructions, tasks at once | Projects | — | See *Projects and repositories*. |

## Comments

The Conversation tab holds your comments, the agents' results, plans, questions, review findings and
the office's status lines. A comment on a task in **In progress, Waiting or Review** puts the agent
back to work:

- The agent is at rest: the comment is its next turn (typed into its terminal, or a worker is hired
  again with the task's session and worktree). In Waiting on the plan, it's an answer or a change
  request for the plan.
- The agent is busy (a review included): the comment is queued (marked *waiting*) and delivered at its
  next rest. Comments that came in during a review are worked on when the review cycle ends, and that
  work is reviewed again when the task has review on.

On To do, Done and archived tasks a comment is just kept. Comments take attachments too
(**Ctrl/⌘ + Enter** sends).

## The detail panel

Click a card (or Enter on it). Its tabs:

- **Overview**: what it waits for (with the answer box), the actions, summary, description,
  acceptance criteria, attachments and details (type, agent, plan, review rounds, branch, workspace,
  queued comments, who made it).
- **Conversation**: see *Comments*.
- **Plan**: every version (draft, accepted, superseded), with approve and request-changes on the
  latest.
- **Runs**: each phase run (phase, round, role, agent, status, verdict), and the task's history.
- **Terminal**: the task worker's live terminal, as at its desk (you can type in it). A task on
  another project's floor takes you to that floor first.
- **Changes**: what the worker changed, per repository (upstream's Changes window: files, diff,
  commit).
- **PRs**: the task's pull requests with their state, **Create/Push & update PRs**, **Fix PRs**, and
  **🔍 Review these N PRs together**.

## Projects and repositories

A project is a floor of the building. The floor's own checkout is the **primary** repository; a floor
without more repositories is a one-repository project, as in upstream agent-office.

Settings → **Projects** (pick the project at the top) → **Repositories**: **＋ Add a local
repository** with its absolute folder, then name, kind (git or folder), GitHub `owner/name`, base
branch and instructions for work in it, and **Save repositories**. At most 8 besides the primary.
The primary's folder is changed from the elevator in the 3D office, not here.

A task gets a worktree of each git repository it works in, all on the same branch (named by the
project's *Branch naming* instructions, else `kanban/<ticket or task id>-<slug>`). A *folder*
repository has no worktree: the agent works in the folder itself. The same page has the project's
general and testing instructions (they go into the prompts), *tasks at once*, and the project's own
plan approval, implementation mode and review settings.

With several repositories, the floor's issues and PR boards show every repository's cards with a
repository chip and a repository filter.

## Issue sources

Settings → **Issue sources**, per project: **GitHub repositories**, a **GitHub project** (Projects
v2) or **Jira**, up to 10 per project. **📌 Issues** on the board lists them (search, and filter by
source, status, label and assignee); **＋ Create task** makes a task in To do from one (title, body
plus a *Source:* link, the ticket key and link). An issue already made into a task shows its number
instead, and is never made twice.

| Source | Filters | Needs |
|---|---|---|
| GitHub repositories | repositories (none picked: every repository of the project with a GitHub remote), assignee (`@me` or a login), labels (all of them), state (open, closed, all) | `gh` signed in on the office's machine |
| GitHub project | owner (user or organisation), project number, assignee (`@me` or a login), status, iteration | `gh auth refresh -s read:project` on the office's machine: `gh` doesn't ask for that scope by default |
| Jira | site (`yourteam.atlassian.net`), project keys, assignee (`me`, an account id or e-mail), epic, labels, status categories to leave out (default *Done*), extra JQL (no ORDER BY) | Settings → **Secrets** → Jira: site, e-mail and API token (id.atlassian.com → Security → API tokens). The token is used only for the site it was given for. |

Issues are fetched again every 90 seconds while someone looks at them, every 10 minutes otherwise, and
with **Refresh**. Keys: `gh:owner/repo#12` (GitHub issues), `ghp:<owner>/<number>#<item>` (project
draft issues), the Jira key.

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
    the task's) and reads them with `gh pr view` / `gh pr diff`. The review is written into the task
    the PRs belong to, or a new **investigate** task *PR review: owner/repo#1, …* (with the ticket
    they share, if any), which goes to Review with the reviewer's findings and verdict. Retry reviews
    them again.
  - 🤝 with several PRs: the floor's meeting room reviews them as one change set; the brief lists every
    PR. The combined review is posted on one of them, which must be in the project's primary
    repository.

## Prompts

Every prompt the kanban sends is editable: plan, replan, branch naming, checkout, implement,
implement (folder project), investigate, review, next review round, fix, comment, acceptance
criteria, open PRs, fix PRs, review PRs together, carry on, compact, language, reading other tasks
and handoff. Each lists its `{{placeholders}}`.

- **Office-wide**: ⚙️ Settings → 🤖 Workers → **📝 Edit the prompts…**, group **🗂️ Kanban tasks**
  (kept in the office's `prompts.json`, like upstream's prompts).
- **Per project**: the kanban's Settings → **Prompts** (or the *For* picker above a kanban prompt in
  the office's editor). A project's text wins over the office's; **Back to the office's** drops it.
  Saving the office's own text for a project stores nothing.
- The layers, lowest first: the default → the office's → the project's.
- **Contract blocks** (🔒, shown read-only under the prompt) are appended by the office and can't be
  changed: the `PLAN READY` / `QUESTIONS:` markers, the `REVIEW:` verdict line and the reviewer's
  rules, the implementer's and the investigation's safety rules, and the `PR:` lines. A rewritten
  prompt can't break the process.

Only admins save prompts.

## Skills

Settings → **Skills** lists every skill the office finds, with where it's from and installed and which
projects use it:

- the office's own (`skills/claude`, `skills/codex` in this install),
- the machine's (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`; `$CODEX_HOME/skills`, default
  `~/.codex/skills`),
- each signed-in account's Claude home (`<data>/homes/<id>/claude/skills`),
- each project repository's `.claude/skills`.

Per project, pick which skills each phase (plan, implement, review, pull requests) is told to use,
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
`Content-Type: application/json` and at most 256 KB. Once an **API key** is set (Settings → Secrets;
at least 16 characters; only its SHA-256 is kept), every `/api/v1` request must send it as
`Authorization: Bearer <key>` or `X-API-Key: <key>`. **Starting a task** over `/api/v1` (`start: true`,
or `/start`) is refused until a key is set, since it runs an agent as the office's user.

## Where the data is

`<data>` is the office's data folder: `~/agent-office/.agent-office` (move `~/agent-office` with
`--home` or `AGENT_OFFICE_HOME`), or `<project>/.agent-office` for an office started in a project
(`agent-office <dir>`). See [Configuration](configuration.md#where-the-office-keeps-things).

| Path | What |
|---|---|
| `<data>/kanban.sqlite` (+ `-wal`, `-shm`) | Tasks, comments, runs, plans, attachments' records, history, PR links. |
| `<data>/kanban-settings.json` | The kanban's settings, per project too (mode 600). |
| `<data>/kanban-secrets.json` | Jira site, e-mail and token; the API key's hash (mode 600). Never sent to a browser. |
| `<data>/kanban/uploads/` | Attached files (mode 600); ones never attached are removed after a day. |
| `<data>/kanban/reports/task-<id>/` | An investigation's report files. |
| `<data>/kanban/refs/task-<id>/` | The plan phase's referenced tasks. |
| `<data>/kanban/skills/` | Generated Claude skill plugins. |
| `<data>/kanban/legacy/` | ai-kanban's stream logs, when migrated with `--with-stream-logs`. |
| `<data>/floors.json` | The floors, with each project's repositories. |
| `<data>/claude-hooks-kanban.json`, `<data>/bin/office-tasks` | Task workers' Claude settings; the `office-tasks` command. |

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
