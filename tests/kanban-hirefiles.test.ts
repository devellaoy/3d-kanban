import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AttachmentRow } from '../src/server/kanban/db/repository.js';
import { hireFiles } from '../src/server/kanban/hirefiles.js';

type Ctx = { after(fn: () => void): void };

/** A stand-in repository and uploads folder: `add` keeps a row and its file, as POST /api/kanban/upload does. */
function setup(t: Ctx) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-hirefiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filesDir = path.join(root, 'kanban');
  mkdirSync(path.join(filesDir, 'uploads'), { recursive: true });
  const rows = new Map<string, AttachmentRow>();
  let n = 0;
  const add = (name: string, body: string, extra: Partial<AttachmentRow> = {}) => {
    const id = (++n).toString(16).padStart(32, '0');
    const stored = `${id}-${name}`;
    writeFileSync(path.join(filesDir, 'uploads', stored), body);
    rows.set(id, { id, name, mime: 'text/plain', size: body.length, stored, createdBy: 'Ada', createdAt: 1, ...extra });
    return id;
  };
  const repo = { getAttachment: (id: string) => rows.get(id) };
  return { repo, filesDir, add };
}

test("no files means no change, and anything but a list of the caller's own loose uploads is refused", (t) => {
  const { repo, filesDir, add } = setup(t);
  assert.equal(hireFiles(repo, filesDir, undefined, 'Ada'), undefined);
  assert.equal(hireFiles(repo, filesDir, [], 'Ada'), undefined);
  for (const bad of ['x', {}, [1], ['nope'], ['../etc'], Array.from({ length: 21 }, (_, i) => String(i + 1).padStart(32, '0'))]) assert.equal(hireFiles(repo, filesDir, bad, 'Ada'), 'Bad attachments');
  const gone = 'An attached file is gone: attach it again';
  assert.equal(hireFiles(repo, filesDir, ['e'.repeat(32)], 'Ada'), gone, 'unknown');
  assert.equal(hireFiles(repo, filesDir, [add('t.txt', 'x', { taskId: 5 })], 'Ada'), gone, "a task's");
  assert.equal(hireFiles(repo, filesDir, [add('o.txt', 'x', { createdBy: 'Bob' })], 'Ada'), gone, "someone else's");
  assert.equal(hireFiles(repo, filesDir, [add('fine.txt', 'x'), 'e'.repeat(32)], 'Ada'), gone, 'one missing refuses all');
});

test("without accounts the caller is 'Guest' as the upload route records it, and a guest can't take an account user's upload", (t) => {
  const { repo, filesDir, add } = setup(t);
  const guest = hireFiles(repo, filesDir, [add('g.txt', 'x', { createdBy: 'Guest' })], 'Guest');
  assert.ok(Array.isArray(guest) && guest[0].name === 'g.txt');
  assert.equal(hireFiles(repo, filesDir, [add('ada.txt', 'x', { createdBy: 'Ada' })], 'Guest'), 'An attached file is gone: attach it again');
  assert.equal(hireFiles(repo, filesDir, [add('guest.txt', 'x', { createdBy: 'Guest' })], 'Ada'), 'An attached file is gone: attach it again');
});

test('the files come back as paths to copy, once each and in order', (t) => {
  const { repo, filesDir, add } = setup(t);
  const a = add('notes.txt', 'hello');
  const b = add('kuva ä.png', 'png', { mime: 'image/png' });
  const r = hireFiles(repo, filesDir, [a, b, a], 'Ada');
  assert.deepEqual(r, [
    { path: path.join(filesDir, 'uploads', `${a}-notes.txt`), name: 'notes.txt', type: 'text/plain' },
    { path: path.join(filesDir, 'uploads', `${b}-kuva ä.png`), name: 'kuva ä.png', type: 'image/png' },
  ]);
});
