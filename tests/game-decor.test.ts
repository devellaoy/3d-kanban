import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyConfig, parseFloor, sanitizeConfig, setLamp, toggleItem, withDesk } from '../src/client/features/deskstuff/model';
import { AREAS, allOn, easeLevel, flip, parseLights } from '../src/client/features/lights/model';
import { DAY_MS, MAX_STAGE, droopOf, daysSince, mergesToNext, newPlant, parsePlant, recordMerge, stageOf } from '../src/client/features/mergeplant/model';

test('desk stuff: toggling keeps order and drops the lamp state with the lamp', () => {
  let c = toggleItem(emptyConfig(), 'duck');
  c = toggleItem(c, 'lamp');
  assert.deepEqual(c.items, ['lamp', 'duck']);
  c = setLamp(c, true);
  assert.equal(c.lampOn, true);
  c = toggleItem(c, 'lamp');
  assert.deepEqual(c, { items: ['duck'], lampOn: false });
  assert.deepEqual(setLamp(c, true), c, 'no lamp, nothing to switch');
});

test('desk stuff: saved data is sanitized', () => {
  assert.deepEqual(sanitizeConfig({ items: ['mug', 'mug', 'bomb', 7], lampOn: true }), { items: ['mug'], lampOn: false });
  assert.deepEqual(parseFloor('not json'), {});
  assert.deepEqual(parseFloor(JSON.stringify({ a: { items: ['plant'] }, b: { items: [] }, gone: { items: ['mug'] } }), (id) => id !== 'gone'), { a: { items: ['plant'], lampOn: false } });
  assert.deepEqual(withDesk({ a: { items: ['plant'], lampOn: false } }, 'a', emptyConfig()), {});
});

test('lights: only a saved off turns an area off', () => {
  assert.deepEqual(parseLights(null), allOn());
  assert.deepEqual(parseLights('{"lounge":false,"desks":"x"}'), { lounge: false, desks: true });
  assert.deepEqual(parseLights('garbage'), allOn());
  assert.equal(flip(allOn(), 'lounge').lounge, false);
  assert.ok(AREAS.length >= 2);
});

test('lights: the level eases to its switch and lands on it', () => {
  let l = 1;
  for (let i = 0; i < 200; i++) l = easeLevel(l, false, 0.05);
  assert.equal(l, 0);
  assert.ok(easeLevel(0, true, 0.05) > 0);
});

test('merge plant: stages come at their merge counts', () => {
  assert.equal(stageOf(0), 0);
  assert.equal(stageOf(1), 1);
  assert.equal(stageOf(3), 2);
  assert.equal(stageOf(10_000), MAX_STAGE);
  assert.equal(mergesToNext({ ...newPlant(0), merges: 0 }), 1);
  assert.equal(mergesToNext({ ...newPlant(0), merges: 10_000 }), null);
});

test('merge plant: a merge counts once per pull request and resets the droop', () => {
  const t0 = 1_000_000;
  let p = newPlant(t0);
  p = recordMerge(p, t0 + 1, 12);
  assert.equal(recordMerge(p, t0 + 2, 12), p, 'same PR twice counts once');
  p = recordMerge(p, t0 + 3, 13);
  assert.equal(p.merges, 2);
  assert.equal(p.lastMergeAt, t0 + 3);
});

test('merge plant: droops after 7 days without a merge, from planting when there is none', () => {
  const t0 = 5 * DAY_MS;
  const p = newPlant(t0);
  assert.equal(droopOf(p, t0 + 6 * DAY_MS), 0);
  assert.equal(droopOf(p, t0 + 7 * DAY_MS), 0);
  assert.ok(droopOf(p, t0 + 8 * DAY_MS) > 0);
  assert.equal(droopOf(p, t0 + 30 * DAY_MS), 1);
  const fed = recordMerge(p, t0 + 9 * DAY_MS, 1);
  assert.equal(droopOf(fed, t0 + 10 * DAY_MS), 0);
  assert.equal(daysSince(fed, t0 + 12 * DAY_MS), 3);
});

test('merge plant: saved data round-trips and bad data is a new plant', () => {
  const p = recordMerge(newPlant(100), 200, 5);
  assert.deepEqual(parsePlant(JSON.stringify(p), 999), p);
  assert.deepEqual(parsePlant('{oops', 999), newPlant(999));
  assert.equal(parsePlant('{"merges":-4}', 999).merges, 0);
});
