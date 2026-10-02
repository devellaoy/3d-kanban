import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MSG_CLASS, classOf, filterForVisitor, visitorMay, SERVER_MSG_OUT, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import { KANBAN_CLIENT_TYPE_LIST } from '../src/shared/kanban/protocol.js';
import type { ClientMsg, FloorInfo, PeerInfo, ServerMsg } from '../src/shared/protocol.js';
import type { KanbanProjectInfo, KanbanSettings } from '../src/shared/kanban/types.js';

const SECRET_ID = 'secretfloor1';
const SECRET_NAME = 'Hidden Repo';
const SECRET_DIR = '/home/owner/hidden-repo';
const scope: VisitorScope = { login: 'vera', floors: new Set(['sharedfloor']), projects: new Set(['sharedfloor']) };
const lookup = {
  floorOfWorker: (id: string) => ({ w1: 'sharedfloor', w2: SECRET_ID })[id],
  projectOfTask: (id: number) => ({ 1: 'sharedfloor', 2: SECRET_ID })[id],
};
const may = (msg: object) => visitorMay(msg as { t: string }, scope, lookup);

test('every classified type is a real client message type (no stale keys)', () => {
  // The kanban's list is a runtime table of its own; the rest are checked by `satisfies` at compile time.
  for (const t of Object.keys(KANBAN_CLIENT_TYPE_LIST)) assert.ok(Object.hasOwn(CLIENT_MSG_CLASS, t), `${t} is not classified`);
  for (const t of Object.keys(CLIENT_MSG_CLASS)) {
    if (t.startsWith('kanban.')) assert.ok(Object.hasOwn(KANBAN_CLIENT_TYPE_LIST, t), `${t} is not a kanban message`);
    assert.match(CLIENT_MSG_CLASS[t as keyof typeof CLIENT_MSG_CLASS], /^(allow|deny|scoped)$/);
  }
  const typed: Record<ClientMsg['t'], string> = CLIENT_MSG_CLASS;
  assert.ok(typed);
});

test('mutating messages are denied; unknown ones too', () => {
  for (const t of ['worker.spawn', 'queue.add', 'gh.comment', 'kanban.task.create', 'term.input', 'mp.connect', 'mp.online', 'carry', 'decor.add', 'jukebox.play', 'kanban.settings.set', 'tv.youtube.play', 'dog.name']) {
    assert.equal(classOf(t), 'deny', t);
    assert.equal(may({ t }), false, t);
  }
  assert.equal(classOf('nope'), 'deny');
  assert.equal(classOf('__proto__'), 'deny');
  assert.equal(classOf(undefined), 'deny');
});

test('play and presence are allowed', () => {
  for (const t of ['move', 'chat', 'rtc', 'wb.update', 'ball.throw', 'cabinet.frame', 'dog.pet', 'golf']) assert.equal(may({ t }), true, t);
});

test('scoped kanban reads need a project in scope', () => {
  assert.equal(may({ t: 'kanban.subscribe', project: null }), false);
  assert.equal(may({ t: 'kanban.subscribe' }), false);
  assert.equal(may({ t: 'kanban.subscribe', project: SECRET_ID }), false);
  assert.equal(may({ t: 'kanban.subscribe', project: 'sharedfloor' }), true);
  assert.equal(may({ t: 'kanban.snapshot', project: null }), false);
  assert.equal(may({ t: 'kanban.pr.bundle', project: 'sharedfloor' }), true);
  assert.equal(may({ t: 'kanban.task.get', id: 1 }), true);
  assert.equal(may({ t: 'kanban.task.get', id: 2 }), false);
  assert.equal(may({ t: 'kanban.task.get', id: 99 }), false);
  assert.equal(may({ t: 'kanban.task.get', id: '1' }), false);
  assert.equal(visitorMay({ t: 'kanban.task.get', id: 1 }, scope), false, 'no lookup, no yes');
  assert.equal(may({ t: 'kanban.comments.page', id: 2 }), false);
  assert.equal(may({ t: 'kanban.meta.get' }), true);
});

test('floor.go only to a floor in scope', () => {
  assert.equal(may({ t: 'floor.go', floor: 'sharedfloor' }), true);
  assert.equal(may({ t: 'floor.go', floor: SECRET_ID }), false);
  assert.equal(may({ t: 'floor.go', floor: '' }), false);
  assert.equal(may({ t: 'floor.go' }), false);
  assert.equal(may({ t: 'floor.go', floor: { toString: () => 'sharedfloor' } }), false);
});

test('terminals and diffs: only workers of a floor in scope', () => {
  assert.equal(may({ t: 'worker.attach', workerId: 'w1' }), true);
  assert.equal(may({ t: 'worker.attach', workerId: 'w2' }), false);
  assert.equal(may({ t: 'worker.attach', workerId: 'nobody' }), false);
  assert.equal(may({ t: 'changes.diff', workerId: 'w1', path: 'a.ts' }), true);
  assert.equal(may({ t: 'changes.diff', workerId: 'w1', path: 'a.ts', repo: `${SECRET_ID}~web` }), false);
  assert.equal(may({ t: 'changes.watch', workerId: 'w1', repo: 'sharedfloor~web' }), true);
  assert.equal(may({ t: 'term.input', workerId: 'w1', data: 'rm -rf' }), false);
});

// --- Outbound: nothing about the secret floor leaves ------------------------------------------------

const peer = (id: string, floor: string | undefined): PeerInfo => ({
  id, name: id, color: '#fff', look: { skin: 0, hair: 0, style: 0 }, x: 1, y: 0, z: 2, rotY: 0, moving: false, voice: false, muted: false, sharing: false,
  floor, doing: floor === SECRET_ID ? `in ${SECRET_NAME}'s terminal` : floor ? 'reading a PR' : undefined, carrying: floor === SECRET_ID ? { issue: 5, title: `Fix ${SECRET_NAME}` } : undefined,
});
const floorInfo = (id: string, name: string, dir: string): FloorInfo => ({ id, name, repo: `acme/${name}`, dir, palette: 0, addedBy: 'owner', addedAt: 0, workers: 1, busy: 0, waiting: 0, people: 1, wing: 0 });
const floors = [floorInfo('sharedfloor', 'shared-repo', '/home/owner/shared-repo'), floorInfo(SECRET_ID, SECRET_NAME, SECRET_DIR)];
const kprojects = floors.map(
  (f): KanbanProjectInfo => ({ id: f.id, name: f.name, repo: f.repo, dir: f.dir, repos: [{ id: f.id, name: f.name, kind: 'git', dir: f.dir, primary: true, instructions: 'be careful' }], open: true, settings: { maxConcurrent: 1, planApproval: 'auto', issueSources: 0, promptOverrides: 0, reviewRounds: 1 } }),
);
const ksettings = {
  schemaVersion: 1,
  defaults: { tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, implementPermission: 'bypass' },
  review: { tool: 'claude', rounds: 1, reReviewLastFix: false, sandbox: false },
  autoResume: { enabled: false, maxAttempts: 1, maxWaitHours: 1 },
  archiveAfterDays: 0,
  projects: Object.fromEntries(floors.map((f) => [f.id, { maxConcurrent: 1, issueSources: [{ kind: 'jira', name: `${SECRET_NAME} board` }], prompts: { x: `secret ${SECRET_NAME}` }, skills: {} }])),
} as unknown as KanbanSettings;
const secrets = { jira: { configured: true, site: 'acme.atlassian.net' }, apiKey: { configured: true } };

const view = (floor: string) => ({
  floor, project: { name: 'shared-repo', dir: '/home/owner/shared-repo', agentCmd: 'claude --dangerously', defaultProvider: 'claude', agentProviders: ['claude'] }, workers: [], issues: { items: [] }, pulls: { items: [] },
  queue: { tasks: [], maxWorkers: 1 }, decor: [], plan: { wing: 0, labels: {} }, services: { items: [{ port: 3000, host: 'localhost', pid: 1, command: 'vite', workerId: 'w1' }], port: 4600 },
  dog: null, jukebox: {}, cabinet: {}, whiteboard: {}, meeting: {}, ball: {}, cars: [], jail: { prisoners: [], bones: 0 }, youtube: null,
});

const fixtures: ServerMsg[] = [
  {
    t: 'welcome', you: 'p1', peers: [peer('p1', 'sharedfloor'), peer('p2', SECRET_ID)], floors, projectsDir: { dir: '/home/owner/projects', custom: false }, ice: [], chat: [], invites: true, version: '0.1.0',
    upgrade: { available: true, phase: 'idle' }, usage: { total: {}, today: {}, day: 'x', pauseHiring: false }, limits: { windows: [], at: 0 }, me: { admin: true }, notify: { webhook: { kind: 'slack', hint: 'hooks.slack.com/…', by: 'o', at: 0 } },
    machine: { cpu: 1, cores: 1, memUsed: 1, memTotal: 1, history: [], workers: 0 }, sky: {}, theme: {}, map: {}, prompts: { custom: { a: { text: SECRET_NAME, by: 'o', at: 0 } } }, leaveOnMerge: { on: false }, ...view('sharedfloor'),
  } as unknown as ServerMsg,
  { t: 'floors', floors },
  { t: 'peer.join', peer: peer('p2', SECRET_ID) },
  { t: 'peer.update', peer: peer('p2', SECRET_ID) },
  { t: 'toast', text: `🛗 owner took ${SECRET_NAME} off the building`, level: 'info' },
  { t: 'kanban.projects', projects: kprojects },
  { t: 'kanban.settings', settings: ksettings, secrets },
  { t: 'kanban.meta', projects: kprojects, settings: ksettings, secrets, me: { admin: true, name: 'owner' } },
  { t: 'kanban.snapshot', project: 'sharedfloor', tasks: [], projects: kprojects, settings: ksettings, secrets, me: { admin: true, name: 'owner' } },
  { t: 'kanban.snapshot', project: null, tasks: [], projects: kprojects, settings: ksettings, secrets, me: { admin: true, name: 'owner' } },
  { t: 'kanban.snapshot', project: SECRET_ID, tasks: [], projects: kprojects, settings: ksettings, secrets, me: { admin: true, name: 'owner' } },
  { t: 'floor.enter', peers: [peer('p2', SECRET_ID)], ...view(SECRET_ID) } as unknown as ServerMsg,
  { t: 'kanban.task.removed', id: 3, project: SECRET_ID },
  { t: 'kanban.comment', comment: { id: 1, taskId: 2 }, project: SECRET_ID } as unknown as ServerMsg,
  { t: 'floor.repos', repos: [{ name: `acme/${SECRET_NAME}`, private: true }] },
  { t: 'services', state: { items: [], port: 4600, ssh: 'office@203.0.113.7' } },
];

test('filterForVisitor never lets the secret floor out', () => {
  for (const msg of fixtures) {
    const out = filterForVisitor(msg, scope, { floorOfPeer: () => 'sharedfloor', projectOfTask: lookup.projectOfTask });
    if (!out) continue;
    const json = JSON.stringify(out);
    for (const secret of [SECRET_ID, SECRET_NAME, SECRET_DIR, '/home/owner', 'acme.atlassian', 'slack', 'be careful', '203.0.113.7', 'claude --dangerously', '"vite"']) {
      assert.ok(!json.includes(secret), `${msg.t} leaked ${secret}: ${json.slice(0, 300)}`);
    }
  }
});

test('welcome keeps the arrival floor and becomes a visitor', () => {
  const out = filterForVisitor(fixtures[0], scope) as Extract<ServerMsg, { t: 'welcome' }>;
  assert.deepEqual(out.floors.map((f) => f.id), ['sharedfloor']);
  assert.deepEqual(out.me, { admin: false, visitor: true });
  assert.equal(out.floor, 'sharedfloor');
  assert.equal(out.invites, false);
  assert.equal(out.peers.find((p) => p.id === 'p2')?.floor, undefined);
  assert.equal(out.peers.find((p) => p.id === 'p1')?.floor, 'sharedfloor');
  assert.equal(out.floors[0].dir, '');
});

test('what a visitor never gets', () => {
  const drop = (m: ServerMsg) => filterForVisitor(m, scope);
  assert.equal(drop(fixtures[4]), undefined, 'toast');
  assert.equal(drop(fixtures[6]), undefined, 'kanban.settings');
  assert.equal(drop(fixtures[9]), undefined, 'snapshot of all projects');
  assert.equal(drop(fixtures[10]), undefined, 'snapshot of a secret project');
  assert.equal(drop(fixtures[11]), undefined, 'floor.enter to a secret floor');
  assert.equal(drop({ t: 'peer.move', id: 'p2', x: 0, y: 0, z: 0, rotY: 0, moving: true }) !== undefined, true, 'no lookup: neighbours only, so it passes');
  assert.equal(filterForVisitor({ t: 'peer.move', id: 'p2', x: 0, y: 0, z: 0, rotY: 0, moving: true }, scope, { floorOfPeer: () => SECRET_ID }), undefined);
  assert.equal(drop({ t: 'me', me: { admin: true } }), undefined);
  assert.equal(filterForVisitor({ t: 'kanban.comments', taskId: 2, comments: [], more: false }, scope, { projectOfTask: lookup.projectOfTask }), undefined);
  assert.equal(drop({ t: 'nonsense' } as unknown as ServerMsg), undefined);
  const meta = filterForVisitor(fixtures[7], scope) as Extract<ServerMsg, { t: 'kanban.meta' }>;
  assert.deepEqual(meta.projects.map((p) => p.id), ['sharedfloor']);
  assert.equal(meta.me.admin, false);
  assert.ok(Object.values(SERVER_MSG_OUT).includes('drop'));
});

test('what people on hidden floors are up to stays hidden', () => {
  const floorOfPeer = (id: string) => (id === 'o1' ? 'secretfloor' : 'sharedfloor');
  const act = (id: string) => filterForVisitor({ t: 'peer.act', id, smoke: true } as ServerMsg, scope, { floorOfPeer });
  assert.equal(act('o1'), undefined, 'the acting one is on a floor out of scope');
  assert.ok(act('o2'), 'on a floor in scope');
  assert.equal(filterForVisitor({ t: 'peer.act', id: 'o2', golf: true } as ServerMsg, scope), undefined, 'no lookup, no frame');
  const peer = { id: 'o1', name: 'Owner', floor: 'secretfloor', x: 3, y: 0, z: 7, smoking: true, golfing: true } as unknown as PeerInfo;
  const out = filterForVisitor({ t: 'peer.update', peer } as ServerMsg, scope) as Extract<ServerMsg, { t: 'peer.update' }>;
  assert.deepEqual([out.peer.x, out.peer.z, out.peer.smoking, out.peer.golfing], [0, 0, undefined, undefined]);
});
