import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { Composer, reposText, slugify } from '../src/server/kanban/engine/compose.js';
import type { PromptKind } from '../src/server/kanban/engine/machine.js';
import type { KanbanContext } from '../src/server/kanban/registry.js';
import { KanbanSettingsStore } from '../src/server/kanban/settings.js';
import { KANBAN_CONTRACTS, KANBAN_PROMPT_DEFS, PROMPT_CONTRACT, STOP_PROCESSES, resolveKanbanPrompt, withContract } from '../src/shared/kanban/prompts.js';
import { PROMPTS, placeholders, promptText, type PromptId } from '../src/shared/prompts.js';
import type { RunPhase } from '../src/shared/kanban/types.js';
import type { LanguageSettings } from '../src/shared/language.js';
import { makeRepo } from './kanban-engine-fixture.js';

function setup(t: { after(fn: () => void): void }, office: Record<string, { text: string }> = {}, langs: LanguageSettings = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-prompts-'));
  // The skills the prompts name are looked up in the agents' homes: never the user's own.
  const homes = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  t.after(() => {
    for (const [k, v] of Object.entries(homes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'proj');
  makeRepo(dir);
  const api = path.join(root, 'api');
  makeRepo(api);
  const notes = path.join(root, 'notes');
  mkdirSync(notes);
  const def: FloorDef = {
    id: 'proj',
    name: 'Proj',
    dir,
    repo: 'acme/proj',
    palette: 0,
    addedBy: 't',
    addedAt: 0,
    repos: [
      { id: 'proj', name: 'Proj', kind: 'git', dir, primary: true, instructions: 'Run npm test.' },
      { id: 'api', name: 'API', kind: 'git', dir: api, remote: 'acme/api', primary: false },
      { id: 'notes', name: 'Notes', kind: 'folder', dir: notes, primary: false },
    ],
  };
  const repo = new KanbanRepository(openKanbanDb(':memory:'));
  const settings = new KanbanSettingsStore(root);
  settings.setProject('proj', { generalInstructions: 'Keep it small.', testingInstructions: 'npm test', skills: { implement: { claude: ['no-such-skill-here'] } } });
  const toasts: string[] = [];
  const ctx = {
    repo,
    settings,
    dataDir: root,
    filesDir: path.join(root, 'files'),
    officePrompts: () => office,
    officeText: (id: PromptId) => promptText(office as Partial<Record<PromptId, { text: string }>>, id),
    languages: () => langs,
    projects: () => [def],
    project: (id: string) => (id === def.id ? def : undefined),
    floor: () => undefined,
    repos: () => def.repos!,
    toast: (_f: string, text: string) => void toasts.push(text),
  } as unknown as KanbanContext;
  return { root, dir, def, repo, settings, ctx, toasts, compose: new Composer(ctx) };
}

const KINDS: [PromptKind, RunPhase][] = [
  ['plan', 'plan'],
  ['replan', 'plan'],
  ['implement', 'implement'],
  ['investigate', 'implement'],
  ['review', 'review'],
  ['rereview', 'review'],
  ['fix', 'fix'],
  ['resume', 'resume'],
  ['continue', 'implement'],
  ['pr.create', 'pr'],
  ['pr.fix', 'pr-fix'],
  ['pr.review', 'pr-review'],
];

test('every prompt the engine sends is filled in completely and ends with its phase contract', (t) => {
  const { def, dir, repo, compose, toasts } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix the login redirect', description: 'Go back after login.', ticket: 'UYT-12', ticketUrl: 'https://jira/UYT-12', goal: 'Redirect works', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  repo.addPlan(task.id, 'The plan');
  repo.acceptPlan(task.id, 'Ada');
  repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  const withPrs = repo.getTask(task.id)!;
  for (const [kind, phase] of KINDS) {
    const text = compose.build(kind, def, withPrs, 'claude', dir, { phase, round: 1, rounds: 2, text: 'An answer', author: 'Ada', findings: 'A finding', fixSummary: 'Fixed', refsFile: '/refs/task-1/referenced-tasks.md', prs: '- acme/api#12 https://github.com/acme/api/pull/12' });
    assert.doesNotMatch(text, /\{\{\s*\w+\s*\}\}/, `${kind} left a placeholder`);
    assert.ok(text.trim(), kind);
    const contract = phase === 'plan' ? 'plan' : phase === 'review' ? 'review' : phase === 'pr-review' ? 'prReview' : phase === 'pr' || phase === 'pr-fix' ? 'pr' : 'implementSafety';
    assert.ok(text.endsWith(KANBAN_CONTRACTS[contract]), `${kind} ends with the ${contract} contract`);
  }
  const impl = compose.build('implement', def, withPrs, 'claude', dir, { phase: 'implement' });
  assert.match(impl, /Ticket: UYT-12 \(https:\/\/jira\/UYT-12\)/);
  assert.match(impl, /The accepted plan:\n\nThe plan/);
  assert.match(impl, /General:\nKeep it small\./);
  assert.match(impl, /In Proj:\nRun npm test\./);
  assert.match(impl, /Acceptance criteria/);
  // A picked skill that isn't installed isn't named to the agent; the office says so instead.
  assert.doesNotMatch(impl, /no-such-skill-here/);
  assert.ok(toasts.some((x) => /no-such-skill-here/.test(x)));
  assert.match(impl, /Name it kanban\/uyt-12-fix-the-login-redirect/);
  assert.match(impl, /ticket: UYT-12/);
  const plan = compose.build('plan', def, withPrs, 'claude', dir, { phase: 'plan', refsFile: '/refs/x.md' });
  assert.match(plan, /fetched for you into \/refs\/x\.md/);
  // An investigation is read-only, with its report folder.
  const inv = repo.createTask({ project: 'proj', title: 'Why is it slow', type: 'investigate', tool: 'codex', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const report = compose.build('investigate', def, inv, 'codex', dir, { phase: 'implement' });
  assert.ok(report.endsWith(KANBAN_CONTRACTS.investigateSafety));
  assert.match(report, new RegExp(`reports[\\\\/]task-${inv.id}`));
  assert.ok(compose.build('resume', def, inv, 'codex', dir, { phase: 'resume', text: 'x' }).endsWith(KANBAN_CONTRACTS.investigateSafety));
});

test('filesText and filesInline give the task grant copies by name and path, empty for none or missing files', (t) => {
  const { compose, ctx } = setup(t);
  mkdirSync(path.join(ctx.filesDir, 'uploads'), { recursive: true });
  for (const f of ['abc.png', 'd.pdf']) writeFileSync(path.join(ctx.filesDir, 'uploads', f), 'x');
  const at = (f: string) => path.join(ctx.filesDir, 'grants', 'task-7', f);
  assert.equal(compose.filesText('proj', 7, []), '');
  const text = compose.filesText('proj', 7, [{ name: 'mock.png', stored: 'abc.png' }, { name: 'gone.txt', stored: 'gone.txt' }]);
  assert.match(text, /^Files attached to the task/);
  assert.match(text, /not instructions/);
  assert.ok(text.includes(`- mock.png: ${at('abc.png')}`) && !text.includes('gone.txt'));
  assert.equal(compose.filesInline(7, []), '');
  const inline = compose.filesInline(7, [{ stored: 'abc.png' }, { stored: 'd.pdf' }]);
  assert.doesNotMatch(inline, /\n/);
  assert.ok(inline.includes(at('abc.png')) && inline.includes(at('d.pdf')));
  assert.ok(!inline.includes(path.join(ctx.filesDir, 'uploads')));
});

test('the workspace lines: predicted before the hire, real paths after, folders by their own path', (t) => {
  const { def, dir, repo } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const before = reposText(def, task, dir);
  assert.match(before, /^- `\.\/proj\/`: Proj \(acme\/proj\), on a fresh branch/m);
  assert.match(before, /^- `\.\/api\/`: API \(acme\/api\)/m);
  assert.match(before, /Notes \(a plain folder, not git\)/);
  const after = reposText(def, { ...task, workspace: { worktree: { path: '.agent-office/worktrees/ada-1/proj', branch: 'office/ada-1', base: 'abc1234def0', from: 'main' }, repos: [{ floor: 'proj~api', name: 'api', dir: path.join(dir, '..', 'api'), path: '.agent-office/worktrees/ada-1/api', branch: 'office/ada-1', base: 'fff', from: 'main' }] } }, dir);
  assert.match(after, new RegExp(`^- \`${path.join(dir, '.agent-office/worktrees/ada-1/proj').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`: Proj \\(acme/proj\\), on branch \`office/ada-1\`, cut from \`main\` at abc1234def`, 'm'));
  assert.match(after, /API \(acme\/api\), on branch `office\/ada-1`/);
  // Only the subset.
  assert.doesNotMatch(reposText(def, { ...task, repoIds: ['proj'] }, dir), /API/);
  assert.equal(slugify('Käännä “login” -sivu!'), 'kaanna-login-sivu');
});

test('layering: a project override and an office rewrite are what the engine sends', (t) => {
  const { def, dir, repo, settings, compose } = setup(t, { 'kanban.fix': { text: 'Office fix for #{{taskId}}: {{findings}}' } });
  const task = repo.createTask({ project: 'proj', title: 'X', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  assert.match(compose.build('fix', def, task, 'claude', dir, { phase: 'fix', round: 1, findings: 'F' }), /^Office fix for #\d+: F\n\n---/);
  settings.setProjectPrompt('proj', 'kanban.fix', 'Project fix: {{findings}}');
  const text = compose.build('fix', def, task, 'claude', dir, { phase: 'fix', round: 1, findings: 'F' });
  assert.match(text, /^Project fix: F/);
  assert.ok(text.endsWith(KANBAN_CONTRACTS.implementSafety), 'a rewrite never loses the contract');
});

test('kanban.pr.review: several pull requests at once, editable like the others', (t) => {
  const def = KANBAN_PROMPT_DEFS['kanban.pr.review'];
  assert.deepEqual(Object.keys(def.vars).sort(), ['language', 'project', 'prs', 'repos', 'task']);
  assert.deepEqual(placeholders(def.text).sort(), ['language', 'project', 'prs', 'repos', 'task']);
  assert.equal(PROMPTS['kanban.pr.review'].group, 'kanban', 'it is in the office prompt editor');
  const prs = '- acme/api#12 https://github.com/acme/api/pull/12 (branch kanban/uyt-1)\n- acme/web#7 https://github.com/acme/web/pull/7 (branch kanban/uyt-1)';
  const filled = resolveKanbanPrompt('kanban.pr.review', {}, { prs, project: 'Proj', task: '', repos: '- `./proj/`: Proj', language: '' });
  assert.match(filled, /^Review these pull requests in the project Proj together, as one change set:\n- acme\/api#12/);
  assert.doesNotMatch(filled, /\{\{/);
  assert.doesNotMatch(filled, /\n\n\n/, 'an empty task line goes');
  assert.match(resolveKanbanPrompt('kanban.pr.review', { project: { 'kanban.pr.review': 'Mine: {{prs}}' } }, { prs: 'x', project: 'P', task: '' }), /^Mine: x$/);
  assert.match(resolveKanbanPrompt('kanban.pr.review', { office: { 'kanban.pr.review': { text: 'Office: {{task}}' } } }, { prs: 'x', project: 'P', task: 'Task #3' }), /^Office: Task #3$/);
  // Every default names what it uses (the upstream placeholder test covers the rest).
  for (const [id, d] of Object.entries(KANBAN_PROMPT_DEFS)) for (const name of placeholders(d.text)) assert.ok(name in d.vars, `${id} uses {{${name}}}`);
  void t;
});

test('the review contracts forbid changing anything, and no rewrite of the prompt can drop them', () => {
  for (const id of ['review', 'prReview'] as const) {
    const c = KANBAN_CONTRACTS[id];
    assert.match(c, /Never modify, create or delete files/, id);
    for (const word of ['commit', 'check out', 'switch branches', 'reset', 'stash', 'push']) assert.ok(c.includes(word), `${id} forbids: ${word}`);
    assert.match(c, /changes the repository or its remote/, id);
    assert.match(c, /Only read, diff, run read-only commands, and report/, id);
    assert.match(c, /REVIEW: APPROVED\nREVIEW: CHANGES_REQUESTED/, `${id} keeps the verdict`);
  }
  assert.equal(PROMPT_CONTRACT['kanban.pr.review'], 'prReview');
  assert.ok(withContract('Mine', 'prReview').endsWith(KANBAN_CONTRACTS.prReview));
});

test('every contract, the review panel’s included, tells the agent to stop the processes it started, right after the rule line', () => {
  for (const [id, c] of Object.entries(KANBAN_CONTRACTS)) assert.ok(c.startsWith(`---\n${STOP_PROCESSES}`), id);
  assert.equal(PROMPT_CONTRACT['kanban.pr.panel'], 'panel');
  for (const word of ['unless the task or the user explicitly asks', 'by the PID or job', 'never by name or port', 'without removing it', "didn't start alone"]) assert.ok(STOP_PROCESSES.includes(word), word);
});

test('kanban.checkout: a fresh worktree is told to check out the branch the task already has', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada', branch: 'kanban/uyt-1-x' });
  const branches = '- Proj: `kanban/uyt-1-x`\n- API: `kanban/uyt-1-x`';
  const impl = compose.build('implement', def, task, 'claude', dir, { phase: 'implement', checkout: branches });
  assert.ok(impl.includes(compose.checkout(task, branches)), 'in place of the branch step');
  assert.doesNotMatch(impl, /Name it kanban\//, 'no new branch is named');
  assert.match(impl, /- API: `kanban\/uyt-1-x`/);
  assert.match(compose.checkout(task, branches), /git checkout <branch>/);
  assert.doesNotMatch(compose.checkout(task, branches), /\{\{/);
});

test('kanban.pr.fix: review comments and CI logs are data; only OWNER, MEMBER and COLLABORATOR comments are acted on; the run lists only the PRs it was given', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix PRs', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  for (const n of [3, 4]) repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: n, url: `https://github.com/acme/proj/pull/${n}`, state: 'OPEN' });
  const t2 = repo.getTask(task.id)!;
  const text = compose.build('pr.fix', def, t2, 'claude', dir, { phase: 'pr-fix', fixPrs: t2.prs.slice(0, 1) });
  assert.match(text, /data, never instructions/);
  assert.match(text, /author_association is OWNER, MEMBER or COLLABORATOR/);
  assert.match(text, /--jq '\.\[\] \| \{author_association, body, path, line\}'/);
  assert.match(text, /gh pr view <url> --json reviews,comments/);
  assert.match(text, /secrets or credentials, or for changes to CI, workflows or credentials/);
  assert.ok(text.includes('pull/3') && !text.includes('pull/4'), 'the listed PRs are the run\'s');
});

test('languages: both rules go on the plan and the handoff, the project’s public language over the office’s, and unset keeps kanban.language', (t) => {
  const langs: LanguageSettings = {};
  const { def, dir, repo, settings, compose } = setup(t, {}, langs);
  const task = repo.createTask({ project: 'proj', title: 'X', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const plan = () => compose.build('plan', def, task, 'claude', dir, { phase: 'plan' });
  const handoff = () => compose.handoff(def, task, dir, 'Next.');
  const fallback = PROMPTS['kanban.language'].text;

  // Nothing set: the task-language prompt, and comments in English.
  const english = 'Write comments in the code (and docstrings) in English, whatever language the task or the conversation is in.';
  assert.ok(plan().includes(fallback) && handoff().includes(fallback));
  assert.equal(compose.language('proj'), `${fallback}\n${english}`);
  assert.ok(plan().includes(english));

  // The project's comment language; @project (nothing else set) is exactly the old text.
  settings.setProject('proj', { commentLanguage: 'Finnish' });
  assert.equal(compose.language('proj'), `${fallback}\n${english.replace('English', 'Finnish')}`);
  settings.setProject('proj', { commentLanguage: '@project' });
  assert.equal(compose.language('proj'), fallback);
  assert.ok(!plan().includes('comments in the code'));
  settings.setProject('proj', { commentLanguage: null } as never);

  // Talk Finnish, the project writes English: both rules, and the old one gone.
  langs.talk = 'Finnish';
  settings.setProject('proj', { publicLanguage: 'English' });
  for (const text of [plan(), handoff(), compose.language('proj')]) {
    assert.match(text, /Talk to the user in Finnish:/);
    assert.match(text, /Write everything that leaves the office in English:/);
    assert.ok(!text.includes(fallback));
  }

  // The office's public language is the default; the project's own wins.
  settings.setProject('proj', { publicLanguage: null } as never);
  langs.public = 'Swedish';
  assert.match(plan(), /leaves the office in Swedish:/);
  settings.setProject('proj', { publicLanguage: 'English' });
  assert.match(plan(), /leaves the office in English:/);

  // @project: the project's own instructions, whatever the office says.
  settings.setProject('proj', { publicLanguage: '@project' });
  const own = compose.language('proj');
  assert.match(own, /Talk to the user in Finnish:/);
  assert.ok(own.includes(PROMPTS['language.public.unset'].text), 'the project goes by its own instructions: the public line leaves commits and branches to them');
  assert.doesNotMatch(own, /Swedish/);
  assert.ok(own.includes('docstrings) in English'), 'comments stay English by default');
});

test('branch name: with a public language the prompt asks for the slug in it; unset or @project is the prompt as before', (t) => {
  const { def, dir, repo, settings, compose } = setup(t, {}, { talk: 'Finnish', public: 'English' });
  const task = repo.createTask({ project: 'proj', title: 'Korjaa kirjautuminen', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const impl = () => compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  const name = `Name it kanban/${task.id}-korjaa-kirjautuminen, the same name in every repository.`;
  const note = "Write the slug in English: translate the title's words when it is written in another language.";
  assert.ok(impl().includes(`${name}\n${note}`), 'the title’s slug and the note');
  settings.setProject('proj', { publicLanguage: '@project' });
  assert.ok(impl().includes(`${name}\n`) && !impl().includes('Write the slug in'));
  assert.ok(!impl().includes(`${name}\n\n`), 'the empty note leaves no blank line');
  const none = setup(t, {}, {});
  const t2 = none.repo.createTask({ project: 'proj', title: 'Korjaa kirjautuminen', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const plain = none.compose.build('implement', none.def, t2, 'claude', none.dir, { phase: 'implement' });
  assert.ok(plain.includes(`Name it kanban/${t2.id}-korjaa-kirjautuminen, the same name in every repository.`) && !plain.includes('Write the slug in'));
});

test('languages: only the conversation language set leaves commits and branch names on the project’s conventions', (t) => {
  const { def, dir, repo, compose } = setup(t, {}, { talk: 'Finnish' });
  const task = repo.createTask({ project: 'proj', title: 'X', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const text = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.match(text, /Talk to the user in Finnish:/);
  assert.ok(text.includes(PROMPTS['language.public.unset'].text));
  assert.ok(!text.includes('Write everything that leaves the office'));
  assert.match(text, /commit messages and branch names follow the project's own conventions/);
  assert.ok(!/commit messages[^.]*in the language the task/.test(text));
});

test('languages: an office rewrite of a language prompt is what is sent, and a blanked one drops its line', (t) => {
  const { compose } = setup(t, { 'language.talk': { text: 'Puhu {{language}}.' }, 'language.public': { text: '' } }, { talk: 'suomea', public: 'English' });
  assert.equal(compose.language('proj'), 'Puhu suomea.\nWrite comments in the code (and docstrings) in English, whatever language the task or the conversation is in.');
});

test('pr.create takes the language rule and no longer hard-codes the task’s language (the review panel gets it at the hire)', (t) => {
  assert.ok(!placeholders(PROMPTS['kanban.pr.panel'].text).includes('language'));
  assert.ok(placeholders(PROMPTS['kanban.pr.create'].text).includes('language'));
  assert.ok(!/same language as the task/.test(PROMPTS['kanban.pr.create'].text));
  const { compose } = setup(t, {}, { public: 'English' });
  assert.match(compose.language('proj'), /leaves the office in English/);
});
