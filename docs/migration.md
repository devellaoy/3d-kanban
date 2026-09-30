# Migrating from ai-kanban

Back to the [README](../README.md). See also the [kanban architecture](kanban-architecture.md).

`scripts/migrate-ai-kanban/` brings ai-kanban's projects, tasks, comments, plans and settings into
3d-kanban. It only ever **reads** ai-kanban's data folder: the database is opened read-only and
nothing in it is changed or copied as a whole.

## Running it

```bash
# 1. A dry run (the default): what would happen, nothing written.
npm run migrate:ai-kanban -- --from ~/.ai-kanban/data

# 2. Place the tasks of repository names it couldn't resolve (as many --map as needed).
npm run migrate:ai-kanban -- --from ~/.ai-kanban/data --map devella-web-wt-1=devella-web --map K360=k360

# 3. Stop the office, then migrate for real.
npm run migrate:ai-kanban -- --from ~/.ai-kanban/data --map … --apply
```

| Option | What it does |
|---|---|
| `--from <dir>` | ai-kanban's data folder (usually `~/.ai-kanban/data`). Required. |
| `--home <dir>` | The office's home: its data is `<home>/.agent-office`. Default `$AGENT_OFFICE_HOME`, else `~/agent-office`. |
| `--apply` | Write into the office. Without it, it's a dry run. |
| `--map name=project` | Tasks whose ai-kanban `repository` is `name` go to `project`: a floor id, or an ai-kanban repository's or folder's name or id. Can be repeated. |
| `--with-stream-logs` | Also keep ai-kanban's raw agent output (`stream` and `stderr` logs), as files under `<data>/kanban/legacy/ai-kanban/task-<id>/stream.log`, never in the database. |
| `--json` | Print the report as JSON. |

The dry run migrates into throwaway copies of the office's `floors.json`, `kanban.sqlite` and
`kanban-settings.json`, so its counts are exactly what `--apply` would do, and then deletes them.

**Stop the office before `--apply`.** The migration writes the same files the office keeps open.
It checks the office's hook port (`<data>/hook-port`): if the office answers, `--apply` refuses,
and a dry run warns.

### Running it again

You can run it as often as you like, before and after you start using 3d-kanban:

- A task is recognised by where it came from (`legacy_source = 'ai-kanban'` and its old id). A
  task brought in before is updated from ai-kanban again. Comments, logs and stream logs pick up
  from where the last run stopped, so only the new ones are added.
- A task **changed in 3d-kanban** since it was brought in (edited, moved, started: its
  `updated_at` is later than its `migrated_at`) is left alone and listed as skipped.
- Floors are found by their folder, so a second run never makes a second floor for the same checkout.
- Project settings, prompts and skills are only filled in where 3d-kanban has none yet. What it
  keeps as 3d-kanban has it is listed under "For you to decide".

### Task ids

Tasks keep their ai-kanban ids, so `#123` in old comments and descriptions still means the same
task, and new tasks continue after the highest old id. If 3d-kanban already has a task **of its
own** with one of those ids, the migration stops before it writes anything and names the ids;
migrate into an office without those tasks.

## What maps to what

### Projects

A 3d-kanban project is a floor (`floors.json`), made with upstream's `Building` rules (the id from
the folder's name, its own look, its GitHub origin). A floor is only made for a folder that exists
on this machine.

| ai-kanban | 3d-kanban |
|---|---|
| A repository (`settings.repositories`) | A floor on its checkout. Its linked folders (`links`) become the project's other repositories (`FloorDef.repos`): git checkouts as `git`, others as `folder`, with their base branch. Linked folders that aren't there are counted and left out. |
| A folder (`settings.folders`) | A floor on the folder: a folder project. |
| A task with an ad-hoc `folderPath` | The configured folder with that path, else a folder project of its own when the folder exists. |
| A task's `repository` | Resolved by `repoId` (a configured repository), then by name (repository or folder name, or the folder's base name), then `--map`. What's left goes to the **Migrated (unassigned)** project (a floor on `<home>/Migrated (unassigned)`), and the report lists the names with their task counts so you can `--map` them and run again. |

### Tasks

| ai-kanban | 3d-kanban |
|---|---|
| `todo` | `todo` |
| `in_progress`, `waiting` | `waiting` ("migrated while it ran"): its run doesn't carry on, because the session and checkout were ai-kanban's. Continue or retry it to start a fresh session. |
| `reviewable` | `review` |
| `pr-stage`, `pr-katselmointi` and any other custom column | `review`, with the column's id as a tag (3d-kanban has no custom columns) |
| `done` | `done` |
| `history` | `archived` |
| `agentTool` claude / codex | the same; `copilot` (or none) becomes the office's default tool, counted in the report |
| `ticketId`, `taskType`, `usePlan`, `review`, `model`, `effort`, `summary`, `branchName` | the task's ticket, type, plan and review switches, model, effort, summary, branch |
| `worktreePath`, `sessionId` | noted in a system comment on the task, for reference; they aren't used |

Runtime state (`runStatus`, pids, worktree slots, retries, pending resumes) is reset.

### Comments, plans, runs, history

- `user` comments stay the user's. `claude` comments become agent comments, marked with the task's
  tool (a review, `**Katselmointi:**`, with the review tool). `system` comments stay system comments.
- Repeated system comments are dropped: one that says exactly what the task's previous comment
  said (ai-kanban once wrote "Ei vapaata worktreetä" 337 215 times on one task), and a system text
  after its 20th time on one task. The report counts both.
- Runs are rebuilt from the comment prefixes: `**Suunnitelma:**` and `**Kysymykset:**` → plan,
  `**Toteutus valmis:**` and `**Selvitys valmis:**` → implement, `**Katselmointi:**` → review (with
  its round, and the verdict from its last `REVIEW:` line), `**Korjaukset katselmoinnin jälkeen:**`
  → fix, `**Jatko:**` → resume, `**Saraketoiminto:**` → pr, `**Tiivistelmä:**` → compact.
- `plan` logs become plan versions; `plan_accepted` accepts the latest (adding its text as a new
  version when it differs).
- `progress`, `question`, `error` and `system` logs become the task's history events (1000
  characters each). `stream` and `stderr` logs are skipped unless `--with-stream-logs`.

### Files

- `uploads/` is copied to `<data>/kanban/uploads/ai-kanban/`, and `reports/task-<id>/` to
  `<data>/kanban/reports/task-<id>/` (where agents look for an investigation's reports). Files
  already there aren't overwritten.
- Absolute paths into the old `uploads/` and `reports/` in descriptions, summaries and comments are
  rewritten to the new places. The files aren't made into attachment rows; agents read them by path.

### Settings

| ai-kanban | 3d-kanban |
|---|---|
| A repository's general, branch and debugging & testing instructions | The project's general, branch and testing instructions |
| `columnActions['pr-stage']` | The project's override of the `kanban.pr.create` prompt |
| Other column actions (`done`, …) | Listed in the report: 3d-kanban has no column actions; decide by hand |
| The default role's `instructions` and `phaseInstructions` (plan, implement, review), where they differ from ai-kanban's built-in texts | Project overrides of `kanban.plan`, `kanban.implement`, `kanban.review`: the default prompt with the role's text added under a heading |
| The role's persona wording (`prompts`) | Listed in the report when it isn't the built-in one |
| The role's `defaultSkills`, `reviewSkills` (free text) | A structured skill pick (plan and implement; review) for Claude, best effort: `claude: X / codex: Y` is read per tool; anything that isn't a skill name is listed |
| `reviewTool`, `reviewModel`, `reviewEffort`, `reviewIterations` | The office's review settings (tool, model, effort, rounds) |
| `agentTool`, `defaultModel`, `defaultEffort` | The office's task defaults |
| `autoResume*` | The office's auto-resume settings |
| `implementPermissionMode` | Listed: implement phases run in the office's own mode (bypass by default) |
| API keys | Not migrated (ai-kanban only kept their hashes): set a new key in ⚙️ Settings → 🗂️ Kanban |

## Using ai-kanban's skills and scripts afterwards

Task workers get `AIKANBAN_API_BASE` (the office's loopback hook server) and `AIKANBAN_TASK_ID`, so
the `kanban-task-refs` skill and scripts written for ai-kanban keep working:

- `GET /api/tasks/reference?ref=<id | #id | ticket | part of a title>` answers in ai-kanban's shape
  (`{ok, ref, match, candidates}`, statuses in ai-kanban's words: `reviewable`, `history`). It is
  **loopback only and needs no key**, as in ai-kanban, because the skill sends none; it is read-only
  and never includes a terminal.
- A minimal `/api/v1`: `GET /api/v1/projects`, `GET /api/v1/tasks?ticketId=&q=&status=&projectId=&scope=&limit=&offset=`,
  `GET /api/v1/tasks/:id`, `POST /api/v1/tasks` (`{title, description, projectId, ticketId?, start?, taskType?, usePlan?}`,
  idempotent on `ticketId` within the project) and `POST /api/v1/tasks/:id/start`. Loopback only;
  once an API key is set in ⚙️ Settings → 🗂️ Kanban (only its sha256 is kept), every request must
  send it as `Authorization: Bearer <key>` or `X-API-Key: <key>`. `projectId` is a floor id.
- **Starting a task needs an API key.** Without one, `POST /api/v1/tasks {start: true}` and
  `POST /api/v1/tasks/:id/start` are refused with `403 api.startNeedsKey`, and nothing is created.
  A started task runs an agent that can do anything the office's user can, and without a key any
  process on the machine (another user's too) could start one. Reading and creating tasks in `todo`
  still work without a key, as in ai-kanban. For jira-loop or jira-kanban-feeder with `start: true`,
  set a key in ⚙️ Settings → 🗂️ Kanban and give it to the script.
- Both routes refuse what a web page open in this machine's browser could send them. That covers
  cross-site requests (CSRF) and DNS rebinding:
  - The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, with the
    hook server's own port. Anything else gets `403 request.badHost`.
  - A request with an `Origin` header that isn't that same host, or with a `Sec-Fetch-Site` other
    than `same-origin`/`none`, gets `403 request.crossOrigin`.
  - Every `POST`, `/start` included, must send `Content-Type: application/json`, even with an empty
    body. Anything else gets `415 request.notJson`. A page can't send that type without a CORS
    preflight, which is never answered: `OPTIONS` gets `405`, and no response carries
    `Access-Control-*` headers.
  - A body may be at most 256 KB (`413 request.tooBig`).
  - `curl`, scripts and the skills send none of those headers, so they're unaffected.
- The office's own ways are `office-tasks get <ref>` / `office-tasks search <words>` on a worker's
  PATH and the `get_task` / `search_tasks` tools of the `agent-office` MCP server; the bundled
  `office-task-refs` skill tells agents about them.
