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

## Sync policy

Upstream is no longer kept mergeable through a seam list: the fork edits upstream's files freely (#327).
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
