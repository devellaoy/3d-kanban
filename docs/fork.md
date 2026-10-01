# Fork notes

Back to the [README](../README.md).

## Upstream

- Upstream: https://github.com/AgentSystemLabs/agent-office (MIT).
- Base: `665aeec571bc03f76cbd16de8d628dd169a48874` (main, 2026-09-30), taken as a source tarball, plus upstream
  PR #215 (`650e872c33052dd42bd4abe26862f89d6c78e603`, 2026-09-30: the split of `main.ts`, `server.ts`,
  `workers.ts`, `protocol.ts`, `state.ts`, `player.ts`, `ui/pull.ts` and others into registries and folders,
  see [Code layout](code-layout.md)). It was brought in with `git cherry-pick 650e872c`; its parent is the old
  base, so it was a real three-way merge, and every seam below was moved to the new layout in the same change.
  Later upstream commits (#195, #201, #202, #212, #213) are not in.
- The `upstream` remote exists in this clone (`https://github.com/AgentSystemLabs/agent-office.git`); nothing
  requires it elsewhere, and a copy without it can add it with `git remote add upstream <url> && git fetch upstream`.

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

Upstream moves fast (hundreds of commits in its first days). Upstream changes are taken in **only when the
user decides**:

1. On a separate branch: `git fetch upstream`, then `git cherry-pick <commit>` for an upstream commit, or
   `git merge upstream/main` for all of it. A cherry-pick is a clean three-way merge as long as the fork has
   taken exactly upstream's history up to that commit's parent (the base above is such a point, and so is
   every commit after it that has been cherry-picked in order): the commit's parent is then the merge base.
   Later upstream commits can be taken the same way, in order.
2. Resolve conflicts with the seam list below: every fork change in an upstream file is listed there.
3. `npm run typecheck && npm test && npm run build`, then check the kanban and the 3D office by hand.

If conflicts grow unreasonable, the fork can stay on its base: fork code talks to upstream only
through the seams below.

## Seams in upstream files

Every fork change in a file that came from upstream, one row per seam. Code seams carry a
`3d-kanban` comment (find them with `grep -rn "3d-kanban" src bin vite.config.ts deploy`, outside
`src/{server,shared,client}/kanban/`); the rows marked *(unmarked)* have no comment of their own and
must be found by hand. Line numbers drift; the "where" column names the function or section.

New files are not seams (they can't conflict): `src/{server,shared,client}/kanban/**` (on the server
including `ws/`, `http/`, `workers.ts` (`KanbanWorkers`, which `WorkerManager` extends), `launch.ts` and
`office.ts`; on the client `install3d.ts`, `views3d.ts`, `shoulder.ts`, `camera3d.ts` and `sensitivity.ts` among the 3D office's pieces),
`src/client/kanban.html`, `bin/office-tasks.js`, `scripts/migrate-ai-kanban/`, `skills/`,
`tests/kanban-*.test.ts`, `tests/sky.test.ts` (upstream PR #207's, so it would conflict only if upstream adds the same file), `tsconfig.scripts.json`, `docs/kanban.md`, `docs/kanban-architecture.md`,
`docs/migration.md`, `docs/fork.md`.

### Server

| File | Where | What | Why |
|---|---|---|---|
| `src/server/github.ts` | `MergeWatch.ring(n, repo?)`, `look()` and the new `pullKey()` | Merges are keyed by `repo#n` instead of `n` | A project's repositories can have PRs with the same number; the gong must ring once per PR |
| `src/server/github.ts` | `GitHub` constructor: `nameWithOwner?`, `pullsOnly` params | Optional owner/name and a pulls-only switch | A project's other repository gets a `GitHub` of its own that fetches only PRs |
| `src/server/github.ts` | `refreshIssues()` / `refreshPulls()` item mapping *(unmarked)*, `refresh()` *(unmarked)* | `...(this.nameWithOwner ? { repo } : {})` on every issue and PR; `refresh()` skips issues when `pullsOnly` | Each card knows its repository (`GhIssue.repo` / `GhPull.repo`) |
| `src/server/github.ts` | import; `GitHub.target` (new getter after the constructor); every gh call that's about the repository *(unmarked)*: `repoInfo()`, `pullDetail()`, `pullDiff()`, `issueDetail()`, `comment()`, `review()`, `repoLabels()`, `setLabels()`, `claim()`, `refreshIssues()`, `refreshPulls()` | `-R owner/name` (`gh repo view owner/name`) and `repos/owner/name/…` instead of `{owner}/{repo}` in `gh api`, owner/name being `nameWithOwner` or else the checkout's `origin` (`checkoutRepo`, kanban/ghrepo.ts); a checkout without a github.com origin keeps gh's own pick | Without `-R`, gh picks the base repository from the remotes (upstream > github > origin), so a fork's checkout with an `upstream` remote listed, commented on and merged the upstream repository's issues and PRs |
| `src/server/changes.ts` | import; `pullRequest()`'s `gh pr create` | `-R` the repository of the remote it just pushed to | Same: the PR opens in the fork, not upstream |
| `src/server/workers/pr.ts` | import; `findOpenPr()` and `createPr()` | `-R` the checkout's origin | Same, for the PRs the office opens for a worker |
| `src/server/workers/types.ts` | `SpawnExtra`, `WorkerObservation`, `WorkerObserver` (new exported types after `OpenedPr`); `Worker.extra`; `Worker.departure`; `WorkerHandle.observeHook`; `DepartureIntent` import | What the engine passes to `spawn` (launch args, reuse of a worktree, resume session, `kanban` role, env, `settingsFile: 'kanban'`, `bases`: the branch to cut each checkout's worktree from, `countsWith`) and what observers hear; `{ launchArgs, env, settingsFile, reused }` kept per worker; who sent a worker home and why (`sent-home`, `queue`, `meeting`, `merged`, `released`, `engine`) | The engine hires ordinary PTY workers with per-phase flags and follows their status/hooks; relaunches and restarts keep the phase flags; one departure path for every way a worker leaves |
| `src/server/workers.ts` | the `export type { … }` line | Also re-exports `SpawnExtra`, `WorkerObservation`, `WorkerObserver` | Other server code imports them from the barrel |
| `src/server/workers/worker.ts` | a re-export line after the imports | `KanbanWorkers`, `kanbanSetup`, `DepartureIntent` from `kanban/workers.js` | `manager.ts` takes what it needs from the fork through `worker.js` |
| `src/server/workers/manager.ts` | `class WorkerManager extends KanbanWorkers`, `workers` made `protected`, `super()` in the constructor, `emitUpdate` made `protected` | The fork's part of the manager lives in `src/server/kanban/workers.ts`: `observe()`, `addObserver()`, `addKeepGuard()`, `setKanbanSummary()`, `launchArgsOf()`, `transcripts()`, `relaunch({ model, effort })` (stop + `--resume` with new flags, checked with `validateWorkerModel/Effort`), `hired()`, `departing()`, `emitted()`, `observable()` | Observers hear removals, hooks, status changes and exits; a task's summary reaches the desk card and /lite as an ordinary `worker.update`; a `reused` worker or one a keep guard names always goes home with cleanup `keep` (a reviewer must never delete the task's worktree, and the worktree stays while another worker or a live run needs it) |
| `src/server/workers/manager.ts` | `spawn(…, extra?: SpawnExtra)` last param; `hired(w, owner, extra)` after the worker is made; `extra?.resumeSessionId` in the first `launch()` | `extra.reuse` seats the worker in an existing worktree/workspace (no new worktree); `resumeSessionId`, `kanban` copied into `info`; `w.extra` stored | Reviewers share the task's worktree; a new hire resumes the task's session |
| `src/server/workers/manager.ts` | `spawn()`'s seat check | A watch spot (`seat.watch`) takes only `extra.kanban.role === 'reviewer'`, refused before the built/occupied checks | Nobody else is hired behind a desk |
| `src/server/workers/manager.ts` | `spawn()`'s `capacity?.full()` line | The worker limit isn't checked for a hire whose `extra.countsWith` worker (the task's implementer) is still here; the hire is counted as usual once seated | A task counts once against the worker limit: its reviewer never waits for the place its own implementer holds, which nothing would free |
| `src/server/workers/manager.ts` | `spawn()`'s worktree lines, `makeWorkspace(…, bases?)`, `fetchBase(branch?)`; `src/server/workers/worktree.ts` `makeWorkspace(…, bases?)` and its two `create()` calls | `extra.bases[path.resolve(dir)]` passed to `Worktrees.create` for the floor's checkout and each other repository; `fetchBase` passes a branch to `Worktrees.fetch` | A kanban task's configured base branch (the primary's too) is what its worktrees are cut from; ordinary workers pass none, so upstream's rule stays |
| `src/server/worktrees.ts` | `create(…, baseBranch?)`, new private `baseStartPoint()`, `fetch(branch?)` and its `fetchedFor` field | `baseBranch` cuts from `origin/<branch>`, else the local branch, and returns an error when neither exists; `fetch` fetches that branch instead of the checkout's (a fetch of another branch in flight is waited for, then this one runs) | Same |
| `src/server/workers/manager.ts` | `kill(…, intent?)`: `departing()` on its first lines, before the worker is let go, and the `seen` callback on its `sendHome` call; the status/exit paths (`launch()`'s lost-folder path, the PTY `onExit` handler, `startFailed()`, `setStatus()`) calling `emitted(…)` instead of `emitUpdate`; `handleOf()` wrapped in `observable(…)`; `launch()`'s plan line (`kanbanSetup(w, adapter, setup)`, `extraArgs: w.extra?.launchArgs`), `env` line and `Object.assign(env, …)` | Observers hear exits and status changes, and hook events through the handle; `extra.env` is merged under the office's variables; task workers get `AIKANBAN_API_BASE` (hook URL) and `AIKANBAN_TASK_ID` | A run whose worker exits or can't start is interrupted, not left running; ai-kanban's env names keep existing skills working |
| `src/server/workers/worktree.ts` | `sendHome(…, seen?)` | Calls `seen('removed')` first and `seen('cleaned')` once the worktree is dealt with (also after `clearRepos`) | The observers hear a worker go before its worktree is touched, and when the folder may be gone |
| `src/server/workers/persist.ts` | imports; `saveWorkers()` (`extra`, `kanban`); `restoreWorkers()` (`validKanban`, `validExtra`) | `kanban` and `extra` saved in and read back from `workers.json` | Task workers survive an office restart as task workers |
| `src/server/workers/process.ts` | `writeOfficeCommands()` | Adds `office-tasks` to the commands written into `<data>/bin/` | Every worker can read other tasks from its PATH |
| `src/server/providers/types.ts` | `LaunchInput.extraArgs?` | `string[]`: a task phase's flags | The adapters' `launch()` takes them |
| `src/server/providers/claude.ts` | imports; `ClaudeSetup.kanbanSettings`; `setup()`; `claudeHook()`; `launch()` | `kanbanSettings: writeKanbanSettings(…)` (`claude-hooks-kanban.json` next to `claude-hooks.json`, with `skipDangerousModePermissionPrompt: true`, in `src/server/kanban/launch.ts`); `settingsFile === 'kanban'` picks it for `--settings`; `args.push(...extraArgs)` before `--resume` and the prompt; `h.observeHook(…)` before the status change | Kanban workers' own Claude `--settings` file (bypass-mode phases start without the TUI confirmation); per-phase permission flags |
| `src/server/providers/codex.ts` | `launch()`; `codexHook()` | `args.push(...extraArgs)` before `resume` and the prompt; `h.observeHook(…)` | Same |
| `src/server/kanban/launch.ts`, `kanban/workers.ts` | new files | `validKanban`, `validExtra`, `writeKanbanSettings`, `KanbanWorkers`, `kanbanSetup` | The fork's half of the worker seams |
| `src/server/office-workers.ts` | the `desk` check in the hire body's validation | `seat.watch` is refused too | A hire through `office-workers` / the MCP tool is refused at the boundary, before `spawn` |
| `src/server/office-workers.ts` | after `MCP_READ_ONLY` | New `MCP_TASK_TOOLS` (`get_task`, `search_tasks`) | Task workers are launched allowing them (upstream's read-only list stays as it is) |
| `src/server/floor.ts` | imports | `parseRepoFloorId`, `projectRepos` (kanban/projects) and `floorPulled` (kanban/integrations/pulls/board) | The floor's PR board covers the project's repositories and tells the kanban |
| `src/server/floor.ts` | `openPullIn()` (new, beside `openPull`) | The open PR for a branch in any list | Other repositories' lists |
| `src/server/floor.ts` | `Floor.boards` field; constructor's `gh.pulls` callback; `refreshBoards()` calls in the constructor, refresh timer and `arrived()` *(unmarked)*; `shutdown()` stops them *(unmarked)* | One pulls-only `GitHub` per other git repository with a remote; the callback emits `pullsState()` and calls `boardPulled()` | The PR board shows every repository of the project |
| `src/server/changes.ts` | `baseCommit()`'s return type and value, `compute()`'s state | `head` (the `rev-parse HEAD` it already runs) passed on as `ChangesState.head` | Same as `ChangesState.head` below |
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
| `src/server/building.ts` | `setName()` (new, before `newDef`) | Renames a floor (trimmed, 1-100 characters, unique among floors) and saves `floors.json`; the id, folder and repositories stay | A project's name is changed from the kanban's settings |
| `src/server/building.ts` | `load()` | `loadRepos(s.repos, …)` after each floor | Reads the repositories back from `floors.json` |
| `src/server/server.ts` | import; `ctx.kanban = openKanban(ctx, hookPort)` after the floors open; `ctx.kanban?.shutdown()` in the shutdown | `openKanban` (kanban/office.ts) builds the kanban on the building's floors, office prompts and hook URL, with `capacity` (`machine.full()`), `runAs` (the sign-ins, keeping upstream's sign-in rule) and `notify` (`webhook.announce()`); `shutdown()` stops the engine and plugins and closes the database | Wiring; task hires queue for the worker limit, and waiting tasks are announced |
| `src/server/kanban/office.ts` *(fork file)* | `openKanban()`'s `installKanban({…})`: `saveName` | `building.setName`, then the open floor's `project.name`, then `ctx.floorsChanged()` | A renamed project reaches the elevator, the top bar of new arrivals and the kanban |
| `src/server/office/context.ts` | import; new `KanbanHost` (`kanban?: Kanban`) in the `Ctx` intersection; `Gates.takeIssue(c, floor, n \| undefined, key?)` | The kanban on the office context | Every handler reaches it as `ctx.kanban`; a card from an issue source has a key and no number |
| `src/server/office/floors.ts` | `floorsChanged()` | `ctx.kanban?.projectsChanged()` | The kanban's project list follows the floors |
| `src/server/office/gates.ts` | `takeIssue()` | `queue.dropIssue(n, key)`; the claim goes through `floor.claimCard(n, key, as)`; the warning names `#n` or the key | Issue-source cards |
| `src/server/hooks/server.ts` | import; the routes before the others; `listenHooks(ctx.cfg.hookPort ?? lastHookPort)` and the fallback message | `officeTasks` (`/office/tasks*`, `/api/tasks/reference`: the worker hook token, like `/office/workers`) and `kanbanLoopback` (`/api/v1*`: the kanban decides who may) from `kanban/http/hooks.ts`; a pinned hook port | Agents read other tasks; ai-kanban compatibility; scripts outside the office (ai-kanban's) reach the hook server |
| `src/server/hooks/office-workers.ts` | `PullsView` and the send-home call | `pullsOf: (id) => floor.pullsOf(id)`; `floor.sendHome(w.id, cleanup, { by, reason })` (`merged` is leave-on-merge's) | Finds `<floor>~<repo>` repositories; the departure intent |
| `src/server/http/routes/index.ts` | import; `kanbanRoutes.pwa`, `kanbanRoutes.pwaIcons`, `kanbanRoutes.page` before the sign-in check, `kanbanRoutes.api` after it | The route table of `kanban/http/routes.ts`: the PWA's `/manifest.webmanifest` (`application/manifest+json`), `/sw.js` (`Service-Worker-Allowed: /`), `/offline.html` and `/icons/*`, all `no-cache` and without a session ([configuration](configuration.md#pwa)); `/kanban`, `/kanban.html` (signed out → `/login?next=/kanban`); `/api/kanban/*` to `kanban.handleHttp` (non-GET must be same-origin) | The PWA, the kanban page and its uploads/attachments |
| `src/server/http/routes/pages.ts` | the `/assets/` route | Serves only files under `assets/` | An encoded `../` reached the signed-in pages' shells without a session |
| `src/server/http/static.ts` | `MIME` | `export` (one word, marked at the end of the line) | The PWA's files (kanban/http/routes.ts) are typed from the same table as upstream's |
| `src/server/http/routes/github.ts` | the `/api/gh/*` detail routes | `?repo=` picks `floor.githubFor(repo)`, 404 when it isn't the project's | PR/issue windows for another repository |
| `src/server/ws/dispatch.ts` | import; `dispatch()`'s early return | A string type that isn't a key of the map goes to `kanbanUnknown` (kanban/ws/handlers.ts), which passes a `kanban.*` one to `handleWs` | A page newer or older than the office (the PWA can keep an old one) gets the kanban's "not available" error, not silence |
| `src/server/ws/handlers/index.ts` | import; `...kanbanHandlers` in `handlers`; `kanbanHooks` first in `features` | Every `kanban.*` type has an entry (`kanban/ws/handlers.ts`, from the keys of `KANBAN_CLIENT_TYPE_LIST` in `shared/kanban/protocol.ts`, the one list of them, which the parser checks too; a type missing there fails the typecheck) that calls `ctx.kanban.handleWs`; `kanbanHooks.closed` calls `kanban.clientGone(id)` | No deltas to a closed socket; the kanban's messages ride the office's socket |
| `src/server/ws/handlers/github.ts` | `issuesView`, `pullsView`; `gh.refresh`; `gh.merge`, `gh.comment`, `gh.close`, `gh.labels` | `floor.issuesState()` / `floor.pullsState()` (the project's issue sources, every repository of the project); `refreshWall(floor.id, 0)` after upstream's refresh (🔄 on the issues board fetches the issue sources too); `repo` picks `floor.githubFor(repo)`, merge passes it to `floor.merged`, the replies echo the request's `repo`; `gh.close` drops the queue's issue only when it's the primary repository's, and refreshes the sources' board a moment later | Every repository on the PR board; the PR window matches a reply to the right repository's PR; the queue holds the primary repository's issues; the 3D issues board from the kanban's issue sources |
| `src/server/ws/handlers/workers.ts` | `worker.spawn`, `worker.resume`, `worker.kill`, `worker.prompt`, `worker.pr` | `issueKey` only through `floor.cardKey()`; `worker.resume`: `kanban.workerResume(info, caller)` first (R on a waiting task is Retry); `worker.kill`: the intent `{ by, reason, done? }` (`msg.kanban.done`) to `floor.sendHome`; `worker.prompt`: `kanban.workerPrompt(info, text, caller, msg.asComment === true)` first, upstream's typing-in (and issue claim) when it hands back `undefined`; `worker.pr`: `prViaKanban()` (kanban/ws/pr.ts) first, upstream's `openPr` only on `PR_FALLBACK` | "O" has an agent write the PR; X can move the task to Done; P / Ask / an issue card on a task worker is a task comment only when the fork's dialogs send `asComment`, everything else types in as upstream |
| `src/server/ws/handlers/presence.ts`, `queue.ts` | `carry`; `queue.add` | `issueKey` through `floor.cardKey()` (a card on that floor's board, checked before `queue.add` stores it) | Issue-source cards in hands and on the queue |
| `src/server/ws/handlers/plan.ts` | `floor.plan.shrink(…)` callback | Also taken when someone stands behind the desk (`watchSpotOf`) | Walling up the back office never strands a reviewer |
| `src/server/upgrade.ts` | `findAppDir()` | The install is found by `package.json` `name === '3d-kanban'` | The package is renamed ([Name and releases](#name-and-releases)); without it self-upgrades on a provisioned server would look in the wrong folder |
| `src/server/config.ts` | `HELP` title and *Usage* lines | `kanban3d` instead of `agent-office` | The command is `kanban3d` |
| `src/server/setup.ts` | `SETUP_HELP` title and *Usage*; `walkthrough()`'s "run `kanban3d setup` again" | Same | Same |
| `src/server/accounts.ts` | `HELP` title and *Usage*; the hints in `runAccounts()` (no office yet, no accounts yet, admin first) | Same | Same |
| `src/server/cli.ts` | `passwordLine()` | `(kanban3d accounts)` | Same |
| `src/server/decor.ts` | picture fetch `user-agent` | `3d-kanban; +https://github.com/devellaoy/3d-kanban` | Sites see this fork's name and address |

### Shared

| File | Where | What | Why |
|---|---|---|---|
| `src/shared/prompts.ts` | import, `PromptGroup`, `PROMPT_GROUPS`, end of `DEFS` | `'kanban'` group ("🗂️ Kanban tasks") and `...KANBAN_PROMPT_DEFS` | Every kanban prompt shows in upstream's prompt editor and `prompts.json` |
| `src/shared/prompts.ts` | import, `PromptGroup`, `PROMPT_GROUPS`, end of `DEFS` | `'kanban'` group ("🗂️ Kanban tasks") and `...KANBAN_PROMPT_DEFS` | Every kanban prompt shows in upstream's prompt editor and `prompts.json` |
| `src/shared/protocol/workers.ts` | import; `WorkerInfo.kanban` | `{ taskId, role: 'implementer' \| 'reviewer', … }` (`KanbanWorkerSummary`) | A task worker says whose it is |
| `src/shared/protocol/workers.ts` | `worker.prompt` | `asComment?: true`, `issueKey?` | A comment on a task worker's task (the fork's dialogs only); without it, typed in as upstream |
| `src/shared/protocol/workers.ts` | `worker.kill` | `kanban?: { done?: boolean }` | X can move the task to Done |
| `src/shared/protocol/workers.ts` | `worker.spawn` | `issueKey?` | Issue-source cards |
| `src/shared/protocol/github.ts` | import; `GhIssue.repo`, `GhPull.repo`; `GhIssue.key/source/status/taskId` | owner/name of the card's repository; the ticket key of a card from the project's issue sources (number 0 for one that isn't a GitHub issue), its source, status and task | Multi-repo boards; the 3D issues board from the kanban's issue sources |
| `src/shared/protocol/github.ts` | `gh.merge` / `gh.comment` / `gh.close` / `gh.labels` and their replies | optional `repo?: string` | Same |
| `src/shared/protocol/presence.ts`, `protocol/queue.ts` | `CarriedIssue.key`, `carry.issueKey`; `QueueTask.issueKey`, `queue.add.issueKey` | The ticket key of an issue-source card | Same |
| `src/shared/protocol.ts` | import; `ClientMsg`, `ServerMsg` unions *(unmarked)* | `\| KanbanClientMsg`, `\| KanbanServerMsg` at the end | The kanban's WS messages ride upstream's socket |
| `src/shared/protocol/changes.ts` | `ChangesState.head` | `head?: string`, the checkout's HEAD commit | The task's Changes view reads the branch's commits again when HEAD moves, an amend (same count and subject) included |
| `src/shared/layout.ts` | `DeskDef.watch`; new `watchSpots()`, `watchSpotOf()`, `WATCH_SPOTS` before `DESK_BY_ID`; `DESK_BY_ID` includes them (its doc comment says so) | A spot behind each seat (desk or bean bag), with the seat's place and turn | A task's reviewer stands behind its implementer's chair instead of taking a desk ([architecture](kanban-architecture.md)) |
| `src/shared/maps/index.ts` | import; `officePlan()`'s and `planMap()`'s `byId` | `...watchSpots(...)` of the map's desks and overflow seats, in the same spread in both | The spot is where its seat is, on every map |

### Client

| File | Where | What | Why |
|---|---|---|---|
| `src/client/core/parts.ts` | import; `Parts.kanban3d` | `Made<typeof installKanban3d>` | The kanban's own pieces of the 3D office, reached by the other parts |
| `src/client/main.ts` | import; the line after the other installs | `parts.kanban3d = installKanban3d(ctx, core, parts)` | J, the kanban's menu entry and its 📍 Show in 3D link (kanban/install3d.ts, which also owns `openKanban()`, the `KeyJ` binding, `followOfficeLink()` and the retry-countdown tick) |
| `src/client/features/hud/index.ts` | `HudParts` (`'kanban3d'`); the menu list | A `kanban` entry (🗂️ Kanban, key J, section *Open*) | In the ☰ menu |
| `src/client/features/workers/actions.ts` | `hire()` `issue` param (a number, or a card's `cardFields`); `pullRequestFor()`, `pullRequestsFor()`, `reposKey()`/desk hint; `promptAtDesk()` (title "✨ Hire at", `kanbanOption`, `promptTaskWorker` branch), `hireAtDesk()`, `sendToWorker()` (`kanbanOption`, task on the buttons, no reviewers, `askWorker`), `killWorker()` top (`sendTaskWorkerHome`), `deskHint()` title/task/R, `interact()` (P with a card at an empty desk, R), `boardActions().kanbanTask` | PR matched by number and repo; the toast says an agent opens the PR(s), "Agent opens PR(s)", "⏳ Agent opening PR…" (still sends `worker.pr`); hire as a kanban task; P at a task worker is a message on its task; Move to Done on X; R retries; the issue as a kanban task; an Ask to a task worker is a message on its task (`askWorker`, kanban/office3d: `asComment` for a task implementer whose task the engine carries on, else upstream's `worker.prompt`) | "O" is agent-written now and opens the right card; Kanban hires; docs/kanban-coupling.md |
| `src/client/features/workers/views.ts` | imports; `syncWorkers()` (`seatView`, `model.watching`, arrivals line `desk.def.watch`, `setTask`, `tagTaskWorker`, `forgetTaskWorker`); `inCourt()` (`!d.watch`); `cameFrom()`, `yours()` (`kanbanStarter`); the per-frame laptop update (`!desk.watch`); `meetingCard` returned | A task worker's card `🗂️ #14 · title` / `phase round · waiting`, name tag `Ada · #14`; a reviewer's spot gets its view from `kanban/watch3d.ts`, the reviewer walks in to it, doesn't line up in the castle, has no laptop to paint; the kanban's hires come in by the doors, a task you started is yours | The desk shows the task; the reviewer stands behind its implementer |
| `src/client/features/waiting/index.ts` | imports; `goToNextWaiting()` toast; `openWorkerTerminal(…, tab)` | N says what the task waits on; the worker window opens on a tab | Same |
| `src/client/features/boards/index.ts` | imports; `offBoard()`; `interact()` O on a note | A card is told apart by `cardId` (its key, else `#n`) and opened with `openCard` | Issue-source cards on the board |
| `src/client/features/boards/world.ts` | import; `DrawnNote.id`, `lifted`, `noteAt()`, `lift()`; `render()`'s tilt, color and number | Notes by `cardId`, colored by `noteSeed`, labelled `UYT-1415` / `api#12`, with `🗂️ #N` for a card made into a task | Same |
| `src/client/features/carrying/card.ts` | import; `issueCard()` color, pin and label; `HeldCard.issue` | The carried card shows its label and is swapped by `cardId` | Same |
| `src/client/features/carrying/index.ts` | imports; `hire()`'s `ids`; `setCarrying()`, `pickUp()`, `putBack()`, `dropCard()`, new `cardTaskAt()`, `carryHint()` | Cards named by `issueCardLabel`, handed out with `cardFields` (`issue` for the floor's own issue, `issueKey`) and `cardPrompt`, queue and meeting by `cardOnQueue` / `cardMeeting`; only a task's own issue goes to its worker (`cardToTaskWorker`); P with a card at an empty desk is a kanban task | Issue-source cards in your hands and at every drop target |
| `src/client/core/arrival.ts`, `features/golf/index.ts`, `features/palette/index.ts`, `core/hintbar.ts` | the reconnect `carry` and the floor-change toast; the golf toast; the command palette's issues; the hint key | `issueKey` and `issueCardLabel`; `openCard`; `cardId` | Same |
| `src/client/state/index.ts` | imports; new `workerForPull()` wrapper over `store.ts`'s | A card with `repo` goes to `workerForRepoPull()` (kanban/ghrepo) | "Go to desk" finds the right worker |
| `src/client/state/persist.ts` | `rememberFloor()` | A `3d-kanban` comment only: it is exported (and re-exported by `state/index.ts`) | The deep link comes in on its floor |
| `src/client/state/core.ts` | `building` slice, `floors` | `project.name` follows the current floor's name in the list | A renamed floor renames the top bar, tab title and sign of whoever stands on it |
| `src/client/state/core.ts` | import; the `floor` slice's `enter()` (`s.workers = ...`) and `worker.update` | Workers go through `shownWorker()` (kanban/status) on their way into the store | A kanban worker whose run is still going shows as working, not done, in 3D and /lite |
| `src/client/state/persist.ts` | `Settings.mouseSensitivity`; `loadSettings()` default and line after `notify` | A multiplier, 1 by default (settings saved before it get 1), kept within 0.25–2 | How fast the mouse looks around, per person |
| `src/client/main.ts`, `src/client/features/hud/index.ts` | after `parts.player.view = parts.settings.view`; the settings window's `onChange` after `player.setView` | `player.setMouseSensitivity(settings.mouseSensitivity)` | Applied at startup and as the slider moves |
| `src/client/ui/help.ts` | `HELP_ROWS` | `O` text (agent opens PRs); `J`, `C/E/P/R/X 🗂️` rows; `Mouse` row for both views, 🏀 text, `Wheel` instead of `Drag / wheel` | The H help matches the behaviour |
| `src/client/player/index.ts` | re-export line; the `facing` update in `update()`; `updateCamera(snap, dt)` and its three `update()` callers passing `dt` | `SHOULDER`, `THIRD_PITCH_*`, `alongRay`, `eyeSees`, `orbitOffset`, `shoulderOffset`, `tapNdc`, `withinReach` re-exported from `kanban/shoulder.ts`; third person faces where the camera looks, standing or walking, at `1 - exp(-25 dt)` (upstream's turn in the steering block removed) | Third person plays like first person, only the camera is behind you |
| `src/client/player/pointer.ts` | import; `ease` (an `OrbitEase`, kanban/camera3d.ts) and `sensitivity` fields; `setMouseSensitivity()`; `pointerdown`, `pointerup` (third person with the mouse free: the tapped point), both `pointermove` `look()` calls, `canLock`, `look()` | Third person captures the mouse and looks around like first person (no drag to orbit, clicks are the crosshair's, taps with the mouse free are where you tapped); mouse look times ⚙️ Settings' sensitivity (0.25–2), captured or dragging with a mouse (touch drags, keys, walking and the wheel untouched); `look()` moves the easing's last yaw/pitch, so the mouse is never eased | Same; how fast the mouse looks around, per person |
| `src/client/player/camera.ts` | import; `Followed.ease`; `aimCamera(…, snap, dt)`: `ease.sync` in first person; in third person the eased yaw/pitch/distance for the target/offset over the right shoulder, and `ease.place(…)` instead of upstream's `lerp(cam, 0.25)` | The camera sits exactly on the orbit of camYaw/camPitch/camDist, so the mouse and smooth changes like a turning car follow rigidly; jumps in yaw/pitch (over 0.15 rad), every zoom, the shown pitch kept within the third-person limits, jumps in the wall clamp and outside writes to `camera.position` (golf, throwing) ease out at `exp(-12 dt)` / `exp(-20 dt)` (kanban/camera3d.ts `OrbitEase`) | Smooth third-person mouse look |
| `src/client/input/pointer.ts` | imports; `eyeRay`; `aimedAt()` (`raycaster.near`, `pickables` const, `eyeSees` line of sight, `withinReach`) and new `inTheWay()`; `aimedNote`; the per-frame `target` block; `onClick` tail (third person with the mouse free: upstream's tap path, at reach without slack) | The crosshair in third person too: the camera's ray through it, ignoring what's between the camera and you, within reach of your eyes and in their line of sight | Same |
| `src/client/core/hintbar.ts`, `features/basketball/index.ts`, `features/hanging/controller.ts` | the crosshair `show`; `shotAim()` heading/toss pitch, `ballHint()` key; `pointerlockchange` cancel, `update()` ray, `place()` | The crosshair, not the mouse, in third person too | Same |
| `src/client/world/character/worker.ts` | `Worker.watching`; `update()`'s working act | Working with no tool call to act out, a watching worker stands at rest instead of typing | The reviewer has no laptop to type on |
| `src/client/ui/boards.ts` | imports; `openBoard()` header (`repoSlot`) and `render()`; `issueColumns()` in progress (a keyed card's queue task by `taskForCard`); `queueChip(issue, key?)`; `card(…, onLabels \| null, label?)`; the issues column's cards | Repository filter select and chips (kanban/boardrepos); every issue card opens with `openCard`; one with a key has its source, status and task chips, and labels only for the project's GitHub issues | A multi-repo project's boards; issue-source cards |
| `src/client/ui/github/pull-window.ts` | imports; `repo`/`label` from the item; footer; `getJson`/`getText` URLs; `fresh` lookup | 🔍 Review and 🤝 Review panel first open `openReviewPicker()` (kanban/prpicker; "just this one" keeps upstream's flow); `?repo=` on `/api/gh/*`, titles show `api#5` | Multi-PR review; multi-repo PRs |
| `src/client/ui/github/api.ts`, `close.ts`, `comment-box.ts`, `labels.ts`, `merge.ts` | waiter maps (keyed by `ghKey`: kind + number + repo), `routePullMessage`-style replies matched by repo (`ghWaiter`), `repo` in gh.* messages (`ghRepoField`), titles | Replies matched by repo when they carry one | `api#5` isn't the primary's #5 |
| `src/client/ui/github/issue-window.ts` | imports; `repo`/`label`; footer; `renderFrame()` queue task; `getJson` URL | 🗂️ Kanban task button when `actions.kanbanTask`; `taskForCard(it)` for a card with a key, else upstream's `taskForIssue`; `?repo=` | Another repository's #12 isn't the floor's #12 on the queue; a kanban task in an issue |
| `src/client/ui/github/prompts.ts` | `BoardActions.kanbanTask?` | Optional action | 🗂️ Kanban task in an issue |
| `src/client/login.ts` | `NEXT_PAGES` | `/kanban` beside `/lite` | Back to the kanban after signing in (only known pages) |
| `src/client/net.ts` | `loginUrl()` | `/login?next=/kanban` from the kanban page | Same |
| `src/client/lite.html` | header | `#to-kanban` link (🗂️ Kanban) | The kanban from the 2D view |
| `src/client/lite.ts` | `renderFloors()` | Keeps the link on `/kanban?project=<floor>` | Same |
| `src/client/ui/settings.ts` | import; `SettingsPane` (`\| KanbanSettingsPane`); `PANES` (`...KANBAN_PANES`); `const kanban = kanbanSettingsSlots(net)` before `panes`; `panes.kanban`, `panes.projects`; `kanban.shown(id)` in `show()`; `kanban.close()` in `onClose` | The kanban's categories 🗂️ Kanban and 📁 Projects (kanban/settingsslot.ts), after 🤖 Workers; their code (kanban/settings.ts) and settings load the first time one is shown | The kanban's settings are part of the office's own ⚙️ Settings, not a window of their own; the kanban page's ⚙️ opens this same window |
| `src/client/ui/prompts.ts` | import, `openPromptEditor()`: `scope`, `saved()`, `paint()`, `save`, `onClose` | `promptScope()` (kanban/promptscope): project scope picker and the read-only contract block for kanban prompts | Office vs project layering in upstream's editor |
| `src/client/ui/repos.ts` | import; `render()` | A project repo's PR on this floor's board opens in the PR window | Multi-repo workers' PRs |
| `src/client/lite.ts` | import; `boardActions().kanbanTask` | `cardTask` (kanban/issuecards) instead of `issueTask` | A card from the issue sources becomes its task by its key on the 2D view too |
| `src/client/notify.ts` | import; `waitingOnSomeone()` | `taskWaiting()` first | N, the count and the compass follow the task |
| `src/client/interaction.ts` | import; `R` | `canRetry()` too | R retries a waiting task |
| `src/client/ui/terminal.ts` | import; `TerminalOptions.tab`; `mountWorkerTabs(…, host, …)` before `ro.observe(host)` (the task pane goes after `host`; the terminal is focused only while it shows, not behind a web page tab); `kanbanTabs?.destroy()` in `onClose` (the variable is `kanbanTabs` because upstream #212's `termTabs()` result is `tabs`); the same `mountWorkerTabs` call also puts 🧩 VSCode into every worker's header, before ✕ (kanban/vscode, admins only) | A task worker's window: 🖥️ Terminal (with upstream's web page tabs) / 🗂️ Task #14 (kanban/worker3d; the task view there has no Changes tab; the task tab hides the terminal side at window level with `kb-on-task`); upstream's 🌿 Changes stays in the header and, through `openChanges()`'s seam below, opens the task's Changes window | The task view inside the worker window |
| `src/client/ui/changes.ts` | import (`kanbanOf`); `openChanges()` after `if (!info) return;` | A kanban task's worker hands over to `openTaskChanges()` (kanban/changesview, loaded on demand) with its `repo` as `floor`, closing upstream's window if one is open once the new one is (no moment without a window); ordinary workers keep upstream's window | One Changes view for a task: every repository, all changes / per commit / uncommitted, live while the worker is on the floor, else read over HTTP (C, 🌿 Changes in the terminal window, the 2D view and the kanban page) |
| `src/client/ui/changes.ts` | `onChangesMessage()` (new, after `routeChangesMessage`) | Adds a listener to the module's `listeners` and returns its remover | The fork's view hears `changes` / `changes.diff` (and `welcome`, to watch again after a reconnect: kanban/changeswatch) without `net.onMessage`, which can't take a handler back |
| `src/client/ui/changes.ts` | `plusMinus()`, `pathLabel()`, `renderDiff()`, `renderPreview()` | `export` (one word each, marked at the end of the line) | The fork's view draws files, diffs and pictures exactly as upstream's window |
| `src/client/ui/terminal.ts` | the backdrop's `dragenter` and `drop` handlers | `inTaskPane(e.target)` (kanban/office) or `termHidden()` (a web page tab or the task tab is showing): such a drop isn't uploaded and typed into the terminal (with the terminal hidden, a toast says to switch to its tab); `insertFiles()` checks `termHidden()` again once the upload is done, so a tab switched while it uploaded types nothing in either | Files for the task's composer never reach the PTY |
| `src/client/ui/prompt.ts` | import; `PromptOptions.kanbanOption`, `rawLabel`, `onSubmit` `raw`; `openPrompt()` toggle, paint, `send(raw)`; `SendHomeOptions.extra` and the body | The "🗂️ Run as a kanban task" toggle (kanban/hireform); "Type straight into the terminal instead"; the task block in send-home | Same |
| `src/client/ui/ask.ts` | import; `AskWorker.task`, `AskOptions.kanbanOption`; `pick()`, the body, `send()` | Kanban toggle for a new worker; `🗂️ #14` on a task worker's button | Same |
| `src/client/ui/queue.ts` | imports; `openQueue()`: the kanban toggle before the form, the form's children, `submit()`'s kanban branch, `render()` parts, the `unsubs`/`tick`/`onClose`/first `render()` lines | `kanbanSection(queueOption(net))` (kanban/hireform, kanban/office3d), `kanbanQueueSection(net, watch.tasks())`, `kanbanQueueWatch` | **🗂️ Run as a kanban task** on the queue board; 🗂️ Kanban on this floor with the tasks waiting their turn |
| `src/client/lite.ts` | imports; `workerCard()` sub line, `promptWorker()`, `sendToWorker()` (`askWorker`), `boardActions().kanbanTask`, `fixLostWorktree()` send home | The same on the 2D view (its terminal gets the tabs from terminal.ts) | Same |
| `src/client/ui/settings.ts` | `VIEWS` third-person text | "The mouse looks around like in first person" | Same |
| `src/client/ui/settings.ts` | import; the You pane's *Mouse sensitivity* `setting(…)` after *Camera view* | `...mouseSensitivityRow(() => settings, (s) => onChange((settings = s)))` (kanban/sensitivity.ts): a slider, 25–200% in steps of 5 | How fast the mouse looks around, per person |
| `src/client/index.html`, `src/client/lite.html` | `<head>` after the icon; after the entry `<script>` | Manifest, apple-touch-icon, `theme-color` (index only; lite had one), `apple-mobile-web-app-capable`; `<script type="module" src="./pwa.ts">` | The PWA: installable, and `pwa.ts` registers `public/sw.js` |
| `src/client/login.html`, `src/client/join.html`, `src/client/claim.html` | `<head>` after the icon | `theme-color` only | The installed app's colour on the sign-in pages |
| `src/client/ui/prompt.ts` | `sendHomeDialog()` `choices` | "`kanban3d prune` tidies up later" | The command is `kanban3d` |
| `src/client/ui/accounts.ts` | shared-password note (off) | "run `kanban3d accounts password on`" | Same |
| `src/client/world/sky.ts` | `INDOOR_FOG`, `ROOM_*`, `WALL_TOP`, `hazeAt()`, `wingRoom()`, `roomAt()`, `indoorAt()`, `ROOM_VARYING`, `ROOM_PARS` with `skyInsideOf()` (split out of `PARS`), `SPRITE_WORLD`, `HAZE_PARS`' `skyInRoom()`, `HAZE`, `onBeforeCompile`, `Sky.setWing()` | Anything inside the office keeps a tenth of the outdoor fog, when you're inside too; upstream PR #207 (closed unmerged, issue #122 still open), plus the fork's own camera check, sprites' haze and the TypeScript mirrors the tests use | The weather's fog doesn't come into the office |

### Build, packaging, deploy, docs

| File | Where | What | Why |
|---|---|---|---|
| `vite.config.ts` | `rollupOptions.input` | `kanban: src/client/kanban.html` | The kanban page is built |
| `tests/size.test.ts` | `FORK_CEILINGS` (new, after `CEILINGS`); `sources()`; the ceiling lookup | The kanban's own code (`src/{client,server,shared}/kanban/`) is left out of the 600-line guard; `FORK_CEILINGS` holds `world/sky.ts` (upstream PR #207's indoor fog) and `ui/settings.ts` (the kanban's settings panes and the mouse sensitivity row), which may never grow past it | The fork's seams push those two upstream files over upstream's own ceiling; the rest of the budget is upstream's ([Code layout](code-layout.md#the-size-guard)) |
| `tests/client-store.test.ts` | the saved settings' shape | `mouseSensitivity: 1` | The fork's ⚙️ Settings field is part of what the browser remembers |
| `docs/code-layout.md` | end of the intro | An *In 3d-kanban* paragraph | Where the fork's code joins the registries |
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
   - `WorkerManager.spawn`'s parameter list (`extra` must stay the last one) and the claude and codex adapters'
     `launch()` argument order: `extraArgs` pushed before `--resume` and the prompt (`tests/kanban-launch-argv.test.ts`
     pins it).
   - `claude`'s `setup()` still writes both hook files (`claude-hooks.json` and, through `writeKanbanSettings`,
     `claude-hooks-kanban.json`) with the same `hooks` and `permissions`.
   - Every place upstream sets a worker's status or removes one still goes through `emitted(...)` /
     `observe(...)` (and `observeHook` in the adapters' hook handlers), so observers hear it.
   - `handlers` in `ws/handlers/index.ts` still spreads `...kanbanHandlers` and `features` still has
     `kanbanHooks`. `HandlerMap` stays exhaustive: the kanban's entries come from `KANBAN_CLIENT_TYPE_LIST`
     (`src/shared/kanban/protocol.ts`, typed `Record<KanbanClientType, true>`), and every upstream type needs
     its own handler.
   - `ClientMsg` / `ServerMsg` in `src/shared/protocol.ts` still end with the kanban unions; `DEFS` still
     spreads `KANBAN_PROMPT_DEFS`; the `src/server/workers.ts` barrel still re-exports `SpawnExtra`,
     `WorkerObservation` and `WorkerObserver`.
   - `src/server/server.ts` still calls `openKanban` and `kanban.shutdown()`; `routes` in
     `http/routes/index.ts` still has the kanban routes (the PWA's and the page before the sign-in check, the
     API after it).
   - `worker.pr`, `worker.prompt` and `worker.resume` in `ws/handlers/workers.ts` still ask the kanban first.
   - New `gh.*` messages or `/api/gh/*` routes upstream adds that act on one PR or issue: give them the
     same `repo` → `githubFor()` handling, or they act on the floor's own repository.
   - `pullsView` / `issuesView` in `ws/handlers/github.ts` still return `floor.pullsState()` /
     `floor.issuesState()`, and the floor's `gh.pulls` callback still sends `pullsState()`
     (`tests/kanban-welcome-views.test.ts` checks the welcome through the real office).
   - `dispatch()` in `ws/dispatch.ts` still hands a type the map lacks to `kanbanUnknown`, so a `kanban.*`
     type this office doesn't know gets the kanban's error reply instead of going nowhere.
   - `kill()` in `workers/manager.ts` still calls `departing()` first, before the worker is deleted and
     `events.remove` runs (the keep guards decide on a worker that's still there, as before).
   - `src/client/main.ts` still has the `installKanban3d` line (`Parts.kanban3d` in `core/parts.ts`), after
     `installArrival` (whose `travel.arrive` clears the trip before 📍 Show in 3D's listener runs) and before
     `net.connect`; moving it either way silently breaks the link.
   - `tests/size.test.ts` still excludes the kanban folders and keeps `FORK_CEILINGS`, each the file's exact
     length (the "only gets shorter" test asks for it to be lowered, or dropped once upstream's limit holds it).
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

### Known small behaviour differences from before the #215 port

- A hire at a watch spot by anyone but a reviewer is refused before the built/occupied checks (same message).

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
- Claude's agent teams (teammates; they run in the lead's process): an `Agent` call with `input.name` gets a
  `toolUseResult` of `status: 'teammate_spawned'` (`name`, `teammate_id: 'name@session-…'`, `team_name`;
  its text starts `Spawned successfully`). A `SendMessage` result has `routing.target` (`@name`; the call's
  `input.to` is the fallback, `*` a broadcast). A teammate's message to the lead is a `user` line with no
  `origin` whose text is `Another Claude session sent a message:` and one or more
  `<teammate-message teammate_id="…" …>…</teammate-message>` tags; an idle teammate's body is JSON
  (`type: 'idle_notification'`, `from`, `idleReason`, `result`, and `summary: '[to Y] …'` when it had just
  messaged Y), read by parsing the text between the tags whole (a `result` holds `}`). Each teammate has a
  transcript `<lead log without .jsonl>/subagents/agent-a<name>-<hash>.jsonl` and a `….meta.json` with
  `taskKind: 'in_process_teammate'` (a background agent's has another kind); at rest it ends in an assistant
  message of text alone, a message for it is a `user` line (or a `queued_command` attachment mid-turn).
  Hooks fired inside a subagent or teammate carry `agent_id` (a teammate's turn ends with `SubagentStop`).
  Every line has an ISO `timestamp`, which the lead's log events are compared to the teammate's with.
- Claude flags: `--permission-mode <mode>`, `--disallowedTools`, `--plugin-dir <path>` (skills as a plugin),
  `--resume <id>`, `--session-id <uuid>`; `--json-schema` only works with `--print`, so interactive review
  verdicts are parsed from the final text. The setting `skipDangerousModePermissionPrompt` exists
  (skips the bypass-mode confirmation in the TUI).
- Codex flags: `-s read-only|workspace-write|danger-full-access`, `-a never`,
  `--dangerously-bypass-approvals-and-sandbox`, `codex resume <SESSION_ID> [PROMPT]`.
- Decision (A4 gate): every phase runs on upstream PTY workers; no phase needs a headless fallback.
