// The 3D office's client store: a floor renamed from the kanban's settings renames the top bar of whoever stands on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/client/state/index.js';
import type { FloorInfo, ProjectInfo } from '../src/shared/protocol.js';

const floor = (id: string, name: string) => ({ id, name, dir: `/x/${id}` }) as FloorInfo;

test("a 'floors' message renames the current floor's project, and only that", () => {
  const project = { name: 'web', dir: '/x/web' } as ProjectInfo;
  store.floor = 'web';
  store.project = project;
  const heard: string[] = [];
  store.on('floors', () => void heard.push(store.project?.name ?? ''));
  store.apply({ t: 'floors', floors: [floor('web', 'Shop'), floor('api', 'API')] });
  assert.equal(store.project?.name, 'Shop');
  assert.equal(store.project?.dir, '/x/web');
  assert.equal(project.name, 'web', 'a new object, the old one untouched');
  assert.deepEqual(heard, ['Shop'], 'listeners see the new name');
  // Another floor's name changing leaves it be.
  const mine = store.project;
  store.apply({ t: 'floors', floors: [floor('web', 'Shop'), floor('api', 'Interfaces')] });
  assert.equal(store.project, mine);
});
