// `kanban3d relay`: runs the multiplayer relay (see server.ts) until it is stopped.
import { readFileSync } from 'node:fs';
import { startRelay } from './server.js';

const HELP = `kanban3d relay — the meeting point for multiplayer offices

Usage:
  kanban3d relay --password <pw> [options]

Offices connect to it over a WebSocket (wss://<host>/mp), prove the shared password and their
GitHub login, see each other in a directory and visit one another read-only. The relay never
sees repository or floor names or repo-scoped tokens, but it does carry the frames of a visit.

Options:
  -p, --port <n>              Port to listen on (default 4700)
  -H, --host <addr>           Address to bind (default 127.0.0.1; 0.0.0.0 for other computers)
      --password <pw>         The password offices connect with (env AGENT_OFFICE_RELAY_PASSWORD)
      --github-client-id <id> Client id of a GitHub OAuth App with the device flow on; offices use
                              it to sign in to GitHub with no scopes (env AGENT_OFFICE_RELAY_GITHUB_CLIENT_ID)
      --tls-cert <file>       Serve https/wss with this certificate (with --tls-key)
      --tls-key <file>        ...and this key
      --trust-proxy           Behind a reverse proxy you control: read the client address from
                              X-Forwarded-For (for the password rate limit)
  -h, --help                  Show this help
`;

export async function runRelay(argv: string[]): Promise<number> {
  let port = 4700;
  let host = '127.0.0.1';
  let password = process.env.AGENT_OFFICE_RELAY_PASSWORD ?? '';
  let githubClientId = process.env.AGENT_OFFICE_RELAY_GITHUB_CLIENT_ID || undefined;
  let tlsCert: string | undefined;
  let tlsKey: string | undefined;
  let trustProxy = false;
  const fail = (msg: string) => {
    console.error(`kanban3d relay: ${msg}`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      return 0;
    } else if (a === '-p' || a === '--port') {
      const v = value();
      port = Number(v);
      if (!/^\d+$/.test(v ?? '') || port > 65535) return fail('--port needs a number from 0 to 65535');
    } else if (a === '-H' || a === '--host') {
      host = value() ?? '';
      if (!host) return fail('--host needs an address');
    } else if (a === '--password') {
      password = value() ?? '';
    } else if (a === '--github-client-id') {
      githubClientId = value() || undefined;
    } else if (a === '--tls-cert') {
      tlsCert = value();
    } else if (a === '--tls-key') {
      tlsKey = value();
    } else if (a === '--trust-proxy') {
      trustProxy = true;
    } else return fail(`unknown option ${a} (see --help)`);
  }
  if (!password) return fail('a password is required: --password <pw> or AGENT_OFFICE_RELAY_PASSWORD');
  if (!!tlsCert !== !!tlsKey) return fail('--tls-cert and --tls-key go together');
  let tls: { cert: Buffer; key: Buffer } | undefined;
  try {
    if (tlsCert && tlsKey) tls = { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) };
  } catch (err) {
    return fail(`can't read the TLS files: ${(err as Error).message}`);
  }
  if (!githubClientId) console.warn('kanban3d relay: no --github-client-id, so offices cannot sign in to GitHub through this relay');
  try {
    const relay = await startRelay({ port, host, password, githubClientId, tls, trustProxy, log: (line) => console.log(line) });
    console.log(`kanban3d relay listening on ${tls ? 'wss' : 'ws'}://${host}:${relay.port}/mp`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return fail(e.code === 'EADDRINUSE' ? `port ${port} is already in use (try --port)` : e.message);
  }
  // Runs until killed: the listening server keeps the process alive.
  return await new Promise<number>(() => {});
}
