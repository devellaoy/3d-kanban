import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MeetingRooms } from '../src/server/meeting-rooms.js';
import type { MeetingWorkers } from '../src/server/meetings.js';
import { MEETING_ROOMS, type MeetingRoomDef } from '../src/shared/layout.js';
import { Worktrees } from '../src/server/worktrees.js';
import type { AgentChoice, MeetingRequest, WorkerInfo } from '../src/shared/protocol.js';
import { MEETING_PATTERN_IDS, isMeetingPattern } from '../src/shared/meetings.js';
import { PROMPTS, type PromptId } from '../src/shared/prompts.js';

function fixture(opts: { rooms?: MeetingRoomDef[]; git?: boolean; rewritten?: Partial<Record<PromptId, string>>; officeDefault?: AgentChoice } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-meeting-'));
  const dataDir = path.join(dir, '.agent-office');
  mkdirSync(dataDir, { recursive: true });
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.agent-office/\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
  }
  const workers: WorkerInfo[] = [];
  const prompts: { id: string; text: string }[] = [];
  const typed: { id: string; data: string }[] = [];
  const toasts: string[] = [];
  const reviews: { pr: number; file: string }[] = [];
  let ids = 0;
  const manager: MeetingWorkers = {
    defaultProvider: 'claude',
    officeDefault: opts.officeDefault,
    list: () => workers,
    seat(deskId, by, prompt, provider, model, effort, meeting) {
      if (workers.some((w) => w.deskId === deskId)) return 'taken';
      const worker: WorkerInfo = {
        id: `w${++ids}`, deskId, kind: 'agent', provider, model, effort, prompt, name: `Worker ${workers.length + 1}`,
        color: '#fff', status: 'starting', acked: true, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [],
        worktree: meeting.worktree, meeting: meeting.id,
      };
      workers.push(worker);
      prompts.push({ id: worker.id, text: prompt });
      return worker;
    },
    prompt(id, text) {
      prompts.push({ id, text });
      return undefined;
    },
    write(id, data) {
      typed.push({ id, data });
    },
    async kill(id) {
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      room.onWorkerGone(id);
      return {};
    },
  };
  const rooms = opts.rooms ?? [MEETING_ROOMS[0]];
  const room: MeetingRooms = new MeetingRooms(dir, dataDir, manager, opts.git ? new Worktrees(dir) : undefined, {
    update() {},
    toast: (text) => toasts.push(text),
    hiringPaused: () => undefined,
    postReview: async (pr, file) => {
      reviews.push({ pr, file });
      return `https://github.com/o/r/pull/${pr}#pullrequestreview-1`;
    },
    prompt: (id) => opts.rewritten?.[id] ?? PROMPTS[id].text,
  }, () => rooms);
  /** What's on in room number `i`. */
  const cur = (i = 0) => room.state().rooms[i].current;
  const cwd = (i = 0) => {
    const wt = cur(i)?.worktree;
    return wt ? path.join(dir, wt.path) : dir;
  };
  /** The worker at seat `i` takes its part: it starts, writes its file (unless `skip`), and ends its turn. */
  const take = (i: number, text = 'Some notes.', skip = false, at = 0) => {
    const m = cur(at)!;
    const t = m.turns.find((x) => x.seat === i);
    assert.ok(t, `seat ${i} has a part in round ${m.round}`);
    const w = workers.find((x) => x.id === m.seats[i].workerId)!;
    w.status = 'working';
    room.onWorker(w);
    if (!skip) {
      const file = path.join(cwd(at), t.file);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    w.status = 'done';
    room.onWorker(w);
  };
  /** Workers who had no part yet say they're ready and end the turn. */
  const settle = () => {
    for (const w of workers) {
      if (w.status !== 'starting') continue;
      w.status = 'done';
      room.onWorker(w);
    }
  };
  const start = (req: Partial<MeetingRequest>) => room.start({ pattern: 'debate', prompt: 'Which cache should we use?', roles: [], ...req } as MeetingRequest, 'Ada');
  return { dir, dataDir, manager, room, cur, rooms, workers, prompts, typed, toasts, reviews, take, settle, start, cwd, kill: (id: string) => manager.kill(id), close() { room.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a debate runs its rounds and ends when the chair writes the decision', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ rounds: 3, output: 'docs/decision.md' }), undefined);
  let m = f.cur()!;
  assert.equal(m.seats.length, 3);
  assert.deepEqual(m.seats.map((s) => s.role), ['Chair', 'Pragmatist', 'Skeptic']);
  assert.equal(f.workers.length, 3);
  assert.match(f.prompts[0].text, /Round 1 of 3, proposing/);
  assert.match(f.prompts[0].text, /Which cache should we use\?/);
  for (const i of [0, 1, 2]) f.take(i);
  m = f.cur()!;
  assert.equal(m.round, 2);
  assert.equal(m.turns.length, 3);
  assert.ok(m.turns.every((x) => x.state === 'sent'));
  assert.match(f.prompts.at(-1)!.text, /Round 2 of 3, critiquing/);
  for (const i of [0, 1, 2]) f.take(i);
  m = f.cur()!;
  assert.equal(m.round, 3);
  assert.deepEqual(m.turns.map((x) => [x.seat, x.file]), [[0, 'docs/decision.md']]);
  assert.match(f.prompts.at(-1)!.text, /writing the decision/);
  f.take(0, '# We use Redis');
  m = f.cur()!;
  assert.equal(m.status, 'done');
  assert.equal(readFileSync(path.join(f.dir, 'docs/decision.md'), 'utf8'), '# We use Redis');
  assert.equal(m.preview, '# We use Redis');
  // The notes are kept by the floor's other state.
  assert.ok(existsSync(path.join(f.dir, '.agent-office', 'meetings', m.id)));
});

test('the meeting stops once it runs over its token budget, and says so', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ budget: 100_000 }), undefined);
  const w = f.workers[0];
  w.status = 'working';
  w.usage = { input: 90_000, output: 20_000, cacheRead: 0, cacheWrite: 0, cost: 0.5, calls: 3 };
  f.room.onWorker(w);
  const m = f.cur()!;
  assert.equal(m.status, 'stopped');
  assert.match(m.reason!, /over budget: 110k of 100k tokens/);
  // Whoever was busy is told to stop.
  assert.deepEqual(f.typed, [{ id: w.id, data: '\x1b' }]);
});

test('a worker that ends its part without writing the file is reminded once, then the meeting stops', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ rounds: 2, output: 'decision.md' }), undefined);
  for (const i of [0, 1, 2]) f.take(i);
  f.take(0, '', true);
  assert.match(f.prompts.at(-1)!.text, /without writing \S*\/decision\.md,/);
  assert.equal(f.cur()!.status, 'running');
  f.take(0, '', true);
  const m = f.cur()!;
  assert.equal(m.status, 'stopped');
  assert.match(m.reason!, /round limit without writing decision\.md/);
});

test('sending a worker home stops the meeting and names who left', async (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({}), undefined);
  await f.kill(f.cur()!.seats[2].workerId!);
  const m = f.cur()!;
  assert.equal(m.status, 'stopped');
  assert.match(m.reason!, /the Skeptic \(Worker 3\) was sent home/);
});

test('red / blue ends early when red finds nothing more', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ pattern: 'redblue', prompt: 'The login change', rounds: 3 }), undefined);
  f.settle();
  let m = f.cur()!;
  assert.deepEqual(m.seats.map((s) => s.role), ['Blue team', 'Red team']);
  f.take(1, '- src/login.ts:12 — token compared with ==');
  m = f.cur()!;
  assert.equal(m.step, 2);
  assert.match(f.prompts.at(-1)!.text, /Round 1 of 3, fixing\./);
  f.take(0, 'Fixed it with a constant-time compare.');
  m = f.cur()!;
  assert.equal(m.round, 2);
  f.take(1, 'NO FINDINGS');
  m = f.cur()!;
  assert.equal(m.lastRound, 2);
  assert.equal(m.turns[0].file, m.output);
  f.take(0, '# Red / blue\n\nOne finding, fixed.');
  assert.equal(f.cur()!.status, 'done');
});

test('a review panel posts the combined review on the pull request', async (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.match(f.start({ pattern: 'review', prompt: 'Review it' }) ?? '', /needs a pull request/);
  assert.equal(f.start({ pattern: 'review', prompt: 'Review it', pr: 42 }), undefined);
  let m = f.cur()!;
  assert.equal(m.output, 'reviews/pr-42.md');
  assert.equal(m.title, 'Review of PR #42');
  assert.match(f.prompts[1].text, /through your lens, Security/);
  for (const i of [0, 1, 2]) f.take(i, '- a.ts:1 — something');
  assert.match(f.prompts.at(-1)!.text, /\*\*\[Security\]\*\*/);
  f.take(0, 'Looks fine. **[Security]** a.ts:1 — something');
  await new Promise((r) => setImmediate(r));
  m = f.cur()!;
  assert.equal(m.status, 'done');
  assert.deepEqual(f.reviews, [{ pr: 42, file: path.join(f.dir, 'reviews/pr-42.md') }]);
  assert.equal(m.review?.url, 'https://github.com/o/r/pull/42#pullrequestreview-1');
});

test('map-reduce hands each mapper its own parts', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.match(f.start({ pattern: 'mapreduce', parts: ['src/a.ts'] }) ?? '', /at least 2 parts/);
  assert.equal(f.start({ pattern: 'mapreduce', parts: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }), undefined);
  const mapper1 = f.prompts.find((p) => p.id === f.workers[1].id)!.text;
  const mapper2 = f.prompts.find((p) => p.id === f.workers[2].id)!.text;
  assert.match(mapper1, /- src\/a\.ts\n- src\/c\.ts/);
  assert.match(mapper2, /- src\/b\.ts\n/);
  assert.match(f.prompts[0].text, /Round 1 has no part for you/);
});

test('bad requests are turned away before anyone sits down', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.match(f.start({ prompt: '  ' }) ?? '', /what the meeting is about/);
  assert.match(f.start({ output: '../x.md' }) ?? '', /\.\./);
  assert.match(f.start({ output: '/etc/x' }) ?? '', /relative/);
  assert.match(f.start({ output: '.agent-office/x.md' }) ?? '', /\.agent-office/);
  assert.match(f.start({ roles: ['a', 'b', 'c', 'd', 'e', 'f'] }) ?? '', /2 to 5 workers/);
  assert.match(f.start({ pattern: 'redblue', roles: ['a', 'b', 'c'] }) ?? '', /seats 2 workers/);
  assert.equal(f.workers.length, 0);
  assert.equal(f.start({}), undefined);
  assert.match(f.start({}) ?? '', /busy/);
});

test('in a git project the output is committed on the meeting branch, which outlives the room being cleared', async (t) => {
  const f = fixture({ git: true }); t.after(() => f.close());
  assert.equal(f.start({ rounds: 2, output: 'docs/decision.md', title: 'Pick a cache' }), undefined);
  const m0 = f.cur()!;
  assert.match(m0.worktree!.branch, /^office\/meeting-pick-a-cache-/);
  assert.ok(f.workers.every((w) => w.worktree?.path === m0.worktree!.path));
  // Every file a part names is a full path inside the meeting's worktree, never the project folder around it.
  assert.ok(f.prompts[0].text.includes(`Write it to ${path.join(f.cwd(), '.meeting', 'r1-1-chair.md')},`));
  for (const i of [0, 1, 2]) f.take(i);
  f.take(0, '# Redis\n');
  for (let i = 0; i < 50 && !f.cur()!.commit; i++) await new Promise((r) => setTimeout(r, 20));
  const m = f.cur()!;
  assert.equal(m.status, 'done');
  assert.ok(m.commit);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8' }).trim();
  assert.equal(git('show', `${m.worktree!.branch}:docs/decision.md`), '# Redis');
  // Notes stay out of the commit.
  assert.equal(git('show', '--name-only', '--format=', m.worktree!.branch), 'docs/decision.md');
  assert.equal(f.room.clear('Ada'), undefined);
  for (let i = 0; i < 50 && existsSync(path.join(f.dir, m.worktree!.path)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.workers.length, 0);
  assert.ok(!existsSync(path.join(f.dir, m.worktree!.path)));
  assert.equal(git('rev-parse', '--abbrev-ref', m.worktree!.branch), m.worktree!.branch);
  assert.equal(f.cur(), null);
  assert.match(f.room.state().past[0].summary, /Debate · 2 rounds · 0 tokens · \$0\.00 · ✅ docs\/decision\.md on office\/meeting-pick-a-cache-/);
});

test('only the real meeting patterns pass, not what every object inherits', () => {
  for (const id of MEETING_PATTERN_IDS) assert.equal(isMeetingPattern(id), true);
  for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'nope', 1, null, undefined]) assert.equal(isMeetingPattern(v), false, String(v));
});

test('a meeting says what the office’s rewritten prompts say, and seats the default worker when nobody picked one', (t) => {
  const f = fixture({
    rewritten: {
      'meeting.brief': 'You are the {{role}}. Topic: {{about}}{{nothing}}',
      'meeting.debate.propose': 'Pitch it as the {{role}}, into {{file}}.',
      'meeting.nudge': 'Still waiting on {{file}}!',
    },
    officeDefault: { provider: 'claude', model: 'sonnet', effort: 'medium' },
  });
  t.after(() => f.close());
  assert.equal(f.start({ rounds: 3, provider: undefined }), undefined);
  assert.equal(f.prompts[0].text, `You are the Chair. Topic: Which cache should we use?{{nothing}}\n\nRound 1 of 3, proposing. Pitch it as the Chair, into ${path.join(f.cwd(), '.agent-office', 'meetings', f.cur()!.id, 'r1-1-chair.md')}.`);
  assert.deepEqual(f.workers.map((w) => [w.provider, w.model, w.effort]), Array(3).fill(['claude', 'sonnet', 'medium']));
  // A worker that ends its turn without its part is nudged in the office's words.
  const w = f.workers[0];
  w.status = 'working';
  f.room.onWorker(w);
  w.status = 'done';
  f.room.onWorker(w);
  assert.match(f.prompts.at(-1)!.text, /^Still waiting on \S+r1-1-chair\.md!$/);
  // Picked, the meeting's own choice wins.
  const g = fixture({ officeDefault: { provider: 'claude', model: 'sonnet' } });
  t.after(() => g.close());
  assert.equal(g.start({ provider: 'claude', model: 'haiku' }), undefined);
  assert.deepEqual(g.workers.map((x) => x.model), ['haiku', 'haiku', 'haiku']);
});

// --- Several rooms ----------------------------------------------------------

test('a second meeting goes to the second room while the first runs, and the two progress on their own', (t) => {
  const f = fixture({ rooms: MEETING_ROOMS }); t.after(() => f.close());
  assert.equal(f.start({ title: 'First', rounds: 2, output: 'a.md' }), undefined);
  assert.equal(f.start({ title: 'Second', rounds: 2, output: 'b.md' }), undefined);
  const [a, b] = [f.cur(0)!, f.cur(1)!];
  assert.deepEqual([a.room, b.room], ['meeting', 'review']);
  assert.deepEqual(a.seats.map((s) => s.deskId), MEETING_ROOMS[0].seats.slice(0, 3).map((d) => d.id));
  assert.deepEqual(b.seats.map((s) => s.deskId), MEETING_ROOMS[1].seats.slice(0, 3).map((d) => d.id));
  assert.equal(f.workers.length, 6);
  // The second one's round 1 is done, the first one's isn't.
  for (const i of [0, 1, 2]) f.take(i, 'Notes.', false, 1);
  assert.equal(f.cur(1)!.round, 2);
  assert.equal(f.cur(0)!.round, 1);
  for (const i of [0, 1, 2]) f.take(i, 'Notes.', false, 0);
  assert.equal(f.cur(0)!.round, 2);
  f.take(0, 'Decision A', false, 0);
  assert.equal(f.cur(0)!.status, 'done');
  assert.equal(f.cur(1)!.status, 'running');
  f.take(0, 'Decision B', false, 1);
  assert.equal(f.cur(1)!.status, 'done');
  assert.equal(readFileSync(path.join(f.dir, 'a.md'), 'utf8'), 'Decision A');
  assert.equal(readFileSync(path.join(f.dir, 'b.md'), 'utf8'), 'Decision B');
  // The same state, in room order, with a past that fills as rooms are cleared.
  assert.deepEqual(f.room.state().rooms.map((r) => r.id), ['meeting', 'review']);
});

test('every room busy is a clear error naming the meetings; an explicit room is asked for by id', (t) => {
  const f = fixture({ rooms: MEETING_ROOMS }); t.after(() => f.close());
  assert.equal(f.start({ title: 'One' }), undefined);
  assert.equal(f.start({ title: 'Two' }), undefined);
  const err = f.start({ title: 'Three' }) ?? '';
  assert.match(err, /^Every meeting room is busy: /);
  assert.match(err, /“One”/);
  assert.match(err, /“Two”/);
  assert.match(err, /stop one of those meetings first/);
  assert.equal(f.workers.length, 6);
  assert.match(f.start({ room: 'review' }) ?? '', /busy with “Two”/);
  assert.match(f.start({ room: 'nope' }) ?? '', /no meeting room/);
});

test('stopping and clearing act on the room named, and a meeting in an empty room is preferred to clearing one', async (t) => {
  const f = fixture({ rooms: MEETING_ROOMS }); t.after(() => f.close());
  assert.equal(f.start({ title: 'One' }), undefined);
  assert.equal(f.start({ title: 'Two' }), undefined);
  assert.match(f.room.stop('Ada') ?? '', /Several/);
  assert.equal(f.room.stop('Ada', 'review'), undefined);
  assert.equal(f.cur(0)!.status, 'running');
  assert.equal(f.cur(1)!.status, 'stopped');
  assert.match(f.room.clear('Ada', 'meeting') ?? '', /still on/);
  assert.equal(f.room.clear('Ada', 'review'), undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.cur(1), null);
  assert.equal(f.workers.length, 3);
  assert.equal(f.room.state().past[0].room, 'review');
  // Stop the first too: now one room is empty and one holds a finished meeting; the empty one is used.
  assert.equal(f.room.stop('Ada'), undefined);
  assert.equal(f.start({ title: 'Three' }), undefined);
  assert.equal(f.cur(1)!.title, 'Three');
  assert.equal(f.cur(0)!.title, 'One');
  // Now both rooms are taken again, one running and one stopped: the finished one is cleared for the next.
  assert.equal(f.room.stop('Ada', 'review'), undefined);
  assert.equal(f.start({ title: 'Four' }), undefined);
  assert.equal(f.cur(0)!.title, 'Four');
});

test('a meeting saved by the one-room office loads into the first room', (t) => {
  const f = fixture({ rooms: MEETING_ROOMS }); t.after(() => f.close());
  assert.equal(f.start({ title: 'Old' }), undefined);
  const { room: _, ...old } = f.cur(0)!;
  f.room.shutdown();
  writeFileSync(path.join(f.dataDir, 'meetings.json'), JSON.stringify({ current: old, past: [{ id: 'x1', pattern: 'debate', title: 'Earlier', status: 'done', summary: 'it was', calledBy: 'Ada', finishedAt: 1, output: 'o.md' }] }));
  const again = new MeetingRooms(f.dir, f.dataDir, f.manager, undefined, { update() {}, toast() {}, hiringPaused: () => undefined, postReview: async () => '' }, () => f.rooms);
  t.after(() => again.shutdown());
  const s = again.state();
  assert.deepEqual(s.rooms.map((r) => [r.id, r.current?.title ?? null]), [['meeting', 'Old'], ['review', null]]);
  assert.equal(s.rooms[0].current!.room, 'meeting');
  assert.equal(s.past[0].title, 'Earlier');
  // And it's saved in the new shape.
  again.shutdown();
  const saved = JSON.parse(readFileSync(path.join(f.dataDir, 'meetings.json'), 'utf8'));
  assert.equal(saved.current, undefined);
  assert.equal(saved.rooms.meeting.title, 'Old');
});

test('a one-room map keeps one room', (t) => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.start({ title: 'One' }), undefined);
  assert.match(f.start({}) ?? '', /^Every meeting room is busy/);
  assert.equal(f.room.state().rooms.length, 1);
});

test('a pull request is reviewed by one panel at a time; two panels on different PRs run at once and post to their own PRs', async (t) => {
  const f = fixture({ rooms: MEETING_ROOMS }); t.after(() => f.close());
  assert.equal(f.start({ pattern: 'review', prompt: 'Review it', pr: 42 }), undefined);
  assert.match(f.start({ pattern: 'review', prompt: 'Again', pr: 42 }) ?? '', /PR #42 is already being reviewed in the 🤝 Meeting room/);
  assert.match(f.start({ pattern: 'review', prompt: 'Again', pr: 42, room: 'review' }) ?? '', /already being reviewed/);
  assert.equal(f.cur(1), null);
  assert.equal(f.start({ pattern: 'review', prompt: 'Review that', pr: 43 }), undefined);
  assert.deepEqual([f.cur(0)!.pr, f.cur(1)!.pr], [42, 43]);
  // The second finishes first, then the first.
  for (const at of [1, 0]) {
    for (const i of [0, 1, 2]) f.take(i, '- a.ts:1 — something', false, at);
    f.take(0, 'Looks fine.', false, at);
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(f.cur(0)!.status, 'done');
  assert.equal(f.cur(1)!.status, 'done');
  assert.deepEqual(f.reviews.map((r) => r.pr).sort(), [42, 43]);
  assert.equal(f.cur(0)!.review?.url, 'https://github.com/o/r/pull/42#pullrequestreview-1');
  assert.equal(f.cur(1)!.review?.url, 'https://github.com/o/r/pull/43#pullrequestreview-1');
  assert.ok(f.reviews.find((r) => r.pr === 42)!.file.endsWith('pr-42.md'));
  assert.ok(f.reviews.find((r) => r.pr === 43)!.file.endsWith('pr-43.md'));
  // With two rooms holding meetings, stop / clear without a room name them.
  assert.match(f.room.clear('Ada') ?? '', /Several rooms have meetings, so say which room: 🤝 Meeting room \(meeting\), 🔍 Review room \(review\)/);
});
