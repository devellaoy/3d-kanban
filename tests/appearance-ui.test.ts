// The Theme row in ⚙️ Settings (ui/appearance.ts) on a few-line stand-in for the DOM: it follows a
// change made in another tab, and clicking the appearance the page left still switches back to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(`data:text/javascript,${encodeURIComponent("export async function load(url, ctx, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, ctx); }")}`);

class FakeEl {
  className = '';
  isConnected = false;
  children: (FakeEl | string)[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  append(...c: (FakeEl | string)[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: (FakeEl | string)[]) {
    this.children = c;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
}

/** The page: a window to hear events, the root element, and a storage that is shared like a browser's. */
function fakePage() {
  const g = globalThis as Record<string, unknown>;
  const storage = new Map<string, string>();
  const win = new EventTarget();
  // Count the listeners the window holds, per event type.
  const listening = new Map<string, Set<unknown>>();
  const add = win.addEventListener.bind(win);
  const remove = win.removeEventListener.bind(win);
  win.addEventListener = (type, fn, ...rest) => {
    listening.set(type, (listening.get(type) ?? new Set()).add(fn));
    add(type, fn, ...rest);
  };
  win.removeEventListener = (type, fn, ...rest) => {
    listening.get(type)?.delete(fn);
    remove(type, fn, ...rest);
  };
  g.Node = FakeEl;
  g.window = win;
  g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    querySelector: () => null,
    documentElement: { dataset: {} as Record<string, string>, style: {} },
  };
  return { storage, win, count: (type: string) => listening.get(type)?.size ?? 0, root: (g.document as { documentElement: { dataset: Record<string, string> } }).documentElement };
}

const checked = (seg: FakeEl) => (seg.children as FakeEl[]).filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent);

test('the Theme row follows a change made in another tab, and clicking the old one switches back', async () => {
  const { storage, win, root } = fakePage();
  const { APPEARANCE_KEY, applyAppearance } = await import('../src/client/themes/index.ts');
  const { appearanceRow } = await import('../src/client/ui/appearance.ts');
  const { row: [seg] } = appearanceRow() as unknown as { row: [FakeEl, FakeEl] };
  seg.isConnected = true;
  assert.equal(seg.children.length, 3);
  assert.deepEqual(checked(seg), ['🧡 Office']);

  // Another tab picks Dark: the storage event makes the page apply it.
  storage.set(APPEARANCE_KEY, 'dark');
  applyAppearance('dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.deepEqual(checked(seg), ['🌙 Dark']);

  // Office is not what the page has now, so clicking it must do something.
  (seg.children[0] as FakeEl).click();
  assert.equal(root.dataset.theme, 'default');
  assert.equal(storage.get(APPEARANCE_KEY), 'default');
  assert.deepEqual(checked(seg), ['🧡 Office']);

  // Clicking what is already chosen changes nothing.
  let changes = 0;
  win.addEventListener('appearancechange', () => changes++);
  (seg.children[0] as FakeEl).click();
  assert.equal(changes, 0);
});

test('closing Settings takes the Theme row off the window, with no theme change in between', async () => {
  const { count } = fakePage();
  const { appearanceRow } = await import('../src/client/ui/appearance.ts');
  const { off } = appearanceRow();
  assert.equal(count('appearancechange'), 1);
  off();
  assert.equal(count('appearancechange'), 0, 'the row took its listener off the window');
  for (let i = 0; i < 3; i++) appearanceRow().off();
  assert.equal(count('appearancechange'), 0, 'open and close three times');
});

test('a Theme row that was closed no longer repaints', async () => {
  const { count } = fakePage();
  const { applyAppearance } = await import('../src/client/themes/index.ts');
  const { appearanceRow } = await import('../src/client/ui/appearance.ts');
  const { row, off } = appearanceRow();
  const seg = row[0] as unknown as FakeEl;
  applyAppearance('glossy');
  assert.deepEqual(checked(seg), ['✨ Glossy']);
  off();
  applyAppearance('dark');
  assert.deepEqual(checked(seg), ['✨ Glossy']);
  assert.equal(count('appearancechange'), 0);
});

// openSettings needs the whole window and the office's store, so what is checked is the wiring: its
// onClose calls the row's off(), which the tests above show takes the listener away.
test('⚙️ Settings hands the Theme row\'s off() to its onClose', () => {
  const src = readFileSync(new URL('../src/client/ui/settings.ts', import.meta.url), 'utf8');
  const onClose = src.slice(src.indexOf('onClose: () => {'));
  assert.match(onClose.slice(0, onClose.indexOf('\n    },')), /appearance\.off\b/);
});

test('applying what the page already shows fires no event; a head script that set only data-theme still gets the colour', async () => {
  const { win, root } = fakePage();
  const meta = new FakeEl('meta');
  meta.setAttribute('content', '#fff1de');
  (globalThis.document as unknown as { querySelector: () => FakeEl }).querySelector = () => meta;
  const { applyAppearance } = await import('../src/client/themes/index.ts');
  let changes = 0;
  win.addEventListener('appearancechange', () => changes++);
  root.dataset.theme = 'dark'; // what the head script leaves before the module runs
  applyAppearance('dark');
  assert.equal(meta.getAttribute('content'), '#212121');
  assert.equal(changes, 1);
  applyAppearance('dark');
  applyAppearance('dark');
  assert.equal(changes, 1, 'a repeat is not a change');
  applyAppearance('glossy');
  assert.equal(changes, 2);
});
