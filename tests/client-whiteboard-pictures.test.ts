// A visitor cannot add pictures to the visited whiteboard: the upload does not even make a request
// (it would have gone to the visitor's own office, under the visited floor's id).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_PICTURES_HINT, canAddPictures, uploadUnlessVisiting } from '../src/client/features/whiteboard/pictures.js';

const g = globalThis as { location?: { search: string } };
afterEach(() => delete g.location);

test('while visiting, the upload is refused with a hint and nothing is requested', async () => {
  g.location = { search: '?visit=owner' };
  const said: string[] = [];
  let ran = 0;
  assert.equal(canAddPictures(), false);
  assert.equal(await uploadUnlessVisiting(async () => (ran++, true), (t) => said.push(t)), false);
  assert.equal(ran, 0);
  assert.deepEqual(said, [NO_PICTURES_HINT]);
});

test('at home the upload runs as before', async () => {
  g.location = { search: '' };
  let ran = 0;
  assert.equal(canAddPictures(), true);
  assert.equal(await uploadUnlessVisiting(async () => (ran++, true), () => assert.fail('no hint at home')), true);
  assert.equal(ran, 1);
});
