# Run it on a server for your team

Any Ubuntu or Debian server, with one line, or set up by hand behind Caddy or nginx. Back to the [README](../README.md).

Run this on any Ubuntu or Debian server, as root or as a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/deploy/provision.sh | bash
```

Or run it from your computer without logging in first: `ssh root@203.0.113.7 'curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/deploy/provision.sh | bash'`.

It takes a few minutes the first time:

1. Installs Node.js 22, git, the GitHub CLI and **Claude Code**. Run as root, it creates an `agentoffice` user and runs the office as that user, so workers never run as root.
2. Clones 3d-kanban (this fork, `https://github.com/devellaoy/3d-kanban`) into `/opt/agent-office` and runs it under systemd. `Restart=always` brings it back after a crash or a reboot, and `KillMode=process` keeps workers running through a restart. It listens on `127.0.0.1:4600` only. The office keeps its data in `~/agent-office` and clones projects into `~/workspace/<owner>/<repo>`.
3. Sets up **👥 Invite teammates**. Teammates' SSH keys log in as a separate `office` user that can only forward to the office port: no shell, no other ports.
4. Offers to sign the GitHub CLI in, if it's running in a terminal.
5. Prints how to get in:

```
  On your computer, open a tunnel and leave it running:

    ssh -N -L 4600:localhost:4600 root@203.0.113.7

  then open http://localhost:4600/claim?t=…
  It shows the office password once: write it down.
```

Everything goes through SSH, so there are no certificates to manage, and `localhost` counts as a secure origin, so voice and screen sharing work. Claude signs in from the office: the first worker asks you to type `/login` in its terminal. If GitHub isn't signed in yet, run `gh auth login` from a shell at any desk (**B**). Do both while you're in on the office password: those are the machine's own sign-ins. Teammates you give [accounts](../README.md#add-users) sign in to their own Claude and GitHub in **☰ → 🔐 Your sign-ins**, and their workers run on their own plan. To update, run the same line again, or use **⬆️ Upgrade the office** in the **☰** menu. Options go after `bash -s --`: `--project owner/repo` clones a first floor, and `--help` lists the rest.

**On your own domain.** Point a DNS record at the server, open ports 80 and 443, and add `--domain`:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/deploy/provision.sh | bash -s -- --domain office.example.com
```

It installs [Caddy](https://caddyserver.com), which gets a certificate from Let's Encrypt by itself and serves the office on https://office.example.com. The claim link is then `https://office.example.com/claim?t=…`. Give teammates an invite link each from **🔑 Accounts**.

**On your Tailscale network.** No domain, and no ports to open: add `--tailscale`, and the server joins your tailnet and serves the office on `https://agent-office.<your-tailnet>.ts.net` with [Tailscale Serve](https://tailscale.com/kb/1312/serve), which brings its own certificate:

```bash
curl -fsSL https://raw.githubusercontent.com/devellaoy/3d-kanban/main/deploy/provision.sh | bash -s -- --tailscale
```

It prints a link to add the machine to your tailnet (or pass `--tailscale-auth-key tskey-auth-…`), and the first time, one that turns on MagicDNS and HTTPS Certificates for the tailnet. It waits for each. `--tailscale-hostname` names the machine (`agent-office` by default). Then anyone on your tailnet opens the link, and workers' web servers get links of their own, `https://agent-office.<your-tailnet>.ts.net:<port>`, still behind the office sign-in. For someone outside your tailnet, share the machine with them from Tailscale's Machines page. Re-running the script keeps it on the tailnet. Turn off key expiry for the machine on that page, or it drops off after 180 days. The details, and what else the tailnet can reach on the machine, are in the [AWS reference](aws.md#tailscale), since `deploy/aws.sh up --tailscale` does the same thing.

**Setting it up by hand** (another distribution, or your own proxy): install it (see [Install](../README.md#install)) and run `kanban3d`, which listens on `127.0.0.1` only, and reach it through `ssh -L 4600:localhost:4600 you@server`. Or put it behind HTTPS on a domain, which voice and screen sharing need, with Caddy:

```caddy
# /etc/caddy/Caddyfile
office.example.com {
    reverse_proxy 127.0.0.1:4600
}
```

```bash
kanban3d setup --projects ~/workspace --project owner/repo   # once; or pick projects in the office
kanban3d --host 127.0.0.1 --trust-proxy --password "$(openssl rand -base64 18)"
```

Caddy proxies WebSockets out of the box. With nginx, forward the Host and Upgrade headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:4600;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1d;
}
```

To keep the office running, use a systemd unit:

```ini
# /etc/systemd/system/agent-office.service
[Unit]
Description=Agent Office
After=network.target

[Service]
User=dev
WorkingDirectory=/home/dev
# generate with: openssl rand -base64 24
Environment=AGENT_OFFICE_PASSWORD=<a long random password>
ExecStart=/usr/bin/env 3d-kanban --host 127.0.0.1 --trust-proxy
Restart=on-failure
# Restarting the office leaves the workers' terminals running for the next one to pick up.
KillMode=process

[Install]
WantedBy=multi-user.target
```

If you don't have a domain, `--self-signed` serves HTTPS directly. Browsers will warn once per person.

**Voice across strict NATs.** Peers connect directly using public STUN. If some teammates can't hear each other (common on corporate networks), run a TURN server such as coturn and pass `--turn turn:user:pass@turn.example.com:3478`.

## Run a multiplayer relay

Offices that want to visit each other connect to a relay: a small separate program, `kanban3d relay`, that you run on one server both can reach. It's not an office and doesn't need `gh`, Claude or a checkout; it keeps nothing on disk. Flags and the GitHub OAuth App it needs are in [Configuration](configuration.md#multiplayer-relay).

Behind Caddy, which proxies WebSockets and gets the certificate for you:

```
# /etc/caddy/Caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:4700
}
```

and a systemd unit:

```ini
# /etc/systemd/system/kanban3d-relay.service
[Unit]
Description=3d-kanban multiplayer relay
After=network.target

[Service]
User=dev
# generate with: openssl rand -base64 24
Environment=AGENT_OFFICE_RELAY_PASSWORD=<a long random password>
Environment=AGENT_OFFICE_RELAY_GITHUB_CLIENT_ID=<the OAuth App's client id>
ExecStart=/usr/bin/env kanban3d relay --host 127.0.0.1 --trust-proxy
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`--trust-proxy` is for exactly this setup: the relay limits password attempts per client address, and behind a proxy it needs `X-Forwarded-For` to tell clients apart. Don't use it when the relay is reachable directly. Without a proxy, give the relay `--tls-cert` and `--tls-key` (and `--host 0.0.0.0`) to serve `wss://` itself. Browsers only let an HTTPS office use an `https://` relay, so use TLS on any relay that isn't on localhost.

Each person then puts `https://relay.example.com` and the password into ⚙️ Settings → **🌐 Multiplayer** in their own office. Everyone who has the password can see who is online, and a visit only shows what its owner shared with that person's GitHub login. The relay carries the content of visits in progress, so run it yourself.

**Voice across offices.** A visitor's voice goes straight between browsers, using the ICE servers the owner's office hands out. If the owner started the office with `--turn` (see above), visitors get those TURN servers too, so a visit through strict NATs needs the owner's TURN server to be reachable by the visitor.
