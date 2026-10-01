// The Theme row in ⚙️ Settings (ui/appearance.ts) on a few-line stand-in for the DOM: it follows a
// change made in another tab, and clicking the appearance the page left still switches back to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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
  g.Node = FakeEl;
  g.window = win;
  g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    querySelector: () => null,
    documentElement: { dataset: {} as Record<string, string>, style: {} },
  };
  return { storage, win, root: (g.document as { documentElement: { dataset: Record<string, string> } }).documentElement };
}

const checked = (seg: FakeEl) => (seg.children as FakeEl[]).filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent);

test('the Theme row follows a change made in another tab, and clicking the old one switches back', async () => {
  const { storage, win, root } = fakePage();
  const { APPEARANCE_KEY, applyAppearance } = await import('../src/client/themes/index.ts');
  const { appearanceRow } = await import('../src/client/ui/appearance.ts');
  const [seg] = appearanceRow() as unknown as [FakeEl, FakeEl];
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

test('a Theme row that has left the page stops listening', async () => {
  const { win } = fakePage();
  const { applyAppearance } = await import('../src/client/themes/index.ts');
  const { appearanceRow } = await import('../src/client/ui/appearance.ts');
  const [seg] = appearanceRow() as unknown as [FakeEl, FakeEl];
  seg.isConnected = true;
  applyAppearance('glossy');
  assert.deepEqual(checked(seg), ['✨ Glossy']);
  seg.isConnected = false;
  applyAppearance('dark'); // notices it is gone and unhooks
  applyAppearance('default');
  assert.deepEqual(checked(seg), ['✨ Glossy']);
  void win;
});
