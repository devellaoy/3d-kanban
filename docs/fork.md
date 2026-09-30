# Fork notes

Back to the [README](../README.md).

## Upstream

- Upstream: https://github.com/AgentSystemLabs/agent-office (MIT).
- Base: `665aeec571bc03f76cbd16de8d628dd169a48874` (main, 2026-09-30), taken as a source tarball.
- There is no git history in this copy. To start tracking upstream later:
  `git init && git add -A && git commit -m "3d-kanban on agent-office 665aeec"`, then
  `git remote add upstream https://github.com/AgentSystemLabs/agent-office.git && git fetch upstream`.

## Sync policy

Upstream moves fast (hundreds of commits in its first days, mostly in `main.ts`, `server.ts`,
`protocol.ts` and `workers.ts`). Upstream changes are taken in **only when the user decides**:

1. On a separate branch: `git fetch upstream && git merge upstream/main` (the first merge needs
   `--allow-unrelated-histories` against a commit of the base above).
2. Resolve conflicts with the seam list below: every fork change in an upstream file is listed there.
3. `npm run typecheck && npm test && npm run build`, then check the kanban and the 3D office by hand.

If conflicts grow unreasonable, the fork can stay on its base: fork code talks to upstream only
through the seams below.

## Seams in upstream files

Every fork change in a file that came from upstream, one row per seam. Code seams carry a
`3d-kanban` comment (find them with `grep -rn "3d-kanban" src bin vite.config.ts deploy`, outside
`src/{server,shared,client}/kanban/`); the rows marked *(unmarked)* have no comment of their own and
must be found by hand. Line numbers drift; the "where" column names the function or section.

New files are not seams (they can't conflict): `src/{server,shared,client}/kanban/**`,
`src/client/kanban.html`, `bin/office-tasks.js`, `scripts/migrate-ai-kanban/`, `skills/`,
`tests/kanban-*.test.ts`, `tsconfig.scripts.json`, `docs/kanban.md`, `docs/kanban-architecture.md`,
`docs/migration.md`, `docs/fork.md`.

### Server

| File | Where | What | Why |
|---|---|---|---|
| `src/server/github.ts` | `MergeWatch.ring(n, repo?)`, `look()` and the new `pullKey()` | Merges are keyed by `repo#n` instead of `n` | A project's repositories can have PRs with the same number; the gong must ring once per PR |
| `src/server/github.ts` | `GitHub` constructor: `nameWithOwner?`, `pullsOnly` params | Optional owner/name and a pulls-only switch | A project's other repository gets a `GitHub` of its own that fetches only PRs |
| `src/server/github.ts` | `refreshIssues()` / `refreshPulls()` item mapping *(unmarked)*, `refresh()` *(unmarked)* | `...(this.nameWithOwner ? { repo } : {})` on every issue and PR; `refresh()` skips issues when `pullsOnly` | Each card knows its repository (`GhIssue.repo` / `GhPull.repo`) |
| `src/server/workers.ts` | `SpawnExtra`, `WorkerObservation` (new exported types after `WorkerRepo`) | What the engine passes to `spawn` (launch args, reuse of a worktree, resume session, `kanban` role, env, `settingsFile: 'kanban'`) and what observers hear | The engine hires ordinary PTY workers with per-phase flags and follows their status/hooks |
| `src/server/workers.ts` | `Worker.extra` field | `{ launchArgs, env, settingsFile, reused }` kept per worker | Relaunches and restarts keep the phase flags |
| `src/server/workers.ts` | `WorkerManager` fields `kanbanSettingsPath`, `observers`; constructor *(unmarked)* | `claude-hooks-kanban.json` path next to `claude-hooks.json` | Kanban workers' own Claude `--settings` file |
| `src/server/workers.ts` | `spawn(…, extra?: SpawnExtra)` last param and body *(unmarked)* | `extra.reuse` seats the worker in an existing worktree/workspace (no new worktree); `resumeSessionId`, `kanban` copied into `info`; `w.extra` stored | Reviewers share the task's worktree; a new hire resumes the task's session |
| `src/server/workers.ts` | new methods `relaunch()`, `addObserver()`, `launchArgsOf()`, `transcripts()`, private `observe()` | Stop + `--resume` with new flags; observer registry; read-only accessors | Phase changes that need other permission flags; the engine reads transcripts (M0 below) |
| `src/server/workers.ts` | `kill()` | A `reused` worker always goes home with cleanup `keep` | A reviewer must never delete the task's worktree |
| `src/server/workers.ts` | `observe(...)` calls in `kill()` *(unmarked, `removed`)*, `handleHook()` *(unmarked, `hook`)*, `setStatus()` *(unmarked)*, `launch()`'s lost-folder path, the PTY `onExit` handler, `startFailed()` | Observers hear removals, hooks, status changes and exits | A run whose worker exits or can't start is interrupted, not left running |
| `src/server/workers.ts` | `launch()`: `--settings` choice *(unmarked)*, claude and codex arg building, env | `settingsFile === 'kanban'` picks the kanban hook file; `extra.launchArgs` go before the resume/prompt args; `extra.env` is merged under the office's variables; task workers get `AIKANBAN_API_BASE` (hook URL) and `AIKANBAN_TASK_ID` | Per-phase permission flags; ai-kanban's env names keep existing skills working |
| `src/server/workers.ts` | `writeHookSettings()` | Also writes `claude-hooks-kanban.json` with `skipDangerousModePermissionPrompt: true` | Bypass-mode phases start without the TUI confirmation |
| `src/server/workers.ts` | `writeOfficeCommands()` | Adds `office-tasks` to the commands written into `<data>/bin/` | Every worker can read other tasks from its PATH |
| `src/server/workers.ts` | `persist()` / `load()` *(unmarked in load)*, new `validKanban()`, `validExtra()` | `kanban` and `extra` saved in and read back from `workers.json` | Task workers survive an office restart as task workers |
| `src/server/office-workers.ts` | after `MCP_READ_ONLY` | New `MCP_TASK_TOOLS` (`get_task`, `search_tasks`) | Task workers are launched allowing them (upstream's read-only list stays as it is) |
| `src/server/floor.ts` | imports | `parseRepoFloorId`, `projectRepos` (kanban/projects) and `floorPulled` (kanban/integrations/pulls/board) | The floor's PR board covers the project's repositories and tells the kanban |
| `src/server/floor.ts` | `openPullIn()` (new, beside `openPull`) | The open PR for a branch in any list | Other repositories' lists |
| `src/server/floor.ts` | `Floor.boards` field; constructor's `gh.pulls` callback; `refreshBoards()` calls in the constructor, refresh timer and `arrived()` *(unmarked)*; `shutdown()` stops them *(unmarked)* | One pulls-only `GitHub` per other git repository with a remote; the callback emits `pullsState()` and calls `boardPulled()` | The PR board shows every repository of the project |
| `src/server/floor.ts` | constructor, the `(workerId, repo)` callback given to `new Changes(…)` | A synthetic `<floor>~<repo>` id finds the project's own other repository's board | Changes window and PR opening for a task's other repositories |
| `src/server/floor.ts` | `merged(n, by, repo?)` | `repo` for a PR in another repository | Gong keying (see github.ts) |
| `src/server/floor.ts` | new section "the project's other repositories' pull requests": `pullsState()`, `githubFor()`, `pullsOf()`, `boardOf()`, `otherRepo()`, `refreshBoards()`, `boardPulled()` | Merged PR list, per-repo `GitHub` lookup, merge watch over all lists; `floorPulled(this)` at the end of `boardPulled()` | Multi-repo PR board; the kanban's linked PR states follow the board |
| `src/server/floor.ts` | `sendLandedHome()` and `landed()` *(unmarked)* | `pullsOf` passed to `landedWorkers`/`landedWork` is `this.pullsOf` | Leave-on-merge sees the other repositories' PRs |
| `src/server/building.ts` | imports *(unmarked)*, `FloorDef.repos?` | `repos?: ProjectRepo[]` on a floor | Project = floor with several repositories |
| `src/server/building.ts` | `setRepos()` (new, before `newDef`) | Sets or clears a floor's repositories and saves `floors.json` | Called by the kanban after `validateProjectRepos` |
| `src/server/building.ts` | `load()` | `loadRepos(s.repos, …)` after each floor | Reads the repositories back from `floors.json` |
| `src/server/server.ts` | imports | `installKanban`, `PR_FALLBACK`, `KanbanCaller`/`KanbanClient`, `isKanbanMsg` | Wiring |
| `src/server/server.ts` | `floorsChanged()` | `kanban?.projectsChanged()` | The kanban's project list follows the floors |
| `src/server/server.ts` | hook server: `let kanban`, routes for `/office/tasks*` and `/api/tasks/reference`, `/api/v1*` | New handlers `officeTasks` (worker hook token, like `/office/workers`) and `kanbanLoopback` (the kanban decides who may) | Agents read other tasks; ai-kanban compatibility |
| `src/server/server.ts` | `officeWorkers` `PullsView` | `pullsOf: (id) => floor.pullsOf(id)` | Finds `<floor>~<repo>` repositories |
| `src/server/server.ts` | after the floors open: `kanban = installKanban({…})`, `kanbanCaller`, `kanbanClient`, `prFallback`, `ghRepoOf`, `notInProject` | Builds the kanban on the building's floors, office prompts and hook URL | Wiring; `repo` on PR-window messages |
| `src/server/server.ts` | `floorView()` | `pulls: floor.pullsState()` | Every repository on the PR board |
| `src/server/server.ts` | HTTP: signed-out redirect; `/api/kanban/*`; static `/kanban`, `/kanban.html` | `/kanban` → `/login?next=/kanban`; `/api/kanban/*` to `kanban.handleHttp` (non-GET must be same-origin); serves `kanban.html` | The kanban page and its uploads/attachments |
| `src/server/server.ts` | `/api/gh/*` detail routes | `?repo=` picks `floor.githubFor(repo)`, 404 when it isn't the project's | PR/issue windows for another repository |
| `src/server/server.ts` | `ws.on('close')` | `kanban.clientGone(id)` | No deltas to a closed socket |
| `src/server/server.ts` | `handleMessage()` before the `switch` | `kanban.*` messages to `kanban.handleWs`; `worker.pr` goes to `kanban.engine.prForWorker` first, upstream's `openPr` only on `PR_FALLBACK` | "O" has an agent write the PR |
| `src/server/server.ts` | `gh.merge`, `gh.comment`, `gh.close`, `gh.labels` cases | `repo` picks `floor.githubFor(repo)`; merge passes it to `floor.merged` | Another repository's PRs and issues |
| `src/server/server.ts` | `shutdown` | `kanban.shutdown()` | Engine, plugins and database close |
| `src/server/server.ts` | `gh.merge`, `gh.comment`, `gh.close`, `gh.labels` replies | `gh.merged` / `gh.commented` / `gh.closed` / `gh.labeled` echo the request's `repo` | The PR window matches a reply to the right repository's PR |
| `src/server/server.ts` | `gh.close`, issue branch | `dropIssue(n)` only when the issue is the primary repository's | The queue holds the primary repository's issues; another repository's #n isn't one |

### Shared

| File | Where | What | Why |
|---|---|---|---|
| `src/shared/prompts.ts` | import, `PromptGroup`, `PROMPT_GROUPS`, end of `DEFS` | `'kanban'` group ("🗂️ Kanban tasks") and `...KANBAN_PROMPT_DEFS` | Every kanban prompt shows in upstream's prompt editor and `prompts.json` |
| `src/shared/protocol.ts` | import, `WorkerInfo.kanban` | `{ taskId, role: 'implementer' \| 'reviewer' }` | A task worker says whose it is |
| `src/shared/protocol.ts` | `GhIssue.repo`, `GhPull.repo` | owner/name of the card's repository | Multi-repo boards |
| `src/shared/protocol.ts` | `gh.merge` / `gh.comment` / `gh.close` / `gh.labels` and their replies | optional `repo?: string` | Same |
| `src/shared/protocol.ts` | `ClientMsg`, `ServerMsg` unions *(unmarked)* | `\| KanbanClientMsg`, `\| KanbanServerMsg` | The kanban's WS messages ride upstream's socket |

### Client

| File | Where | What | Why |
|---|---|---|---|
| `src/client/main.ts` | `openKanban()` (new, before `pullRequestFor`) | `/kanban?project=<floor>` | The kanban view of the floor you're on |
| `src/client/main.ts` | `pullRequestFor()`, `pullRequestsFor()` | The toast says an agent opens the PR(s); still sends `worker.pr` | "O" is agent-written now |
| `src/client/main.ts` | desk hint (`O` key label), `reposKey()` | "Agent opens PR(s)", "⏳ Agent opening PR…" | Same |
| `src/client/main.ts` | key handler | `KeyJ` → `openKanban()` | J opens the kanban |
| `src/client/main.ts` | `mountHud([...])` | A `kanban` entry (🗂️ Kanban, key J, section *Open*) | In the ☰ menu |
| `src/client/login.ts` | `NEXT_PAGES` | `/kanban` beside `/lite` | Back to the kanban after signing in (only known pages) |
| `src/client/net.ts` | `loginUrl()` | `/login?next=/kanban` from the kanban page | Same |
| `src/client/lite.html` | header | `#to-kanban` link (🗂️ Kanban) | The kanban from the 2D view |
| `src/client/lite.ts` | `renderFloors()` | Keeps the link on `/kanban?project=<floor>` | Same |
| `src/client/ui/boards.ts` | import; `openBoard()` header (`repoSlot`) and `render()` | Repository filter select and chips, from `kanban/boardrepos` | A multi-repo project's boards |
| `src/client/ui/hud.ts` | help list | `O` text (agent opens PRs); new `J` line | The H help matches the behaviour |
| `src/client/ui/settings.ts` | Workers pane, after *Prompts* | A *Kanban* row linking `/kanban?settings=1` | The kanban's own settings live on its page |
| `src/client/ui/prompts.ts` | import, `openPromptEditor()`: `scope`, `saved()`, `paint()`, `save`, `onClose` | `promptScope()` (kanban/promptscope): project scope picker and the read-only contract block for kanban prompts | Office vs project layering in upstream's editor |
| `src/client/ui/pull.ts` | import; PR window footer | 🔍 Review and 🤝 Review panel first open `openReviewPicker()` (kanban/prpicker) | Multi-PR review; "just this one" keeps upstream's flow |
| `src/client/ui/pull.ts` | waiter maps, `routePullMessage` | Waiters keyed by kind + number + repo; replies matched by repo when they carry one | `api#5` isn't the primary's #5 |
| `src/client/ui/pull.ts` | `commentBox`, `openMerge`, `openClose`, `openLabels`, `openPull`, `openIssue` | `repo` in gh.* messages, `?repo=` on `/api/gh/*`, titles show `api#5` | Same |
| `src/client/state.ts` | import; top of `workerForPull()` | A card with `repo` goes to `workerForRepoPull()` | "Go to desk" finds the right worker |
| `src/client/main.ts` | `pullRequestFor()`, `pullRequestsFor()` lookups | PR matched by number and repo | "O" opens the right card |
| `src/client/lite.ts` | `showMeeting` `openPr` | Same lookup | Same |
| `src/client/ui/repos.ts` | import; `render()` | A project repo's PR on this floor's board opens in the PR window | Multi-repo workers' PRs |

### Build, packaging, deploy, docs

| File | Where | What | Why |
|---|---|---|---|
| `vite.config.ts` | `rollupOptions.input` | `kanban: src/client/kanban.html` | The kanban page is built |
| `package.json` *(unmarked)* | `dependencies`, `devDependencies` | `better-sqlite3`, `@types/better-sqlite3` | The kanban's database |
| `package.json` *(unmarked)* | `scripts` | `migrate:ai-kanban` (tsx `scripts/migrate-ai-kanban/index.ts`); `typecheck` also runs `tsc -p tsconfig.scripts.json --noEmit` | The migration and its type check |
| `package.json` *(unmarked)* | `files` | `skills` | The bundled skills ship with the package |
| `tsconfig.scripts.json` | new file | Type-checks `scripts/**/*.ts` | The migration script is outside `src/` |
| `bin/office-workers.js` | import; `runTool()`; `tools/list`, `tools/call` *(unmarked)* | `get_task` / `search_tasks` from `office-tasks.js`, listed only when `tasksVisible(env)` (`AIKANBAN_API_BASE` or `AGENT_OFFICE_TASKS` set) | MCP tools for task workers |
| `deploy/container/Dockerfile` | build stage | `python3 make g++`; `npm rebuild better-sqlite3` after `npm ci --ignore-scripts` | Native module needs its binary |
| `CLAUDE.md` | whole file *(unmarked)* | Replaced with the fork's rules; upstream's PR/merge workflow rules removed on purpose | This fork has no upstream-style PR workflow |
| `README.md` | top | Fork section above upstream's README, which follows unchanged | What this fork is |
| `docs/features.md` | *A floor per project*, *One task across several projects*, *One-click PRs*, *PR board* | An "*In 3d-kanban*" sentence at the end of each, pointing to [kanban.md](kanban.md) | The upstream docs don't contradict the fork |
| `docs/configuration.md` | *Where the office keeps things* | An "*In 3d-kanban*" paragraph before *Command line* (kanban data, settings, migration) | Same |
| `docs/controls.md` | keys table (`O` text, new `J` row); new section *In the kanban view* | The fork's keys | Same |

### How to re-apply after an upstream merge

1. Before merging, list the seams: `grep -rn "3d-kanban" src bin vite.config.ts deploy | grep -v '/kanban/'`
   and compare with the tables above (the *(unmarked)* rows too).
2. Merge on a branch (see *Sync policy*). For each conflict, take upstream's side first, then put the
   seam back by the table: same place, same minimal shape, with its `3d-kanban` comment.
3. Check the seams that break silently rather than conflict:
   - `WorkerManager.spawn`'s parameter list (`extra` must stay the last one) and `launch()`'s claude and
     codex argument order (`extra.launchArgs` before `--resume` and the prompt).
   - `writeHookSettings()` still writes both hook files with the same `hooks` and `permissions`.
   - Every place upstream sets a worker's status or removes one still calls `observe(...)`.
   - `ClientMsg` / `ServerMsg` still end with the kanban unions; `DEFS` still spreads `KANBAN_PROMPT_DEFS`.
   - `handleMessage()` still routes `kanban.*` and `worker.pr` before the `switch`.
   - New `gh.*` messages or `/api/gh/*` routes upstream adds that act on one PR or issue: give them the
     same `repo` → `githubFor()` handling, or they act on the floor's own repository.
   - `floorView()` and the floor's `gh.pulls` callback still send `pullsState()`.
4. Re-check `package.json` (dependencies, `files`, `typecheck`, `migrate:ai-kanban`), `vite.config.ts`
   inputs and the Dockerfile's `better-sqlite3` rebuild; keep this fork's `CLAUDE.md`.
5. `npm install && npm run typecheck && npm test && npm run build`, then by hand: a kanban task through
   plan → implement → review → PR, **O** at an ordinary worker's desk, the PR board of a multi-repo
   project, and the 3D office itself.
6. Update the tables here for any seam that moved or changed.

## M0 spike results (2026-09-30, Claude Code 2.1.285, codex-cli 0.159.0)

- Claude and Codex hooks both report `session_id` and `transcript_path` (upstream already stores them).
  Hook output is discarded (`>/dev/null`), so the office can't answer hooks; the engine reads results instead.
- Claude transcript JSONL: `type: 'assistant'` lines carry `message.content[]` blocks; the turn's final
  text is the `text` blocks after the last user prompt. `ExitPlanMode` shows up as a `tool_use` block
  whose `input.plan` is the plan.
- Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`): `event_msg` / `task_complete`
  carries `last_agent_message`.
- Claude flags: `--permission-mode <mode>`, `--disallowedTools`, `--plugin-dir <path>` (skills as a plugin),
  `--resume <id>`, `--session-id <uuid>`; `--json-schema` only works with `--print`, so interactive review
  verdicts are parsed from the final text. The setting `skipDangerousModePermissionPrompt` exists
  (skips the bypass-mode confirmation in the TUI).
- Codex flags: `-s read-only|workspace-write|danger-full-access`, `-a never`,
  `--dangerously-bypass-approvals-and-sandbox`, `codex resume <SESSION_ID> [PROMPT]`.
- Decision (A4 gate): every phase runs on upstream PTY workers; no phase needs a headless fallback.
