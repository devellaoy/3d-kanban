import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KanbanSecrets,
  KanbanSettingsStore,
  defaultKanbanSettings,
  hashApiKey,
  sanitizeIssueSource,
  sanitizeKanbanSettings,
  sanitizePartialReview,
  sanitizeProjectSettings,
  sanitizeReview,
  sanitizeSkillSelection,
} from '../src/server/kanban/settings.js';
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
  assert.equal(mode(store.file), 0o600);
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
  assert.deepEqual(secrets.status(), { jira: { configured: false }, apiKey: { configured: false } });
  const status = secrets.set({ jira: { site: 'acme.atlassian.net', email: 'ada@acme.fi', token: 'tok-SECRET' }, apiKey: 'k'.repeat(20) });
  assert.deepEqual(status, { jira: { configured: true, site: 'acme.atlassian.net' }, apiKey: { configured: true } });
  assert.ok(!JSON.stringify(status).includes('SECRET'));
  assert.ok(!JSON.stringify(status).includes('ada@acme.fi'));
  assert.equal(mode(secrets.file), 0o600);
  // The /api/v1 key is kept hashed.
  const file = readFileSync(secrets.file, 'utf8');
  assert.ok(!file.includes('k'.repeat(20)));
  assert.ok(file.includes(hashApiKey('k'.repeat(20))));
  assert.equal(secrets.checkApiKey('k'.repeat(20)), true);
  assert.equal(secrets.checkApiKey('k'.repeat(19)), false);
  assert.equal(secrets.checkApiKey(undefined), false);

  const again = new KanbanSecrets(dir);
  assert.equal(again.jira()?.token, 'tok-SECRET');
  assert.equal(again.checkApiKey('k'.repeat(20)), true);
  // What isn't given stays; null clears.
  again.set({ apiKey: null });
  assert.equal(again.status().apiKey.configured, false);
  assert.equal(again.status().jira.configured, true);
  again.set({ jira: null });
  assert.equal(new KanbanSecrets(dir).status().jira.configured, false);

  // A key saved before hashing still works.
  writeFileSync(secrets.file, JSON.stringify({ apiKey: 'plain-key-from-before' }));
  assert.equal(new KanbanSecrets(dir).checkApiKey('plain-key-from-before'), true);
});
