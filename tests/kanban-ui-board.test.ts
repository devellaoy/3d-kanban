import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardStats,
  cardRepoIds,
  columnsOf,
  countdown,
  deepLink,
  dropTargets,
  dropZones,
  EMPTY_FILTER,
  filterActive,
  filterIssues,
  matchesFilter,
  needsAttention,
  parseDeepLink,
  phaseBadge,
  pickerRows,
  repoIdFrom,
  sameRepoPick,
  showsRepoChips,
  skillUsage,
  sortCards,
  type BoardFilter,
} from '../src/client/kanban/model.js';
import { checkMove, moveTargets } from '../src/shared/kanban/moves.js';
import { BOARD_COLUMNS, RUN_STATES, TASK_STATUSES, type KanbanProjectInfo, type KanbanTaskCard, type NormalizedIssue, type ProjectSettings } from '../src/shared/kanban/types.js';

function card(id: number, over: Partial<KanbanTaskCard> = {}): KanbanTaskCard {
  return {
    id,
    project: 'web',
    title: `Task ${id}`,
    type: 'implement',
    status: 'todo',
    repoIds: null,
    runState: 'idle',
    reviewRound: 0,
    reviewRounds: 2,
    useReview: true,
    tool: 'claude',
    prs: [],
    tags: [],
    commentCount: 0,
    pendingCount: 0,
    createdBy: 'Ada',
    createdAt: id * 1000,
    updatedAt: id * 1000,
    ...over,
  };
}

const project: KanbanProjectInfo = {
  id: 'web',
  name: 'Web',
  dir: '/code/web',
  repos: [
    { id: 'web', name: 'web', kind: 'git', dir: '/code/web', primary: true, remote: 'acme/web' },
    { id: 'api', name: 'api', kind: 'git', dir: '/code/api', primary: false, remote: 'acme/api' },
  ],
  open: true,
  settings: { maxConcurrent: 2, planApproval: 'auto', issueSources: 0, promptOverrides: 0, reviewRounds: 2 },
};
const f = (over: Partial<BoardFilter> = {}): BoardFilter => ({ ...EMPTY_FILTER, ...over });

test('the search matches #id exactly, and words anywhere in title, ticket, tags and repository names', () => {
  const c = card(12, { title: 'Fix login redirect', ticket: 'UYT-1415', tags: ['auth'], repoIds: ['api'] });
  assert.equal(matchesFilter(c, f({ q: '#12' }), project), true);
  assert.equal(matchesFilter(c, f({ q: '#1' }), project), false, '#1 is task 1, not a prefix of 12');
  assert.equal(matchesFilter(c, f({ q: 'login uyt-1415' }), project), true);
  assert.equal(matchesFilter(c, f({ q: 'auth api' }), project), true);
  assert.equal(matchesFilter(c, f({ q: 'login logout' }), project), false, 'every word has to match');
});

test('the repository filter: a task with no subset works in all of its project’s repositories', () => {
  assert.equal(matchesFilter(card(1, { repoIds: null }), f({ repos: ['api'] }), project), true);
  assert.equal(matchesFilter(card(2, { repoIds: ['web'] }), f({ repos: ['api'] }), project), false);
  assert.equal(matchesFilter(card(3, { repoIds: ['web', 'api'] }), f({ repos: ['api'] }), project), true);
});

test('state, tool and ticket filters', () => {
  const running = card(1, { status: 'in_progress', runState: 'running' });
  const asking = card(2, { status: 'waiting', waitingReason: 'plan_questions' });
  const limited = card(3, { status: 'waiting', waitingReason: 'usage_limit', retryAt: 5000, tool: 'codex' });
  const withPr = card(4, { status: 'review', ticket: 'X-1', prs: [{ repoId: 'web', number: 5, url: 'u', state: 'OPEN' }] });
  const all = [running, asking, limited, withPr];
  const ids = (flt: BoardFilter) => all.filter((c) => matchesFilter(c, flt, project)).map((c) => c.id);
  assert.deepEqual(ids(f({ state: 'running' })), [1]);
  assert.deepEqual(ids(f({ state: 'attention' })), [2], 'a usage-limit wait retries by itself: it doesn’t need you');
  assert.deepEqual(ids(f({ state: 'retrying' })), [3]);
  assert.deepEqual(ids(f({ state: 'has_pr' })), [4]);
  assert.deepEqual(ids(f({ tools: ['codex'] })), [3]);
  assert.deepEqual(ids(f({ ticket: 'with' })), [4]);
  assert.deepEqual(ids(f({ ticket: 'without' })), [1, 2, 3]);
  assert.equal(filterActive(f()), false);
  assert.equal(filterActive(f({ q: '  ' })), false);
  assert.equal(filterActive(f({ ticket: 'with' })), true);
});

test('columns: to do oldest first, waiting ones that need you first, the rest latest change first', () => {
  const todo = sortCards([card(3), card(1), card(2)], 'todo').map((c) => c.id);
  assert.deepEqual(todo, [1, 2, 3]);
  const waiting = sortCards(
    [card(1, { status: 'waiting', waitingReason: 'usage_limit', updatedAt: 1 }), card(2, { status: 'waiting', waitingReason: 'failed', updatedAt: 50 }), card(3, { status: 'waiting', waitingReason: 'plan_approval', updatedAt: 10 })],
    'waiting',
  ).map((c) => c.id);
  assert.deepEqual(waiting, [3, 2, 1]);
  const review = sortCards([card(1, { updatedAt: 5 }), card(2, { updatedAt: 9 })], 'review').map((c) => c.id);
  assert.deepEqual(review, [2, 1]);
});

test('columnsOf keeps to the picked project and puts archived cards in their own column', () => {
  const cards = [card(1), card(2, { project: 'other' }), card(3, { status: 'archived' }), card(4, { status: 'done' })];
  const cols = columnsOf(cards, f(), [project], 'web');
  assert.deepEqual(cols.todo.map((c) => c.id), [1]);
  assert.deepEqual(cols.archived.map((c) => c.id), [3]);
  assert.deepEqual(cols.done.map((c) => c.id), [4]);
  assert.equal(columnsOf(cards, f(), [project], null).todo.length, 2, 'all projects');
  const s = boardStats(cards, null);
  assert.equal(s.total, 3, 'the archive is not on the board');
  assert.equal(s.done, 1);
});

test('drop zones come straight from shared/kanban/moves.ts, for every status and run state', () => {
  for (const status of TASK_STATUSES) {
    for (const runState of RUN_STATES) {
      for (const hasWorker of [false, true]) {
        const c = card(1, { status, runState, workerId: hasWorker ? 'w1' : undefined });
        const subject = { status, runState, hasWorker };
        assert.deepEqual(dropTargets(c), moveTargets(subject));
        for (const z of dropZones(c)) {
          const check = checkMove(subject, z.to);
          assert.equal(z.ok, check.ok, `${status}/${runState}/${hasWorker} → ${z.to}`);
          if (!check.ok) assert.equal(z.reason, check.reason);
        }
        // Every board column but its own, and the archive.
        assert.deepEqual(dropZones(c).map((z) => z.to).sort(), [...BOARD_COLUMNS, 'archived' as const].filter((x) => x !== status).sort());
      }
    }
  }
});

test('the rules the board shows: todo ↔ done never, a reviewer counts as a worker for a reset', () => {
  assert.deepEqual(dropTargets(card(1, { status: 'todo' })), ['in_progress', 'archived']);
  assert.ok(!dropTargets(card(1, { status: 'done' })).includes('todo'));
  assert.ok(dropTargets(card(1, { status: 'review' })).includes('todo'));
  assert.ok(!dropTargets(card(1, { status: 'review', reviewerWorkerId: 'r1' })).includes('todo'));
  assert.deepEqual(dropTargets(card(1, { status: 'in_progress', runState: 'running' })), []);
});

test('the phase badge shows the round only for review and fix', () => {
  assert.deepEqual(phaseBadge(card(1, { phase: 'review', reviewRound: 2, reviewRounds: 3 })), { phase: 'review', round: '2/3' });
  assert.deepEqual(phaseBadge(card(1, { phase: 'fix', reviewRound: 1, reviewRounds: 3 })), { phase: 'fix', round: '1/3' });
  assert.deepEqual(phaseBadge(card(1, { phase: 'plan' })), { phase: 'plan' });
  assert.deepEqual(phaseBadge(card(1, { phase: 'review', reviewRound: 4, reviewRounds: 3 })), { phase: 'review', round: '4/4' }, 'a round by hand past the setting');
  assert.equal(phaseBadge(card(1)), null);
});

test('countdown', () => {
  assert.equal(countdown(10_000, 10_000), 'now');
  assert.equal(countdown(55_000, 10_000), '45 s');
  assert.equal(countdown(10_000 + 245_000, 10_000), '4 min 05 s');
  assert.equal(countdown(2 * 3600_000 + 10 * 60_000, 0), '2 h 10 min');
  assert.equal(countdown(1500, 0, { s: 's', min: 'min', h: 'h', now: 'hetken' }), '2 s');
});

test('needsAttention and repository chips', () => {
  assert.equal(needsAttention(card(1, { status: 'waiting', waitingReason: 'agent_asking' })), true);
  assert.equal(needsAttention(card(1, { status: 'review', waitingReason: 'agent_asking' })), false);
  assert.equal(showsRepoChips(card(1), project), true);
  assert.equal(showsRepoChips(card(1), { repos: [project.repos[0]] }), false);
});

test('deep links: ?task opens it, ?project picks it, and the rest of the query stays', () => {
  assert.deepEqual(parseDeepLink('?task=12&project=web'), { task: 12, project: 'web', settings: false });
  assert.deepEqual(parseDeepLink('?task=abc&project=Bad%20Id&settings=1'), { settings: true });
  assert.equal(deepLink('?x=1', { task: 7 }), '?x=1&task=7');
  assert.equal(deepLink('?task=7&project=web', { task: null }), '?project=web');
  assert.equal(deepLink('?task=7&settings=1', { project: 'api' }), '?task=7&project=api');
  assert.equal(deepLink('?task=7', { task: null }), '');
});

test('issues: chips and search narrow the list', () => {
  const issue = (key: string, over: Partial<NormalizedIssue> = {}): NormalizedIssue => ({ source: 'jira', key, title: key, url: '', body: '', labels: [], updatedAt: '', ...over });
  const items = [issue('UYT-1', { status: 'To Do', labels: ['ai'] }), issue('UYT-2', { status: 'Done', assignee: 'me' }), issue('gh:acme/web#3', { source: 'github-repo', title: 'Login bug', repo: 'acme/web' })];
  const keys = (flt: Partial<Parameters<typeof filterIssues>[1]>) => filterIssues(items, { q: '', source: '', status: '', label: '', assignee: '', ...flt }).map((i) => i.key);
  assert.deepEqual(keys({ source: 'jira' }), ['UYT-1', 'UYT-2']);
  assert.deepEqual(keys({ status: 'Done' }), ['UYT-2']);
  assert.deepEqual(keys({ label: 'ai' }), ['UYT-1']);
  assert.deepEqual(keys({ assignee: 'me' }), ['UYT-2']);
  assert.deepEqual(keys({ q: 'login acme' }), ['gh:acme/web#3']);
});

test('the PR picker lists this PR once, then its bundle, then the others, without repeats', () => {
  const self = { repo: 'acme/web', number: 5, title: 'Web', url: 'u' };
  const bundle = [
    { repo: 'ACME/web', number: 5, url: 'u', title: 'Web', state: 'OPEN' as const },
    { repo: 'acme/api', number: 9, url: 'u', title: 'Api', state: 'OPEN' as const, taskId: 3 },
  ];
  const others = [
    { repo: 'acme/api', number: 9, title: 'Api', url: 'u' },
    { repo: 'acme/docs', number: 1, title: 'Docs', url: 'u' },
  ];
  const rows = pickerRows(self, bundle, others);
  assert.deepEqual(rows.related.map((r) => `${r.repo}#${r.number}`), ['acme/api#9']);
  assert.deepEqual(rows.rest.map((r) => `${r.repo}#${r.number}`), ['acme/docs#1']);
});

test('repository ids for the settings editor are short, valid and unique', () => {
  assert.equal(repoIdFrom('My API', new Set()), 'my-api');
  assert.equal(repoIdFrom('api', new Set(['api'])), 'api-2');
  assert.equal(repoIdFrom('___', new Set()), 'repo');
  assert.match(repoIdFrom('a-really-long-repository-name-here', new Set()), /^[a-z0-9][a-z0-9-]{0,19}$/);
});

test('skill usage lists the projects that pick a skill for a tool', () => {
  const p = (skills: ProjectSettings['skills']): ProjectSettings => ({ branchInstructions: '', generalInstructions: '', testingInstructions: '', maxConcurrent: 2, issueSources: [], prompts: {}, skills });
  const settings = { projects: { web: p({ pr: { claude: ['jopox-pr'] } }), api: p({ review: { codex: ['jopox-pr'] } }), none: p({}) } };
  assert.deepEqual(skillUsage(settings, 'jopox-pr', 'claude'), ['web']);
  assert.deepEqual(skillUsage(settings, 'jopox-pr', 'codex'), ['api']);
});

test("a task's repositories always have the primary one in them, as the engine has it", () => {
  assert.deepEqual(cardRepoIds({ repoIds: null }, project), ['web', 'api']);
  assert.deepEqual(cardRepoIds({ repoIds: ['api'] }, project), ['web', 'api']);
  assert.deepEqual(cardRepoIds({ repoIds: ['web'] }, project), ['web']);
  assert.deepEqual(cardRepoIds({ repoIds: ['api'] }), ['api'], 'without the project there is no primary to add');
});

test('two repository picks that come to the same repositories are no change', () => {
  assert.equal(sameRepoPick(['web', 'api'], ['api'], project), true, 'an old pick without the primary one');
  assert.equal(sameRepoPick(['web', 'api'], null, project), true);
  assert.equal(sameRepoPick(['api', 'web'], ['web', 'api'], project), true);
  assert.equal(sameRepoPick(['web'], null, project), false);
  assert.equal(sameRepoPick(['web'], ['web', 'api'], project), false);
});
