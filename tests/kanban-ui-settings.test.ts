// The kanban's categories in ⚙️ Settings, without the DOM (settingsflow.ts): when the panes redraw as
// the office's settings come in, and that a pane's listeners go when it's drawn again or the window shuts.
// Then ⚙️ Project's name and its Rename button (settings.ts), on a few-line stand-in for the DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Cleanups, Listeners, settingsRedraw } from '../src/client/kanban/settingsflow.js';

test('a page without a board redraws every pane from the first settings after opening, even with a copy kept from before', () => {
  // The 3D office opened Settings before: kstore still holds what was saved then (say archive after 30 days).
  const redraw = settingsRedraw(true, true);
  // The snapshot of this opening (someone set 7 meanwhile) must redraw the forms, not only the secrets.
  assert.equal(redraw(), 'all');
  // Later changes keep what you typed and only say what's configured.
  assert.equal(redraw(), 'secrets');
  assert.equal(redraw(), 'secrets');
});

test('without a copy yet, the first settings draw everything, on any page', () => {
  for (const own of [true, false]) {
    const redraw = settingsRedraw(own, false);
    assert.equal(redraw(), 'all');
    assert.equal(redraw(), 'secrets');
  }
});

test('the kanban page, whose board keeps its copy current, redraws only the secrets', () => {
  const redraw = settingsRedraw(false, true);
  assert.equal(redraw(), 'secrets');
});

test('removing a listener removes that one, and cleanups take them all down once', () => {
  const painters = new Listeners();
  const calls: string[] = [];
  const cleanups = new Cleanups();
  cleanups.add(painters.add(() => calls.push('a')));
  cleanups.add(painters.add(() => calls.push('b')));
  const c = () => calls.push('c');
  const stopC = painters.add(c);
  assert.equal(painters.size, 3);
  painters.call();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  stopC();
  assert.equal(painters.size, 2);
  cleanups.run();
  assert.equal(painters.size, 0);
  assert.equal(cleanups.size, 0);
  // Running again does nothing more.
  cleanups.run();
  painters.call();
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('a listener removed while the others are being called is not called', () => {
  const painters = new Listeners();
  const calls: string[] = [];
  let stopB = () => {};
  painters.add(() => {
    calls.push('a');
    stopB();
  });
  stopB = painters.add(() => calls.push('b'));
  painters.call();
  // Called from a snapshot of the set: b was still in it.
  assert.deepEqual(calls, ['a', 'b']);
  painters.call();
  assert.deepEqual(calls, ['a', 'b', 'a']);
});

// settings.ts imports its stylesheet, which Vite takes and node doesn't: here it's an empty module.
register(`data:text/javascript,${encodeURIComponent("export async function load(url, ctx, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, ctx); }")}`);

/** An element as far as the panes go: attributes, children, and listeners that can be fired. */
class FakeEl {
  className = '';
  id = '';
  title = '';
  value = '';
  checked = false;
  disabled = false;
  tabIndex = 0;
  children: (FakeEl | string)[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  style: Record<string, string> = {};
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
    if (k === 'disabled') this.disabled = true;
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
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  remove() {}
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  /** This element and everything under it. */
  *all(): Generator<FakeEl> {
    yield this;
    for (const c of this.children) if (typeof c !== 'string') yield* c.all();
  }
}

type FixtureRepo = { id: string; name: string; dir: string; primary: boolean; kind: 'git' };

async function projectPaneFixture(admin: boolean, repos: FixtureRepo[] = [{ id: 'shop', name: 'Shop', dir: '/code/shop', primary: true, kind: 'git' }]) {
  const g = globalThis as Record<string, unknown>;
  const toasts = new FakeEl('div');
  g.Node ??= FakeEl;
  g.document ??= { createElement: (tag: string) => new FakeEl(tag), getElementById: (id: string) => (id === 'toasts' ? toasts : null) };
  const { projectPane } = await import('../src/client/kanban/settings.js');
  const { kstore } = await import('../src/client/kanban/store.js');
  const { KANBAN_DEFAULTS, projectDefaults } = await import('../src/client/kanban/defaults.js');
  const info = { id: 'shop', name: 'Shop', dir: '/code/shop', repos, open: true, settings: projectDefaults() };
  kstore.projects = [info] as never;
  kstore.me = { admin, name: 'me' };
  const settings = { ...KANBAN_DEFAULTS, projects: {} } as never;
  const sent: unknown[] = [];
  const api = { request: async (msg: unknown) => void sent.push(msg) };
  const cleanups = new Cleanups();
  const pane = projectPane(api as never, 'shop', settings, cleanups) as unknown as FakeEl;
  const all = [...pane.all()];
  const name = all.find((el) => el.tagName === 'input' && el.getAttribute('aria-label') === 'Project name')!;
  const rename = all.find((el) => el.tagName === 'button' && el.textContent === 'Rename')!;
  const type = (v: string) => {
    name.value = v;
    name.fire('input');
  };
  return { pane, all, name, rename, type, sent, cleanups, kstore, info };
}

test('⚙️ Project names the project, with a Rename of its own that sends the trimmed name', async () => {
  const { all, name, rename, type, sent, cleanups, kstore, info } = await projectPaneFixture(true);
  assert.ok(name, 'a Project name box');
  assert.equal(name.value, 'Shop');
  assert.ok(all.some((el) => el.tagName === 'legend' && el.textContent === 'Project'), 'in a fieldset of its own');
  assert.ok(all.some((el) => el.tagName === 'label' && el.textContent === 'Project name'), 'labelled apart from the repositories’ Name');
  assert.ok(all.some((el) => el.className === 'kb-hint' && /Its id \(shop\), folder and repository stay/.test(el.textContent)), 'says what stays');
  assert.equal(rename.disabled, true, 'nothing to rename yet');
  type('  Shop  ');
  assert.equal(rename.disabled, true, 'the same name, spaced');
  type('   ');
  assert.equal(rename.disabled, true, 'no name');
  type('  Shop & Co ');
  assert.equal(rename.disabled, false);
  rename.fire('click');
  assert.deepEqual(sent, [{ t: 'kanban.project.rename', project: 'shop', name: 'Shop & Co' }]);
  await new Promise((r) => setTimeout(r, 0));
  // The office tells everyone the new name: the box now holds what's saved.
  kstore.apply({ t: 'kanban.projects', projects: [{ ...info, name: 'Shop & Co', repos: [{ ...info.repos[0], name: 'Shop & Co' }] }] } as never);
  assert.equal(rename.disabled, true, 'renamed: unchanged against the live name');
  // The office renamed the primary repository with it: the untouched box follows, so saving the repositories keeps it.
  const primaryName = all.find((el) => el.tagName === 'input' && el.getAttribute('aria-label') === 'Name')!;
  assert.equal(primaryName.value, 'Shop & Co');
  type('Shop');
  assert.equal(rename.disabled, false, 'back to the old name is a change now');
  cleanups.run();
});

test('someone who isn’t an admin can’t rename, even when the projects change', async () => {
  const { rename, cleanups, kstore, info } = await projectPaneFixture(false);
  assert.equal(rename.disabled, true);
  kstore.apply({ t: 'kanban.projects', projects: [{ ...info, name: 'Elsewhere' }] } as never);
  assert.equal(rename.disabled, true);
  cleanups.run();
});

test('a rename the office keeps off the primary repository leaves its box alone, and edits in it stay', async () => {
  const repos: FixtureRepo[] = [
    { id: 'shop', name: 'Shop', dir: '/code/shop', primary: true, kind: 'git' },
    { id: 'api', name: 'API', dir: '/code/api', primary: false, kind: 'git' },
  ];
  const { all, cleanups, kstore, info } = await projectPaneFixture(true, repos);
  const names = all.filter((el) => el.tagName === 'input' && el.getAttribute('aria-label') === 'Name');
  assert.deepEqual(names.map((el) => el.value), ['Shop', 'API']);
  // Renamed to API: the office keeps the primary's Shop, since API is taken.
  kstore.apply({ t: 'kanban.projects', projects: [{ ...info, name: 'API' }] } as never);
  assert.deepEqual(names.map((el) => el.value), ['Shop', 'API'], 'no two repositories called API');
  // Renamed again, and this time the office renames the primary: a box someone typed in keeps what they typed.
  names[0].value = 'Front';
  kstore.apply({ t: 'kanban.projects', projects: [{ ...info, name: 'Store', repos: [{ ...repos[0], name: 'Store' }, repos[1]] }] } as never);
  assert.equal(names[0].value, 'Front');
  cleanups.run();
});

test('⚙️ Project saves its public language: the office’s default, the project’s instructions, or a language of its own', async () => {
  const { all, sent, cleanups } = await projectPaneFixture(true);
  const pick = all.find((el) => el.tagName === 'select' && el.children.some((o) => typeof o !== 'string' && o.getAttribute('value') === '@project'))!;
  assert.ok(pick, 'a Public language select');
  assert.equal(pick.value, '', 'unset: the office’s default');
  const own = all.find((el) => el.tagName === 'input' && el.getAttribute('aria-label') === 'Public language of this project')!;
  const save = all.filter((el) => el.tagName === 'button' && el.textContent === 'Save').pop()!;
  // A save keeps its button off until the office answers.
  const click = () => (save.fire('click'), new Promise((r) => setTimeout(r, 0)));
  const saved = () => (sent.pop() as { settings: { publicLanguage: unknown } }).settings.publicLanguage;
  await click();
  assert.equal(saved(), null, 'the office’s default clears it');
  pick.value = '@project';
  pick.fire('change');
  await click();
  assert.equal(saved(), '@project');
  pick.value = 'other';
  pick.fire('change');
  own.value = '  Brazilian   Portuguese ';
  await click();
  assert.equal(saved(), 'Brazilian Portuguese');
  own.value = 'en; rm -rf';
  await click();
  assert.equal(sent.length, 0, 'not a language: nothing is saved');
  cleanups.run();
});

test('⚙️ Project saves its code comment language: English by default, the project’s conventions, or a language of its own', async () => {
  const { all, sent, cleanups } = await projectPaneFixture(true);
  const pick = all.filter((el) => el.tagName === 'select' && el.children.some((o) => typeof o !== 'string' && o.getAttribute('value') === '@project'))[1]!;
  assert.ok(pick, 'a Code comment language select');
  assert.equal(pick.value, '', 'unset: English');
  const own = all.find((el) => el.tagName === 'input' && el.getAttribute('aria-label') === 'Code comment language of this project')!;
  const save = all.filter((el) => el.tagName === 'button' && el.textContent === 'Save').pop()!;
  const click = () => (save.fire('click'), new Promise((r) => setTimeout(r, 0)));
  const saved = () => (sent.pop() as { settings: { commentLanguage: unknown } }).settings.commentLanguage;
  await click();
  assert.equal(saved(), null, 'the default clears it');
  pick.value = '@project';
  pick.fire('change');
  await click();
  assert.equal(saved(), '@project');
  pick.value = 'other';
  pick.fire('change');
  own.value = ' Finnish ';
  await click();
  assert.equal(saved(), 'Finnish');
  own.value = 'en; rm -rf';
  await click();
  assert.equal(sent.length, 0, 'not a language: nothing is saved');
  cleanups.run();
});
