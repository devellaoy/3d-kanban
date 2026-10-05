# Origin and upstream

Back to the [README](../README.md).

## Upstream

- Upstream: https://github.com/AgentSystemLabs/agent-office (MIT).
- Base: `665aeec571bc03f76cbd16de8d628dd169a48874` (main, 2026-09-30), taken as a source tarball, plus upstream
  PR #215 (`650e872c33052dd42bd4abe26862f89d6c78e603`, 2026-09-30: the split of `main.ts`, `server.ts`,
  `workers.ts`, `protocol.ts`, `state.ts`, `player.ts`, `ui/pull.ts` and others into registries and folders,
  see [Code layout](code-layout.md)). It was brought in with `git cherry-pick 650e872c`; its parent is the old
  base, so it was a real three-way merge.
  Later upstream commits (#195, #201, #202, #212, #213) are not in.
- The `upstream` remote exists in this clone (`https://github.com/AgentSystemLabs/agent-office.git`); nothing
  requires it elsewhere, and a copy without it can add it with `git remote add upstream <url> && git fetch upstream`.

### Ported, not merged

- Upstream PR #219 (`ab07411`; open upstream as of 2026-10-01: indoor lamplight shadows and a real-time sky
  clock) is taken as one squash commit of its three commits (`git diff 1bc3028 ab07411 | git apply -3`). It touches
  `docs/configuration.md`, `docs/features.md`, `docs/how-it-works.md`, `src/client/features/lamplight/index.ts`
  (new), `src/client/main.ts`, `src/client/ui/settings-sky.ts` (new), `src/client/ui/settings.ts`,
  `src/client/world/office/shell.ts`, `src/client/world/sky.ts`, `src/server/config.ts`,
  `src/server/office/services.ts`, `src/server/sky.ts`, `src/server/ws/handlers/settings.ts`,
  `src/shared/protocol/settings.ts`, `src/shared/sun.ts`, `tests/size.test.ts` and `tests/sky-clock.test.ts` (new).
- The fork's deviation: `settings-sky.ts` gets `describe` (the sky's wording) from its caller instead of importing
  `describeSky`, because that would pull three.js into the kanban page, which shares `ui/settings.ts`.
  `features/hud/index.ts` passes it (and no `now` line beside it, which upstream's `outside` has), and `tests/client-structure.test.ts` guards the kanban page's imports.
  The hud's `describe` words the sky on the office's clock (`store.officeNow()`), like the line Settings opens
  with; upstream repaints it on the browser's own clock, so keep the fork's when syncing.
- Two fixes on top of upstream's code, to keep when syncing: `sky.clock` (`server/ws/handlers/settings.ts`) ignores a
  message whose `real` isn't a boolean, where upstream read anything but `true` as *a day every hour* and saved
  it (`tests/server-dispatch.test.ts`); and `features/lamplight` lets go at once when the building leaves the
  office's map, where upstream eased out over the castle's own light for its first seconds (`tests/lamplight.test.ts`).
- After PR #55's review, also to keep: `wallRun`'s pieces and `exitPlug`'s wall are marked `userData.wall` too (the
  back office's walls and the plugs), `features/lamplight` collects the walls again when the back office is
  rebuilt (`player.wing`) and settles its easing so a still frame changes nothing, and `server/sky.ts` has a
  `withClock` helper and writes `sky-place.json` only when the place changed.
- The light indoors (#81) replaces upstream's office lamplight: `sky.ts` loses the uniform `skyOffice` fill, and inside
  the room the sky's light comes in only through the windows and the sun's is made the lamps' (`world/roomlight.ts`,
  new, which uses three.js's `lights_fragment_begin` with the directional light's shadow kept apart: re-check it when
  three.js is upgraded, `tests/roomlight.test.ts` fails if the chunk changed). `features/lamplight` no longer brightens or tints the sun indoors (it still swings it overhead and lightens its
  shadows), `core/loop.ts` keeps the sky's shading on only while the office's own scene draws, `features/lights` dims
  the lamps' light (and their bulbs with the hour) instead of laying a dark pool on the floor and lighting the lounge with a point light, and the room's,
  the loft's, the meeting room's and the back office's lamps push a `RoomLamp` to `NightParts.roomLamps`
  (`world/outside.ts`, `world/office/{room,props,loft,meeting-room,wing}.ts`). Syncing upstream's sky or lamplight
  means keeping these.
- Several meeting rooms per floor (#90): upstream's `server/meetings.ts` `MeetingRoom` is now one room's engine (it takes its `MeetingRoomDef`, no longer holds the state file or the list of earlier meetings), and the new `server/meeting-rooms.ts` `MeetingRooms` owns one per room and is what `Floor.meetings` is. The seams in upstream's files: `MeetingState` is `{ rooms, past }` (was `{ current, past }`) and `Meeting.room`, `MeetingRequest.room`, `meeting.stop` / `meeting.clear` `room` in `shared/protocol/meetings.ts`; `MeetingRoomDef` / `MEETING_ROOMS` (built by `buildMeetingRooms` in `shared/meetingrooms.ts`, re-exported by `shared/layout.ts`; the second room's id is still `review`, from before it was renamed, and rooms 2-4 are the meeting wing's: `FloorPlan.rooms`, `world/office/roomswing.ts`) and `MapPlan.meetingRooms` in `shared/maps/`; `floor.ts` (`meetings`, `ctx.meetingRooms`), `office/floors.ts`, `ws/handlers/meetings.ts`, the top bar chip in `features/hud`, `ui/meeting.ts` (a tab per room) and the places that read the one `current` meeting (`features/workers/{actions,views}.ts`, `state/slices/meeting.ts`). Syncing upstream's meeting room means keeping these.
- The office's LED lighting (`world/office/led.ts`) is a fixture of its own at the end of `floorPlan()` in `world/office/build.ts`, and the ceiling lamps are linear LED fixtures (`pendant` in `world/office/props.ts`); the strips are `bulb`s (each colour its own entry in `NightParts.bulbs`), not `RoomLamp`s. `MAX_ROOM_LAMPS` in `world/roomlight.ts` is 24: the meeting wing's rooms light two lamps each. The meeting wing itself (`world/office/roomswing.ts`, `FloorPlan.rooms`, `floor.expand` / `floor.shrink` with `part: 'meeting'`) mirrors the back office through the north wall; the machine monitor moved to the south wall over the kitchen to make room for it.
- Repositories on Azure DevOps and Bitbucket (#122, [hosting](hosting.md)): the providers are new code of the fork's own
  (`src/{server,shared}/hosting/`, `server/kanban/integrations/hosting/`, `server/gitconfig.ts`,
  `bin/office-pr.js`, `bin/office-git-credential.js`, `ws/handlers/hosting.ts`, `client/ui/signins-hosts.ts`, the
  `hosting` slice). The seams in upstream's files: `github.ts` (`GitHub.hosted` hands the boards, the PR window's detail
  and comments to `hosting/board.ts`, and GitHub-only actions say so), `ghrepo.ts` (`checkoutRemote`), `floor.ts`
  (`githubFor` and the PR board's `repos` know a hosted primary; the meeting's review posts with the host's token),
  `workers/pr.ts`, `workers/manager.ts` and `changes.ts` (a hosted repository's PR through its provider; every
  worker's environment gets `workerHostEnv`, re-exported by `workers/worker.ts`),
  `office/gates.ts` and `office/context.ts` (`withRepoHost` for a board, `withHosts` for work on checkouts: each
  repository's own host, GitHub's sign-in only when one is on GitHub, git pushing with the office's credential helper),
  `changes.ts` (`dirOf`), `ws/handlers/{github,workers,changes}.ts` (those gates),
  `http/routes/github.ts`, `signins.ts` (its git config is written by `gitconfig.ts`, with the office's credential
  helper for the other hosts), `workers/process.ts` (the two commands), `office/services.ts` (`openHosting`),
  `shared/protocol/{github,accounts}.ts` (`GhState.host` and `.note`, `signins.needed` for a host), `shared/protocol.ts`,
  `ui/boards.ts`, `ui/github/pull-window.ts`, `ui/signins.ts`, `features/boards/world.ts` and the multiplayer tables.
  GitHub's own paths are unchanged.
- When #219 merges upstream, syncing it means resolving the same hunks once more (the SHAs differ). Upstream #220
  (the `settings.ts` ceiling in `size.test.ts`) and #221 (party dimming against the lamp boost in `lamplight`) are
  likely to conflict later.

## Name and releases

3d-kanban is its own product, published at https://github.com/devellaoy/3d-kanban, so that it never
clashes with an upstream install on the same machine:

- The npm package is `3d-kanban` and its command `kanban3d` (`package.json` `bin`); the entry file
  keeps upstream's name, `bin/agent-office.js`, so upstream merges stay easy.
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

Worktrees: upstream makes a worker's worktree in the project, under `.agent-office/worktrees/<slug>`, where the project's lint, `tsc`, jest and IDE find the copies. This fork makes them in `<checkout>.worktrees/<slug>` beside it (`src/server/worktree-home.ts`), gives each worktree a `node_modules` folder of links to its repository's packages (scopes and `.bin` as real folders, so `npm ci` and `npm install` replace links rather than wipe the checkout's; the linked packages are still shared, so `npm rebuild` and install scripts run in the checkout's package folders, except workspace packages, which link to the worktree's own copy), makes `prune` touch only `office/*` worktrees there, and still lists, removes and prunes the older ones. Reconcile with that when taking upstream changes to `worktrees.ts`.

The Codex limits reader (`src/server/codex-limits/`) is adapted from the still-unmerged upstream PR #232: if it merges, reconcile with it and prefer ours.

## Sync policy

Upstream is no longer kept mergeable through a seam list: the fork edits upstream's files freely (#327).
The ladder and the fire poles are removed (#360); drop upstream changes to them when syncing.
Taking upstream changes is ordinary merge or cherry-pick work, only when the user decides:

1. On a separate branch: `git fetch upstream`, then `git cherry-pick <commit>` for one upstream commit or
   `git merge upstream/main` for all of it. Expect conflicts, and resolve them like any other.
2. `npm run typecheck && npm test && npm run build`, then check the kanban and the 3D office by hand.
3. Behaviour worth re-checking after a merge, because it can break without a conflict:
   `tests/kanban-launch-argv.test.ts` pins how a kanban hire's agent is launched (`extra` last in
   `WorkerManager.spawn`, `extraArgs` before `--resume` and the prompt), and
   `tests/kanban-welcome-views.test.ts` pins that the PR and issue boards follow the project's repositories,
   and `tests/kanban-codex-trust.test.ts` that the hook commands a Codex task worker trusts are still the ones
   `codexHookArgs` (`server/codex.ts`) gives it.
   For YouTube on the Office TV, the renderer keeps `alpha: true` (`core/scene.ts`), and the TV fixture still
   names its screen `tvScreen`, a `PlaneGeometry` of `TV.width × TV.height` facing +z (`world/office/room.ts`),
   which `youtube/screen.ts` lines the player up with.
   Also check `package.json` (dependencies, `files`, `typecheck`), `vite.config.ts` inputs, the Dockerfile's
   `better-sqlite3` rebuild, and keep this fork's `AGENTS.md` and the pointer `CLAUDE.md` (`@AGENTS.md`).

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
- Codex hook trust (`src/server/kanban/codex-trust.ts`): the office's hooks name each floor's own hook path and Codex keeps one trusted hash per event, so task workers get `-c hooks.state={"/<session-flags>/config.toml:<event>:0:0"={trusted_hash="sha256:…"},…}` for the office's hooks only (the key is the session flags' config, which Codex's `synthetic_layer_path` resolves against `/`, or against `C:\` on Windows as `C:\<session-flags>\config.toml`; then the event in snake_case, group 0, handler 0). The hash mirrors Codex's `hook_hash` / `version_for_toml`: sha256 of the key-sorted JSON of `{event_name, hooks: [normalized handler]}`, the handler being `{type: 'command', command, timeout: 3, async: false}`. `tests/kanban-codex-trust.test.ts` checks the command against `codexHookArgs`; if Codex changes the hashing, the "Hooks need review" screen comes back.
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
- Claude's background commands and monitors (verified against real transcripts): a Bash `run_in_background`
  call's result has `toolUseResult.backgroundTaskId` (also `backgroundCwdHint`), its text starts
  `Command running in background with ID: <id>`; a command that ran past its timeout has the same
  `backgroundTaskId` plus `timedOutAfterMs`, its text `Command did not complete within its 120s timeout and
  was moved to the background (ID: <id>)`. A `Monitor` call (`input.command/description/persistent/timeout_ms`)
  has `toolUseResult: { taskId, timeoutMs, persistent }`; each event arrives as a `<task-notification>` with
  `<task-id>`, `<summary>Monitor event: …</summary>` and `<event>` and no `<status>`, the last one with a
  `<status>`. `TaskStop` (`input.task_id`) has `toolUseResult: { message, task_id, task_type, command }`;
  `TaskOutput` (`input.task_id/block/timeout`) has `{ retrieval_status, task: { task_id, task_type, status, … } }`.
  Notifications are read from their headers only (the first `<task-id>`, `<status>`, `<event>`; the `<result>`, `<output>`,
  `<summary>` and `<event>` bodies are free text and cut out first). A Bash launch known only by its text needs
  `run_in_background` on the call (the timeout's `Command did not complete within…` text needs nothing), and every launch
  logged before the process's start is dead. Only a `local_agent` TaskOutput was seen; a Bash task's is assumed alike.
  Notification `<status>` values seen: `completed`, `failed`, `killed`, `stopped`. They arrive like an agent's
  (a user line with `origin.kind: 'task-notification'`, or a `queued_command` attachment with `commandMode:
  'task-notification'`). Not seen in any transcript, so not read: a `KillShell` or `BashOutput` call.
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
