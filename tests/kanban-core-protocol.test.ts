import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMove, columnName, isRunning, moveTargets, type MoveSubject } from '../src/shared/kanban/moves.js';
import { KANBAN_CLIENT_TYPES, KANBAN_LIMITS, isKanbanMsg, parseKanbanClientMsg, ridOf } from '../src/shared/kanban/protocol.js';
import type { KanbanClientMsg } from '../src/shared/kanban/protocol.js';
import { TASK_STATUSES, type TaskStatus } from '../src/shared/kanban/types.js';
import { MAX_REPOS } from '../src/server/workers.js';
import { PROMPT_MAX } from '../src/shared/prompts.js';
import { INSTRUCTIONS_MAX } from '../src/server/kanban/settings.js';
import { KANBAN_PROMPT_IDS } from '../src/shared/kanban/prompts.js';

const at = (status: TaskStatus, over: Partial<MoveSubject> = {}): MoveSubject => ({ status, runState: 'idle', hasWorker: false, ...over });

test('the manual moves are the documented ones', () => {
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    todo: ['in_progress', 'archived'],
    in_progress: [],
    waiting: ['todo', 'done', 'archived'],
    review: ['todo', 'done', 'archived'],
    done: ['review', 'archived'],
    archived: ['done'],
  };
  for (const from of TASK_STATUSES) {
    // in_progress is always running (see isRunning).
    assert.deepEqual(moveTargets(at(from)), allowed[from], from);
  }
  assert.deepEqual(checkMove(at('todo'), 'in_progress'), { ok: true, action: 'start' });
  assert.deepEqual(checkMove(at('review'), 'todo'), { ok: true, action: 'reset' });
  assert.deepEqual(checkMove(at('review'), 'done'), { ok: true, action: 'status' });
  const no = (r: ReturnType<typeof checkMove>) => (r.ok ? '' : r.reason);
  assert.match(no(checkMove(at('todo'), 'done')), /only once it has been worked on/);
  assert.match(no(checkMove(at('done'), 'todo')), /only once it has been worked on/);
  assert.match(no(checkMove(at('review', { hasWorker: true }), 'todo')), /Release/);
  assert.match(no(checkMove(at('waiting', { runState: 'queued' }), 'todo')), /Stop it first/);
  assert.match(no(checkMove(at('waiting', { runState: 'running' }), 'archived')), /Stop it first/);
  assert.match(no(checkMove(at('in_progress'), 'done')), /stop it first/);
  assert.match(no(checkMove(at('review'), 'waiting')), /Only the automation/);
  assert.match(no(checkMove(at('waiting'), 'review')), /Only the automation/);
  assert.match(no(checkMove(at('waiting'), 'in_progress')), /Continue, Retry/);
  assert.match(no(checkMove(at('done'), 'done')), /already in Done/);
  assert.equal(isRunning(at('review', { runState: 'stopping' })), true);
  assert.equal(isRunning(at('review')), false);
  assert.equal(columnName('archived'), 'Archive');
});

const parse = (m: unknown) => parseKanbanClientMsg(m);
const good = (m: unknown): KanbanClientMsg => {
  const r = parse(m);
  assert.notEqual(typeof r, 'string', `refused: ${String(r)}`);
  return r as KanbanClientMsg;
};
const refused = (m: unknown, why: RegExp) => {
  const r = parse(m);
  assert.equal(typeof r, 'string', `accepted: ${JSON.stringify(r)}`);
  assert.match(r as string, why);
};

test('good messages come through rebuilt, without anything the validator did not check', () => {
  assert.deepEqual(good({ t: 'kanban.subscribe', project: null, rid: 'r1', extra: 'dropped' }), { t: 'kanban.subscribe', project: null, rid: 'r1' });
  assert.deepEqual(good({ t: 'kanban.subscribe', project: 'web', includeArchived: true }), { t: 'kanban.subscribe', project: 'web', includeArchived: true });
  assert.deepEqual(good({ t: 'kanban.task.get', id: 3, comments: 0 }), { t: 'kanban.task.get', id: 3, comments: 0 });
  const created = good({
    t: 'kanban.task.create',
    start: true,
    task: { project: 'web', title: '  Fix it  ', description: 'a\r\nb', ticket: ' UYT-1 ', ticketUrl: 'https://x.atlassian.net/browse/UYT-1', repoIds: ['web', 'api', 'web'], tool: 'codex', model: 'gpt-5.1-codex', effort: 'high', usePlan: false, review: { rounds: 3, tool: 'claude', junk: 1 }, tags: [' a ', 'b'], attachmentIds: ['a'.repeat(32)], sneaky: true },
  });
  assert.deepEqual(created, {
    t: 'kanban.task.create',
    start: true,
    task: { project: 'web', title: 'Fix it', description: 'a\nb', ticket: 'UYT-1', ticketUrl: 'https://x.atlassian.net/browse/UYT-1', repoIds: ['web', 'api'], tool: 'codex', model: 'gpt-5.1-codex', effort: 'high', usePlan: false, review: { rounds: 3, tool: 'claude' }, tags: ['a', 'b'], attachmentIds: ['a'.repeat(32)] },
  });
  assert.deepEqual(good({ t: 'kanban.task.update', id: 1, patch: { ticket: '', model: null, goal: '  ', review: null } }), { t: 'kanban.task.update', id: 1, patch: { ticket: null, model: null, goal: null, review: null } });
  assert.deepEqual(good({ t: 'kanban.task.move', id: 1, to: 'done' }), { t: 'kanban.task.move', id: 1, to: 'done' });
  assert.deepEqual(good({ t: 'kanban.task.continue', id: 1, answer: '   ' }), { t: 'kanban.task.continue', id: 1 });
  assert.deepEqual(good({ t: 'kanban.comment.add', id: 1, text: '', attachmentIds: ['b'.repeat(16)] }), { t: 'kanban.comment.add', id: 1, text: '', attachmentIds: ['b'.repeat(16)] });
  assert.deepEqual(good({ t: 'kanban.plan.approve', id: 1, planId: 4 }), { t: 'kanban.plan.approve', id: 1, planId: 4 });
  assert.deepEqual(good({ t: 'kanban.task.pr', id: 1, mode: 'fix' }), { t: 'kanban.task.pr', id: 1, mode: 'fix' });
  assert.deepEqual(good({ t: 'kanban.project.prompt.set', project: 'web', id: 'kanban.pr.create', text: null }), { t: 'kanban.project.prompt.set', project: 'web', id: 'kanban.pr.create', text: null });
  assert.deepEqual(good({ t: 'kanban.secrets.set', jira: { site: 'https://acme.atlassian.net/', email: ' a@b.fi ', token: ' t ' } }), { t: 'kanban.secrets.set', jira: { site: 'acme.atlassian.net', email: 'a@b.fi', token: 't' } });
  assert.deepEqual(good({ t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'acme/web', number: 1 }, { repo: 'ACME/web', number: 1 }, { repo: 'acme/api', number: 2 }] }), { t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'acme/web', number: 1 }, { repo: 'acme/api', number: 2 }] });
  assert.deepEqual(good({ t: 'kanban.pr.bundle', project: 'web', branch: 'gh-1/x' }), { t: 'kanban.pr.bundle', project: 'web', branch: 'gh-1/x' });
  assert.deepEqual(good({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'Web', dir: '/w', primary: true, kind: 'git', remote: 'acme/web' }] }), {
    t: 'kanban.project.repos.set',
    project: 'web',
    repos: [{ id: 'web', name: 'Web', dir: '/w', primary: true, kind: 'git', remote: 'acme/web' }],
  });
  // Every type the protocol has is known to the validator.
  for (const t of ['kanban.unsubscribe', 'kanban.settings.get', 'kanban.meta.get', 'kanban.skills.list', 'kanban.skills.sync']) assert.deepEqual(good({ t }), { t });
  assert.deepEqual(good({ t: 'kanban.project.repo.clone', project: 'web', remote: 'acme/api', name: ' API ' }), { t: 'kanban.project.repo.clone', project: 'web', remote: 'acme/api', name: 'API' });
  // A task started at a desk: a desk or bean bag, never a board agent's kiosk or a meeting chair.
  assert.deepEqual(good({ t: 'kanban.task.start', id: 2, deskId: 'desk-3', x: 1 }), { t: 'kanban.task.start', id: 2, deskId: 'desk-3' });
  assert.deepEqual(good({ t: 'kanban.task.create', task: { project: 'web', title: 'x' }, start: true, deskId: 'beanbag-1' }), { t: 'kanban.task.create', task: { project: 'web', title: 'x' }, start: true, deskId: 'beanbag-1' });
  for (const deskId of ['station-issues', 'meeting-1', 'desk-999', 7, '']) {
    refused({ t: 'kanban.task.start', id: 2, deskId }, /deskId must be a desk/);
    refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x' }, deskId }, /deskId must be a desk/);
  }
  assert.equal(KANBAN_CLIENT_TYPES.size, 35);
});

test("the primary repository's id is its floor's, up to 40 characters, and repoIds take it", () => {
  const floorId = 'a-rather-long-project-name-for-a-floor-1'; // 40 characters, like Building.newDef can make
  assert.equal(floorId.length, 40);
  const m = good({ t: 'kanban.task.create', task: { project: floorId, title: 'x', repoIds: [floorId, 'api'] } });
  assert.deepEqual(m.t === 'kanban.task.create' && m.task.repoIds, [floorId, 'api']);
  assert.ok(good({ t: 'kanban.task.update', id: 1, patch: { repoIds: [floorId] } }));
  assert.ok(good({ t: 'kanban.project.repos.set', project: floorId, repos: [{ id: floorId, name: 'x', dir: '/x', primary: true }] }));
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', repoIds: ['a'.repeat(41)] } }, /repository ids/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', repoIds: ['Web'] } }, /repository ids/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', repoIds: [] } }, /at least one/);
});

test('bad messages are refused with a reason, and their rid is still found for the answer', () => {
  refused({ t: 'move' }, /Not a kanban message/);
  refused({ t: 'kanban.nope' }, /Unknown kanban message/);
  refused({ t: 'kanban.snapshot', project: null, rid: 'x'.repeat(65) }, /rid must be/);
  refused({ t: 'kanban.snapshot', project: null, rid: 5 }, /rid must be/);
  refused({ t: 'kanban.subscribe', project: 'Web Site' }, /floor id/);
  refused({ t: 'kanban.task.get', id: -1 }, /task number/);
  refused({ t: 'kanban.task.get', id: 1.5 }, /task number/);
  refused({ t: 'kanban.task.get', id: '1' }, /task number/);
  refused({ t: 'kanban.task.get', id: 1, comments: 5000 }, /comments must be/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: '   ' } }, /title can't be empty/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x'.repeat(KANBAN_LIMITS.title + 1) } }, /too long/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', tool: 'copilot' } }, /tool must be one of/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', model: '--yolo' } }, /model must be/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', ticketUrl: 'javascript:alert(1)' } }, /http\(s\) URL/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', review: { rounds: 11 } } }, /rounds must be/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', attachmentIds: ['../../etc/passwd'] } }, /attachment ids/);
  refused({ t: 'kanban.task.create', task: { project: 'web', title: 'x', tags: Array(KANBAN_LIMITS.tags + 1).fill('t') } }, /at most/);
  refused({ t: 'kanban.task.update', id: 1, patch: {} }, /Nothing to change/);
  refused({ t: 'kanban.task.update', id: 1, patch: { unknown: 1 } }, /Nothing to change/);
  refused({ t: 'kanban.task.move', id: 1, to: 'later' }, /to must be one of/);
  refused({ t: 'kanban.comment.add', id: 1, text: '  ' }, /comment can't be empty/);
  refused({ t: 'kanban.plan.requestChanges', id: 1, text: '' }, /can't be empty/);
  refused({ t: 'kanban.task.pr', id: 1, mode: 'merge' }, /mode must be/);
  refused({ t: 'kanban.settings.set', settings: [] }, /must be an object/);
  refused({ t: 'kanban.settings.set', settings: { x: 'y'.repeat(KANBAN_LIMITS.settingsJson) } }, /too big/);
  refused({ t: 'kanban.project.prompt.set', project: 'web', id: 'issue.work', text: 'x' }, /kanban prompt id/);
  refused({ t: 'kanban.secrets.set' }, /Nothing to change/);
  refused({ t: 'kanban.secrets.set', apiKey: 'short' }, /at least 16/);
  refused({ t: 'kanban.secrets.set', jira: { site: 'evil.com/x', email: 'a', token: 'b' } }, /host name/);
  refused({ t: 'kanban.pr.review', project: 'web', prs: [] }, /at least one/);
  refused({ t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'nope', number: 1 }] }, /owner\/name/);
  refused({ t: 'kanban.pr.bundle', project: 'web', branch: 'a', ticket: 'b' }, /exactly one/);
  refused({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'Bad Id', name: 'x', dir: '/x' }] }, /needs an id/);
  assert.equal(ridOf({ t: 'kanban.task.get', id: 'x', rid: 'r9' }), 'r9');
  assert.equal(ridOf({ rid: '' }), undefined);
  assert.equal(ridOf(null), undefined);
  assert.equal(isKanbanMsg({ t: 'kanban.x' }), true);
  assert.equal(isKanbanMsg({ t: 'move' }), false);
  assert.equal(isKanbanMsg('kanban.x'), false);
});

test("the validator's limits fit what the rest of the kanban makes", () => {
  // A project's settings full to the brim still fit in one message.
  const texts = 3 * INSTRUCTIONS_MAX + KANBAN_PROMPT_IDS.length * PROMPT_MAX;
  const full = { branchInstructions: 'x'.repeat(INSTRUCTIONS_MAX), generalInstructions: 'x'.repeat(INSTRUCTIONS_MAX), testingInstructions: 'x'.repeat(INSTRUCTIONS_MAX), prompts: Object.fromEntries(KANBAN_PROMPT_IDS.map((id) => [id, 'y\n'.repeat(PROMPT_MAX / 2)])) };
  assert.ok(JSON.stringify(full).length > texts);
  assert.ok(good({ t: 'kanban.project.settings.set', project: 'web', settings: full }));
  assert.ok(KANBAN_LIMITS.settingsJson < 2 * 1024 * 1024, "under the office's WebSocket message limit");
  // Every kanban prompt id passes the id check; a prompt as long as the office allows passes.
  for (const id of KANBAN_PROMPT_IDS) assert.ok(good({ t: 'kanban.project.prompt.set', project: 'web', id, text: 'x' }), id);
  assert.equal(KANBAN_LIMITS.promptText, PROMPT_MAX);
  assert.ok(good({ t: 'kanban.project.prompt.set', project: 'web', id: 'kanban.plan', text: 'x'.repeat(PROMPT_MAX) }));
  // A project's repositories: the primary plus MAX_REPOS others.
  const repos = Array.from({ length: MAX_REPOS + 1 }, (_, i) => ({ id: `r${i}`, name: `r${i}`, dir: `/r${i}`, primary: i === 0 }));
  assert.ok(good({ t: 'kanban.project.repos.set', project: 'web', repos }));
  assert.ok(good({ t: 'kanban.task.create', task: { project: 'web', title: 'x', repoIds: repos.map((r) => r.id) } }));
  // A remote as the office keeps it (owner/name) or as people paste it (a URL).
  assert.ok(good({ t: 'kanban.project.repos.set', project: 'web', repos: [{ id: 'web', name: 'w', dir: '/w', primary: true, remote: `https://github.com/${'o'.repeat(39)}/${'n'.repeat(100)}.git` }] }));
  // Ticket keys as the issue sources make them, for repositories as long as GitHub names go.
  const key = `gh:${'o'.repeat(100)}/${'n'.repeat(100)}#123456`;
  assert.ok(good({ t: 'kanban.task.create', task: { project: 'web', title: 'x', ticket: key } }));
  assert.ok(good({ t: 'kanban.issues.createTask', project: 'web', issueKey: key }));
  assert.ok(good({ t: 'kanban.pr.bundle', project: 'web', ticket: key }));
  // Model ids the adapters take.
  for (const model of ['opus', 'sonnet[1m]', 'claude-opus-4-5-20251101', 'gpt-5.1-codex-max', 'openai/gpt-5']) assert.ok(good({ t: 'kanban.task.create', task: { project: 'web', title: 'x', model } }), model);
});
