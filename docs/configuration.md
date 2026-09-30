# Configuration

Back to the [README](../README.md).

## Where the office keeps things

The office keeps its data in `~/agent-office` (`--home` or `AGENT_OFFICE_HOME` to move it) and clones projects next to it, as `~/agent-office/<owner>/<repo>`. To clone them somewhere else, like `~/Workspace`, an admin picks the **Workspace folder** in ⚙️ Settings → **🏢 Building** (or start with `--projects` or `AGENT_OFFICE_PROJECTS`). Floors you already have stay where they are, and a checkout of the same repository that's already in the new folder is used as it is. The building's map is in `~/agent-office/.agent-office/map.json`, and maps of your own go in `~/agent-office/.agent-office/maps/` (see [Maps](maps.md)). The list of floors is `~/agent-office/.agent-office/floors.json`, and each account's own Claude and GitHub sign-ins are in `~/agent-office/.agent-office/homes/<account>/` (revoking the account deletes them). Each floor keeps its workers, queue, pictures and worktrees in its own checkout's `.agent-office/`.

Already have a checkout? Pick its repository anyway: a checkout of it that's already where the workspace folder would clone it is used as it is. You can still start the office in a project, `kanban3d ~/code/my-project`: that project becomes a floor, and the office keeps its data in `~/code/my-project/.agent-office` as it did before there were floors. An office that already ran in a project carries on in it when you start `agent-office` there again. An admin can take that project off the building in the elevator like any other floor.

*In 3d-kanban* the kanban keeps its data in the same data folder (`.agent-office` in the office's home, or in the project it was started in): `kanban.sqlite`, `kanban-settings.json`, `kanban-secrets.json` and a `kanban/` folder of uploads, reports and generated skill plugins, and `floors.json` also lists each project's extra repositories. See [The kanban](kanban.md#where-the-data-is). Its settings are on the kanban page (**⚙️** there), not in the office's ⚙️ Settings, and the migration from ai-kanban is `npm run migrate:ai-kanban` ([Migration](migration.md)).

## Command line

```
kanban3d [dir] [options]

      --home <dir>        Where the office keeps its data without a [dir] (default ~/agent-office)
      --projects <dir>    Where new floors are cloned, as <dir>/<owner>/<repo> (default ~/agent-office;
                          also settable from ⚙️ Settings)
  -p, --port <n>          Port (default 4600, env PORT)
  -H, --host <addr>       Bind address (default 127.0.0.1; 0.0.0.0 lets your network in)
      --password <pw>     Office password (env AGENT_OFFICE_PASSWORD)
      --no-open           Don't open the office in your browser when it starts
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
      --weather <kind>    Pin the weather: clear, cloudy, rain, storm, snow or fog

kanban3d setup [--projects <dir>] [--project <owner/repo>]... [--home <dir>]

  The first-start walkthrough again: the workspace folder, GitHub sign-in and
  repositories to clone as floors. With --projects / --project it asks nothing.
  Run it while the office is stopped.

kanban3d prune [dir] [-n|--dry-run] [-f|--force]

  Removes leftover worker worktrees under .agent-office/worktrees/ and their
  office/* branches, in one floor's checkout (dir). Anything with uncommitted changes or unpushed commits is
  kept unless --force is given. A worker across several projects has worktrees of them in its
  own floor's workspace: prune each project to clear those out.

kanban3d accounts [list | invite [name] [--admin] | revoke <name> | role <name> admin|member | password on|off] [-d <dir>]

  Invite, list and revoke people's own accounts, and switch the shared password
  off or on. Works while the office runs.
```

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

The manifest (`/manifest.webmanifest`), the service worker (`/sw.js`), the icons (`/icons/`) and the
offline page are served without a session. The icons are made from `src/client/public/favicon.svg` by
`node scripts/pwa-icons.mjs` (with playwright-core's Chromium or an installed Chrome) and checked in.
