// ⚙️ Settings → 🤖 Workers' languages (ui/language.ts), on a few-line stand-in for the DOM: what they
// show from the office's state and what Save sends.

import test from 'node:test';
import assert from 'node:assert/strict';

class FakeEl {
  className = '';
  value = '';
  disabled = false;
  children: (FakeEl | string)[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, ((e: unknown) => void)[]>();
  classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  style: Record<string, string> = {};
  remove() {}
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
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, e: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.children = [v];
  }
  *all(): Generator<FakeEl> {
    yield this;
    for (const c of this.children) if (typeof c !== 'string') yield* c.all();
  }
}

async function rows(admin: boolean) {
  const g = globalThis as Record<string, unknown>;
  const toasts = new FakeEl('div');
  g.Node ??= FakeEl;
  g.document ??= { createElement: (tag: string) => new FakeEl(tag), getElementById: (id: string) => (id === 'toasts' ? toasts : null) };
  const { languageRows } = await import('../src/client/ui/language.js');
  const { store } = await import('../src/client/state/index.js');
  store.me = { ...store.me, admin };
  store.prompts = { custom: {}, language: { talk: 'Finnish', by: 'Ada', at: Date.now() } };
  const sent: unknown[] = [];
  const made = languageRows({ send: (m: unknown) => sent.push(m) } as never);
  const all = made.rows.flatMap((r) => [...(r as unknown as FakeEl).all()]);
  const input = (label: string) => all.find((el) => el.tagName === 'input' && el.getAttribute('aria-label') === label)!;
  return { talk: input('Conversation language'), pub: input('Public language'), save: all.find((el) => el.tagName === 'button' && el.textContent === 'Save')!, all, sent, store, off: made.off };
}

test('the Workers pane shows the office’s languages and Save sends them, null when both are cleared', async () => {
  const { talk, pub, save, all, sent, store, off } = await rows(true);
  assert.equal(talk.value, 'Finnish');
  assert.equal(pub.value, '');
  assert.equal(talk.disabled, false);
  assert.ok(all.some((el) => el.tagName === 'datalist' && el.getAttribute('id') === talk.getAttribute('list')), 'suggests languages');
  pub.value = ' English ';
  pub.fire('input');
  save.fire('click');
  assert.deepEqual(sent.pop(), { t: 'prompts.language', language: { talk: 'Finnish', public: 'English' } });
  talk.value = '';
  pub.value = '';
  talk.fire('input');
  save.fire('click');
  assert.deepEqual(sent.pop(), { t: 'prompts.language', language: null });
  talk.value = '42';
  talk.fire('input');
  save.fire('click');
  assert.equal(sent.length, 0, 'not a language: nothing is sent');
  // Saved: the boxes follow the office again.
  talk.value = '';
  pub.value = 'Swedish';
  save.fire('click');
  sent.pop();
  store.prompts = { custom: {}, language: { public: 'Swedish', by: 'Ada', at: Date.now() } };
  store.emit('prompts');
  assert.equal(talk.value, '');
  assert.equal(pub.value, 'Swedish');
  off();
});

test('someone who isn’t an admin sees the languages but can’t change them', async () => {
  const { talk, pub, all, off } = await rows(false);
  assert.equal(talk.value, 'Finnish');
  assert.equal(talk.disabled, true);
  assert.equal(pub.disabled, true);
  assert.ok(all.some((el) => /Admins can change them/.test(el.textContent)));
  off();
});
