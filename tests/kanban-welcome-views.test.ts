// What someone arriving on a project's floor is sent, through the real office: the PR board covers the
// project's other repositories, and the issues board shows the cards from the project's issue sources.
// Both come from upstream's `views` registry (pullsView / issuesView in ws/handlers/github.ts), the seam
// that would quietly fall back to the floor's own repository if it were lost (docs/fork.md).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { GitHub } from '../src/server/github.js';
import { setWallProvider } from '../src/server/kanban/integrations/issues/wall.js';
import type { GhIssue, GhPull, GhState, ServerMsg } from '../src/shared/protocol.js';

type Office = Awaited<ReturnType<typeof startServer>>;
type Welcome = Extract<ServerMsg, { t: 'welcome' }>;

let tmp = '';
let office: Office;
let base = '';
const PASSWORD = 'welcome-views-test';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const pull = (number: number, repo?: string): GhPull => ({
  number,
  title: `PR ${number}`,
  state: 'OPEN',
  url: `https://github.com/${repo ?? 'o/app'}/pull/${number}`,
  author: 'ada',
  isDraft: false,
  headRefName: `branch-${number}`,
  baseRefName: 'main',
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  checks: 'none',
  labels: [],
  assignees: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  body: '',
  closes: [],
  ...(repo ? { repo } : {}),
}) as GhPull;

const card: GhIssue = {
  number: 0,
  title: 'Fix the login page',
  state: 'OPEN',
  url: 'https://example.atlassian.net/browse/UYT-1415',
  author: '',
  labels: [],
  assignees: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  body: '',
  comments: 0,
  key: 'UYT-1415',
  source: 'jira',
  status: 'To Do',
};

/** The first welcome a browser signed in with `cookie` gets. */
function welcome(cookie: string): Promise<Welcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?name=Ada`, { headers: { cookie, origin: base } });
    const timer = setTimeout(() => reject(new Error('no welcome within 5s')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t !== 'welcome') return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.once('error', reject);
  });
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kanban-welcome-views-'));
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const publicDir = path.join(tmp, 'public');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, project, publicDir, path.join(publicDir, 'assets'), bin, path.join(tmp, 'projects')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(project, 'README.md'), '# welcome views\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: project });
  }
  for (const page of ['index', 'login', 'claim', 'join', 'lite']) writeFileSync(path.join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  const claude = path.join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o755);

  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_OFFICE_')) delete process.env[k];
  const port = await freePort();
  const cfg = loadConfig([project, '--home', home, '--projects', path.join(tmp, 'projects'), '--port', String(port), '--password', PASSWORD, '--no-open', '--weather', 'clear', '--agent', claude]);
  office = await startServer(cfg, { publicDir });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  setWallProvider(undefined);
  office?.shutdown();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("a project's floor welcomes you with its other repositories' PRs and its issue sources' cards", async () => {
  const floor = office.floors()[0];
  // The floor's own repository has one PR; another repository of the project has one too. Its board is
  // what refreshBoards() makes for a git repository with a remote, here filled in instead of fetched.
  floor.github.pulls = { items: [pull(3)], fetchedAt: 1, loading: false };
  const other = new GitHub(tmp, () => {}, () => {}, 'o/api', true);
  other.pulls = { items: [pull(7, 'o/api')], fetchedAt: 2, loading: false };
  (floor as unknown as { boards: Map<string, unknown> }).boards.set('api', { board: other, dir: tmp, remote: 'o/api' });
  // The project's issue sources, as the issues plugin hands them to the board.
  const sources: GhState<GhIssue> = { items: [card], fetchedAt: 3, loading: false };
  setWallProvider({ board: (id) => (id === floor.id ? sources : undefined), watch() {}, refresh() {}, forget() {}, sourcesChanged() {} });

  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const w = await welcome(cookie);
  assert.equal(w.floor, floor.id);
  assert.deepEqual(
    w.pulls.items.map((p) => [p.number, p.repo]),
    [
      [3, undefined],
      [7, 'o/api'],
    ],
    "the PR board has the other repository's PR beside the floor's own",
  );
  assert.equal(w.pulls.fetchedAt, 2);
  assert.deepEqual(
    w.issues.items.map((i) => [i.key, i.source, i.status]),
    [['UYT-1415', 'jira', 'To Do']],
    "the issues board is the issue sources' cards, not the floor's own repository's issues",
  );
});
