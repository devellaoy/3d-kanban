# 3d-kanban

**3d-kanban** is a fork of [AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office)
(base commit `665aeec`, taken as a source tarball) with an ai-kanban-style task process on top: agents
plan, implement, review and fix each task at desks on the project's floor, and you follow it on a
kanban board beside the 3D office. Agent Office is © 2026 AgentSystemLabs under the
[MIT License](LICENSE), which this fork keeps.

- [Install](#install) · [The kanban: user guide](docs/kanban.md) · [Migrating from ai-kanban](docs/migration.md) ·
  [Origin and upstream](docs/fork.md) · [Kanban architecture](docs/kanban-architecture.md)

## Install

3d-kanban is a product of its own: it installs as the `kanban3d` command, in its own folder, beside
an upstream `agent-office` install if you have one.

**What you need** on the machine that runs it:

- **Node.js 22 or newer** (the kanban's database module, better-sqlite3, needs 22).
- **Python 3, make and a C++ compiler.** better-sqlite3 ships prebuilt binaries (macOS, Linux and
  Windows, x64 and arm64), but npm still runs its native build step on install, which fails without
  them, and compiles it when there is no binary for your platform. macOS: `xcode-select --install`;
  Debian/Ubuntu: `sudo apt install build-essential python3`; Windows: tick *Tools for Native Modules*
  in the Node.js installer (or install Visual Studio Build Tools with *Desktop development with C++*).
  The terminals' module (node-pty) comes prebuilt and needs nothing.
- **git**, and the **GitHub CLI** signed in (`gh auth login`), for projects, worktrees and the issue
  and PR boards. Repositories on **Azure DevOps** or **Bitbucket** need no CLI: a token in
  ☰ → 🔐 Your sign-ins ([docs/hosting.md](docs/hosting.md)).
- **Claude Code** (`claude`) or **Codex** (`codex`), signed in: the kanban's tasks run on them (the
  office's other agents stay ordinary workers).

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.ps1 | iex
```

The installer downloads the newest [release](https://github.com/devellaoy/3d-kanban/releases)
(`3d-kanban.tgz`), installs it in `~/.local/share/3d-kanban` (Windows: `%LOCALAPPDATA%\3d-kanban`),
puts a `kanban3d` command in `~/.local/bin` (Windows: `%LOCALAPPDATA%\3d-kanban\bin`, added to your
PATH) and starts the office; next time just run `kanban3d`, in PowerShell, cmd and
Git Bash alike. `AGENT_OFFICE_INSTALL_ONLY=1` installs
without starting, `AGENT_OFFICE_VERSION=v0.1.4` picks a release; the other settings are at the top of
[`install.sh`](install.sh) and [`install.ps1`](install.ps1).

The one-line installer needs a published release: the [Release workflow](.github/workflows/release.yml)
publishes one (`v0.1.<commits on main>`, with the asset `3d-kanban.tgz`) whenever a change to the app
lands on `main` and its build, tests and test install pass, a few minutes after the push. (The first
release, v0.1.3, came before the rename: it still says `agent-office` in its help, but installs as
`kanban3d` all the same.) To run the newest `main` before its release, or if the workflow failed,
install from source:

```bash
git clone https://github.com/devellaoy/3d-kanban.git && cd 3d-kanban && npm install && npm install -g .
kanban3d
```

(`npm install` also builds the client and the server; `npm install -g .` puts `kanban3d` on your PATH.)

**Updating.** Run the install line again: it installs the newest release, points `kanban3d` at it and
removes the versions nothing runs any more. Your data isn't touched. From source:
`git pull && npm install && npm install -g .`

**Where things live.** The program is in the install folder above (`versions/<tag>`, and `current`
names the one in use). Your data is where upstream keeps it: `~/agent-office` (move it with `--home`
or `AGENT_OFFICE_HOME`), whose `.agent-office` folder holds the password, accounts, floors, chat and
the kanban's `kanban.sqlite`, `kanban-settings.json` and uploads; new projects are cloned next to it
unless you pick another workspace folder. The office still reads upstream's `AGENT_OFFICE_*`
environment variables (`AGENT_OFFICE_HOME`, `AGENT_OFFICE_PASSWORD`, `AGENT_OFFICE_HOOK_PORT`, …), and
the installers take theirs (`AGENT_OFFICE_INSTALL_DIR`, `AGENT_OFFICE_BIN_DIR`, …). An upstream
`agent-office` on the same machine uses the same data folder and port by default: don't run both at
once on them, or start one with `--home <another folder>` and `--port <another port>`.

**Coming from ai-kanban.** The migration runs from a clone of this repository (it isn't in the release)
and writes into the office's data folder above (`--home` picks another). See
[the guide](docs/migration.md):

```sh
git clone https://github.com/devellaoy/3d-kanban.git && cd 3d-kanban && npm install
npm run migrate:ai-kanban -- --from ~/.ai-kanban/data          # a dry run: reports, writes nothing
npm run migrate:ai-kanban -- --from ~/.ai-kanban/data --apply  # for real, with the office stopped
```

**On a server** (Ubuntu or Debian), one line installs a clone of this fork as a systemd service; see
[below](#deploy-to-any-ubuntu-or-debian-server) and [docs/self-hosting.md](docs/self-hosting.md):

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/deploy/provision.sh | bash
```

## What the fork adds

- **A task process**: plan (with questions, auto or manual approval) → implement → 1–10 review rounds ⇄
  fix → the Review column → Done (a task that has to wait for something outside goes **On hold**, its worker resting in the 3D lounge: [docs/kanban.md](docs/kanban.md#on-hold)). Comments put the agent back to work (a comment whose work changes nothing since the task came to
  Review doesn't start a review round), and answer it when it asks in its terminal (you can also type into a worker's terminal mid-run: a reply to you doesn't replace the run's result, and if the run's background work ended in that turn the office asks the agent to restate its final answer); usage limits are retried by themselves (a Codex one at the reset time its account reports). A task that finds no free desk or the office's
  worker limit full is queued and starts when there's room, as the account that made it (a task counts
  once against the limit: its reviewer never waits for its own implementer's place, and it takes no desk
  either: it stands behind the implementer's chair, watching over its shoulder); a task waiting on a person is announced on the
  office's Slack / Discord webhook. Claude Code and Codex.
- **A kanban page** at `/kanban` (**J** or **🗂️ Kanban** in the office, a link on `/lite`). A
  task's view (conversation, plan, runs, the change and its commits read from git, an
  investigation's reports, PRs) is one shared piece, on the kanban and in the office's windows.
- **🧩 VSCode**: the task view's head on the kanban and every worker's terminal window (3D office and
  `/lite`) open the task's or worker's folder in VS Code on the office's machine: its worktree, or all
  its repositories' worktrees in one window. Admins only. VS Code must be installed there: on macOS in
  `/Applications` is enough, elsewhere `code` must be on the PATH ([docs/kanban.md](docs/kanban.md#the-detail-panel)).
- **One world, two views**: a task's workers are ordinary workers at desks. Sending one home (**X**,
  leave-on-merge, the queue, a meeting) is an event on its task, and can mark it done; a task moved to
  Done sends its idle workers home, and stops a run whose agent is still asking in its terminal (see [docs/kanban.md](docs/kanban.md#sending-a-tasks-worker-home)).
  In the office, a task worker's card says `🗂️ #14 · …`; **E** opens its window with a **🗂️ Task** tab
  (the task's conversation, plan and runs), **C** its task's Changes window (every repository, per
  commit too, the same view as the kanban's Changes tab), **P** is a message on its task while it's in progress,
  waiting or in review, **R** retries it, and a hire, or the 📋 Task queue's form, can tick **🗂️ Run as a kanban task** ([controls](docs/controls.md#at-a-kanban-tasks-worker),
  [the contract](docs/kanban-coupling.md)).
- **Restarts carry on**: stop the office (Ctrl+C) in the middle of a turn and start it again, and the workers that were
  working pick up their own session with a *continue*, one after another, by themselves, three seconds apart (a kanban run's are five seconds apart per project); ⚙️ Settings can turn that off, for admins
  (then they wake up and wait for a prompt). A task's worker is resumed by the kanban instead ([docs/features.md](docs/features.md#survives-restarts)).
- **Projects with several repositories**: a floor is a project, and a task gets a worktree of each of
  its repositories on one branch, cut from each repository's configured base branch (else the branch
  its checkout is on). The issues and PR boards show every repository; the PR board (E) has a tab per repository, and **All / 👤 Mine / 👀 To review** beside them shows only your own pull requests (yours on GitHub, or opened from your kanban tasks and workers) or the ones waiting on your review. An admin can rename a project
  in ⚙️ Settings → 📁 Projects; its id, folder and repository stay.
- **Repositories on Azure DevOps and Bitbucket**, not only GitHub: the office reads each repository's host
  from its remote, follows their pull requests on the PR board and on kanban tasks (to merged), opens
  them with a token of yours (☰ → 🔐 Your sign-ins), and its agents use `office-pr` there instead of `gh`.
  A task's Azure Boards work item is completed when its pull request merges ([docs/hosting.md](docs/hosting.md)).
- **Issue sources per project**: GitHub repositories, GitHub Projects v2, Jira and Azure Boards, made into tasks in a click, **🔎 browsed in full** (a tree of all of a Jira project's or board's issues, with filters), and moved on (status), commented on and assigned from the issue's window, on the kanban and in 3D. They are also the 3D office's 📌 Issues board, cards you carry to desks, workers and the queue.
- **Agent-written pull requests**: **O** at a desk and the task's PR phase have the agent push and open
  (or fix, or bring up to date with their target branches and resolve the conflicts of) the PRs in every repository.
- **Multi-PR reviews**: 🔍 Review and 🤝 Review panel pick the PRs that belong together across the
  repositories and review them as one change. The office has one meeting room, and the **🚧 Room for a meeting room** sign on the west wall builds up to
  three more (the same way the back office grows), so panels and other meetings can run at the same time; a new one takes the first free room.
  **📚 Earlier meetings** in the meeting window lists the floor's finished meetings (searchable) and reads
  their output and round notes, Markdown rendered or raw, to copy or download. A finished meeting's output can
  be handed on with **🗂️ Make a kanban task** or **🤖 Hand to a worker** (in the meeting window and in the
  earlier meetings view): the hire dialog opens with the output as the prompt, and the meeting remembers where it went.
- **Languages**: ⚙️ Settings → 🤖 Workers sets the **conversation language** every agent talks to you in and
  the **public language** issues, pull requests, commits and other texts that leave the office are written in;
  a project can pick its own public language in ⚙️ Project, and the **code comment language** (English by
  default; per project, or `The project's own conventions` to opt out). Kanban runs, plain workers, queue tasks,
  `hire_worker` and the board agents all get the two rules; unset, agents go by the task's language and the
  project's instructions as before ([agents](docs/agents.md#languages)).
- **Editable prompts**, office-wide or per project, with the process's contract blocks kept fixed (they also
  tell every kanban run and review panel to stop the processes it started, such as a dev server, when it
  finishes, unless it was asked to leave them running).
- **Skills** per project, phase and agent (Claude via `--plugin-dir`, Codex synced into its home). The repository's `user-skills/` (kanban-dev and others) are synced into your own
  `~/.claude` and `~/.codex` on start, see [docs/kanban.md](docs/kanban.md#skills-synced-to-your-own-home).
- **Task references for agents**: `office-tasks get 14`, the MCP tools `get_task` / `search_tasks`, creating
  tasks from an agent (`office-tasks create`, the MCP tool `create_task`), and
  ai-kanban's `/api/tasks/reference` and `/api/v1` on the loopback hook server (its port is in
  `<data>/hook-port`; `--hook-port <n>` pins it for scripts outside the office, see
  [docs/kanban.md](docs/kanban.md#agents-reading-other-tasks) and
  [Agents creating tasks](docs/kanban.md#agents-creating-tasks)).
- **A migration from ai-kanban**: projects, tasks (with their ids), comments, plans and settings.
- **Third person that plays like first person**: the mouse looks around (click to capture it, no drag
  to orbit), the camera sits over your shoulder, and the crosshair shows what you use, within the same
  reach of your character's eyes as in first person and only what they can see (on a touch screen, a
  tap uses what you tapped); your character faces where the camera looks; the wheel zooms
  ([controls](docs/controls.md)). Upstream's *Mouse drag /
  wheel* row below is out of date.
- **Mouse sensitivity**: ⚙️ Settings → 🧍 You, 25–200% of the usual look speed, kept in your browser.
- **A volume for each kind of sound**: ⚙️ Settings → 🔊 Sound & voice → *Each kind of sound*: background noise, rain, jumps & thumps, footsteps, typing & paper, other effects, and dings & alerts, each 0–100% with its own mute, under the office sounds volume and kept in your browser. Rain indoors and the jump landing are quieter than upstream's ([features](docs/features.md)).
- **Themes**: ⚙️ Settings → 🧍 You → Theme: **Office** (the default), **Dark** or **Glossy**, kept per browser. They restyle the windows, the HUD, the kanban and the 2D view, not the 3D office ([features](docs/features.md)).
- **Light indoors from the lamps and the windows**: inside the office the room is lit only by its own lamps
  (each one lights the area round it, the wall switches turn them off and on, and they come up as it gets
  dark) and by the daylight or moonlight through the windows and the balcony's glass doors, with a little
  light everywhere so nothing is pitch black. Outdoors and the castle are lit as before ([features](docs/features.md)).
- **YouTube on the Office TV**: press **E** at the lounge TV (or paste a YouTube / YouTube Music link
  into the jukebox) and the whole floor sees and hears the same video or song at the same point, in
  YouTube's own player on the TV; sit on the couch or press **E** again to watch it big. Its window has
  shared controls (pause, seek, previous / next, speed), the TV's own queue (kept across restarts) and
  a floor-wide **Same volume across the floor** setting. A screen share still has the TV first ([features](docs/features.md#youtube-on-the-office-tv)).
- **📲 Phone**: **Y** (or ☰ → 📲 Phone) brings up a phone with every floor on it, how many work there
  and how many wait on you; tap a floor for its processes, the waiting ones first, and one of them for
  its window, on any floor without walking there. Its **🎵 Music** plays a YouTube link or playlist for
  you alone (no distance, your own volume), on your floor's TV, or to someone on any floor, both of you
  in step, with the TV's controls and queue ([features](docs/features.md)).
- **An installable app (PWA)**: install the office from the browser; it opens on the kanban, with
  shortcuts to the 3D office and the 2D view, shows *The office is offline. Reconnecting…* while it can't
  reach the office, and offers **Reload** when a new version is out. HTTPS is needed except on
  localhost ([configuration](docs/configuration.md#pwa)).
- **Office games** *(test branch `test/office-game-features`, single player)*: things on your desk, light
  switches, a lounge plant that grows from merges, seasons in the landscape, a campsite and a hill lookout,
  a roof garden, fishing, racing with start lights and a ghost car, quick emoji reactions (**7**–**0**),
  a game room with billiards in the garage, a build mode for furnishing a floor (**U**) with furniture you
  can sit on (and for moving or taking out the office's own desks, bean bags, couch, poufs, whiteboard and rugs, for everyone on the floor), a map (**§**), faster cars that drive anywhere on land (nitro, drift) and two off-road 4x4s on
  softer, longer-travel springs than the supercars' for the speed humps and the rough ground, a livelier scenic
  world, a *six seven* emote, and a third-person camera that stays out of walls. They are kept
  in your browser only, so nobody else sees them yet ([features](docs/features.md#office-games-test-branch),
  [controls](docs/controls.md#office-games-test-branch)).
- **Multiplayer: visit each other's offices**: every office stays on its own machine. Offices connect to a
  small relay (`kanban3d relay`), see who is online in **☰ → 🌐 Players** and walk into each other's
  offices read-only (chat, voice, the whiteboard and the games work; nothing else can be changed).
  Sharing is per floor and off by default, and a visitor only gets the floors whose GitHub repositories
  they can read themselves, checked by the owner's office. An online office reconnects by itself, also
  right after the computer wakes from sleep ([features](docs/features.md#multiplayer-visit-each-others-offices),
  [running a relay](docs/self-hosting.md#run-a-multiplayer-relay)).

The rest is the office's own guide, from upstream agent-office; its install and run commands point at
this repository (`devellaoy/3d-kanban`, its releases and the `kanban3d` command).

---

> [!WARNING]
> **Work in progress.** Agent Office is built for one person's workflow — mine — and it changes fast as I iterate on it.
> Expect breaking changes between releases: keys that move, screens that get redrawn, features that come and go
> without notice. If it's close to what you want, fork or clone it and bend it into what you need it to be.

<div align="center">

*"Whatever you do, work heartily, as for the Lord and not for men."* — Colossians 3:23 (ESV)

# 🏢 Agent Office

**A 3D office your team shares with its coding agents.**

Sit **Claude Code**, **Codex**, **OpenCode**, **Grok**, **Muse** and **DeepSeek Harness** workers at desks, watch each one's terminal on the laptop in front of it,
and jump into any of them together. Every GitHub repo is a floor of the building.

[![Release](https://img.shields.io/github/v/release/devellaoy/3d-kanban?style=flat-square&color=e8c547&label=release)](https://github.com/devellaoy/3d-kanban/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/devellaoy/3d-kanban/release.yml?style=flat-square&label=build)](https://github.com/devellaoy/3d-kanban/actions)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square)](#run-locally)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6?style=flat-square)](https://www.typescriptlang.org)

[**Run locally**](#run-locally) · [**Deploy to AWS**](#deploy-to-aws-ec2) · [**Azure**](#deploy-to-azure) · [**Railway**](#deploy-to-railway) · [**Fly.io**](#deploy-to-flyio) · [**Dokploy**](#deploy-to-dokploy) · [**Any server**](#deploy-to-any-ubuntu-or-debian-server) · [**Add users**](#add-users) · [**Controls**](#controls) · [**Features**](docs/features.md) · [**How it works**](docs/how-it-works.md)

```sh
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.sh | bash
```

</div>

---

## What it is

- **A floor per project.** Ride the elevator, pick one of your GitHub repos, and the office clones it and opens a floor for it. Every worker, board and queue on that floor works in that checkout. A folder you already have works too, git or not: an admin types its path into the elevator and the office uses it as it is, with no clone. The floors are grouped by GitHub owner, and admins can drag them (or press Alt+↑/↓) into the building's order (see [features](docs/features.md)).
- **Workers at desks.** Walk up to an empty desk, press **E**, and pick Claude Code, Codex, OpenCode, Grok, Muse or DeepSeek Harness. The agent's live terminal shows on its laptop, and anyone can open it and type. Pin a web page (a linked chat, docs) open in a tab beside it.
- **You can see who needs you.** A worker that needs input or has finished jumps up and down and dings (a kanban task's worker only when its task waits on you, not while the kanban carries it on to its next step by itself). Press **N** to go straight to the one that has waited longest.
- **From your phone, too.** `/lite` is the office in 2D: every worker and what it's waiting on, its terminal with the keys a phone keyboard lacks, and the boards. The 3D office offers it on a phone or a slow computer.
- **GitHub on the walls.** Issues and pull requests hang on cork boards. Hand an issue to a worker, queue tasks, give a worker its own git worktree and open its PR with one key (if one gets deleted behind the office's back, the worker waits at its desk until you rebuild it). One task can span several projects: the worker gets a worktree of each, and a PR in each that links the others.
- **Agents that manage agents.** Every worker can list, hire, message and send home the others, through an `agent-office` MCP server (Claude Code, Codex, OpenCode) or the `office-workers` command. Ask one to "send everyone whose PR merged home" and it does, deleting their worktrees and branches unless they hold unpushed work.
- **Together.** Voice, chat (what you say pops up as a speech bubble over your head), screen sharing on the lounge TV and a shared whiteboard.

- **Other maps.** Turn the whole building into a castle: sit on a throne of iron blades while your workers line up before you when they're done, send new ones off through the Hand of the King, and watch their beards grow long and grey as they toil. Send one home and the Kingsguard runs up from the dungeon, marches it down the stairs and throws it in a cell, where it starves, dies and rots down to a skeleton. Or make a map of your own, with its own way of seeing workers off in JSON ([docs/maps.md](docs/maps.md)).

There's a lot more (a rooftop bar, an office dog, an arcade, supercars and 4x4s in the garage to drive round a scenic loop past a farm, pines, mountains and a beach): see [docs/features.md](docs/features.md).

## Requirements

On the machine that runs the office:

- **Node.js 22+**, and Python 3, make and a C++ compiler for the kanban's database module (see [Install](#install))
- At least one agent CLI, signed in as the user that runs the office: **Claude Code** (`claude`), **Codex** (`codex`), **OpenCode** (`opencode`), **Grok** (`grok`), **Muse** (`muse`) or **DeepSeek Harness** (`dsh`). With [accounts](#add-users), everyone can sign in to their own Claude from the office instead.
- **git**, and the **GitHub CLI** (`gh auth login`) for cloning repos and the issue and PR boards

## Run locally

Install the latest release and start the office:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.ps1 | iex
```

This puts a `kanban3d` command on your PATH, so next time just run `kanban3d`. Run the install line again to update. The installer's settings (a particular release, install without starting) are listed at the top of [`install.sh`](install.sh) and [`install.ps1`](install.ps1).

The first time it starts, it walks you through setting up, right in the terminal:

1. **Where to clone your projects.** It suggests a code folder you already have (`~/Workspace`, `~/code`…), else `~/agent-office`. Each project goes in `<folder>/<owner>/<repo>`.
2. **GitHub.** If the GitHub CLI isn't signed in, it offers to run `gh auth login` for you.
3. **Your first project.** Pick one of your repos by number, or type `owner/name`, and the office clones it as the first floor. (To use a folder you already have instead, start with `kanban3d <folder>`, or add it from the elevator once the office is open.)

Press Enter to skip a step: the elevator in the office asks for your first project too, and an admin can type the path of a folder there (starting with `/` or `~`) and press **📁 Add folder**. Then the office opens in your browser, **already signed in**, with a link that works once. The terminal also prints the office password, for signing in from another browser (it's saved in `~/agent-office/.agent-office/config.json`).

Walk to an empty desk, press **E** and hire a worker. Its prompt can take files too: **📎 Attach**, paste or drop them on the dialog ([features](docs/features.md)).

Common options:

```bash
kanban3d ~/code/my-project              # use a project you already have as the first floor
kanban3d --password 'correct horse'     # choose the password
kanban3d --port 4700
kanban3d --agent grok                   # default agent: claude, codex, opencode, grok, muse or dsh
kanban3d --no-open                      # print the sign-in link instead of opening a browser
kanban3d setup                          # the first-start walkthrough again (office stopped)
```

Every option is in [docs/configuration.md](docs/configuration.md). Choosing models and providers per worker is in [docs/agents.md](docs/agents.md).

To run it from a clone instead:

```bash
git clone https://github.com/devellaoy/3d-kanban && cd 3d-kanban
npm install          # also builds the client and server
npm install -g .     # puts `kanban3d` on your PATH
kanban3d
```

> Only your computer can reach the office: it listens on `127.0.0.1`. `--host 0.0.0.0` lets your network in, but over plain http, where voice and screen sharing don't work. To share the office with a team, put it on a server: [AWS](#deploy-to-aws-ec2), [Azure](#deploy-to-azure), [Railway](#deploy-to-railway), [Fly.io](#deploy-to-flyio), [Dokploy](#deploy-to-dokploy) or [any Ubuntu or Debian machine](#deploy-to-any-ubuntu-or-debian-server).

## Deploy to AWS (EC2)

One script, using only the AWS CLI. You need the **AWS CLI signed in** (`aws configure` or `aws sso login`), `ssh`, `curl` and a clone of this repo:

```bash
git clone https://github.com/devellaoy/3d-kanban && cd 3d-kanban
deploy/aws.sh up --project your-org/your-repo --claude-token "$(claude setup-token)"
```

In about two minutes, `up`:

1. Launches a **t3.xlarge** (4 vCPU, 16 GiB) Ubuntu 24.04 instance with a 50 GiB disk and a fixed Elastic IP.
2. Creates a security group that opens **only SSH, only to your IP**. The office listens on `127.0.0.1:4600` on the machine and is never on the internet. Everyone reaches it through an SSH tunnel, so there are no certificates to manage, and voice and screen sharing work.
3. Runs [`deploy/provision.sh`](deploy/provision.sh) on it: Node 22, git, the GitHub CLI, Claude Code and the office, under systemd, so it comes back after a crash or reboot and workers keep running through a restart.
4. Opens a tunnel and your browser at http://localhost:4600. **The first page shows the office password once. Write it down.**

`--project` is optional: it clones that repo as the first floor. Leave it out and pick projects in the elevator.

**Signing in the agents.** `--claude-token` uses your Claude subscription; `--anthropic-api-key <key>` uses an API key instead. Leave both out and run `/login` in the first worker's terminal. Codex and OpenCode aren't installed by the script: `deploy/aws.sh ssh` and install them yourself.

**GitHub.** Your local `gh auth token` is copied to the machine so the office can clone private repos, show the boards and push PRs. Anyone in the office can use it, so pass `--github-token <fine-grained token>` or `--no-github-token` to limit that.

**On Tailscale, no tunnels.** If your team uses [Tailscale](https://tailscale.com), add `--tailscale`:

```bash
deploy/aws.sh up --tailscale --project your-org/your-repo --claude-token "$(claude setup-token)"
```

The machine joins your tailnet, and Tailscale Serve puts the office on `https://agent-office.<your-tailnet>.ts.net` with a real certificate. Anyone on your tailnet just opens that link: no terminal to keep open, no SSH keys, no IPs to allow, and voice and screen sharing work. `up` opens Tailscale's page to add the machine (or pass `--tailscale-auth-key tskey-auth-…`) and, the first time, the page that turns on HTTPS for your tailnet. SSH stays open to your IP only, for `deploy/aws.sh` itself. More in [docs/aws.md](docs/aws.md#tailscale).

Day to day:

```bash
deploy/aws.sh open                # tunnel + open the office (Ctrl-C closes the tunnel)
deploy/aws.sh status              # machine, address, is the office up, who's invited
deploy/aws.sh logs                # follow the office's logs
deploy/aws.sh ssh                 # a shell on the machine
deploy/aws.sh update              # install the latest 3d-kanban and restart
deploy/aws.sh resize t3.2xlarge   # bigger or smaller machine, same address
deploy/aws.sh pause               # stop the machine; only the disk and IP are billed
deploy/aws.sh resume              # start it again and open it
deploy/aws.sh destroy             # delete everything it created (asks first)
```

You can also upgrade from inside the office: **☰ → ⬆️ Upgrade the office**. Other flags (`--region`, `--instance-type`, `--disk`, `--name` for several offices) are in `deploy/aws.sh help`, and the details are in [docs/aws.md](docs/aws.md).

## Deploy to Azure

The same thing on an Azure VM, using only the Azure CLI. You need the **Azure CLI signed in** (`az login`), `ssh`, `curl` and a clone of this repo:

```bash
git clone https://github.com/devellaoy/3d-kanban && cd 3d-kanban
deploy/azure.sh up --project your-org/your-repo --claude-token "$(claude setup-token)"
```

`up` puts everything in a resource group of its own, `agent-office`, and launches a **Standard_D4as_v5** VM (4 vCPU and 16 GiB, like the t3.xlarge on AWS, at about the same price) with Ubuntu 24.04, a 64 GiB Premium SSD and a static IP. Its firewall opens **only SSH, only to your IP**. Then it runs the same [`deploy/provision.sh`](deploy/provision.sh) and opens the office through an SSH tunnel at http://localhost:4600. **The first page shows the office password once. Write it down.**

Every command from the AWS script works the same, with `deploy/azure.sh` in its place: `open`, `status`, `logs`, `ssh`, `update`, `invite`, `allow`, `service`, `resize Standard_D8as_v5`, `pause` (deallocates the VM, so only the disk and IP are billed), `resume` and `destroy` (deletes the resource group). One more, `connect`, lets a second computer manage the office. `--location` picks the region (default: your `az` default location, else `eastus`), `--subscription` the subscription and `--size` the VM size. The details are in [docs/azure.md](docs/azure.md).

## Deploy to Railway

No machine to look after: one script, using the Railway CLI. You need the **Railway CLI 5 or newer, logged in** (`railway login`), `ssh`, `curl`, Node.js and a clone of this repo:

```bash
git clone https://github.com/devellaoy/3d-kanban && cd 3d-kanban
deploy/railway.sh up --claude-token "$(claude setup-token)"
```

In about five minutes, `up`:

1. Creates a Railway project with one service, built from this checkout with [`deploy/container/Dockerfile`](deploy/container/Dockerfile): Node 22, git, the GitHub CLI and sshd, with Claude Code installed on first start.
2. Adds a **volume on `/data`** for everything the office keeps: the password, accounts, floors and settings, the projects, Claude's and GitHub's sign-ins, teammates' keys and the SSH host key. Restarts and redeploys replace the container, never the volume.
3. Puts Railway's **TCP proxy** in front of the container's SSH, and nothing else. The office listens on `127.0.0.1:4600` inside the container and has no public URL: everyone reaches it through an SSH tunnel, as on AWS.
4. Opens a tunnel and your browser at http://localhost:4600. **The first page shows the office password once. Write it down.**

The agents and GitHub sign in as on AWS: `--claude-token`, `--anthropic-api-key`, `--github-token` or `--no-github-token`.

```bash
deploy/railway.sh open              # tunnel + open the office (Ctrl-C closes the tunnel)
deploy/railway.sh status            # deployment, SSH address, volume, is the office up, who's invited
deploy/railway.sh invite octocat    # let a teammate tunnel in with their GitHub SSH keys
deploy/railway.sh logs              # follow the office's logs (ssh: a shell in the container)
deploy/railway.sh update            # build this checkout again and redeploy it
deploy/railway.sh destroy           # delete the project and its volume (asks first)
```

The details, and what's on the volume, are in [docs/railway.md](docs/railway.md).

## Deploy to Fly.io

The same container on a [Fly.io](https://fly.io) machine, using flyctl. You need **flyctl logged in** (`fly auth login`), `ssh`, `curl`, Node.js and a clone of this repo:

```bash
git clone https://github.com/devellaoy/3d-kanban && cd 3d-kanban
deploy/fly.sh up --claude-token "$(claude setup-token)"
```

In a few minutes, `up`:

1. Creates a Fly app with one machine, a `shared-cpu-4x` with 8 GB in the region nearest you, built from this checkout with the same [`deploy/container/Dockerfile`](deploy/container/Dockerfile) as on Railway.
2. Adds a **volume on `/data`** for everything the office keeps, so restarts, redeploys and resizes lose none of it.
3. Gives the app a **dedicated IPv4 address** with SSH on a random port, and nothing else. The office listens on `127.0.0.1:4600` inside the machine and has no public URL: everyone reaches it through an SSH tunnel, as on AWS.
4. Opens a tunnel and your browser at http://localhost:4600. **The first page shows the office password once. Write it down.**

The agents and GitHub sign in as on AWS: `--claude-token`, `--anthropic-api-key`, `--github-token` or `--no-github-token`.

```bash
deploy/fly.sh open                    # tunnel + open the office (Ctrl-C closes the tunnel)
deploy/fly.sh status                  # machine, SSH address, volume, is the office up, who's invited
deploy/fly.sh invite octocat          # let a teammate tunnel in with their GitHub SSH keys
deploy/fly.sh logs                    # follow the office's logs (ssh: a shell in the machine)
deploy/fly.sh update                  # build this checkout again and redeploy it
deploy/fly.sh resize performance-2x   # another machine size, same address and volume
deploy/fly.sh pause                   # stop the machine (resume starts it again)
deploy/fly.sh destroy                 # delete the app and its volume (asks first)
```

`--region`, `--org`, `--vm-size`, `--memory`, `--disk` and `--name` (for several offices) are in `deploy/fly.sh help`. The details, and what's on the volume, are in [docs/fly.md](docs/fly.md).

## Deploy to Dokploy

Already run a [Dokploy](https://dokploy.com) server? One script puts the office on it, through Dokploy's API. You need an **API key** (Dokploy: **Settings → Profile → API/CLI Keys**, with rate limiting off), `ssh`, `curl`, `git`, Node.js and a clone of this repo:

```bash
git clone https://github.com/devellaoy/3d-kanban && cd 3d-kanban
export DOKPLOY_API_KEY=<your key>
deploy/dokploy.sh up --url https://dokploy.example.com --claude-token "$(claude setup-token)"
```

In about five minutes, `up`:

1. Creates a Dokploy project with one application, and uploads this checkout for Dokploy to build with [`deploy/container/Dockerfile`](deploy/container/Dockerfile), the same image as on Railway.
2. Mounts a **Docker volume on `/data`** for everything the office keeps. Deploys and restarts replace the container, never the volume.
3. Publishes the container's SSH on **port 2222 of the server** (`--ssh-port` picks another), and nothing else: no domain, and the office listens on `127.0.0.1:4600` inside the container. Everyone reaches it through an SSH tunnel, as on AWS. A firewall in front of the server has to let that port through.
4. Opens a tunnel and your browser at http://localhost:4600. **The first page shows the office password once. Write it down.**

The agents and GitHub sign in as on AWS: `--claude-token`, `--anthropic-api-key`, `--github-token` or `--no-github-token`. `--server <name>` runs it on one of Dokploy's remote servers.

```bash
deploy/dokploy.sh open              # tunnel + open the office (Ctrl-C closes the tunnel)
deploy/dokploy.sh status            # its page in Dokploy, last deployment, SSH address, who's invited
deploy/dokploy.sh invite octocat    # let a teammate tunnel in with their GitHub SSH keys
deploy/dokploy.sh logs              # follow the office's logs (ssh: a shell in the container)
deploy/dokploy.sh update            # upload this checkout again, build it and redeploy it
deploy/dokploy.sh destroy           # delete the application and its volume (asks first)
```

The details, and what's on the volume, are in [docs/dokploy.md](docs/dokploy.md).

## Deploy to any Ubuntu or Debian server

Another cloud, or your own machine? Run one line on the server, as root or as a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/deploy/provision.sh | bash
```

It installs Node 22, git, the GitHub CLI, Claude Code and the office as a systemd service. Run as root, it creates an `agentoffice` user to run the office, so workers never run as root. The office listens on `127.0.0.1:4600` only, and the script ends by printing the SSH tunnel command and a link that shows the office password once. Run the same line again to update.

For HTTPS on your own domain, point a DNS record at the server and add `bash -s -- --domain office.example.com`: it sets up Caddy, which gets the certificate by itself. To put it on your Tailscale network instead, add `bash -s -- --tailscale`. The details, and setting it up by hand behind Caddy or nginx, are in [docs/self-hosting.md](docs/self-hosting.md).

To let offices visit each other, run a relay on a server with `kanban3d relay` ([how](docs/self-hosting.md#run-a-multiplayer-relay), [flags](docs/configuration.md#multiplayer-relay)).

## Add users

Everyone gets their own account, so their name is on their character, in chat and on every terminal they type into.

**1. On a server, let them in first.** On a [Tailscale](docs/aws.md#tailscale) office, everyone on your tailnet can already open it. For someone who isn't, share the machine with them from Tailscale's Machines page: **☰ → 👥 Invite teammates** says how. Skip to step 2.

Otherwise the office is only reachable through an SSH tunnel, so a teammate needs their SSH key on the machine. In the office, open **☰ → 👥 Invite teammates** and type their GitHub username. On AWS, Railway, Fly.io or Dokploy you can also do it from your terminal:

```bash
deploy/aws.sh invite octocat        # installs the keys from github.com/octocat.keys
deploy/aws.sh allow 203.0.113.7     # their IP ("allow anywhere" opens SSH to every IP)
deploy/railway.sh invite octocat    # on Railway, SSH answers every IP already
deploy/fly.sh invite octocat        # and on Fly.io
deploy/dokploy.sh invite octocat    # and on Dokploy
```

It prints the command to send them. They leave it running and open http://localhost:4600:

```
ssh -L 4600:localhost:4600 office@<your-office-ip>
```

(On Railway and Fly.io the address carries a port of its own, like `ssh://office@zephyr.proxy.rlwy.net:17738`. On Dokploy it's the server's SSH port for the office: `ssh://office@203.0.113.7:2222`.)

Their key logs in as a locked-down `office` user that can only forward to the office port: no shell, no other ports. Running the office on your own computer, or on your own domain over HTTPS? Skip this step.

**2. Make them an account.** Open **☰ → 🔑 Accounts** and make an invite link. Name it (or let them pick) and make them a *Member* or an *Admin*. The link works once, for 7 days, and they choose their own password. Make one for yourself too, as an admin.

The same works from a terminal on the office's machine, even while it runs:

```bash
kanban3d accounts                      # accounts and open invites
kanban3d accounts invite ada --admin   # prints a single-use /join#… link
kanban3d accounts role ada member
kanban3d accounts revoke ada           # signed out within seconds
```

On the EC2 machine, run it through `deploy/aws.sh ssh` (on Azure, `deploy/azure.sh ssh`):

```bash
deploy/aws.sh ssh 'node /opt/agent-office/bin/agent-office.js accounts invite ada --dir "$(cat /etc/agent-office/home)"'
deploy/railway.sh ssh 'node /opt/agent-office/bin/agent-office.js accounts invite ada'   # on Railway
deploy/fly.sh ssh 'node /opt/agent-office/bin/agent-office.js accounts invite ada'       # on Fly.io
deploy/dokploy.sh ssh 'node /opt/agent-office/bin/agent-office.js accounts invite ada'   # on Dokploy
```

**Their own Claude and GitHub.** With accounts, everyone's workers run on their own Claude plan, and the office acts on GitHub as them: comments, merges, labels, pushes and pull requests show up under their name. The first time someone comes in, **🔐 Your sign-ins** opens (it's in the **☰** menu too). *Sign in with Claude* gives them Claude's sign-in page and takes back the code it shows. *Sign in with GitHub* shows a one-time code for github.com/login/device. They can paste a token from `claude setup-token`, or a GitHub token, instead. A 🐚 shell they open at a desk runs as them, so `claude auth login` and `gh auth login` typed there work too. Admins can use the office machine's own sign-ins instead. Each account's sign-ins live in `.agent-office/homes/<account>/`, and revoking the account deletes them. The boards are read with the machine's own `gh`, so that account needs read access to the repos. Running it just for yourself, with no accounts, none of this applies.

**3. Turn off the shared password.** Until you do, anyone who knows the office password can get in, as an admin. Once everyone has an account, switch it off in **🔑 Accounts** (signed in with your own admin account), or `kanban3d accounts password off`.

**Removing someone.** Revoke their account in **🔑 Accounts** (or `kanban3d accounts revoke <name>`), and on a server also remove them in **👥 Invite teammates** (on AWS, `deploy/aws.sh uninvite <name>`; on Railway, `deploy/railway.sh uninvite <name>`; on Fly.io, `deploy/fly.sh uninvite <name>`; on Dokploy, `deploy/dokploy.sh uninvite <name>`) to take away their SSH keys and drop open tunnels (other teammates just reconnect). If the shared password is still on, change it with `deploy/aws.sh reset-password` (or `deploy/railway.sh reset-password`, `deploy/fly.sh reset-password` or `deploy/dokploy.sh reset-password`).

## Controls

| Key | Action |
| --- | --- |
| W A S D | Walk (hold Shift to run) |
| Space | Jump |
| Mouse drag / wheel | Orbit / zoom the camera |
| E | Interact: hire a worker, open its terminal, read a board, sit down, ride the elevator |
| P | Give a task to a new worker, or to the one at this desk |
| C | See a worker's changes: diff, commit, open a PR |
| N | Go to the next worker that's waiting on you |
| X | Send a worker home |
| L | Hang a sign over a desk ("Operations", "Code cleanup") |
| T / Enter | Chat |
| Enter, in a prompt box | A new line (Shift + Enter too); Ctrl/⌘ + Enter sends (on a phone, tap the send button) |
| V | Join voice; then hold V to talk |
| M | Mute / unmute in voice |
| Tab | The ☰ menu, and the floor list where there's room: every window, every project |
| Esc | Close any window |
| Ctrl + [ | Send Esc to a terminal, to close a menu like Claude's `/skills` or interrupt Claude (or **⎋ Esc** in its header) |
| Ctrl + C / Ctrl + V, in a terminal | Copy the selection / paste on Windows and Linux (⌘C / ⌘V on a Mac); Ctrl + C with nothing selected interrupts |

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

[docs/code-layout.md](docs/code-layout.md) says where the code lives, and where a new feature's pieces go.

Every change to the app that lands on `main` is published as a GitHub release of `devellaoy/3d-kanban` (asset `3d-kanban.tgz`) by [`.github/workflows/release.yml`](.github/workflows/release.yml), and `install.sh` and `install.ps1` install the newest one. Bump `package.json`'s version to start a new minor.

## More

- [Features](docs/features.md): everything in the office, room by room
- [Agents](docs/agents.md): Claude Code, Codex and OpenCode, models and effort, and the office's prompts
- [Configuration](docs/configuration.md): every command-line option, and where the office keeps its data
- [Maps](docs/maps.md): the castle, and making a map of your own
- [AWS reference](docs/aws.md): Tailscale, service tunnels, upgrades, and everything `deploy/aws.sh` does
- [Railway reference](docs/railway.md): what `deploy/railway.sh` sets up, and what the volume keeps
- [Fly.io reference](docs/fly.md): what `deploy/fly.sh` sets up, machine sizes, pausing and what the volume keeps
- [Dokploy reference](docs/dokploy.md): what `deploy/dokploy.sh` sets up on your Dokploy, and what the volume keeps
- [Your own server](docs/self-hosting.md): the one-line setup for any Ubuntu or Debian server, or by hand behind Caddy or nginx
- [Azure reference](docs/azure.md): picking a VM size, pausing, and everything `deploy/azure.sh` does
- [Performance and battery](docs/performance.md): how often the office is drawn, and what it costs
- [How it works](docs/how-it-works.md): the architecture, and security notes
- [Code layout](docs/code-layout.md): where the code lives, adding a feature or an agent provider, and the size guard

## License

[MIT](LICENSE)
