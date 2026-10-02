import test from 'node:test';
import assert from 'node:assert/strict';
import { wantedFloor, type WatchState } from '../src/client/phone/wanted.js';

const state = (extra: Partial<WatchState> = {}): WatchState => ({
  floor: 'f1',
  floors: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
  phoneFloor: null,
  workers: new Map([['own-w', 1]]),
  ...extra,
});
const held = (floor: string, ...ids: string[]) => ({ floor, workers: new Map(ids.map((i) => [i, 1])) });

test('phone watch: a listed other floor is followed', () => {
  assert.equal(wantedFloor('f2', null, state()), 'f2');
});

test('phone watch: your own floor is never followed', () => {
  assert.equal(wantedFloor('f1', null, state()), null);
});

test('phone watch: a floor that is not in the building is not followed', () => {
  assert.equal(wantedFloor('gone', null, state()), null);
});

test('phone watch: with nothing listed, an open window of a worker known through the phone keeps its floor', () => {
  assert.equal(wantedFloor(null, 'f2-w', state({ phoneFloor: held('f2', 'f2-w') })), 'f2');
});

test('phone watch: with nothing listed and no window, nothing is followed', () => {
  assert.equal(wantedFloor(null, null, state({ phoneFloor: held('f2', 'f2-w') })), null);
});

test('phone watch: a window on your own floor\'s worker, or an unknown one, follows nothing', () => {
  assert.equal(wantedFloor(null, 'own-w', state({ phoneFloor: held('f2', 'own-w') })), null);
  assert.equal(wantedFloor(null, 'nobody', state({ phoneFloor: held('f2', 'f2-w') })), null);
});

test('phone watch: a held floor that is gone is not followed', () => {
  assert.equal(wantedFloor(null, 'f9-w', state({ phoneFloor: held('f9', 'f9-w') })), null);
});

test('phone watch: switching the listed floor under an open window follows the listed one', () => {
  assert.equal(wantedFloor('f3', 'f2-w', state({ phoneFloor: held('f2', 'f2-w') })), 'f3');
});
