# 3d-kanban

[![Release](https://img.shields.io/github/v/release/devellaoy/3d-kanban?style=flat-square&color=e8c547&label=release)](https://github.com/devellaoy/3d-kanban/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/devellaoy/3d-kanban/release.yml?style=flat-square&label=build)](https://github.com/devellaoy/3d-kanban/actions)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**3d-kanban** is a 3D office your team shares with its coding agents. Every repository is a floor of the
building, agents sit at desks with their terminals on the laptops in front of them, and a kanban task
process on top (plan, implement, review, fix, pull request) runs each task there while you follow it on a
board beside the office.

[Install](#install) · [Updating](#updating) · [Agents and the way of working](#agents-and-the-way-of-working) · [The 3D world](#the-3d-world) · [Development](#development) ·
[The kanban: user guide](docs/kanban.md) · [All features](docs/features.md) · [Controls](docs/controls.md) · [Configuration](docs/configuration.md)

## Install

**You need**, on the machine that runs it: Node.js 22 or newer; Python 3, make and a C++ compiler (the
kanban's database module is built on install); `git`; the GitHub CLI signed in (`gh auth login`); and
Claude Code (`claude`), Codex (`codex`) or Antigravity (`agy`), signed in, for the kanban's tasks (the implement phases' default, Claude's auto mode,
needs Claude Code 2.1.327 or newer and a model that supports it; see [docs/kanban.md](docs/kanban.md#settings)). Details and the
per-platform packages: [docs/configuration.md](docs/configuration.md#installing).

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.ps1 | iex
```

The installer downloads the newest [release](https://github.com/devellaoy/3d-kanban/releases), puts a
`kanban3d` command on your PATH and starts the office; next time just run `kanban3d`.
`AGENT_OFFICE_INSTALL_ONLY=1` installs without starting and `AGENT_OFFICE_VERSION=v0.1.4` picks a release;
the other settings are at the top of [`install.sh`](install.sh) and [`install.ps1`](install.ps1).

**From source** (the newest `main` before its release):

```bash
git clone https://github.com/devellaoy/3d-kanban.git && cd 3d-kanban && npm install && npm install -g .
kanban3d
```

**The first start** walks you through setting up in the terminal: where to clone your projects, GitHub
sign-in (`gh auth login`, if needed) and your first project (press Enter to skip a step; you can add
projects later in the kanban or at the elevator). Then the kanban opens in your browser, already signed in,
and the terminal prints the office password for signing in from another browser. In the 3D office, walk to
an empty desk, press **E** and hire a worker. The full walkthrough is in
[docs/configuration.md](docs/configuration.md#first-start).

The common options (all of them are in [docs/configuration.md](docs/configuration.md#command-line)):

```bash
kanban3d ~/code/my-project              # use a project you already have as the first floor
kanban3d --password 'correct horse'     # choose the password
kanban3d --port 4700
kanban3d --agent grok                   # default agent: claude, codex, antigravity, opencode, grok, muse or dsh
kanban3d --no-open                      # print the sign-in link instead of opening a browser
kanban3d setup                          # the first-start walkthrough again (office stopped)
```

**Where things live.** The installer puts the program in `~/.local/share/3d-kanban` (Windows:
`%LOCALAPPDATA%\3d-kanban`).
Your data is in `~/agent-office` (`--home` or `AGENT_OFFICE_HOME` moves it); its `.agent-office` folder holds
the password, accounts, floors, chat and the kanban's `kanban.sqlite`. An upstream `agent-office` on the
same machine uses the same data folder and port by default: don't run both at once on them.

**On a server, or for a team.** Only your own computer can reach a local office. To share it, put it on a
server: [any Ubuntu or Debian machine](docs/self-hosting.md) (one line, `deploy/provision.sh`), or a script
that sets up the machine and the tunnel for you on [AWS](docs/aws.md), [Azure](docs/azure.md),
[Railway](docs/railway.md), [Fly.io](docs/fly.md) or [Dokploy](docs/dokploy.md). Then give everyone their own
account and their own Claude and GitHub sign-ins: [Accounts and teammates](docs/accounts.md).

**Coming from ai-kanban?** The migration of projects, tasks, comments, plans and settings is in
[docs/migration.md](docs/migration.md).

## Updating

Run the install line again: it installs the newest release, points `kanban3d` at it and removes the versions
nothing runs any more. Your data isn't touched. From source: `git pull && npm install && npm install -g .`.
On a server, run the provision line again, use **☰ → ⬆️ Upgrade the office**, or the deploy script's `update`
(`deploy/aws.sh update` and so on; on Railway, Fly.io and Dokploy it builds your checkout again, so `git pull`
first).

## Agents and the way of working

A task goes through the same steps whoever made it, and the office sees each step end when the agent says so
(a final `WORK DONE` line, the plan's `PLAN READY`, a review's verdict), not when the logs look quiet:

1. **A task is created**: by hand, from an issue, or by an agent.
2. **Plan**: the agent plans read-only (Claude in plan mode, or in auto mode with its file editing tools off, as you set
   it; Codex in a read-only sandbox; Antigravity in its plan mode, which is advisory) and may ask questions. A finished plan is approved automatically or
   waits for your approval, as you set it.
3. **Implement**: in a git worktree of its own, on its own branch (one worktree per repository).
4. **Review rounds**: a reviewer checks the work, the implementer fixes what it finds, for 1 to 10 rounds. The reviewer can be given a focus, a viewpoint such as Security to review from. Up to four additional reviewers (each its own agent, model and effort, and optionally a focus of its own) can review at the same time, and the main reviewer combines their findings into the round's one review.
5. **Review column**: you read the result, comment, and have the agent open the pull requests.
6. **Done** when you accept it: you move it there or send its implementer home (leave-on-merge, when it is on,
   does that once every pull request of the task has merged). A task that has to wait for something outside
   goes **On hold**.

Comments put the agent back to work. A task that finds no free desk, or the office's worker limit full, is
queued and starts when there is room. See [The process](docs/kanban.md#the-process) and
[Columns and moves](docs/kanban.md#columns-and-moves).

What the office does for you:

- **The kanban page** at `/kanban` (**J**, or **🗂️ Kanban** in the office, a link on `/lite`): board, task
  view with conversation, plan, runs, changes and PRs, and a bar of the floor's other workers ([docs/kanban.md](docs/kanban.md#opening-it)).
- **Workers at desks**: Claude Code, Codex, Antigravity, OpenCode, Grok, Muse or DeepSeek Harness, each with its terminal
  on its laptop; kanban tasks run on Claude Code, Codex or Antigravity ([agents](docs/agents.md)).
- **Who needs you**: workers that wait on you jump and ding, **N** goes to the one waiting longest, and a
  Slack / Discord webhook (`--webhook`) can announce it ([configuration](docs/configuration.md#command-line)).
- **Projects with several repositories**: a task gets a worktree of each repository on one branch, and the PR
  board shows them all ([docs/kanban.md](docs/kanban.md#projects-and-repositories)).
- **Hosts**: GitHub, Azure DevOps and Bitbucket ([docs/hosting.md](docs/hosting.md)).
- **Issue sources**: GitHub, GitHub Projects v2, Jira and Azure Boards, made into tasks in a click
  ([docs/kanban.md](docs/kanban.md#issue-sources)).
- **Agent-written pull requests**: **O** at a desk, or the task's PR phase, has the agent push and open (or
  fix, or update) the PRs ([docs/kanban.md](docs/kanban.md#pull-requests)). **Fetch review comments** on a
  task's Pull requests tab has the agent list and judge every unresolved comment, from anyone, each remark of a comment as a row of its own and duplicates once; you then decide
  per remark (fix, don't fix, or your own instruction) and send the decisions back; the agent replies on each
  and resolves the threads it settled, the ones it only answered included.
- **Multi-PR reviews, review panels and meetings** across repositories ([features](docs/features.md)). The PR window's **Review** is a
  kanban task with the pull request's head checked out for the reviewers of the review settings, and can post the review on
  the PRs and test the UI and its functionality first ([docs/kanban.md](docs/kanban.md#pull-requests)); **Review panel** opens the meeting form.
- **UI testing**: the implementer saves before and after screenshots, the reviewer looks at them, and they go
  into the pull request description ([docs/kanban.md](docs/kanban.md#ui-testing)).
- **Languages**: the conversation language, the public language and the code comment language
  ([docs/agents.md](docs/agents.md#languages)).
- **Editable prompts and skills**, office-wide or per project ([prompts](docs/kanban.md#prompts),
  [skills](docs/kanban.md#skills)).
- **Agents that manage agents and tasks**: `office-workers`, `office-tasks` and the MCP tools (`hire_worker`,
  `create_task`, `get_task`, `get_issue` (the task's Jira ticket, read fresh), `report_turn` and more) ([docs/kanban.md](docs/kanban.md#agents-reading-other-tasks),
  [the Jira ticket](docs/kanban.md#agents-reading-the-tasks-jira-ticket), [creating tasks](docs/kanban.md#agents-creating-tasks)).
- **Restarts carry on**: stop the office mid-turn and the workers pick up their own sessions when it starts
  again ([features](docs/features.md)); an agent left idle in Review, Waiting or Done is closed after 2 hours
  by default and reopens where it was ([docs/kanban.md](docs/kanban.md#idle-agents-close)).
- **VS Code** opens a task's or worker's folder on the office's machine (admins; [docs/kanban.md](docs/kanban.md#the-task-window)).
- **`/lite`**, the office in 2D for a phone or a slow computer, and an **installable app (PWA)** that opens
  on the kanban ([configuration](docs/configuration.md#pwa)).
- **Accounts**: everyone with a name of their own, and their own Claude and GitHub sign-ins
  ([docs/accounts.md](docs/accounts.md)).

## The 3D world

Every repository is a floor; the rest is what makes the office a place to be in. Everything is listed, room
by room, in [docs/features.md](docs/features.md).

- **Floors and the elevator**: ride it, pick one of your repositories and the office clones it as a floor.
  Floors are grouped by GitHub owner, and a folder you already have works too.
- **Desks and laptops**: walk up to a desk, press **E**, hire a worker, and read or type into its terminal.
- **Boards on the walls**: issues and pull requests hang on cork boards, with a task queue beside them; carry an
  issue to a desk, a worker or the queue. Meeting rooms hold review panels and other meetings.
- **Camera**: third person that plays like first person (click to capture the mouse, the crosshair shows what
  you use), first person, and god mode (**Ctrl + N**, or **Alt + N**) to fly through walls.
- **Together**: voice, chat, screen sharing on the lounge TV and a shared whiteboard.
- **YouTube on the Office TV**: the whole floor watches and hears the same video or song.
- **📲 Phone** (**Y**): every floor and what waits on you, and a music player.
- **Themes and settings**: five themes, indoor lights, mouse sensitivity and a volume for each kind of sound,
  kept in your browser; the weather and the sky's clock are set for the whole office ([features](docs/features.md)).
- **Maps**: turn the building into a castle, or make a map of your own ([docs/maps.md](docs/maps.md)).
- **Games and extras**: a rooftop bar, an arcade, supercars and 4x4s on a scenic loop, a build mode and more
  ([features](docs/features.md#office-games-test-branch)).
- **Multiplayer**: offices connect to a small relay (`kanban3d relay`) and visit each other read-only
  ([features](docs/features.md), [running a relay](docs/self-hosting.md#run-a-multiplayer-relay)).

| Key | Action |
| --- | --- |
| W A S D | Walk (hold Shift to run); Space jumps |
| Mouse | Look around once a click has captured it (Esc frees it); the wheel zooms the third-person camera |
| E | Interact: hire a worker, open its terminal, read a board, sit down, ride the elevator |
| P / C / X | Give a task to a worker / see its changes / send it home |
| J | The kanban |
| N | Go to the next worker that's waiting on you |
| Ctrl + N / Alt + N | God mode: fly through walls; again to land |
| T / Enter | Chat |
| V | Join voice; then hold V to talk |
| Tab | The ☰ menu and the floor list |
| Esc | Close any window |

The full list is in [docs/controls.md](docs/controls.md).

## Development

```bash
npm install
npm run dev          # Vite with hot reload on :5173, the server on :4600 (password: dev)
npm run typecheck
npm test
```

See [testing notes](docs/testing.md) for platform-specific fixture and filesystem checks.

Server edits restart the server, not the workers. After changing `ptyhost.ts`, bump `PTY_PROTOCOL` in `ptys.ts` so the next server replaces the PTY host.

Every change to the app that lands on `main` is published as a GitHub release of `devellaoy/3d-kanban` (asset `3d-kanban.tgz`) by [`.github/workflows/release.yml`](.github/workflows/release.yml), and `install.sh` and `install.ps1` install the newest one. Bump `package.json`'s version to start a new minor. The one-line installer needs a published release; if the workflow failed, install from source.

Where to read next:

- [docs/code-layout.md](docs/code-layout.md): where the code lives, and where a new feature's pieces go
- [docs/kanban-architecture.md](docs/kanban-architecture.md): the kanban's contract
- [docs/kanban-coupling.md](docs/kanban-coupling.md): how the kanban and the 3D office meet
- [docs/how-it-works.md](docs/how-it-works.md): the architecture, and security notes
- [docs/testing.md](docs/testing.md): platform-specific test notes
- [docs/performance.md](docs/performance.md): how often the office is drawn, and what it costs

## License

[MIT](LICENSE). Agent Office is © 2026 AgentSystemLabs under the MIT License, which this fork keeps.

3d-kanban is a fork of [AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office),
taken at base commit `665aeec` as a source tarball, with the kanban task process and the other changes
on top. What was taken, and how upstream is followed, is in [docs/fork.md](docs/fork.md).
