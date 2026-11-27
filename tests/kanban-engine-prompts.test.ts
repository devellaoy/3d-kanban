import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import type { Floor } from '../src/server/floor.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { prReviewRepoIds } from '../src/server/kanban/engine/launchdirs.js';
import { Composer, reposText, slugify } from '../src/server/kanban/engine/compose.js';
import type { PromptKind } from '../src/server/kanban/engine/machine.js';
import type { KanbanContext } from '../src/server/kanban/registry.js';
import { KanbanSettingsStore, sanitizeKanbanSettings } from '../src/server/kanban/settings.js';
import { KANBAN_CONTRACTS, KANBAN_PROMPT_DEFS, PROMPT_CONTRACT, prPosted, isKanbanPromptId, STOP_PROCESSES, resolveKanbanPrompt, withContract } from '../src/shared/kanban/prompts.js';
import { PROMPTS, placeholders, promptText, type PromptId } from '../src/shared/prompts.js';
import type { RunPhase } from '../src/shared/kanban/types.js';
import type { LanguageSettings } from '../src/shared/language.js';
import { makeRepo } from './kanban-engine-fixture.js';
import { conversationFilePath, planFilePath } from '../src/server/kanban/taskfiles.js';
import { keepUiTestReport, resetUiTestReport } from '../src/server/kanban/engine/uitesting.js';
import { uiTestReport } from '../src/server/kanban/engine/prreview-ui.js';
import { syncBuiltinESMExports } from 'node:module';
import { HISTORY_TEXT_MAX } from '../src/server/kanban/engine/taskfiles-block.js';

function setup(t: { after(fn: () => void): void }, office: Record<string, { text: string }> = {}, langs: LanguageSettings = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kanban-prompts-')));
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
  ['restarted', 'implement'],
  ['pr.create', 'pr'],
  ['pr.fix', 'pr-fix'],
  ['pr.conflicts', 'pr-conflicts'],
  ['pr.review', 'pr-review'],
  ['pr.comments', 'pr-comments'],
  ['pr.answers', 'pr-answers'],
];

test('every prompt the engine sends is filled in completely and ends with its phase contract', (t) => {
  const { def, dir, repo, compose, toasts, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix the login redirect', description: 'Go back after login.', ticket: 'UYT-12', ticketUrl: 'https://jira/UYT-12', goal: 'Redirect works', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  repo.addPlan(task.id, 'The plan');
  repo.acceptPlan(task.id, 'Ada');
  repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  const withPrs = repo.getTask(task.id)!;
  for (const [kind, phase] of KINDS) {
    const text = compose.build(kind, def, withPrs, 'claude', dir, { phase, round: 1, rounds: 2, text: 'An answer', author: 'Ada', findings: 'A finding', fixSummary: 'Fixed', refsFile: '/refs/task-1/referenced-tasks.md', prs: '- acme/api#12 https://github.com/acme/api/pull/12' });
    assert.doesNotMatch(text, /\{\{\s*\w+\s*\}\}/, `${kind} left a placeholder`);
    assert.ok(text.trim(), kind);
    const contract = phase === 'plan' ? 'plan' : phase === 'review' ? 'review' : phase === 'pr-review' ? 'prReview' : phase === 'pr-comments' ? 'prComments' : phase === 'pr' || phase === 'pr-fix' || phase === 'pr-conflicts' || phase === 'pr-answers' ? 'pr' : 'implementSafety';
    assert.ok(text.endsWith(KANBAN_CONTRACTS[contract]), `${kind} ends with the ${contract} contract`);
  }
  const impl = compose.build('implement', def, withPrs, 'claude', dir, { phase: 'implement' });
  assert.match(impl, /Ticket: UYT-12 \(https:\/\/jira\/UYT-12\)/);
  assert.ok(impl.includes(`\`${planFilePath(ctx.filesDir, task.id)}\``), 'the plan is a reference to its file');
  assert.doesNotMatch(impl, /The plan\b/, 'the plan text is in the file');
  assert.match(impl, /The project's instructions/);
  assert.ok(impl.includes(`\`${path.join(ctx.filesDir, 'instructions', 'proj', 'general.md')}\``), 'the general instructions are a reference to their file');
  assert.doesNotMatch(impl, /Keep it small\.|Run npm test\./, 'the text itself is in the files');
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

test('a continue after an office restart says the turn was cut off, in front of the usual text', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix the login redirect', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const plain = compose.build('continue', def, task, 'claude', dir, { phase: 'implement' });
  const restarted = compose.build('restarted', def, task, 'claude', dir, { phase: 'implement' });
  assert.doesNotMatch(plain, /office was restarted/);
  assert.match(restarted, /^The office was restarted while you were working on this task, and your turn was cut off/);
  assert.ok(restarted.endsWith(plain), 'the usual continue prompt and its contract follow');
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
  settings.setProject('proj', { uiTesting: false });
  assert.match(compose.build('fix', def, task, 'claude', dir, { phase: 'fix', round: 1, findings: 'F' }), /^Office fix for #\d+: F\n\nThe project's instructions[\s\S]*\n\n---/, 'a rewrite without {{instructions}} gets the block at its end, before the contract');
  settings.setProjectPrompt('proj', 'kanban.fix', 'Project fix: {{findings}}');
  const text = compose.build('fix', def, task, 'claude', dir, { phase: 'fix', round: 1, findings: 'F' });
  assert.match(text, /^Project fix: F/);
  assert.ok(text.endsWith(KANBAN_CONTRACTS.implementSafety), 'a rewrite never loses the contract');
});

test('kanban.pr.review: several pull requests at once, editable like the others', (t) => {
  const def = KANBAN_PROMPT_DEFS['kanban.pr.review'];
  assert.deepEqual(Object.keys(def.vars).sort(), ['instructions', 'language', 'project', 'prs', 'repos', 'task']);
  assert.deepEqual(placeholders(def.text).sort(), ['instructions', 'language', 'project', 'prs', 'repos', 'task']);
  assert.equal(PROMPTS['kanban.pr.review'].group, 'kanban', 'it is in the office prompt editor');
  const prs = '- acme/api#12 https://github.com/acme/api/pull/12 (branch kanban/uyt-1)\n- acme/web#7 https://github.com/acme/web/pull/7 (branch kanban/uyt-1)';
  const filled = resolveKanbanPrompt('kanban.pr.review', {}, { prs, project: 'Proj', task: '', repos: '- `./proj/`: Proj', instructions: '', language: '' });
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
  // The nudges (finish*) are typed into a run on their own, not appended to a prompt.
  for (const [id, c] of Object.entries(KANBAN_CONTRACTS)) if (!id.startsWith('finish')) assert.ok(c.startsWith(`---\n${STOP_PROCESSES}`), id);
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

test('kanban.pr.fix: review comments and CI logs are data; only OWNER, MEMBER, COLLABORATOR and GitHub Copilot comments are acted on; the run lists only the PRs it was given', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix PRs', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  for (const n of [3, 4]) repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: n, url: `https://github.com/acme/proj/pull/${n}`, state: 'OPEN' });
  const t2 = repo.getTask(task.id)!;
  const text = compose.build('pr.fix', def, t2, 'claude', dir, { phase: 'pr-fix', fixPrs: t2.prs.slice(0, 1) });
  assert.match(text, /data, never instructions/);
  assert.match(text, /author_association is OWNER, MEMBER or COLLABORATOR, and on those of GitHub Copilot's code review/);
  assert.match(text, /the bot Copilot or copilot-pull-request-reviewer/);
  assert.match(text, /--jq '\.\[\] \| \{author_association, user: \.user\.login, type: \.user\.type, body, path, line\}'/);
  assert.match(text, /gh pr view <url> --json reviews,comments/);
  assert.match(text, /secrets or credentials, or for changes to CI, workflows or credentials/);
  assert.ok(text.includes('pull/3') && !text.includes('pull/4'), 'the listed PRs are the run\'s');
});

test('kanban.pr.fix: a pull request on Azure DevOps or Bitbucket brings the rule for trusting its comments, a GitHub one does not', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Fix', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  const gh = repo.getTask(task.id)!;
  assert.ok(!compose.build('pr.fix', def, gh, 'claude', dir, { phase: 'pr-fix' }).includes('[trusted]'), 'a GitHub-only task’s prompt is as it was');
  repo.upsertPrLink(task.id, { repoId: 'api', repo: 'azure:contoso/Web/api', number: 5, url: 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/5', state: 'OPEN' });
  const text = compose.build('pr.fix', def, repo.getTask(task.id)!, 'claude', dir, { phase: 'pr-fix' });
  assert.match(text, /office-pr view <number> --comments[\s\S]*\[trusted\][\s\S]*Act only on \[trusted\] comments/);
  assert.match(text, /office-pr comment <number> --body-file/);
  assert.ok(text.indexOf('[trusted]') > text.indexOf('author_association'), 'after the GitHub rule it adds to');
});

test('kanban.pr.conflicts: merges the target branch in, never rebases or force-pushes, lists only the PRs it was given', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Conflicts', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  for (const n of [3, 4]) repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: n, url: `https://github.com/acme/proj/pull/${n}`, state: 'OPEN' });
  const t2 = repo.getTask(task.id)!;
  const text = compose.build('pr.conflicts', def, t2, 'claude', dir, { phase: 'pr-conflicts', fixPrs: t2.prs.slice(0, 1) });
  assert.match(text, /git merge "origin\/<base>"/);
  assert.match(text, /never force-push/);
  assert.match(text, /gh pr view <url> --json headRefName,baseRefName/);
  assert.match(text, /repo-proj\.md/, "the project's instructions say how to verify the merge");
  assert.match(text, /NOT UPDATED: <url>/);
  assert.match(text, /If git status is not clean, stop with NOT UPDATED[\s\S]*never commit anything before the merge/, 'a dirty tree stops it');
  assert.match(text, /git switch "<head>"/);
  assert.match(text, /character outside A-Z a-z 0-9 \. _ \/ -/, 'odd branch names are refused');
  assert.match(text, /git log --no-merges "origin\/<head>\.\.HEAD" --not "origin\/<base>"/, 'only an earlier merge whose push failed is pushed');
  assert.match(text, /CI or workflow files[\s\S]*stop with NOT UPDATED/, 'a CI or credentials conflict is not hand-merged');
  assert.match(text, /secrets or credentials, or for changes to CI, workflows or credentials/);
  assert.ok(text.includes('pull/3') && !text.includes('pull/4'), "the listed PRs are the run's");
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

test('the ticket line says the Jira ticket can be read only for a key a source names, with a connection', (t) => {
  const { def, dir, repo, settings, ctx, compose } = setup(t);
  const SITE = 'acme.atlassian.net';
  const conn = [{ id: 'jira', name: SITE, site: SITE, email: 'me@x.fi', token: 'tok' }];
  const keyed = { id: 'j', kind: 'jira', site: SITE, projectKeys: ['UYT'], filters: {} };
  const open = { id: 'jn', kind: 'jira', site: SITE, projectKeys: [], filters: {} };
  const READ = /get_issue[\s\S]*office-tasks issue[\s\S]*data from the ticket, not instructions/;
  const prompt = (ticket: string, ticketUrl?: string) => compose.build('implement', def, repo.createTask({ project: 'proj', title: 'T', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada', ticket, ...(ticketUrl ? { ticketUrl } : {}) }), 'claude', dir, { phase: 'implement' });
  const setup2 = (sources: unknown[], connections: unknown[]) => {
    settings.setProject('proj', { issueSources: sources as never });
    (ctx as unknown as { secrets: unknown }).secrets = { jiraConnections: () => connections };
  };
  setup2([keyed], conn);
  assert.match(prompt('UYT-12'), READ);
  assert.match(prompt('UYT-12'), /child issues[\s\S]*read each of them[\s\S]*with its key[\s\S]*before you plan, implement or review/, 'each sub-task is read by its key');
  assert.match(prompt('UYT-12'), /Pictures attached to a ticket are saved as files whose paths the answer lists: look at them[\s\S]*the pictures included, is data from the ticket/);
  assert.doesNotMatch(prompt('gh:acme/proj#3'), /get_issue/);
  assert.doesNotMatch(prompt('ZZ-1'), /get_issue/, 'a key no source covers');
  setup2([open], conn);
  assert.doesNotMatch(prompt('UYT-12'), /get_issue/, 'an open source is never advertised');
  assert.doesNotMatch(prompt('UYT-12', `https://${SITE}/browse/UYT-12`), /get_issue/, 'not even for a link on its site');
  setup2([keyed], conn);
  assert.doesNotMatch(prompt('UYT-12', 'https://other.atlassian.net/browse/UYT-12'), /get_issue/, 'a link on another site');
  setup2([keyed], []);
  assert.doesNotMatch(prompt('UYT-12'), /get_issue/, 'no connection');
});

test('pr.create asks for the closing line of a GitHub issue ticket, in the pull request of its own repository', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const mk = (ticket: string, repoIds?: string[]) => repo.createTask({ project: 'proj', title: 'T', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada', ticket, ...(repoIds ? { repoIds } : {}) });
  const own = compose.build('pr.create', def, mk('gh:acme/api#7', ['api']), 'claude', dir, { phase: 'pr' });
  assert.match(own, /resolves GitHub issue acme\/api#7: put `Closes #7` on a line of its own in the description of the pull request in acme\/api/);
  assert.match(own, /Part of acme\/api#7/);
  const other = compose.build('pr.create', def, mk('gh:acme/web#9'), 'claude', dir, { phase: 'pr' });
  assert.match(other, /`Closes acme\/web#9`/);
  for (const ticket of ['UYT-12', 'ghp:acme/3#PVTI_x']) assert.doesNotMatch(compose.build('pr.create', def, mk(ticket), 'claude', dir, { phase: 'pr' }), /resolves GitHub issue/);
});

test('workerPr gives an office worker the ticket of its queue task, else of its prompt', (t) => {
  const { def, dir, ctx, compose } = setup(t);
  const queued: Record<string, { issue?: number; issueKey?: string }> = { w1: { issue: 5 }, w2: { issueKey: 'gh:acme/api#8' } };
  const floor = { id: 'proj', def, dir, project: { name: 'Proj', branch: 'main' }, queue: { issueOf: (id: string) => queued[id] ?? {} } } as unknown as Floor;
  const info = (id: string, prompt?: string) => ({ id, name: 'W', title: '', prompt }) as unknown as WorkerInfo;
  assert.match(compose.workerPr(floor, info('w1')), /`Closes acme\/proj#5`|`Closes #5`/);
  assert.match(compose.workerPr(floor, info('w2')), /`Closes acme\/api#8`/);
  assert.match(compose.workerPr(floor, info('w3', 'Work on GitHub issue #12: "Title".')), /issue acme\/proj#12/);
  assert.doesNotMatch(compose.workerPr(floor, info('w4', 'Tidy things up')), /resolves GitHub issue/);
  void ctx;
});

function attach(repo: KanbanRepository, filesDir: string, id: string, name: string, taskId: number, commentId?: number) {
  mkdirSync(path.join(filesDir, 'uploads'), { recursive: true });
  const stored = `${id}-${name}`;
  writeFileSync(path.join(filesDir, 'uploads', stored), 'x');
  repo.addAttachment({ id, name, mime: 'image/png', size: 1, stored, createdBy: 'Ada', createdAt: 1 });
  repo.linkAttachments([id], taskId, commentId);
  return stored;
}

test('inline attachment links become grant paths; other tasks and unknown ids stay as they are', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'T', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const other = repo.createTask({ project: 'proj', title: 'U', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const a = 'a'.repeat(32);
  const b = 'b'.repeat(32);
  const c = 'c'.repeat(32);
  const stored = attach(repo, ctx.filesDir, a, 'shot.png', task.id);
  attach(repo, ctx.filesDir, b, 'theirs.png', other.id);
  const grant = path.join(ctx.filesDir, 'grants', `task-${task.id}`, stored);
  const text = `see ![shot](/api/kanban/attachments/${a}) and [file](http://localhost:3000/api/kanban/attachments/${a}) but ![x](/api/kanban/attachments/${b}) ![y](/api/kanban/attachments/${c})`;
  assert.equal(compose.inline(task.id, text), `see ![shot](${grant}) and [file](${grant}) but ![x](/api/kanban/attachments/${b}) ![y](/api/kanban/attachments/${c})`);
  // The description is inlined in the task prompts and the handoff, and its file is not listed again.
  repo.updateTask(task.id, { description: `look: ![shot](/api/kanban/attachments/${a})` });
  const fresh = repo.getTask(task.id)!;
  const prompt = compose.build('implement', def, fresh, 'claude', dir, { phase: 'implement' });
  assert.ok(prompt.includes(`![shot](${grant})`));
  assert.ok(!prompt.includes(`shot.png: ${grant}`), 'no duplicate listing');
  assert.ok(compose.handoff(def, fresh, dir, 'go').includes(`![shot](${grant})`));
});

test('task prompts list the task files the description does not link, never a comment\'s', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'T', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const old = attach(repo, ctx.filesDir, 'd'.repeat(32), 'old.png', task.id);
  const { comment } = repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'hi', kind: 'comment' } as never);
  attach(repo, ctx.filesDir, 'e'.repeat(32), 'comment.png', task.id, comment.id);
  const prompt = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.ok(prompt.includes('old.png') && prompt.includes(old));
  assert.ok(!prompt.includes('comment.png'));
});

test('a resume prompt carries only its own message and files, none of the older comments\'', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'T', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  attach(repo, ctx.filesDir, 'd'.repeat(32), 'old.png', task.id);
  const { comment: oldC } = repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'before', kind: 'comment' } as never);
  attach(repo, ctx.filesDir, 'e'.repeat(32), 'older.png', task.id, oldC.id);
  const f = attach(repo, ctx.filesDir, 'f'.repeat(32), 'new.png', task.id);
  const linked = `![n](/api/kanban/attachments/${'f'.repeat(32)})`;
  const own = [{ id: 'f'.repeat(32), name: 'new.png', stored: f }, { id: '9'.repeat(32), name: 'x.txt', stored: 'gone' }];
  const body = compose.commentText('proj', task.id, `look ${linked}`, own);
  const grant = path.join(ctx.filesDir, 'grants', `task-${task.id}`, f);
  assert.ok(body.includes(`![n](${grant})`));
  assert.ok(!body.includes('Files attached'), 'a linked file is not listed again');
  const prompt = compose.build('resume', def, task, 'claude', dir, { phase: 'implement', text: body, author: 'Ada' });
  assert.ok(prompt.includes(grant));
  assert.ok(!prompt.includes('old.png') && !prompt.includes('older.png'));
  // A file the text does not link is listed; in one line for a terminal answer.
  const listed = compose.commentText('proj', task.id, 'plain', own);
  assert.match(listed, /^plain\n\nFiles attached/);
  assert.ok(listed.includes(`new.png: ${grant}`));
  assert.doesNotMatch(compose.answerText(task.id, `a ${linked}`, own), /attached files/);
  assert.match(compose.answerText(task.id, 'a', own), /^a \(attached files/);
});

test('UI testing: the implementer gets the block with the images folder, or the on-request one with it off', (t) => {
  const { def, dir, repo, settings, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'Restyle the board', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const on = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.match(on, /UI testing is on for this task/);
  assert.ok(on.includes(images), 'names the folder');
  assert.match(on, /<subject>-before\.png/);
  assert.match(on, /kanban-ui-screenshots/);
  assert.match(on, /do not get stuck/);
  assert.match(on, /real browser/);
  assert.match(on, /flow runner and assertions/);
  assert.match(on, /what you tested and what the result was/);
  assert.match(on, /could not test or capture/);
  assert.ok(existsSync(images), 'the folder is made');
  assert.ok(on.indexOf('UI testing is on') < on.indexOf('Never push, open pull requests'), 'in front of the closing lines');
  assert.ok(on.endsWith(KANBAN_CONTRACTS.implementSafety));
  // Off for the project: only when asked.
  settings.setProject('proj', { uiTesting: false });
  const off = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.doesNotMatch(off, /UI testing is on/);
  assert.match(off, /UI testing is off for this task by default/);
  assert.doesNotMatch(off, /flow runner/);
  // The other blocks are still about pictures only.
  for (const id of ['kanban.uiTesting.onRequest', 'kanban.uiTesting.fix'] as const) assert.ok(KANBAN_PROMPT_DEFS[id].text.includes('Use the kanban-ui-screenshots skill for the pictures if it is available to you'), id);
  // The task's own choice over the project's.
  const own = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada', overrides: { uiTesting: true } });
  assert.match(compose.build('implement', def, own, 'claude', dir, { phase: 'implement' }), /UI testing is on/);
  // Not for an investigation or the plan.
  for (const kind of ['plan', 'investigate'] as const) assert.doesNotMatch(compose.build(kind, def, task, 'claude', dir, { phase: kind === 'plan' ? 'plan' : 'implement' }), /UI testing/, kind);
});

test('UI testing: the reviewer is told to read the images and that missing ones are no finding', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const none = compose.build('review', def, task, 'claude', dir, { phase: 'review', round: 1, rounds: 2 });
  assert.match(none, /none yet/);
  assert.ok(!existsSync(images), 'a reviewer does not make the folder');
  mkdirSync(images, { recursive: true });
  writeFileSync(path.join(images, 'board-before.png'), 'x');
  writeFileSync(path.join(images, 'board-after.png'), 'y');
  for (const kind of ['review', 'rereview'] as const) {
    const text = compose.build(kind, def, task, 'claude', dir, { phase: 'review', round: 2, rounds: 2, fixSummary: 'Fixed' });
    assert.ok(text.includes(`- board: before ${path.join(images, 'board-before.png')}, after ${path.join(images, 'board-after.png')}`), kind);
    assert.match(text, /A wrong UI in the pictures is a finding/);
    assert.match(text, /Pictures that are missing are not/);
    assert.match(text, /Never modify, move or delete the images/);
    assert.ok(text.endsWith(KANBAN_CONTRACTS.review));
  }
});

test('UI testing: fix, comment and pull request fix runs carry their block', (t) => {
  const { def, dir, repo, settings, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  const withPr = repo.getTask(task.id)!;
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const fix = compose.build('fix', def, withPr, 'claude', dir, { phase: 'fix', round: 1, rounds: 2, findings: 'F' });
  assert.match(fix, /take the after pictures again under the same name in the same folder/);
  assert.ok(fix.includes(images));
  assert.match(compose.build('resume', def, withPr, 'claude', dir, { phase: 'resume', text: 'Do UI testing too' }), /take the after pictures again/);
  assert.match(compose.build('pr.fix', def, withPr, 'claude', dir, { phase: 'pr-fix' }), /take the after pictures again/);
  assert.doesNotMatch(compose.build('pr.create', def, withPr, 'claude', dir, { phase: 'pr' }), /UI testing|pictures/);
  // Off, no images: a fix round is left alone, a comment hears a request for it.
  settings.setProject('proj', { uiTesting: false });
  assert.doesNotMatch(compose.build('fix', def, withPr, 'claude', dir, { phase: 'fix', round: 1, rounds: 2, findings: 'F' }), /UI testing|pictures/);
  const asked = compose.build('resume', def, withPr, 'claude', dir, { phase: 'resume', text: 'Do UI testing too' });
  assert.match(asked, /UI testing is off for this task by default/);
  assert.match(compose.build('pr.fix', def, withPr, 'claude', dir, { phase: 'pr-fix' }), /UI testing is off for this task by default/);
  // The images alone are a reason for the fix block.
  mkdirSync(images, { recursive: true });
  writeFileSync(path.join(images, 'a-after.png'), 'x');
  assert.match(compose.build('fix', def, withPr, 'claude', dir, { phase: 'fix', round: 1, rounds: 2, findings: 'F' }), /take the after pictures again/);
});

test('UI testing: a rewritten prompt without {{uiTesting}} gets the block at its end, before the contract; with it, where it says', (t) => {
  const { def, dir, repo, compose } = setup(t, { 'kanban.implement': { text: 'Office implement #{{taskId}}\n\n{{uiTesting}}\n\nEnd.' }, 'kanban.fix': { text: 'Office fix: {{findings}}' } });
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const impl = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.match(impl, /^Office implement #\d+\n\nUI testing is on[\s\S]*\n\nEnd\.\n\nThe project's instructions[\s\S]*\n\n---/);
  assert.equal(impl.split('UI testing is on').length, 2, 'once');
  const fix = compose.build('fix', def, task, 'claude', dir, { phase: 'fix', round: 1, rounds: 2, findings: 'F' });
  assert.match(fix, /^Office fix: F\n\nThe task keeps before and after pictures[\s\S]*\n\n---/);
  // A rewrite that has the placeholder but a block that is off leaves no hole.
  const bare = setup(t, { 'kanban.review': { text: 'Review.\n\n{{uiTesting}}\n\nDone.' } });
  const rev = bare.compose.build('review', bare.def, bare.repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' }), 'claude', bare.dir, { phase: 'review', round: 1, rounds: 1 });
  assert.match(rev, /^Review\.\n\nThe implementer may have saved/);
});

test('UI testing: the prompts are optional, carry the placeholder where they should, and an investigation never has it', () => {
  for (const id of ['kanban.uiTesting', 'kanban.uiTesting.onRequest', 'kanban.uiTesting.review', 'kanban.uiTesting.fix'] as const) {
    assert.equal(KANBAN_PROMPT_DEFS[id].optional, true, id);
    assert.equal(PROMPTS[id].group, 'kanban', id);
    assert.ok(placeholders(KANBAN_PROMPT_DEFS[id].text).includes('imagesDir'), id);
  }
  assert.ok(placeholders(KANBAN_PROMPT_DEFS['kanban.uiTesting.review'].text).includes('imageList'));
  const withIt = ['kanban.implement', 'kanban.review', 'kanban.rereview', 'kanban.fix', 'kanban.resume', 'kanban.pr.fix'] as const;
  for (const id of withIt) assert.ok(placeholders(KANBAN_PROMPT_DEFS[id].text).includes('uiTesting'), id);
  for (const id of ['kanban.plan', 'kanban.replan', 'kanban.investigate', 'kanban.pr.create', 'kanban.implement.folder', 'kanban.pr.conflicts'] as const) assert.ok(!placeholders(KANBAN_PROMPT_DEFS[id].text).includes('uiTesting'), id);
  // Rewritten to nothing, the block is left out.
  assert.equal(resolveKanbanPrompt('kanban.uiTesting', { office: { 'kanban.uiTesting': { text: '' } } }, { imagesDir: '/x' }), '');
});

test('UI testing: a folder project’s implementer gets the block too', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const folderDef: FloorDef = { ...def, repos: [{ id: 'proj', name: 'Proj', kind: 'folder', dir, primary: true }] };
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const text = compose.build('implement', folderDef, task, 'claude', dir, { phase: 'implement' });
  assert.match(text, /UI testing is on for this task/);
  assert.ok(text.indexOf('UI testing is on') < text.indexOf('---'), 'before the contract');
  assert.doesNotMatch(text, /\{\{/);
});

test('a prompt override stored for the removed kanban.unhold prompt is ignored, not an error', (t) => {
  const { def, dir, repo, settings, compose } = setup(t);
  assert.equal(isKanbanPromptId('kanban.unhold'), false);
  // A settings file saved before the prompt went: its override is dropped when the file is read, the others stay.
  const stored = sanitizeKanbanSettings({ projects: { proj: { prompts: { 'kanban.unhold': 'Back to work.', 'kanban.resume': 'Mine.' } } } });
  assert.deepEqual(stored.projects.proj.prompts, { 'kanban.resume': 'Mine.' });
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  assert.match(String(settings.setProjectPrompt('proj', 'kanban.unhold', 'Back to work.')), /Only kanban prompts/);
  // A comment's run on a task that was held is the ordinary resume.
  const held = { ...task, hold: { at: Date.now(), by: 'Ada', from: 'review' as const, note: 'waiting' } } as typeof task;
  const text = compose.build('resume', def, held, 'claude', dir, { phase: 'resume', text: 'The keys are in.', author: 'Ada' });
  assert.match(text, /Ada commented on task #\d+/);
  assert.match(text, /The keys are in\./);
  assert.doesNotMatch(text, /on hold since/);
});

test('UI testing: a fresh session’s hand-off carries the block exactly once, for implement, fix and comment', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const cases: [PromptKind, RunPhase, string][] = [
    ['implement', 'implement', 'UI testing is on for this task'],
    ['fix', 'fix', 'take the after pictures again'],
    ['resume', 'resume', 'take the after pictures again'],
  ];
  for (const [kind, phase, phrase] of cases) {
    const next = compose.build(kind, def, task, 'claude', dir, { phase, round: 1, rounds: 2, findings: 'F', text: 'Please', author: 'Ada' });
    const text = compose.handoff(def, task, dir, next);
    assert.equal(text.split(phrase).length, 2, `${kind}: the block once`);
    // The repositories' folders under it (this project has two) are named by their own lines.
    assert.equal(text.split(images).length - 1 - text.split(`${images}/`).length + 1, 1, `${kind}: the folder named`);
    assert.doesNotMatch(text, /\{\{/, kind);
  }
});

test('UI testing: a task in several git repositories gets a folder per repository, named in the block; one repository gets none and no leftover', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const mk = (repoIds?: string[]) => repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada', repoIds });
  const task = mk();
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const text = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.ok(text.includes(`- ${path.join(images, 'proj')}: Proj`), 'the primary');
  assert.ok(text.includes(`- ${path.join(images, 'api')}: API (acme/api)`));
  assert.ok(!text.includes(path.join(images, 'notes')) && !existsSync(path.join(images, 'notes')), 'a folder repository is no git repository');
  assert.match(text, /goes to every pull request/);
  assert.ok(statSync(path.join(images, 'api')).isDirectory() && statSync(path.join(images, 'proj')).isDirectory());
  assert.doesNotMatch(text, /\{\{/);
  // One git repository (the folder one does not count): the block as before.
  const one = mk(['proj']);
  const oneText = compose.build('implement', def, one, 'claude', dir, { phase: 'implement' });
  assert.doesNotMatch(oneText, /several repositories|\{\{/);
  assert.ok(oneText.includes('(it exists; make it if it does not).\nName each image'), 'no stray blank line');
  assert.deepEqual(readdirSync(path.join(ctx.filesDir, 'grants', `task-${one.id}`, 'ui')), []);
  // The fix block names them too; the reviewer's does not.
  assert.match(compose.build('fix', def, task, 'claude', dir, { phase: 'fix', round: 1, rounds: 2, findings: 'F' }), /several repositories/);
});

test('UI testing: a rewritten block without {{imageFolders}} gets the folders at its end', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t, { 'kanban.uiTesting': { text: 'Take pictures into {{imagesDir}}.' } });
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const text = compose.build('implement', def, task, 'claude', dir, { phase: 'implement' });
  assert.match(text, /Take pictures into [^\n]+\.\n\nThis task changes several repositories/);
  assert.ok(text.includes(`- ${path.join(images, 'api')}: API`));
  assert.equal(text.split('This task changes several repositories').length, 2, 'once');
});

test('UI testing: with no repository folders the blocks render as the text without the {{imageFolders}} line', () => {
  for (const id of ['kanban.uiTesting', 'kanban.uiTesting.onRequest', 'kanban.uiTesting.fix'] as const) {
    const raw = KANBAN_PROMPT_DEFS[id].text;
    assert.ok(raw.includes('\n{{imageFolders}}\n'), id);
    const filled = resolveKanbanPrompt(id, {}, { imagesDir: '/i', imageFolders: '' });
    assert.equal(filled, raw.replace('\n{{imageFolders}}', '').replace('{{imagesDir}}', '/i'), id);
    assert.doesNotMatch(filled, /\n\n|\{\{/, id);
  }
});

// --- the project's instructions as files ---------------------------------------------------------

const INS_KINDS = KINDS.map(([k, ph]) => [k, ph] as const);
const insTask = (repo: ReturnType<typeof setup>['repo']) => {
  const task = repo.createTask({ project: 'proj', title: 'Fix it', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  repo.upsertPrLink(task.id, { repoId: 'proj', repo: 'acme/proj', number: 3, url: 'https://github.com/acme/proj/pull/3', state: 'OPEN' });
  return repo.getTask(task.id)!;
};
const insX = (phase: RunPhase) => ({ phase, round: 1, rounds: 2, text: 'An answer', author: 'Ada', findings: 'A finding', fixSummary: 'Fixed', prs: '- acme/api#12 https://github.com/acme/api/pull/12' });
const count = (text: string, part: string) => text.split(part).length - 1;

test('instructions: every kind names the files, never the text; the files hold the text', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = insTask(repo);
  const at = (f: string) => path.join(ctx.filesDir, 'instructions', 'proj', f);
  for (const [kind, phase] of INS_KINDS) {
    const text = compose.build(kind, def, task, 'claude', dir, insX(phase));
    assert.doesNotMatch(text, /\{\{/, kind);
    assert.ok(text.includes(at('general.md')) && text.includes(at('testing.md')) && text.includes(at('repo-proj.md')), `${kind} names the three files`);
    assert.doesNotMatch(text, /Keep it small\.|Run npm test\./, `${kind} has no instruction text`);
    assert.equal(count(text, "The project's instructions"), 1, kind);
  }
  assert.equal(readFileSync(at('general.md'), 'utf8').trim(), 'Keep it small.');
  assert.equal(readFileSync(at('testing.md'), 'utf8').trim(), 'npm test');
  assert.equal(readFileSync(at('repo-proj.md'), 'utf8').trim(), 'Run npm test.');
});

test('instructions: a pr.review names the repositories involved in the pull requests', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  def.repos![1].instructions = 'API rules.';
  const task = insTask(repo);
  const at = (f: string) => path.join(ctx.filesDir, 'instructions', 'proj', f);
  const only = compose.build('pr.review', def, task, 'claude', dir, { ...insX('pr-review'), prRepoIds: [] });
  assert.ok(only.includes(at('repo-proj.md')) && !only.includes(at('repo-api.md')));
  const both = compose.build('pr.review', def, task, 'claude', dir, { ...insX('pr-review'), prRepoIds: ['api'] });
  assert.ok(both.includes(at('repo-proj.md')) && both.includes(at('repo-api.md')));
  // A continued review (an answer, a restart) keeps to the repositories of its request, read from the pull requests again.
  assert.deepEqual(prReviewRepoIds(def, [{ repo: 'acme/proj' }]), []);
  assert.deepEqual(prReviewRepoIds(def, [{ repo: 'ACME/api' }]), ['api']);
  for (const kind of ['continue', 'restarted', 'resume'] as const) {
    const later = compose.build(kind, def, task, 'claude', dir, { ...insX('pr-review'), text: 'Go on.', prRepoIds: prReviewRepoIds(def, [{ repo: 'acme/proj' }]) });
    assert.ok(later.includes(at('repo-proj.md')) && !later.includes(at('repo-api.md')), kind);
  }
});

test('instructions: a project with none gets nothing extra, in every kind', (t) => {
  const { def, dir, repo, settings, compose } = setup(t);
  settings.setProject('proj', { generalInstructions: '', testingInstructions: '' });
  def.repos![0].instructions = undefined;
  const task = insTask(repo);
  for (const [kind, phase] of INS_KINDS) {
    const text = compose.build(kind, def, task, 'claude', dir, insX(phase));
    assert.doesNotMatch(text, /The project's instructions|instructions\/proj|\{\{/, kind);
    assert.doesNotMatch(text, /\n{3,}/, `${kind} has no doubled blank lines`);
  }
  assert.doesNotMatch(compose.handoff(def, task, dir, compose.build('fix', def, task, 'claude', dir, insX('fix'))), /The project's instructions/);
});

test('instructions: a rewrite without {{instructions}} gets the block at its end, before the contract; one with it, once, in place', (t) => {
  const office = { 'kanban.fix': { text: 'Office fix: {{findings}}' }, 'kanban.continue': { text: 'Office continue.' }, 'kanban.pr.create': { text: 'Office PR: {{title}}\n\n{{instructions}}\n\nEnd.' } };
  const { def, dir, repo, settings, compose } = setup(t, office);
  const task = insTask(repo);
  settings.setProject('proj', { uiTesting: false });
  const fix = compose.build('fix', def, task, 'claude', dir, insX('fix'));
  assert.match(fix, /^Office fix: A finding\n\nThe project's instructions[\s\S]*repo-proj\.md` before you work in Proj\.\n\n---/);
  assert.equal(count(fix, "The project's instructions"), 1);
  // A project override over an office one, still without the placeholder.
  settings.setProjectPrompt('proj', 'kanban.fix', 'Project fix: {{findings}}');
  assert.match(compose.build('fix', def, task, 'claude', dir, insX('fix')), /^Project fix: A finding\n\nThe project's instructions[\s\S]*\n\n---/);
  // restarted follows continue.
  const restarted = compose.build('restarted', def, task, 'claude', dir, insX('implement'));
  assert.equal(count(restarted, "The project's instructions"), 1);
  assert.match(restarted, /Office continue\.\n\nThe project's instructions/);
  const pr = compose.build('pr.create', def, task, 'claude', dir, insX('pr'));
  assert.match(pr, /^Office PR: Fix it\n\nThe project's instructions[\s\S]*\n\nEnd\.\n\n---/);
  assert.equal(count(pr, "The project's instructions"), 1);
  // Held messages and the contract stay last.
  const held = compose.build('fix', def, task, 'claude', dir, { ...insX('fix'), held: '- Ada: hi' });
  assert.ok(held.indexOf("The project's instructions") < held.indexOf('Messages left on the task') && held.endsWith(KANBAN_CONTRACTS.implementSafety));
});

test('instructions: the handoff carries the reference once, in the intro when its next prompt lacks it', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = insTask(repo);
  for (const [kind, phase] of [['fix', 'fix'], ['resume', 'resume'], ['pr.create', 'pr'], ['pr.fix', 'pr-fix']] as const) {
    const out = compose.handoff(def, task, dir, compose.build(kind, def, task, 'claude', dir, insX(phase)));
    assert.equal(count(out, "The project's instructions"), 1, kind);
  }
  const bare = compose.handoff(def, task, dir, 'Carry on.');
  assert.match(bare, /The project's instructions[\s\S]*\n\nCarry on\.$/);
  assert.equal(count(bare, "The project's instructions"), 1);
});

test('instructions: a part whose file cannot be written is inlined as text, the others stay references', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  mkdirSync(path.join(ctx.filesDir, 'instructions', 'proj', 'testing.md'), { recursive: true });
  const text = compose.build('fix', def, insTask(repo), 'claude', dir, insX('fix'));
  assert.match(text, /Testing and verifying:\nnpm test/);
  assert.ok(text.includes(path.join(ctx.filesDir, 'instructions', 'proj', 'general.md')) && text.includes('repo-proj.md'));
  assert.doesNotMatch(text, /\{\{/);
});

test("instructions: a repository called like an Object member still gets its text when its file can't be written", (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  def.repos!.push({ id: 'constructor', name: 'Ctor', kind: 'folder', dir: def.repos![2].dir, primary: false, instructions: 'Ctor rules.' });
  mkdirSync(path.join(ctx.filesDir, 'instructions', 'proj', 'repo-constructor.md'), { recursive: true });
  const text = compose.build('fix', def, insTask(repo), 'claude', dir, insX('fix'));
  assert.match(text, /In Ctor:\nCtor rules\./, 'the text, as no file holds it');
  assert.doesNotMatch(text, /native code|repo-constructor\.md/);
});

test('instructions: the plain worker PR prompt has no placeholder left', (t) => {
  const { compose, def, root } = setup(t);
  const floor = { id: 'proj', def, dir: def.dir, project: { name: 'Proj', branch: 'main' }, queue: { issueOf: () => ({}) } } as unknown as Floor;
  const info = { id: 'w', name: 'Ada', title: 'Work', provider: 'claude' } as unknown as WorkerInfo;
  assert.doesNotMatch(compose.workerPr(floor, info), /\{\{instructions\}\}/);
  void root;
});

// --- the accepted plan and the conversation as files ------------------------------------------------

const histTask = (repo: ReturnType<typeof setup>['repo'], opts: { plan?: boolean; comment?: boolean; summary?: boolean } = {}) => {
  const task = repo.createTask({ project: 'proj', title: 'Fix it', description: 'x', tool: 'claude', usePlan: !!opts.plan, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  if (opts.plan) {
    repo.addPlan(task.id, 'Secret plan text');
    repo.acceptPlan(task.id, 'Ada');
  }
  if (opts.comment) repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'Please also handle the empty case.' });
  if (opts.summary) repo.updateTask(task.id, { summary: 'I changed the redirect.' });
  return repo.getTask(task.id)!;
};
const histX = (phase: RunPhase) => ({ ...insX(phase) });

test('plan file: the plan is a reference in implement, implement.folder, review and the handoff, and its text in no kind', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = histTask(repo, { plan: true });
  const ref = `\`${planFilePath(ctx.filesDir, task.id)}\``;
  for (const [kind, phase] of KINDS) assert.doesNotMatch(compose.build(kind, def, task, 'claude', dir, histX(phase)), /Secret plan text/, kind);
  for (const kind of ['implement', 'review'] as const) assert.ok(compose.build(kind, def, task, 'claude', dir, histX(kind === 'review' ? 'review' : 'implement')).includes(ref), kind);
  const folder = { ...def, repos: [def.repos![2]], dir: def.repos![2].dir };
  assert.ok(compose.build('implement', folder, task, 'claude', dir, histX('implement')).includes(ref), 'implement.folder');
  const handoff = compose.handoff(def, task, dir, 'Carry on.');
  assert.ok(handoff.includes(ref));
  assert.doesNotMatch(handoff, /Secret plan text/);
  assert.equal(readFileSync(planFilePath(ctx.filesDir, task.id), 'utf8').trim(), 'Secret plan text');
});

test('plan file: where the file cannot be written the text is inlined', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = histTask(repo, { plan: true });
  mkdirSync(planFilePath(ctx.filesDir, task.id), { recursive: true });
  const text = compose.build('implement', def, task, 'claude', dir, histX('implement'));
  assert.match(text, /The accepted plan:\n\nSecret plan text/);
  assert.doesNotMatch(text, /\{\{/);
});

test('plan file: acceptPlan on the composer writes the file', (t) => {
  const { repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', tool: 'claude', usePlan: true, planApproval: 'manual', useReview: true, createdBy: 'Ada' });
  repo.addPlan(task.id, 'Agreed plan');
  compose.acceptPlan(task.id, 'Ada');
  assert.equal(readFileSync(planFilePath(ctx.filesDir, task.id), 'utf8').trim(), 'Agreed plan');
});

test('history: review and rereview name the conversation file, which holds the comments; no other kind does', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = histTask(repo, { comment: true });
  const file = conversationFilePath(ctx.filesDir, task.id);
  for (const [kind, phase] of KINDS) {
    const text = compose.build(kind, def, task, 'claude', dir, histX(phase));
    assert.doesNotMatch(text, /\{\{\s*\w+\s*\}\}/, kind);
    const has = kind === 'review' || kind === 'rereview';
    assert.equal(text.includes(file), has, kind);
    if (has) assert.match(text, /a later message from the user overrides/, kind);
  }
  assert.match(readFileSync(file, 'utf8'), /Please also handle the empty case\./);
  const combine = compose.build('rereview', def, task, 'claude', dir, { ...histX('review'), panel: 'combine', reviews: 'R1' });
  assert.ok(!combine.includes(file), 'not in the combine part');
});

test('history: a bare task gets no blocks, no doubled blank lines and no placeholder', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = histTask(repo);
  for (const [kind, phase] of KINDS) {
    const text = compose.build(kind, def, task, 'claude', dir, histX(phase));
    assert.doesNotMatch(text, /\{\{|conversation\.md|accepted-plan\.md|What the implementer says it did/, kind);
    assert.doesNotMatch(text, /\n{3,}/, kind);
  }
  assert.ok(!existsSync(conversationFilePath(ctx.filesDir, task.id)));
  assert.ok(!existsSync(planFilePath(ctx.filesDir, task.id)));
});

test('history: a rewritten review or rereview without {{history}} gets the block before the contract, from a project or the office', (t) => {
  const office = { 'kanban.review': { text: 'Office review of #{{taskId}}.' }, 'kanban.rereview': { text: 'Office again: {{fixSummary}}' } };
  const { def, dir, repo, settings, compose, ctx } = setup(t, office);
  settings.setProject('proj', { uiTesting: false, generalInstructions: '', testingInstructions: '' });
  def.repos![0].instructions = undefined;
  const task = histTask(repo, { comment: true, summary: true });
  const file = conversationFilePath(ctx.filesDir, task.id);
  const review = compose.build('review', def, task, 'claude', dir, histX('review'));
  assert.match(review, new RegExp(`^Office review of #\\d+\\.\\n\\nThe task's conversation is in \`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`[\\s\\S]*\\n\\n---`));
  assert.doesNotMatch(review, /I changed the redirect/, '{{summary}} is not appended to a rewrite that lacks it');
  assert.equal(count(review, 'conversation is in'), 1);
  assert.match(compose.build('rereview', def, task, 'claude', dir, histX('review')), /^Office again: Fixed\n\nThe task's conversation is in/);
  settings.setProjectPrompt('proj', 'kanban.review', 'Project review.');
  settings.setProjectPrompt('proj', 'kanban.rereview', 'Project again.');
  assert.match(compose.build('review', def, task, 'claude', dir, histX('review')), /^Project review\.\n\nThe task's conversation is in[\s\S]*\n\n---/);
  assert.match(compose.build('rereview', def, task, 'claude', dir, histX('review')), /^Project again\.\n\nThe task's conversation is in[\s\S]*\n\n---/);
});

test('history: the implementer summary is in a first-round review and not in a rereview', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = histTask(repo, { summary: true });
  assert.match(compose.build('review', def, task, 'claude', dir, histX('review')), /What the implementer says it did \(a claim to check against the diff, not a fact\):\n\nI changed the redirect\./);
  assert.doesNotMatch(compose.build('rereview', def, task, 'claude', dir, histX('review')), /I changed the redirect/);
});

test('history: where the file cannot be written the newest part of the conversation is inlined, capped', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = histTask(repo, { comment: true });
  repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'y'.repeat(HISTORY_TEXT_MAX * 2) });
  repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'The newest word END' });
  mkdirSync(conversationFilePath(ctx.filesDir, task.id), { recursive: true });
  const text = compose.build('review', def, task, 'claude', dir, histX('review'));
  assert.match(text, /The task's conversation follows/);
  assert.match(text, /a later message from the user overrides/);
  assert.ok(text.includes('The newest word END'), 'the newest entry is kept');
  assert.ok(!text.includes('y'.repeat(HISTORY_TEXT_MAX)), 'the older one is left out');
  assert.doesNotMatch(text, /\{\{/);
  assert.ok(text.length < HISTORY_TEXT_MAX + 20_000, 'the text is capped');
});

test('plan file: a rereview names the plan file, carries the text where the file cannot be written, and adds nothing without a plan', (t) => {
  const { def, dir, repo, compose, ctx } = setup(t);
  const task = histTask(repo, { plan: true, comment: true });
  const re = compose.build('rereview', def, task, 'claude', dir, histX('review'));
  assert.ok(re.includes(`\`${planFilePath(ctx.filesDir, task.id)}\``));
  assert.doesNotMatch(re, /Secret plan text/);
  rmSync(planFilePath(ctx.filesDir, task.id), { force: true });
  mkdirSync(planFilePath(ctx.filesDir, task.id), { recursive: true });
  assert.match(compose.build('rereview', def, task, 'claude', dir, histX('review')), /The accepted plan:\n\nSecret plan text/);
  const bare = histTask(repo);
  const text = compose.build('rereview', def, bare, 'claude', dir, histX('review'));
  assert.doesNotMatch(text, /accepted plan|\{\{|\n{3,}/i);
});

test('review focus: the reviewer\'s own review and re-review carry it before the panel rule, the combine and no-focus prompts do not', (t) => {
  const { def, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'X', description: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const base = { phase: 'review' as const, round: 2, rounds: 2, fixSummary: 'Fixed' };
  for (const kind of ['review', 'rereview'] as const) {
    const plain = compose.build(kind, def, task, 'claude', dir, base);
    for (const empty of [undefined, '', '  ']) assert.equal(compose.build(kind, def, task, 'claude', dir, { ...base, focus: empty }), plain, `${kind}: an empty focus changes nothing`);
    const focused = compose.build(kind, def, task, 'claude', dir, { ...base, focus: 'Security' });
    assert.match(focused, /Your viewpoint for your own review: Security\. Look hardest for what matters from that viewpoint\. Still report a problem outside it when it is serious\./);
    assert.doesNotMatch(focused, /on its own merits/);
    assert.doesNotMatch(focused, /\{\{/);
    assert.ok(focused.endsWith(KANBAN_CONTRACTS.review));
    const co = compose.build(kind, def, task, 'claude', dir, { ...base, focus: 'Security', panel: 'co' });
    assert.ok(co.indexOf('Your viewpoint') < co.indexOf('reviewing this same folder'), `${kind}: focus, then the panel rule`);
  }
  const combine = compose.build('rereview', def, task, 'claude', dir, { ...base, focus: 'Security', panel: 'combine', reviews: 'x' });
  assert.equal(combine, compose.build('rereview', def, task, 'claude', dir, { ...base, panel: 'combine', reviews: 'x' }), 'the combine prompt is the same with and without a focus');
  assert.match(compose.build('rereview', def, task, 'claude', dir, { ...base, panel: 'combine', reviews: 'x' }), /Judge each finding on its own merits, whatever viewpoint you or its reviewer reviewed from\./, 'the combiner is told so without a focus of its own too');
  assert.match(combine, /Combine them into the review/);
  assert.doesNotMatch(combine, /Your viewpoint/);
  assert.deepEqual(placeholders(KANBAN_PROMPT_DEFS['kanban.review.focus'].text), ['focus']);
  assert.equal(PROMPT_CONTRACT['kanban.review.focus'], undefined, 'a fragment like kanban.review.co: the contract follows the whole prompt');
});

// --- Pull-request review prompts: heads, combine, posting, UI test ---------------------------------------------------

test('kanban.pr.review: the checkout state and the diff command are in the default text and travel in the {{prs}} lines, the contract keeps its bans', (t) => {
  const { def, dir, repo, compose, settings } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review: acme/proj#3', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const prs = '- acme/proj#3 “Fix” https://github.com/acme/proj/pull/3 — Checked out in your worktree of Proj: read its change there with `git diff origin/main...HEAD`.\n- acme/api#5 https://github.com/acme/api/pull/5 — Not checked out (your worktree of its repository is on the base branch): read it with `gh pr diff 5 -R acme/api`.';
  const text = compose.build('pr.review', def, task, 'claude', dir, { phase: 'pr-review', prs });
  assert.match(text, /a pull request marked as checked out above is the code in its repository's worktree: read its change there with the diff command given on its line; any other is read with gh pr diff/);
  assert.ok(text.includes('git diff origin/main...HEAD') && text.includes('gh pr diff 5 -R acme/api'));
  assert.doesNotMatch(text, /the pull requests' own code is in gh pr diff, not here/);
  // A project's own rewrite of the prompt gets the lines too: the state is in the variable, not the default text.
  settings.setProject('proj', { prompts: { 'kanban.pr.review': 'Look at {{prs}}' } });
  const mine = compose.build('pr.review', def, task, 'claude', dir, { phase: 'pr-review', prs });
  assert.ok(mine.startsWith(`Look at ${prs}`) && mine.includes('git diff origin/main...HEAD'));
  // The bans stay, and the contract tells how to read a checked-out pull request.
  const c = KANBAN_CONTRACTS.prReview;
  for (const word of ['git checkout', 'git switch', 'git commit', 'git push', 'gh pr review', 'Never modify, create or delete files']) assert.ok(c.includes(word), word);
  assert.match(c, /A pull request that its line says is checked out is the code in your worktree: read it there \(git diff, git log, the files\), read-only/);
  assert.doesNotMatch(c, /the worktree you are in is only for reading the code around them/);
});

test('kanban.pr.review.combine: names the pull requests and the reviews, no task or round language, the review contract after it', (t) => {
  const def = KANBAN_PROMPT_DEFS['kanban.pr.review.combine'];
  assert.deepEqual(placeholders(def.text).sort(), ['instructions', 'language', 'prs', 'reviews']);
  assert.equal(PROMPT_CONTRACT['kanban.pr.review.combine'], 'prReview');
  assert.equal(PROMPTS['kanban.pr.review.combine'].group, 'kanban');
  const { def: floorDef, dir, repo, compose } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review: acme/proj#3', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const text = compose.build('rereview', floorDef, task, 'claude', dir, { phase: 'pr-review', panel: 'combine', prs: '- acme/proj#3 https://github.com/acme/proj/pull/3', reviews: 'Reviewer 1 (Claude), you: APPROVED\nFine.' });
  assert.match(text, /^Other reviewers reviewed these pull requests at the same time as you:\n- acme\/proj#3 /);
  assert.match(text, /Reviewer 1 \(Claude\), you: APPROVED\nFine\./);
  assert.doesNotMatch(text, /task #|round \{\{|round \d of/);
  assert.ok(text.endsWith(KANBAN_CONTRACTS.prReview));
});

test('post: the block telling the reply is posted goes after the pr.review and the combine prompt of a posting review, before the contract, whatever the prompt says', (t) => {
  const { def, dir, repo, compose, settings } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review: acme/proj#3', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const common = { phase: 'pr-review' as const, prs: '- acme/proj#3 https://github.com/acme/proj/pull/3', reviews: 'R' };
  for (const x of [{ ...common }, { ...common, panel: 'combine' as const }, { ...common, panel: 'co' as const }]) {
    const kind: PromptKind = x.panel === 'combine' ? 'rereview' : 'pr.review';
    const off = compose.build(kind, def, task, 'claude', dir, x);
    const on = compose.build(kind, def, task, 'claude', dir, { ...x, post: true });
    assert.ok(!off.includes(prPosted()), 'nothing without post');
    assert.ok(on.includes(`${prPosted()}\n\n${KANBAN_CONTRACTS.prReview}`), `${kind}/${x.panel ?? 'solo'}: the block, then the contract`);
  }
  // The fixture sets no public language: the block points at the prompt's own language rule.
  assert.match(prPosted(), /in the language this prompt's language rule sets for what is posted on pull requests, in English when it sets none, for a reader outside this office/);
  assert.match(prPosted(), /Don't mention a kanban task, rounds, other reviewers/);
  // What doesn't block the merge is kept apart from the findings, in the posted review and in both editable prompts.
  assert.match(prPosted(), /it goes after them under a heading `### Other observations`, written in the language of your reply/);
  for (const id of ['kanban.pr.review', 'kanban.pr.review.combine'] as const) {
    assert.match(KANBAN_PROMPT_DEFS[id].text, /under a heading of its own, "Other observations"/, id);
    assert.match(KANBAN_PROMPT_DEFS[id].text, /the order to merge and deploy in/i, id);
    assert.match(KANBAN_PROMPT_DEFS[id].text, /A migration that looks missing from these pull requests is not a finding by itself either/, id);
  }
  assert.match(prPosted(), /a pull request description that doesn't spell those out\) is never listed among the findings/);
  assert.match(prPosted(), /A migration that looks missing from these pull requests is not a finding by itself either/);
  assert.match(prPosted(), /whatever else the test found that is worth saying goes among the other observations/);
  assert.match(KANBAN_PROMPT_DEFS['kanban.pr.uiTest.section'].text, /goes with your other observations, apart from the findings/);
  assert.match(prPosted('Finnish'), /write it in Finnish, for a reader outside this office/);
  assert.ok(!prPosted('Finnish').includes('in English'));
  assert.match(prPosted('Finnish'), /don't write a section about testing/);
  assert.match(prPosted(), /`## <owner\/repo#number>` exactly as its line above names it/);
  assert.ok(!prPosted().includes('Pictures:') && prPosted(undefined, true).includes('`Pictures:`'));
  // A rewritten prompt gets it too: it is not a prompt variable.
  settings.setProject('proj', { prompts: { 'kanban.pr.review': 'Mine', 'kanban.pr.review.combine': 'Mine too {{reviews}}' } });
  const mine = compose.build('pr.review', def, task, 'claude', dir, { ...common, post: true });
  assert.ok(mine.startsWith('Mine') && mine.includes(`${prPosted()}\n\n${KANBAN_CONTRACTS.prReview}`));
  // The rewritten prompt has none of the default's rules: what is no finding still reaches its reviewer, in the block.
  assert.ok(!mine.includes('under a heading of its own, "Other observations"') && /a pull request description that doesn't spell those out\) is never listed among the findings/.test(mine));
  assert.ok(compose.build('rereview', def, task, 'claude', dir, { ...common, panel: 'combine', post: true }).includes(prPosted()));
  assert.deepEqual(Object.keys(PROMPTS).filter((id) => PROMPTS[id as PromptId].text.includes(prPosted())), [], 'it is in no editable prompt');
});

test('kanban.pr.uiTest.review: a rewritten block without {{report}} gets the report line at its end, and an emptied one adds nothing but the section', (t) => {
  const { def: floorDef, dir, repo, compose, ctx } = setup(t, { 'kanban.pr.uiTest.review': { text: 'Pictures: {{imageList}}' } });
  const task = repo.createTask({ project: 'proj', title: 'PR review', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const grant = path.join(ctx.filesDir, 'grants', `task-${task.id}`);
  keepUiTestReport(repo, ctx.filesDir, task.id, 'x');
  const text = compose.build('pr.review', floorDef, task, 'claude', dir, { phase: 'pr-review', prs: '- acme/proj#3 https://github.com/acme/proj/pull/3', uiTest: true });
  assert.ok(text.includes(`Pictures: none yet\n${"The tester's report is in " + path.join(grant, 'ui-test-report.md')}.\n\nDon't write a section about the test`));
});

test('kanban.pr.uiTest: the UI tester’s prompt names each head, the images folder and the rules, and ends with the UI test contract; the pictures are listed to the reviewers', (t) => {
  const def = KANBAN_PROMPT_DEFS['kanban.pr.uiTest'];
  assert.deepEqual(placeholders(def.text).sort(), ['imagesDir', 'instructions', 'language', 'project', 'prs', 'reportFile', 'repos', 'task']);
  assert.equal(PROMPT_CONTRACT['kanban.pr.uiTest'], 'prUiTest');
  assert.equal(PROMPTS['kanban.pr.uiTest'].group, 'kanban');
  assert.ok(placeholders(KANBAN_PROMPT_DEFS['kanban.pr.uiTest.review'].text).every((n) => ['imagesDir', 'imageList', 'report'].includes(n)));
  assert.deepEqual(placeholders(KANBAN_PROMPT_DEFS['kanban.pr.uiTest.section'].text), []);
  const { def: floorDef, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review: acme/proj#3', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const images = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui');
  const report = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui-test-report.md');
  const x = { phase: 'implement' as const, prs: '- acme/proj#3 https://github.com/acme/proj/pull/3 — its head is fetched as origin/office-pr/3', prRepos: '- `.`: Proj' };
  const text = compose.build('pr.uitest', floorDef, task, 'claude', dir, x);
  assert.doesNotMatch(text, /\{\{/);
  for (const part of ['its head is fetched as origin/office-pr/3', `Save the pictures in ${images}`, '<subject>-before.png or <subject>-after.png', 'under its Images tab. When the review is posted on the pull requests, the pictures that show a fault are attached', 'git worktree add --detach', 'git fetch origin pull/<number>/head', 'Never create, move or delete a branch, never commit', 'is from a fork is not tested', "Don't commit, push or change any file of the repositories", 'stop every process you started', 'say so in your report and end', 'Use test data and test accounts only', 'Test what these pull requests change', 'real user actions', `Write the report to ${report} as you go`, '## Test report', 'a shared or production backend']) assert.ok(text.includes(part), part);
  for (const part of ['call the changed endpoints', "the project's pull-request review instructions", 'send nothing that writes there']) assert.ok(text.includes(part), part); // not a UI-only tester: endpoints, the project's say, the shared-backend guard
  assert.ok(text.endsWith(KANBAN_CONTRACTS.prUiTest), 'the UI test contract');
  assert.match(KANBAN_CONTRACTS.prUiTest, /Don't comment on, review, merge or change the pull requests, and attach the pictures \(if you take any\) to none of them/);
  assert.match(KANBAN_CONTRACTS.prUiTest, /How to end your work/, 'the work-done ending of an investigation');
  assert.doesNotMatch(KANBAN_CONTRACTS.prUiTest, /REVIEW: APPROVED/);
  assert.ok(text.includes('WORK DONE'));
  // What the user said to a tester that asked goes after it.
  assert.match(compose.build('pr.uitest', floorDef, task, 'claude', dir, { ...x, text: 'Use the staging login.' }), /Use the staging login\./);
  // The reviewers get the report and the pictures, when the UI was tested and the tester left either.
  const base = { phase: 'pr-review' as const, prs: '- acme/proj#3 https://github.com/acme/proj/pull/3' };
  const SECTION = "Don't write a section about the test";
  const TESTED = /were tested before your review/;
  assert.doesNotMatch(compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true }), TESTED, 'no report and no pictures, nothing to add');
  // A report without pictures.
  keepUiTestReport(repo, ctx.filesDir, task.id, '## UI test report\nPASSED');
  const only = compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true });
  assert.match(only, TESTED);
  assert.ok(only.includes(`The tester's report is in ${report}.`));
  assert.ok(only.includes(`${images}:\nnone yet`));
  // A file there that is not what the office stored (changed since, or left by the tester when the store failed) is never named: the kept text is given.
  rmSync(report);
  writeFileSync(report, 'x'.repeat(5_000_000));
  const foreign = compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true });
  assert.ok(!foreign.includes("The tester's report is in") && foreign.includes("The tester's report could not be kept as a file. It is:\n## UI test report\nPASSED"));
  // A new UI test starts: the earlier report is not its.
  rmSync(report);
  resetUiTestReport(repo, ctx.filesDir, task.id);
  assert.doesNotMatch(compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true }), TESTED);
  // Pictures without a report.
  mkdirSync(images, { recursive: true });
  writeFileSync(path.join(images, 'login-before.png'), 'b');
  writeFileSync(path.join(images, 'login-after.png'), 'a');
  const listed = compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true });
  assert.ok(listed.includes(`- login: before ${path.join(images, 'login-before.png')}, after ${path.join(images, 'login-after.png')}`));
  assert.match(listed, /A wrong UI in the pictures is a finding\. Pictures that are missing are not/);
  assert.ok(listed.includes('The tester left no report.'));
  // A folder, or a file nobody stored, at the report's path is no report to name.
  mkdirSync(report);
  const folder = compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true });
  assert.ok(folder.includes('The tester left no report.') && !folder.includes("The tester's report is in"));
  rmSync(report, { recursive: true });
  writeFileSync(report, 'written by the tester, never taken in by the office');
  const stray = compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true });
  assert.ok(stray.includes('The tester left no report.') && !stray.includes("The tester's report is in"));
  rmSync(report);
  assert.doesNotMatch(compose.build('pr.review', floorDef, task, 'claude', dir, base), TESTED, 'only a review that had the UI tested');
  // The review's own section: the main reviewer and the combine, not an additional reviewer.
  assert.ok(listed.includes(SECTION), 'the main reviewer');
  const co = compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true, panel: 'co' });
  assert.ok(co.includes('login-before.png') && !co.includes(SECTION), 'the additional reviewers get the block, not the section');
  const combine = compose.build('rereview', floorDef, task, 'claude', dir, { ...base, uiTest: true, panel: 'combine', reviews: 'r' });
  assert.ok(combine.includes('login-before.png') && combine.includes(SECTION), 'the combine gets both');
  assert.ok(combine.indexOf(SECTION) < combine.indexOf(KANBAN_CONTRACTS.prReview), 'before the contract');
  keepUiTestReport(repo, ctx.filesDir, task.id, 'x');
  assert.ok(compose.build('pr.review', floorDef, task, 'claude', dir, { ...base, uiTest: true }).includes(`The tester's report is in ${report}.`));
});

test('kanban.pr.uiTest.review: a report that is the tester’s file and its reply together, larger than the tester’s own file may be, is still named whole to the reviewers', (t) => {
  const { def: floorDef, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const report = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui-test-report.md');
  // The tester's file, near its limit, and a reply as large that holds the last finding: what uiEnded keeps of the two.
  const own = `## UI test report\n### Tested\n${'- PR 3 a path in the file: PASSED\n'.repeat(3600)}`;
  const reply = `## UI test report\n### Tested\n${'- PR 3 a path in the reply: PASSED\n'.repeat(3600)}### Findings\n- PR 3: the last finding, only in the reply`;
  const whole = uiTestReport(own.trim(), reply);
  assert.ok(Buffer.byteLength(own) < 200_000 && Buffer.byteLength(whole) > 200_000, `${Buffer.byteLength(own)} and ${Buffer.byteLength(whole)} bytes`);
  keepUiTestReport(repo, ctx.filesDir, task.id, whole);
  const build = () => compose.build('pr.review', floorDef, task, 'claude', dir, { phase: 'pr-review', prs: '- acme/proj#3 https://github.com/acme/proj/pull/3', uiTest: true });
  const text = build();
  assert.ok(text.includes(`The tester's report is in ${report}.`), 'the file is named');
  assert.ok(!text.includes('The report is cut here') && !text.includes('could not be kept as a file'));
  assert.match(readFileSync(report, 'utf8'), /the last finding, only in the reply\n$/, 'and it holds the reply’s finding at its end');
  // One byte more in it than the office gave it, or other text of the same size, and it is not named.
  const stored = readFileSync(report, 'utf8');
  rmSync(report);
  writeFileSync(report, `${stored}x`);
  assert.ok(!build().includes("The tester's report is in"), 'grown');
  rmSync(report);
  writeFileSync(report, stored.replace('the last finding', 'THE LAST FINDING'));
  assert.ok(!build().includes("The tester's report is in"), 'changed');
  rmSync(report);
  writeFileSync(report, stored);
  assert.ok(build().includes(`The tester's report is in ${report}.`));
});

test('kanban.pr.uiTest.review: when the report file can be neither replaced nor removed, the file left there is not named: the whole report is kept beside it, and with no file at all its text is given, marked as cut when it is', (t) => {
  const { def: floorDef, dir, repo, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const report = path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui-test-report.md');
  const folder = path.dirname(report);
  mkdirSync(folder, { recursive: true });
  // What the tester left, over the limit and so refused as a report: an ordinary file.
  writeFileSync(report, 'x'.repeat(5_000_000));
  // The only finding is far past what a prompt could carry as text.
  const long = `## UI test report\n### Tested\n${'- PR 3 a path: PASSED\n'.repeat(2000)}### Findings\n- PR 3: the form submits twice`;
  assert.ok(long.indexOf('the form submits twice') > 30_000);
  const refusing = (every: boolean, run: () => void) => {
    const refuse = (name: 'renameSync' | 'rmSync', at: number) => {
      const real = fs[name] as (...a: unknown[]) => unknown;
      t.mock.method(fs, name, ((...a: unknown[]) => {
        if (a[at] === report || (every && name === 'renameSync' && path.dirname(String(a[at])) === folder)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return real(...a);
      }) as never);
    };
    refuse('renameSync', 1);
    refuse('rmSync', 0);
    syncBuiltinESMExports();
    try {
      run();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  };
  const build = () => compose.build('pr.review', floorDef, task, 'claude', dir, { phase: 'pr-review', prs: '- acme/proj#3 https://github.com/acme/proj/pull/3', uiTest: true });

  // Its own path refused: the whole report is kept under another name, and that file is what the reviewers are pointed to.
  refusing(false, () => keepUiTestReport(repo, ctx.filesDir, task.id, long));
  assert.equal(statSync(report).size, 5_000_000, 'the refused file is still there');
  const spare = readdirSync(folder).filter((n) => n !== 'ui-test-report.md');
  assert.equal(spare.length, 1, 'one more file, and no temporary one');
  assert.match(spare[0], /^ui-test-report\.[0-9a-f]{16}\.md$/);
  assert.match(readFileSync(path.join(folder, spare[0]), 'utf8'), /the form submits twice/, 'the whole report, the finding at its end too');
  const kept = build();
  assert.ok(kept.includes(`The tester's report is in ${path.join(folder, spare[0])}.`) && !kept.includes(`${report}.`), 'the refused file is not named');
  assert.ok(kept.includes("Don't write a section about the test"));
  // A new UI test clears the spare file too.
  resetUiTestReport(repo, ctx.filesDir, task.id);
  assert.deepEqual(readdirSync(folder), []);

  // No file can be written at all: the text is given, and said to be cut where it is.
  writeFileSync(report, 'x'.repeat(5_000_000));
  refusing(true, () => keepUiTestReport(repo, ctx.filesDir, task.id, long));
  assert.deepEqual(readdirSync(folder), ['ui-test-report.md'], 'no temporary file is left');
  const cut = build();
  assert.ok(!cut.includes("The tester's report is in") && !cut.includes(report), 'the file is not named');
  assert.ok(cut.includes("The tester's report could not be kept as a file. It is:\n## UI test report\n### Tested"));
  assert.match(cut, new RegExp(`\\[The report is cut here: this is its first 30000 of ${long.length} characters\\. The rest, which may hold findings, could not be given to you`));
  assert.ok(!cut.includes('the form submits twice'));
  // A short one is given whole, with no such note.
  refusing(true, () => keepUiTestReport(repo, ctx.filesDir, task.id, '## UI test report\n### Findings\n- PR 3: the form submits twice'));
  const whole = build();
  assert.ok(whole.includes("It is:\n## UI test report\n### Findings\n- PR 3: the form submits twice") && !whole.includes('The report is cut here'));
});

test('the project’s pull-request review instructions go to the UI tester of a pull-request review only', (t) => {
  const MARK = 'Pull-request review and testing';
  const { def, dir, repo, settings, compose, ctx } = setup(t);
  const task = repo.createTask({ project: 'proj', title: 'PR review: acme/proj#3', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  const x = { phase: 'implement' as const, prs: '- acme/proj#3 https://github.com/acme/proj/pull/3', prRepos: '- `.`: Proj' };
  const file = path.join(ctx.filesDir, 'instructions', 'proj', 'pr-review.md');
  assert.ok(KANBAN_PROMPT_DEFS['kanban.pr.uiTest'].text.includes("When the project's instructions below have a part for pull-request review and testing, follow it"));
  assert.doesNotMatch(compose.build('pr.uitest', def, task, 'claude', dir, x), new RegExp(MARK));
  settings.setProject('proj', { prReviewInstructions: 'Copy the database.' });
  const text = compose.build('pr.uitest', def, task, 'claude', dir, x);
  assert.ok(text.includes(`${MARK}: the project's instructions for it are in \`${file}\`. Read it now, before you start anything or prepare any test data`));
  assert.equal(readFileSync(file, 'utf8'), 'Copy the database.\n');
  assert.ok(text.includes('Keep it small.') || text.includes('general.md'), 'with the general instructions too');
  assert.ok(text.includes(file));
  for (const kind of ['pr.review', 'implement', 'review'] as const) {
    const other = compose.build(kind, def, task, 'claude', dir, kind === 'pr.review' ? { ...x, phase: 'pr-review' as const } : { phase: kind === 'review' ? ('review' as const) : ('implement' as const) });
    assert.ok(!other.includes(MARK), kind);
  }
  // Alone, without the general and the testing instructions.
  settings.setProject('proj', { generalInstructions: '', testingInstructions: '' });
  assert.ok(compose.build('pr.uitest', def, task, 'claude', dir, x).includes(`${MARK}: the project's`));
});

test('a rewritten kanban.pr.uiTest without {{instructions}} still gets the pull-request review instructions at its end', (t) => {
  const { def, dir, repo, settings, compose, ctx } = setup(t, { 'kanban.pr.uiTest': { text: 'Test {{prs}} only.' } });
  const task = repo.createTask({ project: 'proj', title: 'PR review: acme/proj#3', description: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'Ada' });
  settings.setProject('proj', { prReviewInstructions: 'Copy the database.' });
  const text = compose.build('pr.uitest', def, task, 'claude', dir, { phase: 'implement', prs: 'P1', prRepos: '- `.`: Proj' });
  assert.ok(text.includes(`Test P1 only.`));
  assert.ok(text.includes(path.join(ctx.filesDir, 'instructions', 'proj', 'pr-review.md')));
});
