# Configuration

Back to the [README](../README.md).

## Installing

3d-kanban is a product of its own: it installs as the `kanban3d` command, in its own folder, beside an upstream `agent-office` install if you have one.

**What you need** on the machine that runs it:

- **Node.js 22 or newer** (the kanban's database module, better-sqlite3, needs 22).
- **Python 3, make and a C++ compiler.** better-sqlite3 ships prebuilt binaries (macOS, Linux and Windows, x64 and arm64), but npm still runs its native build step on install, which fails without them, and compiles it when there is no binary for your platform. macOS: `xcode-select --install`; Debian/Ubuntu: `sudo apt install build-essential python3`; Windows: tick *Tools for Native Modules* in the Node.js installer (or install Visual Studio Build Tools with *Desktop development with C++*). The terminals' module (node-pty) comes prebuilt and needs nothing.
- **git**, and the **GitHub CLI** signed in (`gh auth login`), for projects, worktrees and the issue and PR boards. Repositories on **Azure DevOps** or **Bitbucket** need no CLI: a token in ☰ → 🔐 Your sign-ins ([hosting](hosting.md)).
- At least one agent CLI, signed in as the user that runs the office: **Claude Code** (`claude`), **Codex** (`codex`), **OpenCode** (`opencode`), **Grok** (`grok`), **Muse** (`muse`) or **DeepSeek Harness** (`dsh`). The kanban's tasks run on Claude Code or Codex (the office's other agents stay ordinary workers). With [accounts](accounts.md), everyone can sign in to their own Claude from the office instead.

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.ps1 | iex
```

The installer downloads the newest [release](https://github.com/devellaoy/3d-kanban/releases) (`3d-kanban.tgz`), installs it in `~/.local/share/3d-kanban` (Windows: `%LOCALAPPDATA%\3d-kanban`), puts a `kanban3d` command in `~/.local/bin` (Windows: `%LOCALAPPDATA%\3d-kanban\bin`, added to your PATH) and starts the office; next time just run `kanban3d`, in PowerShell, cmd and Git Bash alike. `AGENT_OFFICE_INSTALL_ONLY=1` installs without starting, `AGENT_OFFICE_VERSION=v0.1.4` picks a release; the other settings are at the top of [`install.sh`](../install.sh) and [`install.ps1`](../install.ps1).

The one-line installer needs a published release: the [Release workflow](../.github/workflows/release.yml) publishes one (`v0.1.<commits on main>`, with the asset `3d-kanban.tgz`) whenever a change to the app lands on `main` and its build, tests and test install pass, a few minutes after the push (see [Name and releases](fork.md#name-and-releases)). To run the newest `main` before its release, or if the workflow failed, install from source:

```bash
git clone https://github.com/devellaoy/3d-kanban.git && cd 3d-kanban && npm install && npm install -g .
kanban3d
```

(`npm install` also builds the client and the server; `npm install -g .` puts `kanban3d` on your PATH.)

**Updating.** Run the install line again: it installs the newest release, points `kanban3d` at it and removes the versions nothing runs any more. Your data isn't touched. From source: `git pull && npm install && npm install -g .`. On a server, run the provision line again, use **⬆️ Upgrade the office** in the **☰** menu, or the deploy script's `update` ([self-hosting](self-hosting.md)).

**Where things live.** The program is in the install folder above (`versions/<tag>`, and `current` names the one in use). Your data is where upstream keeps it: `~/agent-office` (see below), whose `.agent-office` folder holds the password, accounts, floors, chat and the kanban's `kanban.sqlite`, `kanban-settings.json` and uploads. The office still reads upstream's `AGENT_OFFICE_*` environment variables (`AGENT_OFFICE_HOME`, `AGENT_OFFICE_PASSWORD`, `AGENT_OFFICE_HOOK_PORT`, …), and the installers take theirs (`AGENT_OFFICE_INSTALL_DIR`, `AGENT_OFFICE_BIN_DIR`, …). An upstream `agent-office` on the same machine uses the same data folder and port by default: don't run both at once on them, or start one with `--home <another folder>` and `--port <another port>`.

**Coming from ai-kanban.** The migration runs from a clone of this repository (it isn't in the release) and writes into the office's data folder (`--home` picks another). See [the guide](migration.md).

## First start

The first time it starts, it walks you through setting up, right in the terminal:

1. **Where to clone your projects.** It suggests a code folder you already have (`~/Workspace`, `~/code`…), else `~/agent-office`. Each project goes in `<folder>/<owner>/<repo>`.
2. **GitHub.** If the GitHub CLI isn't signed in, it offers to run `gh auth login` for you.
3. **Your first project.** Pick one of your repos by number, or type `owner/name`, and the office clones it as the first floor. (To use a folder you already have instead, start with `kanban3d <folder>`, or add it from the elevator once the office is open.)

Press Enter to skip a step: you can add your first project later in the kanban (**⚙️ Settings → 📁 Projects → New project**, for admins: a local folder or a GitHub repository), or at the elevator in the 3D office, where an admin can type the path of a folder (starting with `/` or `~`) and press **📁 Add folder**. Then the kanban board opens in your browser, **already signed in**, with a link that works once. The 3D office is at `/`, and the board's **3D office** button takes you there. The terminal also prints the office password, for signing in from another browser (it's saved in `~/agent-office/.agent-office/config.json`).

In the 3D office, walk to an empty desk, press **E** and hire a worker. Its prompt can take files too: **📎 Attach**, paste or drop them on the dialog ([features](features.md)).

Common options:

```bash
kanban3d ~/code/my-project              # use a project you already have as the first floor
kanban3d --password 'correct horse'     # choose the password
kanban3d --port 4700
kanban3d --agent grok                   # default agent: claude, codex, opencode, grok, muse or dsh
kanban3d --no-open                      # print the sign-in link instead of opening a browser
kanban3d setup                          # the first-start walkthrough again (office stopped)
```

Only your computer can reach the office: it listens on `127.0.0.1`. `--host 0.0.0.0` lets your network in, but over plain http, where voice and screen sharing don't work. To share the office with a team, put it on a server: [AWS](aws.md), [Azure](azure.md), [Railway](railway.md), [Fly.io](fly.md), [Dokploy](dokploy.md) or [any Ubuntu or Debian machine](self-hosting.md). Every option is in [Command line](#command-line) below. Choosing models and providers per worker is in [agents](agents.md).

## Where the office keeps things

The office keeps its data in `~/agent-office` (`--home` or `AGENT_OFFICE_HOME` to move it) and clones projects next to it, as `~/agent-office/<owner>/<repo>`. To clone them somewhere else, like `~/Workspace`, an admin picks the **Workspace folder** in ⚙️ Settings → **Building** (or start with `--projects` or `AGENT_OFFICE_PROJECTS`). Floors you already have stay where they are, and a checkout of the same repository that's already in the new folder is used as it is. The building's map is in `~/agent-office/.agent-office/map.json`, and maps of your own go in `~/agent-office/.agent-office/maps/` (see [Maps](maps.md)). The list of floors is `~/agent-office/.agent-office/floors.json`, and each account's own Claude and GitHub sign-ins are in `~/agent-office/.agent-office/homes/<account>/` (revoking the account deletes them). Each floor keeps its workers, queue, pictures in its own checkout's `.agent-office/`, and its worktrees in `<checkout>.worktrees/` beside it.

Already have a checkout? Pick its repository anyway: a checkout of it that's already where the workspace folder would clone it is used as it is. You can still start the office in a project, `kanban3d ~/code/my-project`: that project becomes a floor, and the office keeps its data in `~/code/my-project/.agent-office` as it did before there were floors. An office that already ran in a project carries on in it when you start `agent-office` there again. An admin can take that project off the building in the elevator like any other floor.

*In 3d-kanban* the kanban keeps its data in the same data folder (`.agent-office` in the office's home, or in the project it was started in): `kanban.sqlite`, `kanban-settings.json` (how the plan and implement phases run, *auto mode* by default, see [the kanban's settings](kanban.md#settings); each project's `publicLanguage` and `commentLanguage` (the language of code comments; unset is English, `@project` follows the project's own conventions) among its settings; the office's conversation and public languages are in `prompts.json`, see [Languages](agents.md#languages)), `kanban-secrets.json`, `hosting-secrets.json` (the office's Azure DevOps and Bitbucket tokens; each account's own are in `homes/<account>/hosting.json`, see [Repositories on Azure DevOps and Bitbucket](hosting.md#tokens)) and a `kanban/` folder of uploads, reports and generated skill plugins, and `floors.json` also lists each project's extra repositories. See [The kanban](kanban.md#where-the-data-is). Its settings are in the office's ⚙️ Settings, under **🗂️ Kanban** and **📁 Projects** (**⚙️** on the kanban page opens the same window), and the migration from ai-kanban is `npm run migrate:ai-kanban` ([Migration](migration.md)).

## Command line

```
kanban3d [dir] [options]

      --home <dir>        Where the office keeps its data without a [dir] (default ~/agent-office)
      --projects <dir>    Where new floors are cloned, as <dir>/<owner>/<repo> (default ~/agent-office;
                          also settable from ⚙️ Settings)
  -p, --port <n>          Port (default 4600, env PORT)
  -H, --host <addr>       Bind address (default 127.0.0.1; 0.0.0.0 lets your network in)
      --password <pw>     Office password (env AGENT_OFFICE_PASSWORD)
      --no-open           Don't open the kanban in your browser when it starts
      --agent <cmd>       Default agent command (default "claude")
      --agent-args <str>  Extra args for the configured agent, e.g. "--model opus"
      --dsh-profile <n>   DeepSeek Harness profile over ACP (default "acp")
      --tls-cert <file>   Serve HTTPS with this cert…
      --tls-key <file>    …and key
      --self-signed       Serve HTTPS with a generated self-signed cert
      --trust-proxy       Trust X-Forwarded-* (behind Caddy/nginx)
      --turn <url>        Add a TURN server for voice, e.g. turn:user:pass@host:3478
      --budget <usd>      Daily tracked Claude Code budget (OpenCode/Codex/Grok/Muse/DSH excluded)
      --budget-pause      ...and nobody can hire a new worker until the next day
      --max-workers <n>   Run at most n workers at once, across every floor (env AGENT_OFFICE_MAX_WORKERS)
      --webhook <url>     Post to this Slack / Discord webhook when a worker needs input or finishes
      --city <name>       Put the office in a real city: its sun and live weather (open-meteo.com)
      --weather <kind>    Pin the weather: clear, cloudy, rain, storm, snow or fog (rain and storm show only with ⚙️ Rain / Lightning on)
      --real-time-sky     Start the sky on the real clock, not a day an hour (env AGENT_OFFICE_SKY_CLOCK=real; ⚙️ Settings can switch it)

kanban3d setup [--projects <dir>] [--project <owner/repo>]... [--home <dir>]

  The first-start walkthrough again: the workspace folder, GitHub sign-in and
  repositories to clone as floors. With --projects / --project it asks nothing.
  Run it while the office is stopped.

kanban3d prune [dir] [-n|--dry-run] [-f|--force]

  Removes leftover worker worktrees under <dir>.worktrees/ (and the older
  .agent-office/worktrees/) and their
  office/* branches, in one floor's checkout (dir). Anything with uncommitted changes or unpushed commits is
  kept unless --force is given. A worker across several projects has worktrees of them in its
  own floor's workspace: prune each project to clear those out.

kanban3d accounts [list | invite [name] [--admin] | revoke <name> | role <name> admin|member | password on|off] [-d <dir>]

  Invite, list and revoke people's own accounts, and switch the shared password
  off or on. Works while the office runs.
```

## Multiplayer relay

```
kanban3d relay --password <pw> [options]

  -p, --port <n>              Port (default 4700)
  -H, --host <addr>           Bind address (default 127.0.0.1; 0.0.0.0 lets other computers in)
      --password <pw>         The password offices connect with (env AGENT_OFFICE_RELAY_PASSWORD; required)
      --github-client-id <id> Client id of a GitHub OAuth App with the device flow on
                              (env AGENT_OFFICE_RELAY_GITHUB_CLIENT_ID)
      --tls-cert <file>       Serve wss with this certificate…
      --tls-key <file>        …and key (the two go together)
      --trust-proxy           Behind a reverse proxy you control: read the client address from
                              X-Forwarded-For (for the limit on password attempts)
```

The relay closes an office's connection with code 4403 when GitHub says the token is not valid (the office then asks you to sign in again, after checking the token with GitHub itself), and with 4504 when GitHub could not be asked (a timeout or a GitHub error; the office just tries again). Behind a reverse proxy (for example Apache) pass `--trust-proxy` and make sure the relay's port is reachable only through the proxy (otherwise anyone can set `X-Forwarded-For` and get past the attempts limit); without it every office appears to come from the proxy and they all share one limit on attempts.

The relay listens on `/mp` (`ws://host:4700/mp`, or `wss://` with TLS) and keeps nothing on disk. Offices type its address into ⚙️ Settings → **Multiplayer** (see [Features](features.md)); running it on a server is in [Self-hosting](self-hosting.md#run-a-multiplayer-relay).

**The GitHub OAuth App.** The relay uses it so offices can prove their GitHub login. In GitHub, go to Settings → Developer settings → OAuth Apps → **New OAuth App**, give it any name, any homepage and any callback URL (the device flow never uses it), tick **Enable Device Flow** and save. Only the **Client ID** is needed, passed as `--github-client-id`: no client secret, and offices ask GitHub for no permissions. Without a client id the relay starts but offices can't verify themselves through it.

**`multiplayer.json`** is in the office's data folder (`.agent-office`, see above). It holds whether to connect, the relay's address and password, the office's GitHub identity token and login (a token with no scopes: it only proves who you are, yet whoever holds it can say so on any relay with the same password, so **🗑 Forget GitHub account** in the settings pane deletes it, and GitHub → Settings → Applications → Authorized OAuth Apps → the relay's app → Revoke ends it for good), the ids of the shared floors and a random key for each (what the relay shows instead of the floor's name). It is written for its owner only (mode 600) and is never sent to a browser: the settings pane only learns that a password is saved.

## PWA

*In 3d-kanban* the office is an installable app (a PWA) that opens on the kanban, with shortcuts to the
3D office and the 2D view.

- **Install it** from the browser, on the office's own address: Chrome and Edge show an install button
  in the address bar (or ⋮ → **Install 3D Kanban**, on Android **Add to Home screen**); Safari on iOS is
  Share → **Add to Home Screen**; Safari on the Mac is File → **Add to Dock**. It opens as a window of
  its own on `/kanban` (on iOS the home-screen app keeps its own cookies, so you sign in there once).
- **HTTPS, except on localhost.** Browsers only run the app's service worker on `http://localhost` or
  over HTTPS. For the office on your network, use a real certificate (`--tls-cert`/`--tls-key`, Caddy or
  nginx in front with `--trust-proxy`, or Tailscale), or `--self-signed`; a self-signed certificate works
  for the app only once the device trusts it (installed in its certificate store), since browsers refuse
  a service worker on a certificate warning. Without it the office works as before, just not installable
  or offline.
- **Offline.** The pages are always fetched fresh (they're for the signed-in only, and never cached).
  When the office can't be reached, whether the network or the office is down or it's restarting behind a
  proxy, a page says *The office is offline. Reconnecting…* and reloads by itself when it's back. The
  socket, `/api/*` and the sign-in pages are never touched by the service worker; only the build's hashed
  files under `/assets/` are cached, one cache per build.
- **Updates.** After the office is upgraded, an open window shows **⬆️ Update available** with
  **Reload**: that switches to the new version and reloads. ✕ puts it off until the next time the page
  opens. It also checks for a new version every hour.

- **Colour.** The title bar's colour follows the theme chosen in ⚙️ Settings (the page keeps it in its `theme-color` tag). The manifest's own colours (the splash screen) are Midnight's, the look a browser gets before it has chosen one, since an install can't change them.

The manifest (`/manifest.webmanifest`), the service worker (`/sw.js`), the icons (`/icons/`) and the
offline page are served without a session. The icons are made from `src/client/public/favicon.svg` by
`node scripts/pwa-icons.mjs` (with playwright-core's Chromium or an installed Chrome) and checked in.
