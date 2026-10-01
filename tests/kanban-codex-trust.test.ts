import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CODEX_HOOK_EVENTS, codexHookArgs } from '../src/server/codex.js';
import { codexHookTrustArgs, hookTrustHash, officeHookCommand } from '../src/server/kanban/codex-trust.js';
import { kanbanExtraArgs } from '../src/server/kanban/workers.js';
import type { Worker } from '../src/server/workers/types.js';

const label = (e: string) => e.replace(/(?<=[a-z])(?=[A-Z])/g, '_').toLowerCase();

test('codexHookTrustArgs: one -c hooks.state table with a trusted hash per event', () => {
  const args = codexHookTrustArgs('/tmp/floorA/hook.cjs');
  assert.equal(args.length, 2);
  assert.equal(args[0], '-c');
  assert.ok(args[1].startsWith('hooks.state={') && args[1].endsWith('}'));
  const entries = args[1].slice('hooks.state={'.length, -1).split('},');
  assert.equal(entries.length, CODEX_HOOK_EVENTS.length);
  CODEX_HOOK_EVENTS.forEach((e, i) => assert.match(entries[i], new RegExp(`^"/<session-flags>/config\\.toml:${label(e)}:0:0"=\\{trusted_hash="sha256:[0-9a-f]{64}"\\}?$`)));
  assert.notEqual(codexHookTrustArgs('/tmp/floorB/hook.cjs')[1], args[1]);
});

test('the hook command and timeout are the ones codexHookArgs gives', () => {
  const hook = "/tmp/it's a floor/hook.cjs";
  const args = codexHookArgs(hook);
  for (const e of CODEX_HOOK_EVENTS) {
    const config = args[args.findIndex((a) => a.startsWith(`hooks.${e}=`))];
    const m = config.match(/command=("(?:[^"\\]|\\.)*"),timeout=3\}\]\}\]$/);
    assert.ok(m, e);
    assert.equal(JSON.parse(m[1]), officeHookCommand(hook, e));
  }
});

test('hookTrustHash is the sha256 of the key-sorted JSON identity', () => {
  const json = '{"event_name":"stop","hooks":[{"async":false,"command":"\'/n\' \'/h.cjs\' \'Stop\'","timeout":3,"type":"command"}]}';
  assert.equal(hookTrustHash('stop', "'/n' '/h.cjs' 'Stop'"), `sha256:${createHash('sha256').update(json).digest('hex')}`);
});

test('kanbanExtraArgs: a codex task worker gets the trust args before its launch args; others keep theirs', () => {
  const w = (kanban: boolean, launchArgs?: string[]) => ({ info: kanban ? { kanban: { taskId: 1, role: 'impl' } } : {}, extra: launchArgs && { launchArgs } }) as unknown as Worker;
  const setup = { hook: '/tmp/h.cjs' };
  assert.deepEqual(kanbanExtraArgs(w(true, ['-s', 'read-only']), { id: 'codex' }, setup), [...codexHookTrustArgs('/tmp/h.cjs'), '-s', 'read-only']);
  assert.deepEqual(kanbanExtraArgs(w(true), { id: 'codex' }, setup), codexHookTrustArgs('/tmp/h.cjs'));
  assert.deepEqual(kanbanExtraArgs(w(true, ['a']), { id: 'claude' }, setup), ['a']);
  assert.deepEqual(kanbanExtraArgs(w(false, ['a']), { id: 'codex' }, setup), ['a']);
  assert.equal(kanbanExtraArgs(w(false), { id: 'codex' }, setup), undefined);
  assert.deepEqual(kanbanExtraArgs(w(true, ['a']), { id: 'codex' }, undefined), ['a']);
});
