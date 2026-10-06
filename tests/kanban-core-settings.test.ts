import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KanbanSettingsStore,
  DEFAULT_REVIEW,
  defaultKanbanSettings,
  sanitizeIssueSource,
  sanitizeKanbanSettings,
  sanitizePartialReview,
  sanitizeProjectSettings,
  sanitizeReview,
  sanitizeSkillSelection,
} from '../src/server/kanban/settings.js';
import { KanbanSecrets, hashApiKey } from '../src/server/kanban/secrets.js';
import { MAX_JIRA_CONNECTIONS, jiraSourcesProblem } from '../src/shared/kanban/jira-connections.js';
import { PROMPT_MAX } from '../src/shared/prompts.js';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-core-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const mode = (file: string) => statSync(file).mode & 0o777;

test('a missing or broken settings file is the defaults', () => {
  assert.deepEqual(sanitizeKanbanSettings(undefined), defaultKanbanSettings());
  assert.deepEqual(sanitizeKanbanSettings('nonsense'), defaultKanbanSettings());
  assert.deepEqual(sanitizeKanbanSettings([1, 2]), defaultKanbanSettings());
  assert.equal(defaultKanbanSettings().archiveAfterDays, 30);
});

test('every field is clamped or dropped into range', () => {
  const s = sanitizeKanbanSettings({
    schemaVersion: 99,
    defaults: { tool: 'copilot', model: '--dangerous', effort: 'huge', usePlan: 'yes', planApproval: 'manual', implementPermission: 'workspace-write' },
    review: { tool: 'codex', rounds: 0, reReviewLastFix: false, sandbox: 'no', model: 'gpt-5.1-codex', effort: 'xhigh' },
    autoResume: { enabled: false, maxAttempts: 500, maxWaitHours: 0 },
    archiveAfterDays: -4,
    projects: { 'Not An Id': {}, web: { maxConcurrent: 99, planApproval: 'sometimes' } },
  });
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.defaults.tool, 'claude');
  assert.equal(s.defaults.model, undefined, 'a model that looks like a flag is dropped');
  assert.equal(s.defaults.effort, undefined);
  assert.equal(s.defaults.usePlan, true);
  assert.equal(s.defaults.planApproval, 'manual');
  assert.equal(s.defaults.implementPermission, 'workspace-write');
  assert.deepEqual(s.review, { tool: 'codex', rounds: 1, reReviewLastFix: false, sandbox: true, model: 'gpt-5.1-codex', effort: 'xhigh' });
  assert.deepEqual(s.autoResume, { enabled: false, maxAttempts: 50, maxWaitHours: 1 });
  assert.equal(s.archiveAfterDays, 0);
  assert.deepEqual(Object.keys(s.projects), ['web']);
  assert.equal(s.projects.web.maxConcurrent, 20);
  assert.equal(s.projects.web.planApproval, undefined);
  assert.equal(sanitizeKanbanSettings({ archiveAfterDays: 1e9 }).archiveAfterDays, 3650);
  assert.equal(sanitizeReview({ rounds: 11.6 }).rounds, 10);
  assert.equal(sanitizeReview({ rounds: 2.4 }).rounds, 2);
  assert.equal(sanitizePartialReview({ nothing: 1 }), undefined);
  assert.deepEqual(sanitizePartialReview({ rounds: 40, tool: 'codex', sandbox: false }), { rounds: 10, tool: 'codex', sandbox: false });
});

test('project settings: texts capped, issue sources checked, prompts only the kanban ones', () => {
  const p = sanitizeProjectSettings({
    branchInstructions: 'x'.repeat(30_000),
    generalInstructions: 'a\r\nb',
    issueSources: [
      { kind: 'github-repo', repos: ['acme/web', 'not a repo'], filters: { labels: ['bug', ''], state: 'weird' } },
      { kind: 'github-project', owner: 'acme', number: 3, filters: {} },
      { kind: 'github-project', owner: 'acme' },
      { kind: 'jira', site: 'https://acme.atlassian.net/', projectKeys: ['UYT', 'bad-key'], filters: { jql: 'x'.repeat(5000) } },
      { kind: 'gitlab' },
    ],
    prompts: { 'kanban.plan': 'Plan it\r\n', 'issue.work': 'not ours', 'kanban.review': 'r'.repeat(PROMPT_MAX + 10) },
    skills: { plan: { claude: ['kanban-task-refs', '--x', 'kanban-task-refs'] }, deploy: { claude: ['x'] } },
  });
  assert.equal(p.branchInstructions.length, 20_000);
  assert.equal(p.generalInstructions, 'a\nb');
  assert.equal(p.issueSources.length, 3);
  const [gh, proj, jira] = p.issueSources;
  assert.equal(gh.kind, 'github-repo');
  assert.deepEqual(gh.kind === 'github-repo' && gh.repos, ['acme/web']);
  assert.deepEqual(gh.filters, { labels: ['bug'] });
  assert.ok(/^src-/.test(gh.id), 'a source without an id gets one');
  assert.equal(proj.kind, 'github-project');
  assert.equal(jira.kind === 'jira' && jira.site, 'acme.atlassian.net');
  assert.deepEqual(jira.kind === 'jira' && jira.projectKeys, ['UYT']);
  assert.equal(jira.kind === 'jira' && jira.filters.jql?.length, 2000);
  assert.deepEqual(Object.keys(p.prompts), ['kanban.plan', 'kanban.review']);
  assert.equal(p.prompts['kanban.plan'], 'Plan it\n');
  assert.equal(p.prompts['kanban.review']?.length, PROMPT_MAX);
  assert.deepEqual(p.skills, { plan: { claude: ['kanban-task-refs'] } });
  assert.deepEqual(sanitizeSkillSelection({ review: { codex: [] } }), {});
  assert.equal(sanitizeIssueSource({ kind: 'jira', site: 'evil.com/path' }), undefined);
});

test('the settings file is saved privately, reloaded, and changed a part at a time', (t) => {
  const dir = scratch(t);
  const heard: number[] = [];
  const store = new KanbanSettingsStore(dir, (s) => heard.push(s.review.rounds));
  store.set({ review: { rounds: 4 } as never, defaults: { model: 'opus' } as never });
  assert.equal(store.get().review.rounds, 4);
  assert.equal(store.get().review.tool, 'claude', 'the rest of the review setting stays');
  assert.equal(store.get().defaults.model, 'opus');
  assert.deepEqual(heard, [4]);
  // Windows does not represent POSIX owner-only permission bits.
  if (process.platform !== 'win32') assert.equal(mode(store.file), 0o600);
  // A copy: changing what get() gave changes nothing.
  store.get().review.rounds = 9;
  assert.equal(store.get().review.rounds, 4);
  // null clears an optional field.
  store.set({ defaults: { model: null } as never });
  assert.equal(store.get().defaults.model, undefined);
  store.set({ archiveAfterDays: 7 });

  store.setProject('web', { maxConcurrent: 3, review: { rounds: 5 }, planApproval: 'manual' });
  assert.equal(store.project('web').maxConcurrent, 3);
  assert.equal(store.planApproval('web'), 'manual');
  assert.equal(store.planApproval('api'), 'auto');
  assert.equal(store.effectiveReview('web').rounds, 5);
  assert.equal(store.effectiveReview('web', { review: { rounds: 1, tool: 'codex' } }).tool, 'codex');
  assert.equal(store.effectiveReview('api').rounds, 4);
  store.setProject('web', { planApproval: null } as never);
  assert.equal(store.planApproval('web'), 'auto');
  // A project's public language: cleaned, kept across other changes, @project kept, null clears.
  assert.equal(store.project('web').publicLanguage, undefined);
  store.setProject('web', { publicLanguage: '  English ' });
  assert.equal(store.project('web').publicLanguage, 'English');
  store.setProject('web', { maxConcurrent: 4 });
  assert.equal(store.project('web').publicLanguage, 'English', 'left alone by other changes');
  store.setProject('web', { publicLanguage: '@project' });
  assert.equal(store.project('web').publicLanguage, '@project');
  assert.equal(new KanbanSettingsStore(dir).project('web').publicLanguage, '@project', 'survives a reload');
  assert.match(String(store.setProject('web', { publicLanguage: 'rm -rf /; Finnish' })), /isn't a language name/);
  assert.equal(store.project('web').publicLanguage, '@project', 'not a language: the earlier choice stays');
  assert.match(String(store.setProject('web', { publicLanguage: 12, maxConcurrent: 9 } as never)), /isn't a language name/);
  assert.notEqual(store.project('web').maxConcurrent, 9, 'nothing is saved');
  assert.equal(store.project('web').publicLanguage, '@project');
  store.setProject('web', { publicLanguage: 'Swedish' });
  store.setProject('web', { publicLanguage: null } as never);
  assert.equal(store.project('web').publicLanguage, undefined, 'null clears it');
  assert.equal(store.project('web').commentLanguage, undefined, 'English by default: nothing stored');
  store.setProject('web', { commentLanguage: ' Finnish ' });
  assert.equal(store.project('web').commentLanguage, 'Finnish');
  assert.match(String(store.setProject('web', { commentLanguage: 'x; drop' })), /isn't a language name/);
  assert.match(String(store.setProject('web', { commentLanguage: 7 } as never)), /isn't a language name/);
  assert.equal(store.project('web').commentLanguage, 'Finnish', 'not a language: the earlier choice stays');
  store.setProject('web', { commentLanguage: '@project' });
  assert.equal(new KanbanSettingsStore(dir).project('web').commentLanguage, '@project');
  store.setProject('web', { commentLanguage: null } as never);
  assert.equal(store.project('web').commentLanguage, undefined, 'null clears it');
  store.setProject('web', { maxConcurrent: 3 });
  assert.equal(store.project('web').maxConcurrent, 3, 'what was not given stays');
  assert.throws(() => store.setProject('Bad Id', {}), /Not a project id/);

  assert.equal(store.setProjectPrompt('web', 'issue.work', 'x'), 'Only kanban prompts can be overridden per project');
  assert.match(store.setProjectPrompt('web', 'kanban.plan', 'x'.repeat(PROMPT_MAX + 1)) ?? '', /at most/);
  assert.equal(store.setProjectPrompt('web', 'kanban.plan', '  Plan carefully  '), undefined);
  assert.equal(store.project('web').prompts['kanban.plan'], 'Plan carefully');

  const again = new KanbanSettingsStore(dir);
  assert.equal(again.get().archiveAfterDays, 7);
  assert.equal(again.project('web').prompts['kanban.plan'], 'Plan carefully');
  again.setProjectPrompt('web', 'kanban.plan', null);
  assert.equal(again.project('web').prompts['kanban.plan'], undefined);
  again.removeProject('web');
  assert.equal(again.get().projects.web, undefined);

  writeFileSync(store.file, '{ broken');
  assert.deepEqual(new KanbanSettingsStore(dir).get(), defaultKanbanSettings());
});

test('secrets are kept in a file only the office can read, and never handed out', (t) => {
  const dir = scratch(t);
  const secrets = new KanbanSecrets(dir);
  assert.deepEqual(secrets.status(), { jira: [], apiKey: { configured: false } });
  const added = secrets.setJiraConnection({ name: 'Acme', site: 'acme.atlassian.net', email: 'ada@acme.fi', token: 'tok-SECRET' });
  assert.ok(typeof added !== 'string' && added.jira.length === 1);
  const status = secrets.set({ apiKey: 'k'.repeat(20) });
  assert.deepEqual(status, { jira: [{ id: secrets.jiraConnections()[0].id, name: 'Acme', site: 'acme.atlassian.net', configured: true }], apiKey: { configured: true } });
  assert.match(secrets.jiraConnections()[0].id, /^jc-[a-z0-9]+$/);
  assert.ok(!JSON.stringify(status).includes('SECRET'));
  assert.ok(!JSON.stringify(status).includes('ada@acme.fi'));
  if (process.platform !== 'win32') assert.equal(mode(secrets.file), 0o600);
  // The /api/v1 key is kept hashed.
  const file = readFileSync(secrets.file, 'utf8');
  assert.ok(!file.includes('k'.repeat(20)));
  assert.ok(file.includes(hashApiKey('k'.repeat(20))));
  assert.equal(secrets.checkApiKey('k'.repeat(20)), true);
  assert.equal(secrets.checkApiKey('k'.repeat(19)), false);
  assert.equal(secrets.checkApiKey(undefined), false);

  const again = new KanbanSecrets(dir);
  assert.equal(again.jiraConnections()[0].token, 'tok-SECRET');
  assert.equal(again.checkApiKey('k'.repeat(20)), true);
  // What isn't given stays; null clears.
  again.set({ apiKey: null });
  assert.equal(again.status().apiKey.configured, false);
  assert.equal(again.status().jira.length, 1);

  // A key saved before hashing still works.
  writeFileSync(secrets.file, JSON.stringify({ apiKey: 'plain-key-from-before' }));
  assert.equal(new KanbanSecrets(dir).checkApiKey('plain-key-from-before'), true);
});

test('a file with the one legacy Jira login becomes a connection with the stable id "jira", and is written the new way', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'kanban-secrets.json');
  writeFileSync(file, JSON.stringify({ jira: { site: 'https://x.atlassian.net/', email: 'a@x.fi', token: 'old-TOKEN' }, apiKey: 'sha256:abc' }));
  const secrets = new KanbanSecrets(dir);
  assert.deepEqual(secrets.jiraConnections(), [{ id: 'jira', name: 'x.atlassian.net', site: 'x.atlassian.net', email: 'a@x.fi', token: 'old-TOKEN' }]);
  assert.deepEqual(secrets.status().jira, [{ id: 'jira', name: 'x.atlassian.net', site: 'x.atlassian.net', configured: true }]);
  // The next write has the list and no legacy field.
  secrets.set({});
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.jira, undefined);
  assert.equal(written.jiraConnections.length, 1);
  assert.equal(written.apiKey, 'sha256:abc');
  if (process.platform !== 'win32') assert.equal(mode(file), 0o600);
  // An invalid legacy login (no token) is nothing.
  writeFileSync(file, JSON.stringify({ jira: { site: 'x.atlassian.net', email: 'a', token: '' } }));
  assert.deepEqual(new KanbanSecrets(dir).jiraConnections(), []);
});

test('Jira connections: edit keeps what is not given, a new site needs its token, remove, the limit, and an empty list stays empty', (t) => {
  const dir = scratch(t);
  const secrets = new KanbanSecrets(dir);
  assert.match(String(secrets.setJiraConnection({ name: 'x', site: 'a.atlassian.net' })), /needs the e-mail and the API token/);
  assert.match(String(secrets.setJiraConnection({ name: 'x', site: 'not a host', email: 'e', token: 't' })), /host name/);
  assert.match(String(secrets.setJiraConnection({ id: 'nope', name: 'x', site: 'a.atlassian.net' })), /No such Jira connection/);
  secrets.setJiraConnection({ name: '', site: 'https://A.atlassian.net/', email: 'e@a.fi', token: 'tok-A' });
  const id = secrets.jiraConnections()[0].id;
  assert.equal(secrets.jiraConnections()[0].name, 'A.atlassian.net', 'no name: the site');
  // Rename; the e-mail and the token stay. The same site in another case is the same site.
  secrets.setJiraConnection({ id, name: 'Customer A', site: 'a.ATLASSIAN.net' });
  assert.deepEqual(secrets.jiraConnections()[0], { id, name: 'Customer A', site: 'a.ATLASSIAN.net', email: 'e@a.fi', token: 'tok-A' });
  // A new site without the token is refused and nothing changes; with it, the whole connection moves.
  assert.match(String(secrets.setJiraConnection({ id, name: 'Customer A', site: 'b.atlassian.net', email: 'other@b.fi' })), /needs the API token again/);
  assert.equal(secrets.jiraConnections()[0].site, 'a.ATLASSIAN.net');
  assert.equal(secrets.jiraConnections()[0].email, 'e@a.fi');
  secrets.setJiraConnection({ id, name: 'Customer B', site: 'b.atlassian.net', token: 'tok-B' });
  assert.deepEqual(secrets.jiraConnections()[0], { id, name: 'Customer B', site: 'b.atlassian.net', email: 'e@a.fi', token: 'tok-B' });
  // The copies the store hands out are not its own.
  secrets.jiraConnections()[0].token = 'changed';
  assert.equal(secrets.jiraConnections()[0].token, 'tok-B');

  // Up to the limit.
  for (let i = 1; i < MAX_JIRA_CONNECTIONS; i++) assert.equal(typeof secrets.setJiraConnection({ name: `c${i}`, site: `c${i}.atlassian.net`, email: 'e', token: 't' }), 'object');
  assert.match(String(secrets.setJiraConnection({ name: 'one more', site: 'z.atlassian.net', email: 'e', token: 't' })), /20 Jira connections at most/);
  assert.equal(new KanbanSecrets(dir).jiraConnections().length, MAX_JIRA_CONNECTIONS);

  // Remove; the last one's removal is not undone by a restart, even from a legacy file.
  assert.match(String(secrets.removeJiraConnection('nope')), /No such Jira connection/);
  for (const c of secrets.jiraConnections()) secrets.removeJiraConnection(c.id);
  assert.deepEqual(secrets.status().jira, []);
  assert.deepEqual(JSON.parse(readFileSync(secrets.file, 'utf8')), { jiraConnections: [] });
  assert.deepEqual(new KanbanSecrets(dir).status().jira, []);
});

test('a hand-edited secrets file keeps only sound connections: no duplicate ids, a real site, a token', (t) => {
  const dir = scratch(t);
  const ok = { id: 'a', name: '  ', site: 'https://a.atlassian.net', email: 'e', token: 't' };
  writeFileSync(path.join(dir, 'kanban-secrets.json'), JSON.stringify({ jiraConnections: [ok, { ...ok, site: 'dup.atlassian.net' }, { ...ok, id: 'b', token: '' }, { ...ok, id: 'c', site: 'evil.com/x' }, { ...ok, id: 'bad id!' }, 7] }));
  assert.deepEqual(new KanbanSecrets(dir).jiraConnections(), [{ id: 'a', name: 'a.atlassian.net', site: 'a.atlassian.net', email: 'e', token: 't' }]);
});

test('a Jira source keeps its connection id when it is one, and its site is cleaned', () => {
  const s = sanitizeIssueSource({ kind: 'jira', site: 'https://A.atlassian.net/', projectKeys: ['DEV'], connection: 'jc-1', filters: {} });
  assert.deepEqual(s && s.kind === 'jira' && [s.site, s.connection], ['A.atlassian.net', 'jc-1']);
  const bad = sanitizeIssueSource({ kind: 'jira', site: 'a.atlassian.net', projectKeys: [], connection: '../x', filters: {} });
  assert.ok(bad && !('connection' in bad));
});

test('Jira sources over several sites must each name their project keys', (t) => {
  const store = new KanbanSettingsStore(scratch(t));
  const src = (site: string, id: string, keys: string[]) => ({ kind: 'jira', id, site, projectKeys: keys, filters: {} });
  const err = store.setProject('web', { issueSources: [src('a.atlassian.net', 's1', []), src('b.atlassian.net', 's2', ['OPS'])] } as never);
  assert.match(String(err), /without project keys can't sit beside sources on another site \(a\.atlassian\.net, b\.atlassian\.net\): give it project keys/);
  assert.deepEqual(store.project('web').issueSources, []);
  assert.match(String(store.setProject('web', { issueSources: [src('a.atlassian.net', 's1', ['DEV']), src('b.atlassian.net', 's2', [])] } as never)), /without project keys/);
  assert.equal(typeof store.setProject('web', { issueSources: [src('a.atlassian.net', 's1', []), src('A.atlassian.net', 's2', [])] } as never), 'object', 'one site: keys are optional');
  assert.equal(typeof store.setProject('web', { issueSources: [src('a.atlassian.net', 's1', ['DEV']), src('b.atlassian.net', 's2', ['OPS'])] } as never), 'object');
  // The same check the browser makes before asking.
  assert.equal(jiraSourcesProblem([{ kind: 'github-repo' }, { kind: 'jira', site: 'a.atlassian.net', projectKeys: [] }]), undefined);
  assert.match(String(jiraSourcesProblem([{ kind: 'jira', site: 'a.atlassian.net', projectKeys: ['X'] }, { kind: 'jira', site: 'b.atlassian.net', projectKeys: ['X'] }])), /key X is in sources on two sites/);
});

test('setProject refuses one Jira project key on two sites, and allows it twice on one', (t) => {
  const store = new KanbanSettingsStore(scratch(t));
  const src = (site: string, id: string, key = 'DEV') => ({ kind: 'jira', id, site, projectKeys: [key], filters: {} });
  const err = store.setProject('web', { issueSources: [src('a.atlassian.net', 's1'), src('b.atlassian.net', 's2')] } as never);
  assert.match(String(err), /Jira project key DEV is in sources on two sites \(a\.atlassian\.net, b\.atlassian\.net\)/);
  assert.deepEqual(store.project('web').issueSources, [], 'nothing was saved');
  assert.equal(typeof store.setProject('web', { issueSources: [src('a.atlassian.net', 's1'), src('A.atlassian.net', 's2')] } as never), 'object', 'the same site, in any case');
  assert.equal(typeof store.setProject('web', { issueSources: [src('a.atlassian.net', 's1'), src('b.atlassian.net', 's2', 'OPS')] } as never), 'object', 'other keys');
  assert.equal(store.project('web').issueSources.length, 2);
});

test('the last fix is not re-reviewed by default: the rounds set are all the reviews a task gets', () => {
  assert.equal(DEFAULT_REVIEW.reReviewLastFix, false);
  assert.equal(sanitizeReview({}).reReviewLastFix, false);
  assert.equal(defaultKanbanSettings().review.reReviewLastFix, false);
  assert.equal(sanitizeReview({ reReviewLastFix: true }).reReviewLastFix, true, 'a saved choice still wins');
});
