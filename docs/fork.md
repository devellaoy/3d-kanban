# Fork notes

Back to the [README](../README.md).

## Upstream

- Upstream: https://github.com/AgentSystemLabs/agent-office (MIT).
- Base: `665aeec571bc03f76cbd16de8d628dd169a48874` (main, 2026-09-30), taken as a source tarball.
- There is no git history in this copy. To start tracking upstream later:
  `git init && git add -A && git commit -m "3d-kanban on agent-office 665aeec"`, then
  `git remote add upstream https://github.com/AgentSystemLabs/agent-office.git && git fetch upstream`.

## Name and releases

3d-kanban is its own product, published at https://github.com/devellaoy/3d-kanban, so that it never
clashes with an upstream install on the same machine:

- The npm package is `3d-kanban` and its command `kanban3d` (`package.json` `bin`); the entry file
  keeps upstream's name, `bin/agent-office.js`, to keep the seams small.
- `install.sh` / `install.ps1` download the release asset `3d-kanban.tgz` from this repository's
  releases, install it in `~/.local/share/3d-kanban` (Windows `%LOCALAPPDATA%\3d-kanban`) and write
  a `kanban3d` launcher. The fork's first release, v0.1.3, still carried `agent-office.tgz`; both
  installers fall back to that name.
- `.github/workflows/release.yml` publishes `v<major.minor>.<commits on main>` with `3d-kanban.tgz`.
- The command starts with a letter because PowerShell reads a bare `3d-kanban` as the number `3d`
  followed by `-kanban`; `kanban3d` runs as it is in PowerShell, cmd and Git Bash.
- What stays upstream's on purpose: the `AGENT_OFFICE_*` environment variables (the office and the
  installers read them), the data home `~/agent-office` and its `.agent-office` folder (the docs and
  the ai-kanban migration rely on it), the `agent-office` MCP server's name, log prefixes
  (`agent-office: …`), the product name *Agent Office* in the UI, and a server's own names from
  `deploy/provision.sh` (`/opt/agent-office`, the `agent-office` service, `/etc/agent-office`,
  `agent-office-team`), which existing servers and their upgrades rely on.
- The kanban's `better-sqlite3` 13 needs Node.js 22, so `engines`, both installers and
  `deploy/provision.sh` require 22 instead of upstream's 20. npm runs its implicit `node-gyp rebuild` on
  install (the package has a `binding.gyp` and no install script), a no-op build when its bundled
  prebuild fits but one that still needs Python 3, make and a C++ toolchain.

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
`tests/kanban-*.test.ts`, `tests/sky.test.ts` (upstream PR #207's, so it would conflict only if upstream adds the same file), `tsconfig.scripts.json`, `docs/kanban.md`, `docs/kanban-architecture.md`,
`docs/migration.md`, `docs/fork.md`.

### Server

| File | Where | What | Why |
|---|---|---|---|
| `src/server/github.ts` | `MergeWatch.ring(n, repo?)`, `look()` and the new `pullKey()` | Merges are keyed by `repo#n` instead of `n` | A project's repositories can have PRs with the same number; the gong must ring once per PR |
| `src/server/github.ts` | `GitHub` constructor: `nameWithOwner?`, `pullsOnly` params | Optional owner/name and a pulls-only switch | A project's other repository gets a `GitHub` of its own that fetches only PRs |
| `src/server/github.ts` | `refreshIssues()` / `refreshPulls()` item mapping *(unmarked)*, `refresh()` *(unmarked)* | `...(this.nameWithOwner ? { repo } : {})` on every issue and PR; `refresh()` skips issues when `pullsOnly` | Each card knows its repository (`GhIssue.repo` / `GhPull.repo`) |
| `src/server/workers.ts` | `SpawnExtra`, `WorkerObservation` (new exported types after `WorkerRepo`) | What the engine passes to `spawn` (launch args, reuse of a worktree, resume session, `kanban` role, env, `settingsFile: 'kanban'`, `bases`: the branch to cut each checkout's worktree from) and what observers hear | The engine hires ordinary PTY workers with per-phase flags and follows their status/hooks |
| `src/server/workers.ts` | `Worker.extra` field | `{ launchArgs, env, settingsFile, reused }` kept per worker | Relaunches and restarts keep the phase flags |
| `src/server/workers.ts` | `WorkerManager` fields `kanbanSettingsPath`, `observers`; constructor *(unmarked)* | `claude-hooks-kanban.json` path next to `claude-hooks.json` | Kanban workers' own Claude `--settings` file |
| `src/server/workers.ts` | `spawn(…, extra?: SpawnExtra)` last param and body *(unmarked)* | `extra.reuse` seats the worker in an existing worktree/workspace (no new worktree); `resumeSessionId`, `kanban` copied into `info`; `w.extra` stored | Reviewers share the task's worktree; a new hire resumes the task's session |
| `src/server/workers.ts` | `spawn()`'s `capacity.full()` line; `SpawnExtra.countsWith` | The worker limit isn't checked for a hire whose `extra.countsWith` worker (the task's implementer) is still here; the hire is counted as usual once seated | A task counts once against the worker limit: its reviewer never waits for the place its own implementer holds, which nothing would free |
| `src/server/workers.ts` | new methods `relaunch()`, `addObserver()`, `launchArgsOf()`, `transcripts()`, private `observe()` | Stop + `--resume` with new flags; `relaunch({ model, effort })` checks them with `validateWorkerModel/Effort`, sets `info.model/effort` and emits the update; observer registry; read-only accessors | Phase changes that need other permission flags, and the task's model/effort changed since the hire; the engine reads transcripts (M0 below) |
| `src/server/workers.ts` | `spawn()`'s worktree line, `makeWorkspace(…, bases?)` and its two `create()` calls, `fetchBase(branch?)` | `extra.bases[path.resolve(dir)]` passed to `Worktrees.create` for the floor's checkout and each other repository; `fetchBase` passes a branch to `Worktrees.fetch` | A kanban task's configured base branch (the primary's too) is what its worktrees are cut from; ordinary workers pass none, so upstream's rule stays |
| `src/server/worktrees.ts` | `create(…, baseBranch?)`, new private `baseStartPoint()`, `fetch(branch?)` and its `fetchedFor` field | `baseBranch` cuts from `origin/<branch>`, else the local branch, and returns an error when neither exists; `fetch` fetches that branch instead of the checkout's (a fetch of another branch in flight is waited for, then this one runs) | Same |
| `src/server/workers.ts` | `kill()` | A `reused` worker always goes home with cleanup `keep` | A reviewer must never delete the task's worktree |
| `src/server/workers.ts` | `observe(...)` calls in `kill()` *(unmarked, `removed`)*, `handleHook()` *(unmarked, `hook`)*, `setStatus()` *(unmarked)*, `launch()`'s lost-folder path, the PTY `onExit` handler, `startFailed()` | Observers hear removals, hooks, status changes and exits | A run whose worker exits or can't start is interrupted, not left running |
| `src/server/workers.ts` | `launch()`: `--settings` choice *(unmarked)*, claude and codex arg building, env | `settingsFile === 'kanban'` picks the kanban hook file; `extra.launchArgs` go before the resume/prompt args; `extra.env` is merged under the office's variables; task workers get `AIKANBAN_API_BASE` (hook URL) and `AIKANBAN_TASK_ID` | Per-phase permission flags; ai-kanban's env names keep existing skills working |
| `src/server/workers.ts` | `writeHookSettings()` | Also writes `claude-hooks-kanban.json` with `skipDangerousModePermissionPrompt: true` | Bypass-mode phases start without the TUI confirmation |
| `src/server/workers.ts` | `writeOfficeCommands()` | Adds `office-tasks` to the commands written into `<data>/bin/` | Every worker can read other tasks from its PATH |
| `src/server/workers.ts` | `persist()` / `load()` *(unmarked in load)*, new `validKanban()`, `validExtra()` | `kanban` and `extra` saved in and read back from `workers.json` | Task workers survive an office restart as task workers |
| `src/server/workers.ts` | `DepartureIntent` import; `Worker.departure`; `kill(…, intent?)` | Who sent a worker home and why (`sent-home`, `queue`, `meeting`, `merged`, `released`, `engine`), kept on the worker and passed to observers with `removed` | One departure path for every way a worker leaves; the engine writes one status comment per departure |
| `src/server/workers.ts` | `keepGuards` field, `addKeepGuard()`, its check in `kill()` | A guard forces cleanup `keep` while the kanban still needs the worktree | Another worker of the task sits in it, or a run is live |
| `src/server/workers.ts` | `spawn()`, after the seat checks | A watch spot (`seat.watch`) takes only `extra.kanban.role === 'reviewer'` | Nobody else is hired behind a desk |
| `src/server/office-workers.ts` | the `desk` check in the hire body's validation | `seat.watch` is refused too | A hire through `office-workers` / the MCP tool is refused at the boundary, before `spawn` |
| `src/server/server.ts` | import; `floor.plan.shrink(…)` callback | Also taken when someone stands behind the desk (`watchSpotOf`) | Walling up the back office never strands a reviewer |
| `src/server/workers.ts` | `setKanbanSummary()` | Sets `WorkerInfo.kanban` and sends the ordinary `worker.update` | The desk card and /lite follow the task without a kanban subscription |
| `src/server/office-workers.ts` | after `MCP_READ_ONLY` | New `MCP_TASK_TOOLS` (`get_task`, `search_tasks`) | Task workers are launched allowing them (upstream's read-only list stays as it is) |
| `src/server/floor.ts` | imports | `parseRepoFloorId`, `projectRepos` (kanban/projects) and `floorPulled` (kanban/integrations/pulls/board) | The floor's PR board covers the project's repositories and tells the kanban |
| `src/server/floor.ts` | `openPullIn()` (new, beside `openPull`) | The open PR for a branch in any list | Other repositories' lists |
| `src/server/floor.ts` | `Floor.boards` field; constructor's `gh.pulls` callback; `refreshBoards()` calls in the constructor, refresh timer and `arrived()` *(unmarked)*; `shutdown()` stops them *(unmarked)* | One pulls-only `GitHub` per other git repository with a remote; the callback emits `pullsState()` and calls `boardPulled()` | The PR board shows every repository of the project |
| `src/server/floor.ts` | constructor, the `(workerId, repo)` callback given to `new Changes(…)` | A synthetic `<floor>~<repo>` id finds the project's own other repository's board | Changes window and PR opening for a task's other repositories |
| `src/server/floor.ts` | `merged(n, by, repo?)` | `repo` for a PR in another repository | Gong keying (see github.ts) |
| `src/server/floor.ts` | new section "the project's other repositories' pull requests": `pullsState()`, `githubFor()`, `pullsOf()`, `boardOf()`, `otherRepo()`, `refreshBoards()`, `boardPulled()` | Merged PR list, per-repo `GitHub` lookup, merge watch over all lists; `floorPulled(this)` at the end of `boardPulled()` | Multi-repo PR board; the kanban's linked PR states follow the board |
| `src/server/floor.ts` | `sendLandedHome()` and `landed()` *(unmarked)* | `pullsOf` passed to `landedWorkers`/`landedWork` is `this.pullsOf` | Leave-on-merge sees the other repositories' PRs |
| `src/server/floor.ts` | import; `sendHome(id, cleanup, intent?)`; leave-on-merge's `kill(…, { reason: 'merged' })` | The departure intent passed through to `WorkerManager.kill` | Same |
| `src/server/leave-on-merge.ts` | `notLeaving()` | A worker of a task in progress, or with a run under way, is never picked | Leave-on-merge doesn't stop a task mid-work |
| `src/server/meetings.ts` | import; `MeetingWorkers.kill(id, intent?)`; its two calls | `{ by: 'The meeting', reason: 'meeting' }` | Same departure path |
| `src/server/queue.ts` | import; `QueueWorkers.kill(…, intent?)`; the recycle call | `{ by: 'The queue', reason: 'queue' }` | Same |
| `src/server/queue.ts` | `QueueEvents.claimIssue(…, key?)`; `add(…, issueKey?)`, `retry()`, `dropIssue(issue, key?)`, the claim in `pump()`, `load()`, `label()` | A task carries `issueKey` (a card from the project's issue sources): deduplicated, dropped and claimed by it, and kept across restarts | Issue-source cards on the 📋 queue ([Issue sources](kanban.md#issue-sources)) |
| `src/server/floor.ts` | imports; `offWall` field; the `GitHub` constructor's issues callback; `onWallIssues()` in the constructor; `watchWall()` in the refresh timer; `offWall()` in `shutdown()`; the queue's `claimIssue`; new section "the issues board from the project's issue sources": `issuesState()`, `claimCard()`, `cardKey()` | The issues board is `wallIssues(id)` (kanban/integrations/issues/wall.ts) when the project has issue sources, else upstream's (whose callback then doesn't emit); a card is claimed on GitHub by the number in its key (another repository's with `-R`), a Jira or project card isn't; `cardKey()` takes a key from a client only when it's a card on this floor's board | The 3D issues board from the kanban's issue sources |
| `src/server/webhook.ts` | `announce()` (new method) | Posts a kanban announcement ("🗂️ #14 … needs plan approval in …") like a worker's `needs_input` alert | A task waiting on a person reaches the team's notifications |
| `src/server/config.ts` | `Config.hookPort`; `--hook-port` parsing and `AGENT_OFFICE_HOOK_PORT`; the check in `loadConfig`; `HELP` text *(unmarked)* | Pins the loopback hook server's port | Scripts outside the office (ai-kanban's) can reach it |
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
| `src/server/server.ts` | `/assets/` route | Serves only files under `assets/` | An encoded `../` reached the signed-in pages' shells without a session |
| `src/server/server.ts` | `gh.merge`, `gh.comment`, `gh.close`, `gh.labels` replies | `gh.merged` / `gh.commented` / `gh.closed` / `gh.labeled` echo the request's `repo` | The PR window matches a reply to the right repository's PR |
| `src/server/server.ts` | `gh.close`, issue branch | `dropIssue(n)` only when the issue is the primary repository's | The queue holds the primary repository's issues; another repository's #n isn't one |
| `src/server/server.ts` | after the floors open: `installKanban({…})`'s `capacity`, `runAs`, `notify` | `machine.full()`, the sign-ins, `webhook.announce()` | Task hires queue for the worker limit, keep upstream's sign-in rule, and waiting tasks are announced |
| `src/server/server.ts` | `worker.prompt` case | `kanban.workerPrompt(info, text, caller, msg.asComment === true)` first; upstream's typing-in (and issue claim) when it hands back `undefined`; with `issue`, the claim after the comment is in | P / Ask / an issue card on a task worker is a task comment, only when the fork's dialogs send `asComment`; everything else types in as upstream |
| `src/server/server.ts` | `worker.resume` case | `kanban.workerResume(info, caller)` first | R on a task worker whose task waits is Retry |
| `src/server/server.ts` | imports (`refreshWall`); `floorView()` `issues`; `carry`, `worker.spawn`, `worker.prompt` and `queue.add` cases; `takeIssue(c, floor, n, key?)`; `gh.close`'s issue branch | `issues: floor.issuesState()`; `issueKey` from those messages only through `floor.cardKey()` (a card on that floor's board, checked before `queue.add` stores it); the claim goes through `floor.claimCard()`; a closed issue refreshes the sources' board a moment later | Same |
| `src/server/server.ts` | `gh.refresh` case | `refreshWall(floor.id, 0)` after upstream's refresh | 🔄 Refresh on the issues board fetches the project's issue sources again too |
| `src/server/server.ts` | `worker.kill` case; `/office/workers` send-home route | The intent `{ by, reason, done? }` (`msg.kanban.done`) to `floor.sendHome` | X can move the task to Done; leave-on-merge's reason |
| `src/server/server.ts` | hook server: `listenHooks(cfg.hookPort ?? lastHookPort)` and the fallback message | A pinned hook port | See config.ts |
| `src/server/upgrade.ts` | `findAppDir()` | The install is found by `package.json` `name === '3d-kanban'` | The package is renamed ([Name and releases](#name-and-releases)); without it self-upgrades on a provisioned server would look in the wrong folder |
| `src/server/config.ts` | `HELP` title and *Usage* lines | `kanban3d` instead of `agent-office` | The command is `kanban3d` |
| `src/server/setup.ts` | `SETUP_HELP` title and *Usage*; `walkthrough()`'s "run `kanban3d setup` again" | Same | Same |
| `src/server/accounts.ts` | `HELP` title and *Usage*; the hints in `runAccounts()` (no office yet, no accounts yet, admin first) | Same | Same |
| `src/server/cli.ts` | `passwordLine()` | `(kanban3d accounts)` | Same |
| `src/server/decor.ts` | picture fetch `user-agent` | `3d-kanban; +https://github.com/devellaoy/3d-kanban` | Sites see this fork's name and address |
| `src/server/server.ts` | HTTP: after `/favicon.svg`, before the session check | `/manifest.webmanifest` (`application/manifest+json`), `/sw.js` (`Service-Worker-Allowed: /`), `/offline.html`, `/icons/*`, all `no-cache` and without a session | The PWA: the browser fetches the manifest, icons and worker without the cookie ([configuration](configuration.md#pwa)) |

### Shared

| File | Where | What | Why |
|---|---|---|---|
| `src/shared/prompts.ts` | import, `PromptGroup`, `PROMPT_GROUPS`, end of `DEFS` | `'kanban'` group ("🗂️ Kanban tasks") and `...KANBAN_PROMPT_DEFS` | Every kanban prompt shows in upstream's prompt editor and `prompts.json` |
| `src/shared/protocol.ts` | import, `WorkerInfo.kanban` | `{ taskId, role: 'implementer' \| 'reviewer' }` | A task worker says whose it is |
| `src/shared/protocol.ts` | `worker.prompt` | `asComment?: true` | A comment on a task worker's task (the fork's dialogs only); without it, typed in as upstream |
| `src/shared/protocol.ts` | `worker.kill` | `kanban?: { done?: boolean }` | X can move the task to Done |
| `src/shared/protocol.ts` | `GhIssue.repo`, `GhPull.repo` | owner/name of the card's repository | Multi-repo boards |
| `src/shared/protocol.ts` | import; `GhIssue.key/source/status/taskId`, `CarriedIssue.key`, `QueueTask.issueKey`; `carry`, `worker.spawn`, `worker.prompt`, `queue.add` | The ticket key of a card from the project's issue sources (number 0 for one that isn't a GitHub issue) and `issueKey?` on the messages that hand one out | The 3D issues board from the kanban's issue sources |
| `src/shared/protocol.ts` | `gh.merge` / `gh.comment` / `gh.close` / `gh.labels` and their replies | optional `repo?: string` | Same |
| `src/shared/protocol.ts` | `ClientMsg`, `ServerMsg` unions *(unmarked)* | `\| KanbanClientMsg`, `\| KanbanServerMsg` | The kanban's WS messages ride upstream's socket |
| `src/shared/layout.ts` | `DeskDef.watch`; new `watchSpots()`, `watchSpotOf()`, `WATCH_SPOTS` before `DESK_BY_ID`; `DESK_BY_ID` includes them (its doc comment says so) | A spot behind each seat (desk or bean bag), with the seat's place and turn | A task's reviewer stands behind its implementer's chair instead of taking a desk ([architecture](kanban-architecture.md)) |
| `src/shared/maps/index.ts` | import; `officePlan()`'s and `planMap()`'s `byId` | `...watchSpots(...)` of the map's desks and overflow seats, in the same spread in both | The spot is where its seat is, on every map |

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
| `src/client/ui/settings.ts` | import; `SettingsPane` (`\| KanbanSettingsPane`); `PANES` (`...KANBAN_PANES`); `const kanban = kanbanSettingsSlots(net)` before `panes`; `panes.kanban`, `panes.projects`; `kanban.shown(id)` in `show()`; `kanban.close()` in `onClose` | The kanban's categories 🗂️ Kanban and 📁 Projects (kanban/settingsslot.ts), after 🤖 Workers; their code (kanban/settings.ts) and settings load the first time one is shown | The kanban's settings are part of the office's own ⚙️ Settings, not a window of their own; the kanban page's ⚙️ opens this same window |
| `src/client/ui/prompts.ts` | import, `openPromptEditor()`: `scope`, `saved()`, `paint()`, `save`, `onClose` | `promptScope()` (kanban/promptscope): project scope picker and the read-only contract block for kanban prompts | Office vs project layering in upstream's editor |
| `src/client/ui/pull.ts` | import; PR window footer | 🔍 Review and 🤝 Review panel first open `openReviewPicker()` (kanban/prpicker) | Multi-PR review; "just this one" keeps upstream's flow |
| `src/client/ui/pull.ts` | waiter maps, `routePullMessage` | Waiters keyed by kind + number + repo; replies matched by repo when they carry one | `api#5` isn't the primary's #5 |
| `src/client/ui/pull.ts` | `commentBox`, `openMerge`, `openClose`, `openLabels`, `openPull`, `openIssue` | `repo` in gh.* messages, `?repo=` on `/api/gh/*`, titles show `api#5` | Same |
| `src/client/state.ts` | import; top of `workerForPull()` | A card with `repo` goes to `workerForRepoPull()` | "Go to desk" finds the right worker |
| `src/client/main.ts` | `pullRequestFor()`, `pullRequestsFor()` lookups | PR matched by number and repo | "O" opens the right card |
| `src/client/lite.ts` | `showMeeting` `openPr` | Same lookup | Same |
| `src/client/ui/repos.ts` | import; `render()` | A project repo's PR on this floor's board opens in the PR window | Multi-repo workers' PRs |
| `src/client/main.ts` | imports; `officeLink` after `chose3d`; `followOfficeLink()` (new, after `openKanban`) called at the end of the `welcome` and `floor.enter` cases | The kanban's 📍 Show in 3D link `/?floor=&worker=&desk=`: in on that floor, to the desk, the worker window on its Task tab | One world, two views |
| `src/client/main.ts` | `syncWorkers()` (`setTask`, name tag, `kanbanNames`), the retry-countdown `setInterval` after `meetingCard` | A task worker's card `🗂️ #14 · title` / `phase round · waiting`, name tag `Ada · #14`, ⏳ countdown | The desk shows the task |
| `src/client/main.ts` | `cameFrom()`, `yours()` | `kanbanStarter(createdBy)`: from the doors; a task you started is yours | Kanban hires |
| `src/client/main.ts` | `promptAtDesk()` (title "✨ Hire at", `kanbanOption`, `promptTaskWorker` branch), `hireAtDesk()`, `sendToWorker()` (`kanbanOption`, task on the buttons, no reviewers) | Hire as a kanban task; P at a task worker is a message on its task | docs/kanban-coupling.md |
| `src/client/main.ts` | `killWorker()` top | `sendTaskWorkerHome()` (kanban/sendhome) | Move to Done on X |
| `src/client/main.ts` | `openKanban()`, `goToNextWaiting()` toast, `openWorkerTerminal(…, tab)` | J opens the task you face (`tab=conversation`); N says what the task waits on | Same |
| `src/client/main.ts` | `boardActions().kanbanTask`, `interact()` (P with a card at an empty desk, R), `dropCard()` (`cardToTaskWorker`), `cardTaskAt()` (new), `carryHint()` P, `deskHint()` title/task/R | Issue cards as kanban tasks; only a task's own issue goes to its worker; R retries | Same |
| `src/client/main.ts` | imports (kanban/issuecards, `cardId`; `issuePrompt`, `openIssue`, `issueMeeting`, `issueTask` no longer); `offBoard()`, `renderIssuesBoard`, `teeOff()`, the reconnect `carry`, `floor.enter`'s toast; `hire()`'s `issue` (a number, or a card's `cardFields`); the command palette's issues; `boardActions().kanbanTask`; `interact()` O on a note; `setCarrying()`, `pickUp()`, `putBack()`, `dropCard()`, `cardTaskAt()`; `onQueue()` removed (`cardOnQueue`); `carryHint()`; the hint key; `noteUnder()`; `issuesTex.lift()` | A card is told apart by `cardId` (its key, else `#n`), named by `issueCardLabel`, handed out with `cardFields` (`issue` for the floor's own issue, `issueKey`) and `cardPrompt`, opened with `openCard` | Issue-source cards on the board, in your hands and at every drop target |
| `src/client/world/boards.ts` | import; `DrawnNote.id`, `lifted`, `noteAt()`, `lift()`; `render()`'s tilt, color and number | Notes by `cardId`, colored by `noteSeed`, labelled `UYT-1415` / `api#12`, with `🗂️ #N` for a card made into a task | Same |
| `src/client/world/card.ts` | import; `issueCard()` color, pin and label; `HeldCard.issue` | The carried card shows its label and is swapped by `cardId` | Same |
| `src/client/ui/boards.ts` | imports; `issueColumns()` in progress (a keyed card's queue task by `taskForCard`); `queueChip(issue, key?)`; `card(…, onLabels \| null, label?)`; the issues column's cards (one `card()` call); `openIssue` import | Every issue card opens with `openCard`; one with a key has its source, status and task chips, and labels only for the project's GitHub issues | Same |
| `src/client/ui/pull.ts` | import; `openIssue()`'s `renderFrame()` queue task | `taskForCard(it)` for a card with a key, else upstream's `taskForIssue` | Another repository's #12 isn't the floor's #12 on the queue |
| `src/client/lite.ts` | import; `boardActions().kanbanTask` | `cardTask` (kanban/issuecards) instead of `issueTask` | A card from the issue sources becomes its task by its key on the 2D view too |
| `src/client/state.ts` | `rememberFloor()` | exported | The deep link comes in on its floor |
| `src/client/notify.ts` | import; `waitingOnSomeone()` | `taskWaiting()` first | N, the count and the compass follow the task |
| `src/client/interaction.ts` | import; `R` | `canRetry()` too | R retries a waiting task |
| `src/client/ui/terminal.ts` | import; `TerminalOptions.tab`; `mountWorkerTabs()` before `ro.observe(host)`; `kanbanTabs?.destroy()` in `onClose` (the variable is `kanbanTabs` because upstream #212's `termTabs()` result is `tabs`) | A task worker's window: 🖥️ Terminal (with upstream's web page tabs) / 🗂️ Task #14 (kanban/worker3d; the task tab hides the terminal side at window level with `kb-on-task`); upstream's 🌿 Changes stays in the header | The task view inside the worker window |
| `src/client/ui/terminal.ts` | the backdrop's `dragenter` and `drop` handlers | `inTaskPane(e.target)` (kanban/office) or `termHidden()` (a web page tab or the task tab is showing): such a drop isn't uploaded and typed into the terminal | Files for the task's composer never reach the PTY |
| `src/client/ui/prompt.ts` | import; `PromptOptions.kanbanOption`, `rawLabel`, `onSubmit` `raw`; `openPrompt()` toggle, paint, `send(raw)`; `SendHomeOptions.extra` and the body | The "🗂️ Run as a kanban task" toggle (kanban/hireform); "Type straight into the terminal instead"; the task block in send-home | Same |
| `src/client/ui/ask.ts` | import; `AskWorker.task`, `AskOptions.kanbanOption`; `pick()`, the body, `send()` | Kanban toggle for a new worker; `🗂️ #14` on a task worker's button | Same |
| `src/client/ui/boards.ts` | `BoardActions.kanbanTask?` | Optional action | 🗂️ Kanban task in an issue |
| `src/client/ui/pull.ts` | `openIssue()` footer | 🗂️ Kanban task button when `actions.kanbanTask` | Same |
| `src/client/ui/queue.ts` | imports; `openQueue()`: the kanban toggle before the form, the form's children, `submit()`'s kanban branch, `render()` parts, the `unsubs`/`tick`/`onClose`/first `render()` lines | `kanbanSection(queueOption(net))` (kanban/hireform, kanban/office3d), `kanbanQueueSection(net, watch.tasks())`, `kanbanQueueWatch` | **🗂️ Run as a kanban task** on the queue board; 🗂️ Kanban on this floor with the tasks waiting their turn |
| `src/client/ui/hud.ts` | help list | `J` text; `E/P/R/X 🗂️` rows | The H help |
| `src/client/lite.ts` | imports; `workerCard()` sub line, `promptWorker()`, `sendToWorker()` (`askWorker`), `boardActions().kanbanTask`, `fixLostWorktree()` send home | The same on the 2D view (its terminal gets the tabs from terminal.ts) | Same |
| `src/client/main.ts`, `src/client/lite.ts` | `sendToWorker()`'s `onSubmit` | `askWorker(net, to, prompt)` (kanban/office3d): `asComment` for a task implementer whose task the engine carries on, else upstream's `worker.prompt` | Ask → an existing task worker is a message on its task |
| `src/client/player.ts` | `SHOULDER`…`tapNdc()` (new, after `CENTER`, with `eyeSees()`, which takes the scene's camera so its ray can meet sprites); `onClick` doc; `pointerdown`, `pointerup` (third person with the mouse free: the tapped point), drag `pointermove`, `canLock`, `setView()`, `look()`, third-person `facing` in `update()` (after first person's, every frame but on a `walkPath`; upstream's turn in the steering block removed), `updateCamera()` target/offset | Third person captures the mouse and looks around like first person (no drag to orbit, clicks are the crosshair's, taps with the mouse free are where you tapped), faces where the camera looks standing or walking, camera over the right shoulder | Third person plays like first person, only the camera is behind you |
| `src/client/main.ts` | import; `shotAim()` heading/toss pitch; `ballHint()` key; `renderCrosshair()` `show`; *Clicking the world* header; `eyeRay`; `aimedAt()` (`raycaster.near`, `pickables` const, `eyeSees` line of sight with `camera`, `withinReach`) and new `inTheWay()` after it; `aimedNote` (upstream's mouse `pointer` removed); `player.onClick` tail (third person with the mouse free: upstream's tap path, at reach without slack); the per-frame `target` block; `pickTarget()` left unused | The crosshair in third person too: the camera's ray through it, ignoring what's between the camera and you, within reach of your eyes and in their line of sight | Same |
| `src/client/hanging.ts` | `pointerlockchange` cancel; `update()` ray; `place()`'s third-person `mouse.copy(ndc)` removed (nothing read it) | The crosshair, not the mouse, in third person too | Same |
| `src/client/main.ts` | import; `syncWorkers()`'s seat lookup (`seatView`), `model.watching`, its arrivals line (`desk.def.watch`); `inCourt()` (`!d.watch`); the per-frame laptop update (`!desk.watch`) | A reviewer's spot gets its view from `kanban/watch3d.ts`, and the reviewer walks in to it; it doesn't line up in the castle, and has no laptop to paint | The reviewer stands behind its implementer |
| `src/client/world/character.ts` | `Worker.watching`; `update()`'s working act | Working with no tool call to act out, a watching worker stands at rest instead of typing | The reviewer has no laptop to type on |
| `src/client/ui/settings.ts` | `VIEWS` third-person text | "The mouse looks around like in first person" | Same |
| `src/client/ui/hud.ts` | help list | `Mouse` row for both views, 🏀 text, `Wheel` instead of `Drag / wheel` | Same |
| `src/client/index.html`, `src/client/lite.html` | `<head>` after the icon; after the entry `<script>` | Manifest, apple-touch-icon, `theme-color` (index only; lite had one), `apple-mobile-web-app-capable`; `<script type="module" src="./pwa.ts">` | The PWA: installable, and `pwa.ts` registers `public/sw.js` |
| `src/client/login.html`, `src/client/join.html`, `src/client/claim.html` | `<head>` after the icon | `theme-color` only | The installed app's colour on the sign-in pages |
| `src/client/ui/prompt.ts` | `sendHomeDialog()` `choices` | "`kanban3d prune` tidies up later" | The command is `kanban3d` |
| `src/client/ui/accounts.ts` | shared-password note (off) | "run `kanban3d accounts password on`" | Same |
| `src/client/world/sky.ts` | `INDOOR_FOG`, `ROOM_*`, `WALL_TOP`, `hazeAt()`, `wingRoom()`, `roomAt()`, `indoorAt()`, `ROOM_VARYING`, `ROOM_PARS` with `skyInsideOf()` (split out of `PARS`), `SPRITE_WORLD`, `HAZE_PARS`' `skyInRoom()`, `HAZE`, `onBeforeCompile`, `Sky.setWing()` | Anything inside the office keeps a tenth of the outdoor fog, when you're inside too; upstream PR #207 (closed unmerged, issue #122 still open), plus the fork's own camera check, sprites' haze and the TypeScript mirrors the tests use | The weather's fog doesn't come into the office |

### Build, packaging, deploy, docs

| File | Where | What | Why |
|---|---|---|---|
| `vite.config.ts` | `rollupOptions.input` | `kanban: src/client/kanban.html` | The kanban page is built |
| `package.json` *(unmarked)* | `dependencies`, `devDependencies` | `better-sqlite3`, `@types/better-sqlite3` | The kanban's database |
| `package.json` *(unmarked)* | `scripts` | `migrate:ai-kanban` (tsx `scripts/migrate-ai-kanban/index.ts`); `typecheck` also runs `tsc -p tsconfig.scripts.json --noEmit` | The migration and its type check |
| `package.json` *(unmarked)* | `files` | `skills` | The bundled skills ship with the package |
| `package.json`, `package-lock.json` *(unmarked)* | `name`, `bin`, `engines` | `3d-kanban`, `{ "3d-kanban": "bin/agent-office.js" }`, `node >=22` | [Name and releases](#name-and-releases) |
| `install.sh` | header comment, `REPO`/`NAME`/`MARKER`/`INSTALL_DIR`, `die()`, `check_requirements()`, `install_release()`, `write_launcher()`, `main()` messages | `devellaoy/3d-kanban`, asset `3d-kanban.tgz` (falling back to `agent-office.tgz` for v0.1.3), `~/.local/share/3d-kanban`, launcher `3d-kanban`, Node 22, a build-tools hint when `npm ci` fails | Same |
| `install.ps1` | header comment, `$repo`/`$name`/`$marker`/`$installDir`, `Check-Requirements`, `Install-Release`, `Write-Launcher`, messages | The same as `install.sh`, for `%LOCALAPPDATA%\3d-kanban` and `3d-kanban.cmd` | Same |
| `.github/workflows/release.yml` | header comment; *Pack the release*; *Install it with install.sh*; *Publish* | `3d-kanban-<version>.tgz` → `3d-kanban.tgz` (and the entry file checked in it), `bin/3d-kanban --help` checked, the release notes lead with the install lines of `$GITHUB_REPOSITORY` | Same |
| `deploy/provision.sh` | header comment, `APP_REPO` default, the *Installing* step, the Node check | `https://github.com/devellaoy/3d-kanban.git`; installs Node 22 when it finds an older one | A server gets this fork (a clone built in place, not the release asset) |
| `deploy/aws.sh`, `deploy/azure.sh` | `cmd_up()` `APP_REPO` fallback | `https://github.com/devellaoy/3d-kanban` when the clone has no GitHub origin | Same |
| `deploy/fly.sh`, `deploy/railway.sh`, `deploy/dokploy.sh` | "run this from a clone of …" errors | `3d-kanban` | Same |
| `tsconfig.scripts.json` | new file | Type-checks `scripts/**/*.ts` | The migration script is outside `src/` |
| `bin/office-workers.js` | import; `runTool()`; `tools/list`, `tools/call` *(unmarked)* | `get_task` / `search_tasks` from `office-tasks.js`, listed only when `tasksVisible(env)` (`AIKANBAN_API_BASE` or `AGENT_OFFICE_TASKS` set) | MCP tools for task workers |
| `deploy/container/Dockerfile` | build stage | `python3 make g++`; `npm rebuild better-sqlite3` after `npm ci --ignore-scripts` | Native module needs its binary |
| `AGENTS.md`, `CLAUDE.md` | whole files *(unmarked)* | `AGENTS.md` holds the fork's rules, replacing upstream's `CLAUDE.md` content (its PR/merge workflow rules removed on purpose); `CLAUDE.md` is only the one-line pointer `@AGENTS.md` (Claude Code's import), not a symlink, so Windows checkouts work | This fork has no upstream-style PR workflow; one rules file every agent (Codex, OpenCode, Claude Code…) reads |
| `README.md` | top | Fork section above upstream's README, which follows unchanged (its *Mouse drag / wheel* row is flagged there as out of date) | What this fork is |
| `docs/features.md` | *A floor per project*, *One task across several projects*, *One-click PRs*, *PR board*, *Walk around*, *Basketball* | An "*In 3d-kanban*" sentence at the end of each, pointing to [kanban.md](kanban.md) | The upstream docs don't contradict the fork |
| `docs/configuration.md` | *Where the office keeps things* | An "*In 3d-kanban*" paragraph before *Command line* (kanban data, settings, migration) | Same |
| `docs/features.md` | *Day and night, and weather* | Last sentence: fog is kept out of doors | Same as `sky.ts` above |
| `docs/how-it-works.md` *(unmarked)* | *Sky* | The haze sentence on the room you're in (from upstream PR #207) | Same |
| `docs/controls.md` | keys table (`O` text, new `J` row; `Mouse`, `Click`, `Wheel` rows for the third person that looks around like first); new section *In the kanban view* | The fork's keys | Same |
| `vite.config.ts` | imports (`createHash`, `writeFileSync`); `pwaBuild()` (new, before `defineConfig`); `plugins` | Writes the build's id into `dist/public/sw.js` (`'__PWA_BUILD__'`) | Each build's `/assets/` get a cache of their own |
| `docs/configuration.md` | end of the file | Section *PWA* (the fork's) | How to install it, HTTPS, updates |
| `README.md` | fork section | A PWA bullet | Same |
| `README.md` | fork section *Install*; upstream part *(unmarked)*: badges, the install lines, *Requirements* (Node 22, build tools), *Run locally* commands and clone, the deploy sections' clones, `provision.sh` line, *Add users* commands, *Development*'s release sentence | `devellaoy/3d-kanban` and the `3d-kanban` command everywhere an instruction installs or runs it | No instruction installs upstream by mistake |
| `docs/self-hosting.md`, `docs/aws.md`, `docs/azure.md`, `docs/fly.md`, `docs/railway.md`, `docs/dokploy.md` *(unmarked)* | `provision.sh` lines, clones, "install/pull the latest …", commands and the systemd `ExecStart` | Same | Same |
| `docs/configuration.md`, `docs/maps.md` *(unmarked)* | *Command line* usage lines; `3d-kanban <dir>` mentions | Same | Same |

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
   - `src/client/world/sky.ts`: if upstream fixes its issue #122 (fog indoors) its own way, take upstream's
     version and drop the fork's (upstream PR #207) along with `tests/sky.test.ts`.
   - `src/client/ui/termtabs.{ts,css}` are upstream #212's files verbatim: upstream's version wins.
     worker3d's `kb-on-task` hides the terminal side at window level, so anything upstream adds there
     hides on the task tab too.
4. Re-check `package.json` (dependencies, `files`, `typecheck`, `migrate:ai-kanban`), `vite.config.ts`
   inputs and the Dockerfile's `better-sqlite3` rebuild; keep this fork's `AGENTS.md` and the pointer
   `CLAUDE.md` (`@AGENTS.md`), resolving any upstream change to `CLAUDE.md` in favour of the pointer.
5. `npm install && npm run typecheck && npm test && npm run build`, then by hand: a kanban task through
   plan → implement → review → PR, **O** at an ordinary worker's desk, the PR board of a multi-repo
   project, and the 3D office itself.
6. Update the tables here for any seam that moved or changed.

## M0 spike results (2026-09-30, Claude Code 2.1.285, codex-cli 0.159.0)

- Claude and Codex hooks both report `session_id` and `transcript_path` (upstream already stores them).
  Hook output is discarded (`>/dev/null`), so the office can't answer hooks; the engine reads results instead.
- Claude transcript JSONL: `type: 'assistant'` lines carry `message.content[]` blocks; the turn's final
  text is the `text` blocks of the last assistant message (its lines share `message.id`) after the last
  user prompt. `ExitPlanMode` shows up as a `tool_use` block
  whose `input.plan` is the plan. The Stop hook can arrive before the final message is in the log (it
  then ends at a tool's result), so a last message with a tool call isn't the final answer; the Stop
  hook's payload carries `last_assistant_message`, the fallback when the log doesn't catch up (the fix
  relies on it: without it, a log that never catches up still gives what the agent said on the way,
  with a warning in the office's log).
- Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`): `event_msg` / `task_complete`
  carries `last_agent_message`.
- Claude's background agents: an async launch is a user line with `toolUseResult.isAsync` and
  `status: 'async_launched'` (`agentId`; a launch with no `toolUseResult` counts only as an Agent or Task
  call's result starting `Async agent launched successfully` with an `agentId:` line); a `SendMessage`
  resume has `toolUseResult.resumedAgentId`; the end is a `<task-notification>` (a user line with
  `origin.kind: 'task-notification'`, trusted over its text whenever `origin` is there, or a
  `queued_command` attachment inside another turn) naming the `<task-id>`. A notification counts as a real prompt for the
  final answer, but not as the office's prompt that opens the window agents are counted in. A Claude CLI
  restart between phases stops the previous phase's background agents, which the window handles.
- Claude flags: `--permission-mode <mode>`, `--disallowedTools`, `--plugin-dir <path>` (skills as a plugin),
  `--resume <id>`, `--session-id <uuid>`; `--json-schema` only works with `--print`, so interactive review
  verdicts are parsed from the final text. The setting `skipDangerousModePermissionPrompt` exists
  (skips the bypass-mode confirmation in the TUI).
- Codex flags: `-s read-only|workspace-write|danger-full-access`, `-a never`,
  `--dangerously-bypass-approvals-and-sandbox`, `codex resume <SESSION_ID> [PROMPT]`.
- Decision (A4 gate): every phase runs on upstream PTY workers; no phase needs a headless fallback.
