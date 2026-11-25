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
  g.document ??= { createElement: (tag: string) => new FakeEl(tag), createElementNS: (_ns: string, tag: string) => new FakeEl(tag), getElementById: (id: string) => (id === 'toasts' ? toasts : null) };
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
  own.value = '  ';
  await click();
  assert.equal(saved(), null, 'another language with an empty box is back to the default');
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
  own.value = '  ';
  await click();
  assert.equal(saved(), null, 'another language with an empty box is back to the default');
  cleanups.run();
});

/** The select under a field's label, and the hint under that select. */
function permissionField(all: FakeEl[], label: string) {
  const fieldEl = all.find((el) => el.className === 'kb-field' && el.children.some((c) => typeof c !== 'string' && c.tagName === 'label' && c.textContent === label))!;
  assert.ok(fieldEl, `a ${label} field`);
  const kids = fieldEl.children.filter((c): c is FakeEl => typeof c !== 'string');
  const pick = kids.find((c) => c.tagName === 'select')!;
  const hint = kids.find((c) => c.className === 'kb-hint')!;
  const options = pick.children.filter((c): c is FakeEl => typeof c !== 'string').map((o) => [o.getAttribute('value'), o.textContent]);
  const choose = (v: string) => {
    pick.value = v;
    pick.fire('change');
  };
  return { pick, hint, options, choose };
}

test('🗂️ Kanban offers every way the plan and implementation phases run, says what each means per agent, and saves both', async () => {
  const { kstore } = await projectPaneFixture(true);
  const { generalPane } = await import('../src/client/kanban/settings.js');
  const { KANBAN_DEFAULTS } = await import('../src/client/kanban/defaults.js');
  const { PLAN_PERMISSIONS, PLAN_PERMISSION_INFO, IMPLEMENT_PERMISSIONS, IMPLEMENT_PERMISSION_INFO } = await import('../src/shared/kanban/permissions.js');
  kstore.me = { admin: true, name: 'me' };
  const sent: { settings: { defaults: Record<string, unknown> } }[] = [];
  const api = { request: async (msg: never) => void sent.push(msg) };
  const pane = generalPane(api as never, { ...KANBAN_DEFAULTS, projects: {} } as never, false) as unknown as FakeEl;
  const all = [...pane.all()];
  const plan = permissionField(all, 'Plan phase runs');
  const impl = permissionField(all, 'Implementation runs');
  assert.deepEqual(plan.options, PLAN_PERMISSIONS.map((v) => [v, PLAN_PERMISSION_INFO[v].name]));
  assert.deepEqual(impl.options, IMPLEMENT_PERMISSIONS.map((v) => [v, IMPLEMENT_PERMISSION_INFO[v].name]));
  assert.equal(plan.pick.value, 'plan');
  assert.equal(impl.pick.value, 'auto');
  assert.equal(plan.hint.textContent, `Claude: ${PLAN_PERMISSION_INFO.plan.claude} · Codex: ${PLAN_PERMISSION_INFO.plan.codex} · Antigravity: ${PLAN_PERMISSION_INFO.plan.antigravity}`);
  assert.equal(impl.hint.textContent, `Claude: ${IMPLEMENT_PERMISSION_INFO.auto.claude} · Codex: ${IMPLEMENT_PERMISSION_INFO.auto.codex} · Antigravity: ${IMPLEMENT_PERMISSION_INFO.auto.antigravity}`);
  plan.choose('auto');
  impl.choose('workspace-write');
  assert.equal(plan.hint.textContent, `Claude: ${PLAN_PERMISSION_INFO.auto.claude} · Codex: ${PLAN_PERMISSION_INFO.auto.codex} · Antigravity: ${PLAN_PERMISSION_INFO.auto.antigravity}`, 'the hint follows the choice');
  assert.equal(impl.hint.textContent, `Claude: ${IMPLEMENT_PERMISSION_INFO['workspace-write'].claude} · Codex: ${IMPLEMENT_PERMISSION_INFO['workspace-write'].codex} · Antigravity: ${IMPLEMENT_PERMISSION_INFO['workspace-write'].antigravity}`);
  assert.ok(all.some((el) => el.className === 'kb-hint' && /implement, fix, resume and PR phases\. Reviews are not affected/.test(el.textContent)), 'says what implementation covers');
  assert.ok(!all.some((el) => /always read-only/.test(el.className === 'kb-hint' ? el.textContent : '')), 'plans are no longer called read-only');
  const save = all.filter((el) => el.tagName === 'button' && el.textContent === 'Save').pop()!;
  save.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  const { defaults } = sent.pop()!.settings;
  assert.equal(defaults.planPermission, 'auto');
  assert.equal(defaults.implementPermission, 'workspace-write');
});

test('⚙️ Project overrides how the phases run, or leaves them to the office: Default saves null and explains the office’s value', async () => {
  const { all, sent, cleanups } = await projectPaneFixture(true);
  const { PLAN_PERMISSION_INFO, IMPLEMENT_PERMISSION_INFO } = await import('../src/shared/kanban/permissions.js');
  const plan = permissionField(all, 'Plan phase runs');
  const impl = permissionField(all, 'Implementation runs');
  assert.deepEqual(plan.options[0], ['', `Default (${PLAN_PERMISSION_INFO.plan.name})`]);
  assert.deepEqual(impl.options[0], ['', `Default (${IMPLEMENT_PERMISSION_INFO.auto.name})`]);
  assert.deepEqual(plan.options.slice(1).map((o) => o[0]), ['plan', 'auto']);
  assert.deepEqual(impl.options.slice(1).map((o) => o[0]), ['auto', 'bypass', 'workspace-write']);
  assert.equal(plan.pick.value, '');
  assert.equal(impl.hint.textContent, `Claude: ${IMPLEMENT_PERMISSION_INFO.auto.claude} · Codex: ${IMPLEMENT_PERMISSION_INFO.auto.codex} · Antigravity: ${IMPLEMENT_PERMISSION_INFO.auto.antigravity}`, 'Default: what the office’s value means');
  const save = all.filter((el) => el.tagName === 'button' && el.textContent === 'Save').pop()!;
  const click = () => (save.fire('click'), new Promise((r) => setTimeout(r, 0)));
  const saved = () => (sent.pop() as { settings: Record<string, unknown> }).settings;
  await click();
  let settings = saved();
  assert.equal(settings.planPermission, null);
  assert.equal(settings.implementPermission, null);
  plan.choose('auto');
  impl.choose('bypass');
  assert.equal(impl.hint.textContent, `Claude: ${IMPLEMENT_PERMISSION_INFO.bypass.claude} · Codex: ${IMPLEMENT_PERMISSION_INFO.bypass.codex} · Antigravity: ${IMPLEMENT_PERMISSION_INFO.bypass.antigravity}`);
  await click();
  settings = saved();
  assert.equal(settings.planPermission, 'auto');
  assert.equal(settings.implementPermission, 'bypass');
  cleanups.run();
});

/** The additional-reviewers rows: each row's Reviewer, Model and Effort controls, in order; and the buttons. */
function reviewerRows(all: FakeEl[]) {
  const rows = all.filter((el) => el.className === 'kb-repo' && el.all().next() && [...el.all()].some((c) => c.getAttribute('aria-label') === 'Remove this reviewer'));
  const control = (row: FakeEl, label: string) => [...row.all()].find((c) => c.getAttribute('aria-label') === label)!;
  const add = all.find((el) => el.tagName === 'button' && el.textContent === 'Add a reviewer')!;
  return { rows, control, add };
}

test('🗂️ Kanban lists the additional reviewers: add rows, fill them, remove one, and Save sends the list', async () => {
  const { kstore } = await projectPaneFixture(true);
  const { generalPane } = await import('../src/client/kanban/settings.js');
  const { KANBAN_DEFAULTS } = await import('../src/client/kanban/defaults.js');
  kstore.me = { admin: true, name: 'me' };
  const sent: { settings: { review: Record<string, unknown> } }[] = [];
  const api = { request: async (msg: never) => void sent.push(msg) };
  const pane = generalPane(api as never, { ...KANBAN_DEFAULTS, projects: {} } as never, false) as unknown as FakeEl;
  const all = [...pane.all()];
  assert.ok(all.some((el) => el.tagName === 'b' && el.textContent === 'Additional reviewers'));
  assert.ok(all.some((el) => el.className === 'kb-hint' && el.textContent === 'All reviewers review the change at the same time; the main reviewer then combines their results.'));
  const { rows, add } = reviewerRows(all);
  assert.equal(rows.length, 0);
  assert.ok(add.className.includes('kb-admin'));
  const save = all.filter((el) => el.tagName === 'button' && el.textContent === 'Save').pop()!;
  const click = () => (save.fire('click'), new Promise((r) => setTimeout(r, 0)));
  await click();
  assert.deepEqual(sent.pop()!.settings.review.extra, [], 'no rows: an empty list, which clears it on the server');

  // The window draws its rows into the same tree: look again after each click.
  add.fire('click');
  add.fire('click');
  add.fire('click');
  let now = reviewerRows([...pane.all()]);
  assert.equal(now.rows.length, 3);
  const [a, b] = now.rows;
  const toolOf = (r: FakeEl) => now.control(r, 'Reviewer');
  assert.deepEqual([...toolOf(a).children].map((o) => (o as FakeEl).getAttribute('value')), ['claude', 'codex', 'antigravity'], 'every agent is a choice');
  toolOf(a).value = 'codex';
  toolOf(a).fire('change');
  now.control(a, 'Model').value = ' gpt-5 ';
  now.control(a, 'Effort').value = 'high';
  now.control(b, 'Effort').value = 'low';
  await click();
  assert.deepEqual(sent.pop()!.settings.review.extra, [{ tool: 'codex', model: 'gpt-5', effort: 'high' }, { tool: 'claude', effort: 'low' }, { tool: 'claude' }]);

  // Removing a row takes its settings out of the list.
  now.control(b, 'Remove this reviewer').fire('click');
  await click();
  assert.deepEqual(sent.pop()!.settings.review.extra, [{ tool: 'codex', model: 'gpt-5', effort: 'high' }, { tool: 'claude' }]);
});

test('the add button hides at four additional reviewers and comes back when one is removed', async () => {
  const { kstore } = await projectPaneFixture(true);
  const { extraReviewersField } = await import('../src/client/kanban/reviewers-field.js');
  kstore.me = { admin: true, name: 'me' };
  const field = extraReviewersField([{ tool: 'codex' }]);
  const root = field.el as unknown as FakeEl;
  const { add } = reviewerRows([...root.all()]);
  const hidden: boolean[] = [];
  add.classList.toggle = ((_: string, on?: boolean) => void hidden.push(!!on)) as never;
  for (let i = 0; i < 3; i++) add.fire('click');
  assert.deepEqual(hidden, [false, false, true], 'hidden once there are four');
  add.fire('click');
  assert.equal(field.value().length, 4, 'a click while hidden adds nothing');
  const { rows, control } = reviewerRows([...root.all()]);
  control(rows[0], 'Remove this reviewer').fire('click');
  assert.equal(hidden.at(-1), false);
  assert.equal(field.value().length, 3);
  assert.equal(extraReviewersField([{ tool: 'claude' }, { tool: 'claude' }, { tool: 'claude' }, { tool: 'claude' }, { tool: 'claude' }]).value().length, 4, 'a longer list is cut to four');
});

test('⚙️ Project sends its own additional reviewers with its own review settings, and nothing without them', async () => {
  const { pane, all, sent, cleanups } = await projectPaneFixture(true);
  const save = all.filter((el) => el.tagName === 'button' && el.textContent === 'Save').pop()!;
  const click = () => (save.fire('click'), new Promise((r) => setTimeout(r, 0)));
  const saved = () => (sent.pop() as { settings: { review: { extra?: unknown } | null } }).settings;
  await click();
  assert.equal(saved().review, null, 'the override box is off: no review settings, so no list either');
  const own = all.find((el) => el.className === 'kb-check' && el.textContent === 'Its own review settings')!;
  const box = [...own.all()].find((el) => el.tagName === 'input')!;
  box.checked = true;
  box.fire('change');
  const { rows, add, control } = reviewerRows(all);
  assert.equal(rows.length, 0);
  add.fire('click');
  const now = reviewerRows([...pane.all()]);
  assert.equal(now.rows.length, 1);
  control(now.rows[0], 'Reviewer').value = 'codex';
  control(now.rows[0], 'Effort').value = 'medium';
  await click();
  assert.deepEqual(saved().review?.extra, [{ tool: 'codex', effort: 'medium' }]);
  cleanups.run();
});
