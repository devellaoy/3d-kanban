import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MEETING_FILE_MAX, listMeetingFiles, listMeetings, readMeetingFile } from '../src/server/meeting-files.js';
import type { MeetingRecord } from '../src/shared/protocol.js';

/** Later than any folder's own date (an orphan's is its folder's, so about now). */
const LATER = Date.now() + 1e7;
const rec = (id: string, finishedAt: number, extra: Partial<MeetingRecord> = {}): MeetingRecord => ({ id, pattern: 'debate', title: `T ${id}`, status: 'done', summary: 's', calledBy: 'Ada', finishedAt, output: 'o.md', ...extra });

function fixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'office-archive-'));
  const root = path.join(tmp, 'meetings');
  const outside = path.join(tmp, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.md'), 'secret');
  const a = path.join(root, 'aaaaaaaa');
  mkdirSync(a, { recursive: true });
  for (const n of ['r2-red.md', 'r1-1-skeptic.md', 'plan.md', 'output-decision.md', 'zeta.md']) writeFileSync(path.join(a, n), `# ${n}`);
  writeFileSync(path.join(a, '.meeting.json'), JSON.stringify(rec('aaaaaaaa', 500, { title: 'From folder', prompt: 'Q?' })));
  mkdirSync(path.join(a, 'sub'));
  symlinkSync(path.join(outside, 'secret.md'), path.join(a, 'link.md'));
  symlinkSync(outside, path.join(a, 'linkdir'));
  writeFileSync(path.join(a, 'big.md'), Buffer.alloc(2 * 1024 * 1024, 97));
  writeFileSync(path.join(a, 'bin.md'), Buffer.from([65, 0, 66]));
  symlinkSync(outside, path.join(root, 'bbbbbbbb'));
  mkdirSync(path.join(root, 'cccccccc'));
  mkdirSync(path.join(root, 'not-an-id'));
  return { tmp, root, outside, close: () => rmSync(tmp, { recursive: true, force: true }) };
}

test('the list: newest first, a finished meeting beats its folder record beats the state line; orphans by id; no odd folders', async (t) => {
  const f = fixture(); t.after(f.close);
  const past = [rec('aaaaaaaa', 1, { title: 'From state' }), rec('dddddddd', 300, { title: 'Gone folder' }), rec('bbbbbbbb', 50)];
  const r = await listMeetings(f.root, past, [rec('eeeeeeee', LATER, { title: 'On table' })]);
  const ids = r.meetings.map((m) => m.id);
  assert.deepEqual(ids.slice(0, 2), ['eeeeeeee', 'cccccccc']);
  assert.deepEqual(ids.slice(2), ['aaaaaaaa', 'dddddddd', 'bbbbbbbb']);
  assert.equal(r.meetings[0].id, 'eeeeeeee');
  assert.equal(r.meetings.find((m) => m.id === 'aaaaaaaa')!.title, 'From folder');
  assert.equal(r.meetings.find((m) => m.id === 'dddddddd')!.title, 'Gone folder');
  const orphan = r.meetings.find((m) => m.id === 'cccccccc')!;
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.title, 'Meeting cccccccc');
  assert.equal(ids.filter((i) => i === 'aaaaaaaa').length, 1);
  assert.ok(!ids.includes('not-an-id'));
  // bbbbbbbb is a link out: only its state line (an old record without the new fields) shows.
  assert.equal(r.meetings.find((m) => m.id === 'bbbbbbbb')!.prompt, undefined);
  assert.equal(r.more, false);
});

test('a finished meeting wins over the folder, and with no past record the folder one is used; a broken .meeting.json is ignored', async (t) => {
  const f = fixture(); t.after(f.close);
  assert.equal((await listMeetings(f.root, [], [rec('aaaaaaaa', LATER, { title: 'Table' })])).meetings[0].title, 'Table');
  assert.equal((await listMeetings(f.root, [], [])).meetings.find((m) => m.id === 'aaaaaaaa')!.prompt, 'Q?');
  for (const bad of ['{nope', JSON.stringify({ ...rec('aaaaaaaa', 1), id: 'ffffffff' }), JSON.stringify({ ...rec('aaaaaaaa', 1), pattern: 'x' }), JSON.stringify({ ...rec('aaaaaaaa', 1), finishedAt: 'x' })]) {
    writeFileSync(path.join(f.root, 'aaaaaaaa', '.meeting.json'), bad);
    const m = (await listMeetings(f.root, [rec('aaaaaaaa', 2, { title: 'State' })], [])).meetings.find((x) => x.id === 'aaaaaaaa')!;
    assert.equal(m.title, 'State');
  }
  writeFileSync(path.join(f.root, 'aaaaaaaa', '.meeting.json'), ' '.repeat(70 * 1024) + JSON.stringify(rec('aaaaaaaa', 1, { title: 'Huge' })));
  assert.equal((await listMeetings(f.root, [], [])).meetings.find((x) => x.id === 'aaaaaaaa')!.orphan, true);
});

test('a missing root lists only the state, and the list is capped at 500', async (t) => {
  const f = fixture(); t.after(f.close);
  assert.deepEqual((await listMeetings(path.join(f.tmp, 'nope'), [rec('aaaaaaaa', 1)], [])).meetings.map((m) => m.id), ['aaaaaaaa']);
  assert.deepEqual(await listMeetings(path.join(f.tmp, 'nope'), [], []), { meetings: [], more: false });
  const many = Array.from({ length: 501 }, (_, i) => rec(i.toString(16).padStart(8, '0'), i));
  const r = await listMeetings(path.join(f.tmp, 'nope'), many, []);
  assert.equal(r.meetings.length, 500);
  assert.equal(r.more, true);
  assert.equal(r.meetings[0].finishedAt, 500);
});

test('a meeting’s files: output first, then by round, no hidden files, folders or links', async (t) => {
  const f = fixture(); t.after(f.close);
  const r = await listMeetingFiles(f.root, 'aaaaaaaa');
  assert.ok('files' in r);
  assert.deepEqual(r.files.map((x) => x.name), ['output-decision.md', 'plan.md', 'r1-1-skeptic.md', 'r2-red.md', 'big.md', 'bin.md', 'zeta.md']);
  assert.deepEqual(r.files.map((x) => [x.kind, x.round]), [['output', undefined], ['note', 1], ['note', 1], ['note', 2], ['note', undefined], ['note', undefined], ['note', undefined]]);
  for (const id of ['bbbbbbbb', 'not-an-id', '..', 'dddddddd']) assert.deepEqual(await listMeetingFiles(f.root, id), { status: 404, error: 'No such meeting' });
  assert.deepEqual((await listMeetingFiles(f.root, 'cccccccc')), { files: [] });
});

test('reading a file: names that escape are refused, links and unknowns are 404, big is 413, binary 415', async (t) => {
  const f = fixture(); t.after(f.close);
  for (const n of ['../x', '/etc/passwd', 'a/b', '..', '..\\x', '.meeting.json', '']) assert.equal((await readMeetingFile(f.root, 'aaaaaaaa', n) as { status: number }).status, 400, n);
  for (const n of ['link.md', 'linkdir', 'sub', 'nothing.md']) assert.equal((await readMeetingFile(f.root, 'aaaaaaaa', n) as { status: number }).status, 404, n);
  assert.equal((await readMeetingFile(f.root, 'bbbbbbbb', 'secret.md') as { status: number }).status, 404);
  assert.equal((await readMeetingFile(f.root, '../outside', 'secret.md') as { status: number }).status, 404);
  assert.equal((await readMeetingFile(f.root, 'aaaaaaaa', 'big.md') as { status: number }).status, 413);
  assert.equal((await readMeetingFile(f.root, 'aaaaaaaa', 'bin.md') as { status: number }).status, 415);
  assert.deepEqual(await readMeetingFile(f.root, 'aaaaaaaa', 'plan.md'), { name: 'plan.md', size: 9, text: '# plan.md' });
  writeFileSync(path.join(f.root, 'aaaaaaaa', 'edge.md'), Buffer.alloc(MEETING_FILE_MAX, 98));
  assert.equal(((await readMeetingFile(f.root, 'aaaaaaaa', 'edge.md')) as { text: string }).text.length, MEETING_FILE_MAX);
});

test('a hard link to a file outside is neither listed nor read; a symlinked id folder gives 404 for files and file', async (t) => {
  const f = fixture(); t.after(f.close);
  linkSync(path.join(f.outside, 'secret.md'), path.join(f.root, 'aaaaaaaa', 'hard.md'));
  assert.equal((await readMeetingFile(f.root, 'aaaaaaaa', 'hard.md') as { status: number }).status, 404);
  const r = await listMeetingFiles(f.root, 'aaaaaaaa');
  assert.ok('files' in r && !r.files.some((x) => x.name === 'hard.md'));
  assert.ok('files' in r && r.files.some((x) => x.name === 'plan.md'));
  symlinkSync(path.join(f.root, 'aaaaaaaa'), path.join(f.root, 'dddddddd'));
  assert.equal(((await listMeetingFiles(f.root, 'dddddddd')) as { status: number }).status, 404);
  assert.equal((await readMeetingFile(f.root, 'dddddddd', 'plan.md') as { status: number }).status, 404);
});

test('a .meeting.json with fields of the wrong type is listed with those fields dropped', async (t) => {
  const f = fixture(); t.after(f.close);
  writeFileSync(path.join(f.root, 'aaaaaaaa', '.meeting.json'), JSON.stringify({ ...rec('aaaaaaaa', 5, { title: 'Odd' }), prompt: 42, seats: 'oops', cost: 'x', tokens: 7, commit: 3 }));
  const m = (await listMeetings(f.root, [], [])).meetings.find((x) => x.id === 'aaaaaaaa')!;
  assert.equal(m.title, 'Odd');
  assert.equal(m.tokens, 7);
  for (const k of ['prompt', 'seats', 'cost', 'commit'] as const) assert.equal(m[k], undefined, k);
});
