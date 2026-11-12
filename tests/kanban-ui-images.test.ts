// UI testing and a task's images as the page works them out, without the DOM
// (src/client/kanban/taskimagesmodel.ts): whose choice counts, an image's address, and when a list changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { imagesKey, imagesUrl, imageUrl, missingText, projectUiTesting, taskUiTesting, uiTestingPatch } from '../src/client/kanban/taskimagesmodel.js';
import { KANBAN_DEFAULTS, projectDefaults } from '../src/client/kanban/defaults.js';
import { pairImages, type KanbanTaskImage } from '../src/shared/kanban/uitesting.js';

const settings = (office: boolean, project?: boolean) => ({
  defaults: { ...KANBAN_DEFAULTS.defaults, uiTesting: office },
  projects: { api: { ...projectDefaults(), ...(project === undefined ? {} : { uiTesting: project }) } },
});
const img = (name: string, mtime = 1000.4, size = 10): KanbanTaskImage => ({ name, kind: name.includes('-before.') ? 'before' : 'after', subject: name.replace(/-(before|after)\.[a-z]+$/, ''), size, mtime });

test('UI testing: the task’s choice, else the project’s, else the office’s', () => {
  assert.equal(projectUiTesting(null, 'api'), KANBAN_DEFAULTS.defaults.uiTesting);
  assert.equal(projectUiTesting(settings(false), 'api'), false);
  assert.equal(projectUiTesting(settings(false, true), 'api'), true);
  assert.equal(projectUiTesting(settings(true, false), 'api'), false);
  // A project the settings don't know takes the office's.
  assert.equal(projectUiTesting(settings(false, true), 'web'), false);
  assert.equal(taskUiTesting(settings(true, true), 'api', { uiTesting: false }), false);
  assert.equal(taskUiTesting(settings(false, false), 'api', { uiTesting: true }), true);
  assert.equal(taskUiTesting(settings(true, false), 'api', {}), false);
  assert.equal(taskUiTesting(settings(true), 'api'), true);
});

test('an edit sends UI testing only when the box says something else than the task does today', () => {
  assert.equal(uiTestingPatch(true, true), undefined);
  assert.equal(uiTestingPatch(false, false), undefined);
  assert.equal(uiTestingPatch(false, true), false);
  assert.equal(uiTestingPatch(true, false), true);
});

test('an image’s address: its name encoded, and its modified time so a retaken picture is fetched again', () => {
  assert.equal(imagesUrl(42), '/api/kanban/tasks/42/images');
  assert.equal(imageUrl(42, img('login-before.png')), '/api/kanban/tasks/42/images/login-before.png?v=1000');
  assert.equal(imageUrl(42, img('login-before.png', 2000)), '/api/kanban/tasks/42/images/login-before.png?v=2000');
  // Removing one names the file itself.
  assert.equal(imageUrl(42, img('a.b_c-after.webp'), false), '/api/kanban/tasks/42/images/a.b_c-after.webp');
});

test('a list is another one when a name, a size or a time changed', () => {
  const a = [img('login-before.png'), img('login-after.png')];
  assert.equal(imagesKey(a), imagesKey([img('login-before.png'), img('login-after.png')]));
  assert.notEqual(imagesKey(a), imagesKey([img('login-before.png'), img('login-after.png', 2000)]));
  assert.notEqual(imagesKey(a), imagesKey([img('login-before.png'), img('login-after.png', 1000.4, 11)]));
  assert.notEqual(imagesKey(a), imagesKey([img('login-before.png')]));
  assert.equal(imagesKey([]), '');
});

test('the tab’s pairs: a subject each, either side may be missing, and each missing side says so', () => {
  const pairs = pairImages([img('settings-after.png'), img('login-after.png'), img('login-before.png'), img('new-view-after.png')]);
  assert.deepEqual(pairs.map((p) => [p.subject, !!p.before, !!p.after]), [['login', true, true], ['new-view', false, true], ['settings', false, true]]);
  assert.match(missingText('before'), /before/);
  assert.match(missingText('after'), /after/);
  assert.notEqual(missingText('before'), missingText('after'));
});
