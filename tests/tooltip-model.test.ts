// A button's tooltip (ui/tooltipmodel.ts): which words it shows, whether they describe the button for a
// screen reader, and where the bubble goes around the button and inside the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeTip, tipDescribes, tipText, TIP_GAP, TIP_MARGIN, TIP_TARGETS } from '../src/client/ui/tooltipmodel.js';

const VIEW = { width: 1280, height: 900 };
const TIP = { width: 200, height: 40 };
const box = (left: number, top: number, width = 100, height = 36) => ({ left, top, width, height });

test('the words are the title, trimmed; none when there is no title', () => {
  assert.equal(tipText('  Look for the pull requests ', null, 'Find PRs'), 'Look for the pull requests');
  assert.equal(tipText(null, null, 'Find PRs'), '');
  assert.equal(tipText('', undefined, 'Find PRs'), '');
  assert.equal(tipText('   ', null, ''), '');
});

test('a title written while the tooltip held the old one wins over it', () => {
  assert.equal(tipText('The agent is on it', 'Fix the pull requests', 'Fix PRs'), 'The agent is on it');
  assert.equal(tipText(null, 'Fix the pull requests', 'Fix PRs'), 'Fix the pull requests');
  assert.equal(tipText('  ', 'Fix the pull requests', 'Fix PRs'), 'Fix the pull requests');
});

test('words that only repeat the button get no bubble; an icon button’s label does', () => {
  assert.equal(tipText('Refresh', null, 'Refresh'), '');
  assert.equal(tipText('refresh', null, '  Refresh\n '), '');
  assert.equal(tipText('Find PRs', null, 'Find   PRs'), '');
  assert.equal(tipText('Refresh', null, ''), 'Refresh');
  assert.equal(tipText('Refresh: read it again', null, 'Refresh'), 'Refresh: read it again');
});

test('the tooltip describes the button unless its name is the same words', () => {
  assert.equal(tipDescribes('Read it from GitHub again', 'Refresh'), true);
  assert.equal(tipDescribes('Refresh', 'Refresh'), false);
  assert.equal(tipDescribes('Refresh', ' refresh '), false);
  assert.equal(tipDescribes('', 'Refresh'), false);
  assert.equal(tipDescribes('Close (Esc)', null), true);
});

test('only buttons and links drawn as buttons get a tooltip', () => {
  assert.deepEqual(TIP_TARGETS.split(',').map((s) => s.trim()), ['button', 'a.btn', '[role="button"]']);
});

test('the bubble sits centred above the button, a gap away, its arrow in the middle', () => {
  const at = placeTip(box(600, 400), TIP, VIEW);
  assert.deepEqual(at, { left: 550, top: 400 - TIP_GAP - TIP.height, side: 'above', arrow: 100 });
});

test('with no room above it goes below', () => {
  const at = placeTip(box(600, 20), TIP, VIEW);
  assert.equal(at.side, 'below');
  assert.equal(at.top, 20 + 36 + TIP_GAP);
  // Just enough room above keeps it there.
  assert.equal(placeTip(box(600, TIP_MARGIN + TIP.height + TIP_GAP), TIP, VIEW).side, 'above');
  assert.equal(placeTip(box(600, TIP_MARGIN + TIP.height + TIP_GAP - 1), TIP, VIEW).side, 'below');
});

test('at the window’s sides it stays inside, and the arrow still points at the button', () => {
  const left = placeTip(box(4, 400, 40), TIP, VIEW);
  assert.equal(left.left, TIP_MARGIN);
  assert.equal(left.arrow, 4 + 20 - TIP_MARGIN);
  const right = placeTip(box(1180, 400, 96), TIP, VIEW);
  assert.equal(right.left, VIEW.width - TIP_MARGIN - TIP.width);
  assert.equal(right.left + right.arrow, 1180 + 48);
  // A button in the very corner: the arrow keeps off the bubble's rounded corner.
  const corner = placeTip(box(1272, 400, 8), TIP, VIEW);
  assert.ok(corner.arrow <= TIP.width - 14 && corner.arrow >= 14, `arrow at ${corner.arrow}`);
});

test('a window too low for either side takes the roomier one and keeps the bubble inside', () => {
  const view = { width: 400, height: 90 };
  const nearTop = placeTip(box(100, 10), TIP, view);
  assert.equal(nearTop.side, 'below');
  assert.ok(nearTop.top >= TIP_MARGIN && nearTop.top + TIP.height <= view.height - TIP_MARGIN);
  const nearBottom = placeTip(box(100, 50), TIP, view);
  assert.equal(nearBottom.side, 'above');
  assert.ok(nearBottom.top >= TIP_MARGIN);
});

test('a bubble wider than the window starts at the margin', () => {
  const at = placeTip(box(10, 400, 60), { width: 280, height: 40 }, { width: 240, height: 900 });
  assert.equal(at.left, TIP_MARGIN);
  assert.equal(at.side, 'above');
});
