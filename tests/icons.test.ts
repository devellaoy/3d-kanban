// The icon registry (ui/icons.ts): every name is a Lucide icon with parts to draw, and icon() builds the
// SVG the same way each time: decorative unless labelled, 1.75 stroke, text-coloured. A few-line stand-in
// for the DOM is enough for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as lucide from 'lucide';
import { ICONS, icon, iconButton, withIcon, type IconName } from '../src/client/ui/icons.ts';

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  className = '';
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  append(...c: (FakeEl | string)[]) {
    for (const x of c) if (typeof x !== 'string') this.children.push(x);
  }
}

function fakeDocument(t: { after(fn: () => void): void }) {
  const g = globalThis as Record<string, unknown>;
  const was = g.document;
  g.document = {
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    createElement: (tag: string) => new FakeEl(tag),
  };
  g.Node = FakeEl;
  t.after(() => {
    g.document = was;
  });
}

const pascal = (kebab: string) => kebab.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');

test('every icon is a named Lucide icon with something to draw', () => {
  const names = Object.keys(ICONS);
  assert.ok(names.length >= 80, `${names.length} icons`);
  for (const name of names) {
    const node = ICONS[name as IconName];
    assert.ok(Array.isArray(node) && node.length > 0, `${name} has no parts`);
    assert.equal(node, (lucide as unknown as Record<string, unknown>)[pascal(name)], `${name} is not Lucide's ${pascal(name)}`);
    for (const [tag, attrs] of node) assert.ok(tag && typeof attrs === 'object', `${name}: a part is malformed`);
  }
});

test('icon(): decorative without a label, an image with one', (t) => {
  fakeDocument(t);
  const plain = icon('play') as unknown as FakeEl;
  assert.equal(plain.getAttribute('aria-hidden'), 'true');
  assert.equal(plain.getAttribute('role'), null);
  assert.equal(plain.getAttribute('aria-label'), null);
  const named = icon('play', { label: 'Start' }) as unknown as FakeEl;
  assert.equal(named.getAttribute('role'), 'img');
  assert.equal(named.getAttribute('aria-label'), 'Start');
  assert.equal(named.getAttribute('aria-hidden'), null);
});

test('icon(): the stroke style, the size, the class and the parts', (t) => {
  fakeDocument(t);
  const el = icon('square-kanban', { size: 20, cls: 'big' }) as unknown as FakeEl;
  assert.equal(el.tagName, 'svg');
  assert.equal(el.getAttribute('class'), 'i big');
  assert.equal(el.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(el.getAttribute('width'), '20');
  assert.equal(el.getAttribute('height'), '20');
  assert.equal(el.getAttribute('fill'), 'none');
  assert.equal(el.getAttribute('stroke'), 'currentColor');
  assert.equal(el.getAttribute('stroke-width'), '1.75');
  assert.equal(el.getAttribute('stroke-linecap'), 'round');
  assert.equal(el.getAttribute('stroke-linejoin'), 'round');
  assert.equal(el.children.length, ICONS['square-kanban'].length);
  assert.equal(el.children[0].tagName, 'rect');
  assert.equal(el.children[0].getAttribute('rx'), '2');
  const small = icon('x') as unknown as FakeEl;
  assert.equal(small.getAttribute('width'), '16', 'the default size');
  assert.equal(small.getAttribute('class'), 'i');
});

test('withIcon and iconButton', (t) => {
  fakeDocument(t);
  const [svg, text] = withIcon('plus', 'New task', 14);
  assert.equal((svg as unknown as FakeEl).getAttribute('width'), '14');
  assert.equal(text, 'New task');
  const b = iconButton('settings', 'Settings', { 'data-focus': 'x' }) as unknown as FakeEl;
  assert.equal(b.tagName, 'button');
  assert.equal(b.className, 'btn icon-btn');
  assert.equal(b.getAttribute('type'), 'button');
  assert.equal(b.getAttribute('aria-label'), 'Settings');
  assert.equal(b.getAttribute('title'), 'Settings');
  assert.equal(b.getAttribute('data-focus'), 'x');
  assert.equal(b.children[0].getAttribute('aria-hidden'), 'true');
});
