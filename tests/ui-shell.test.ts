// The shared window shell, tab strip and kit builders (ui/shell.ts, ui/tabs.ts, ui/kit.ts): where the ✕
// sits (openModal looks for it there before adding its own), the footer's two groups, the tabs' ids,
// roving tabindex and arrow keys, and the classes the kit's sheets (styles/kit-*.css) style. A small
// stand-in for the DOM is enough for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  text = '';
  className = '';
  tabIndex = 0;
  listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly tagName: string) {}
  get classes() {
    return this.className.split(/\s+/).filter(Boolean);
  }
  classList = {
    toggle: (c: string, on: boolean) => void (this.className = [...this.classes.filter((x) => x !== c), ...(on ? [c] : [])].join(' ')),
    add: (c: string) => this.classList.toggle(c, true),
  };
  setAttribute(k: string, v: string) {
    if (k === 'class') this.className = v;
    else this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...e });
  }
  append(...c: (FakeEl | string)[]) {
    for (const x of c) {
      if (typeof x === 'string') this.text += x;
      else (x.parent = this), this.children.push(x);
    }
  }
  replaceChildren(...c: FakeEl[]) {
    this.children = [];
    this.text = '';
    this.append(...c);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  focus() {
    focused = this;
  }
  has(cls: string) {
    return this.classes.includes(cls);
  }
}
let focused: FakeEl | null = null;

const g = globalThis as Record<string, unknown>;
g.document = { createElement: (tag: string) => new FakeEl(tag), createElementNS: (_ns: string, tag: string) => new FakeEl(tag), getElementById: () => null };
g.Node = FakeEl;

const { modalShell, shellHead } = await import('../src/client/ui/shell.ts');
const { tabStrip, tabCount } = await import('../src/client/ui/tabs.ts');
const kit = await import('../src/client/ui/kit.ts');
const { dialog } = await import('../src/client/kanban/ui.ts');
const fake = (el: unknown) => el as FakeEl;

test('a simple shell: the ✕ is a child of the header, the body has its main part and no rail or footer', () => {
  const s = modalShell({ cls: 'kb-hold w480', icon: 'circle-pause', title: 'Put on hold', id: '#144', body: 'Why?' });
  const el = fake(s.el);
  assert.deepEqual(el.classes, ['modal', 'shell', 'kb-hold', 'w480']);
  assert.equal(el.getAttribute('role'), 'dialog');
  assert.equal(el.getAttribute('aria-modal'), 'true');
  assert.equal(el.getAttribute('aria-label'), 'Put on hold');
  const head = fake(s.head);
  assert.equal(head.tagName, 'header');
  assert.equal(head.parent, el);
  assert.equal(fake(s.close).parent, head, 'the ✕ sits straight in the header');
  assert.deepEqual(fake(s.close).classes, ['btn', 'close', 'icon-btn']);
  assert.equal(fake(s.close).getAttribute('aria-label'), 'Close');
  assert.equal(fake(s.close).getAttribute('title'), 'Close (Esc)');
  assert.deepEqual(head.children.map((c) => c.tagName), ['svg', 'h2', 'span', 'div', 'button']);
  assert.equal(fake(s.main).textContent, 'Why?');
  assert.equal(s.rail, null);
  assert.equal(s.foot, null);
  s.setTitle('Resume');
  assert.equal(head.children[1].textContent, 'Resume');
  assert.equal(el.getAttribute('aria-label'), 'Resume');
});

test('a rich shell: the ✕ is on the first row, the title on its own line, the tabs last; the footer has two groups', () => {
  const tabs = tabStrip([{ id: 'a', label: 'A' }], 'a', () => {}, 'Sections');
  const s = modalShell({ kind: 'rich', role: 'alertdialog', label: 'Task 144', title: 'A task', id: '#144', pill: kit.pill('waiting'), tools: [kit.btn('Show in 3D', { kind: 'quiet', size: 'sm' })], tabs: tabs.el, rail: [], footerLeft: ['2 of 3'], footerRight: [kit.btn('Approve', { kind: 'primary' })] });
  const head = fake(s.head);
  assert.ok(head.has('rich') && head.has('has-tabs'));
  const row = head.children[0];
  assert.ok(row.has('shell-row'));
  assert.equal(fake(s.close).parent, row, 'the ✕ sits on the header’s first row');
  assert.equal(row.children.at(-1), fake(s.close));
  assert.equal(head.children[1].tagName, 'h2');
  assert.equal(head.children.at(-1), fake(tabs.el));
  assert.equal(fake(s.el).getAttribute('role'), 'alertdialog');
  assert.equal(fake(s.el).getAttribute('aria-label'), 'Task 144');
  assert.ok(fake(s.rail).has('shell-rail'));
  assert.deepEqual(fake(s.foot).children.map((c) => c.className), ['shell-foot-left', 'shell-foot-right']);
  assert.deepEqual(fake(s.foot).children[1].children[0].classes, ['btn', 'primary', 'lg']);
  s.setFooter([], []);
  assert.equal(s.foot, null);
  assert.equal(fake(s.el).children.some((c) => c.tagName === 'footer'), false);
});

test('dialog() keeps its shape on the shell’s header: the caller’s body and footer stay the window’s children', () => {
  const body = new FakeEl('div');
  const foot = new FakeEl('footer');
  const extra = new FakeEl('button');
  const d = dialog('kb-x', 'Title', body as unknown as HTMLElement, foot as unknown as HTMLElement, [extra as unknown as Node]);
  const el = fake(d.el);
  assert.deepEqual(el.classes, ['modal', 'shell', 'kb-x']);
  assert.deepEqual(el.children.map((c) => c.tagName), ['header', 'div', 'footer']);
  assert.equal(fake(d.close).parent, el.children[0]);
  assert.equal(extra.parent?.has('shell-tools'), true);
  assert.ok(shellHead({ title: 'x' }).head);
});

test('the tab strip: ids from the prefix, a label-free data-focus, roving tabindex and arrow keys', () => {
  const picked: string[] = [];
  const s = tabStrip([{ id: 'one', label: 'One' }, { id: 'two', label: ['Two', tabCount(3, true), null] }, { id: 'three', label: 'Three' }], 'one', (id) => picked.push(id), 'Sections', 'wtab');
  const el = fake(s.el);
  assert.deepEqual(el.classes, ['tabs']);
  assert.equal(el.getAttribute('role'), 'tablist');
  const [one, two, three] = el.children;
  assert.deepEqual([one, two, three].map((b) => [b.getAttribute('id'), b.getAttribute('data-focus'), b.getAttribute('role')]), [['wtab-one', 'tab-one', 'tab'], ['wtab-two', 'tab-two', 'tab'], ['wtab-three', 'tab-three', 'tab']]);
  assert.deepEqual([one, two, three].map((b) => [b.has('on'), b.getAttribute('aria-selected'), b.tabIndex]), [[true, 'true', 0], [false, 'false', -1], [false, 'false', -1]]);
  assert.deepEqual(two.children[0].classes, ['tab-n', 'attention']);
  assert.equal(tabCount(0), null);
  one.fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(picked, ['three']);
  assert.equal(focused, three);
  assert.equal(three.tabIndex, 0);
  three.fire('keydown', { key: 'Home' });
  two.fire('click');
  assert.deepEqual(picked, ['three', 'one', 'two']);
  s.set('three');
  assert.deepEqual(picked.length, 3, 'set() does not call onPick');
  assert.equal(fake(tabStrip([{ id: 'a', label: 'A' }], 'a', () => {}, 'x').buttons.get('a')).getAttribute('id'), 'kbtab-a');
});

test('the kit’s builders use classes the kit’s sheets define', () => {
  const css = ['kit-modal', 'kit-controls', 'kit-chips'].map((f) => readFileSync(path.join(import.meta.dirname, `../src/client/styles/${f}.css`), 'utf8')).join('\n');
  const defined = (cls: string) => new RegExp(`\\.${cls.replace(/[-_]/g, '\\$&')}(?![\\w-])`).test(css);
  const walk = (el: FakeEl, out: string[] = []) => (out.push(...el.classes), el.children.forEach((c) => walk(c, out)), out);
  const built = [
    ...(['todo', 'in_progress', 'waiting', 'review', 'on_hold', 'done', 'archived'] as const).map((s) => kit.pill(s)),
    kit.phaseBadge('review', 2),
    ...(['OPEN', 'DRAFT', 'MERGED', 'CLOSED'] as const).map((s) => kit.prPill(s)),
    kit.chip('UYT-1', 'ticket'),
    kit.banner({ icon: 'hand', title: 'Waits', text: 'for you', link: { label: 'Open the plan', onClick() {} }, tone: 'neutral' }),
    kit.detailsRail([{ label: 'Project', value: 'x' }, { label: 'Ticket', value: null }], true),
    ...(['primary', 'secondary', 'quiet', 'danger', 'quiet-danger'] as const).flatMap((kind) => (['lg', 'md', 'sm', 'xs'] as const).map((size) => kit.btn('Go', { kind, size, icon: 'play' }))),
    modalShell({ kind: 'rich', title: 't', id: '#1', tools: ['x'], lines: ['l'], rail: [], footerRight: ['x'] }).el,
    tabStrip([{ id: 'a', label: ['A', tabCount(1)] }], 'a', () => {}, 'x').el,
  ].flatMap((el) => walk(fake(el)));
  // The status and state names ride on a kit class (.st-pill.waiting), as do an icon's own classes.
  const missing = [...new Set(built)].filter((c) => !defined(c) && !['i', 'simple', 'banner-text', 'archived', 'review'].includes(c));
  assert.deepEqual(missing, []);
  assert.equal(fake(kit.phaseBadge('review', 2)).textContent, 'review 2');
  assert.equal(fake(kit.detailsRail([{ label: 'Project', value: 'x' }, { label: 'Ticket', value: null }])).children.length, 2, 'a row without a value is left out');
  assert.doesNotMatch(css, /text-transform:\s*uppercase|!important/, 'the kit upper-cases nothing and never uses !important');
});
