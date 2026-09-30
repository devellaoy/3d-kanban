// The ai-kanban migration against a fixture: an old-schema SQLite database, settings.json, uploads
// and reports made here in a temp folder (never the real ~/.ai-kanban).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Building } from '../src/server/building.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { kanbanDbPath, openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanSettingsStore } from '../src/server/kanban/settings.js';
import { projectRepos } from '../src/server/kanban/projects.js';
import { SystemDedupe, mapComment, mapStatus, parseSkillText, pathRewriter, reviewVerdict } from '../scripts/migrate-ai-kanban/legacy.js';
import { formatReport, parseArgs, run } from '../scripts/migrate-ai-kanban/index.js';

const OLD_SCHEMA = `
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', ticketId TEXT, repository TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', branchName TEXT, worktreePath TEXT, runStatus TEXT NOT NULL DEFAULT 'idle', lastActivity TEXT, summary TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, repoId TEXT, sessionId TEXT, phase TEXT, useGoal INTEGER NOT NULL DEFAULT 0, worktreeSlot INTEGER,
  model TEXT, effort TEXT, usePlan INTEGER NOT NULL DEFAULT 1, folderPath TEXT, taskType TEXT NOT NULL DEFAULT 'implement', agentTool TEXT,
  review INTEGER NOT NULL DEFAULT 0, actedColumns TEXT, role TEXT);
CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER NOT NULL, author TEXT NOT NULL DEFAULT 'system', content TEXT NOT NULL, createdAt TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'system', content TEXT NOT NULL, createdAt TEXT NOT NULL);
`;

interface Fixture {
  from: string;
  home: string;
  web: string;
  api: string;
  notes: string;
  db: string;
  addComment(taskId: number, author: string, content: string): void;
}

function fixture(): Fixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mig-fixture-'));
  const from = path.join(tmp, 'ai-kanban-data');
  const home = path.join(tmp, 'office');
  const web = path.join(tmp, 'repos', 'web');
  const api = path.join(tmp, 'repos', 'web-api');
  const notes = path.join(tmp, 'folders', 'notes');
  for (const d of [path.join(web, '.git'), path.join(api, '.git'), notes, path.join(from, 'uploads'), path.join(from, 'reports', 'task-3'), path.join(home, '.agent-office')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(from, 'uploads', 'abc-shot.png'), 'png');
  writeFileSync(path.join(from, 'reports', 'task-3', 'report.md'), '# report');
  writeFileSync(
    path.join(from, 'settings.json'),
    JSON.stringify({
      repositories: [
        { id: 'r1', name: 'web', path: web, baseBranch: 'main', links: [{ name: 'Backend API', path: api, baseBranch: 'develop' }, { name: 'Gone', path: path.join(tmp, 'nowhere') }], generalInstructions: 'Run npm test', branchInstructions: 'gh-{issue}/slug', debugTestingInstructions: 'Use the debugger', columnActions: { 'pr-stage': 'Use /hellewi-pr to open the PRs', done: 'Merge it' } },
        { id: 'r2', name: 'missing', path: path.join(tmp, 'repos', 'missing'), links: [] },
      ],
      folders: [{ id: 'f1', name: 'notes', path: notes, generalInstructions: 'Plain notes' }],
      columns: [{ id: 'pr-stage', title: 'PR iterointi' }, { id: 'pr-katselmointi', title: 'PR katselmointi' }],
      agentTool: 'claude',
      defaultModel: 'opus',
      defaultEffort: 'high',
      reviewTool: 'codex',
      reviewModel: 'gpt-5-codex',
      reviewEffort: 'high',
      reviewIterations: 3,
      reviewSkills: '',
      roles: [{ id: 'software-development', name: 'Software development', defaultSkills: 'kanban-dev, kanban-ui-screenshots', instructions: 'custom role words', phaseInstructions: { implement: 'Always write tests first' }, prompts: { planner: 'software development planner' } }],
      defaultRole: 'software-development',
      apiKeys: [],
    }),
  );
  const dbFile = path.join(from, 'database.sqlite');
  const db = new Database(dbFile);
  db.exec(OLD_SCHEMA);
  const task = db.prepare(
    `INSERT INTO tasks (id, title, description, ticketId, repository, status, branchName, worktreePath, summary, createdAt, updatedAt, repoId, sessionId, folderPath, taskType, agentTool, review, model, effort)
     VALUES (@id, @title, @description, @ticketId, @repository, @status, @branchName, @worktreePath, @summary, @createdAt, @updatedAt, @repoId, @sessionId, @folderPath, @taskType, @agentTool, @review, @model, @effort)`,
  );
  const t = (id: number, over: Record<string, unknown>) =>
    task.run({ id, title: `Task ${id}`, description: '', ticketId: null, repository: 'web', status: 'done', branchName: null, worktreePath: null, summary: null, createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-02T10:00:00.000Z', repoId: null, sessionId: null, folderPath: null, taskType: 'implement', agentTool: 'claude', review: 1, model: null, effort: null, ...over });
  t(1, { repoId: 'r1', status: 'reviewable', description: `See ${path.join(from, 'uploads', 'abc-shot.png')}`, ticketId: 'UYT-1', branchName: 'gh-1/login', worktreePath: '/old/wt', sessionId: 'sess-1', model: 'opus', effort: 'max' });
  t(2, { repoId: 'orphan-id', repository: 'web', status: 'pr-stage' });
  t(3, { repository: 'devella-web-wt-1', status: 'history', taskType: 'investigate', summary: `Report in ${path.join(from, 'reports', 'task-3', 'report.md')}` });
  t(4, { repository: 'notes', folderPath: notes, status: 'done' });
  t(5, { repository: 'K360', status: 'in_progress', agentTool: 'copilot' });
  t(6, { repository: 'web', status: 'waiting' });
  t(7, { repository: 'web', status: 'pr-katselmointi' });
  const comment = db.prepare('INSERT INTO comments (taskId, author, content, createdAt) VALUES (?, ?, ?, ?)');
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 6, 1, 11, minute++)).toISOString();
  comment.run(1, 'user', 'Please fix the login', at());
  comment.run(1, 'claude', '**Suunnitelma:**\nThe plan', at());
  comment.run(1, 'claude', '**Toteutus valmis:**\nDone', at());
  comment.run(1, 'claude', '**Katselmointi:**\nFix X\nREVIEW: CHANGES_REQUESTED', at());
  comment.run(1, 'claude', '**Korjaukset katselmoinnin jälkeen:**\nFixed X', at());
  comment.run(1, 'claude', '**Katselmointi:**\nGood\nREVIEW: APPROVED', at());
  comment.run(1, 'user', `Another shot: ${path.join(from, 'uploads', 'abc-shot.png')}`, at());
  // Task 6: the spam, and a flood of two alternating lines.
  for (let i = 0; i < 50; i++) comment.run(6, 'system', 'Ei vapaata worktreetä', at());
  for (let i = 0; i < 30; i++) comment.run(6, 'system', i % 2 ? 'A' : 'B', at());
  const log = db.prepare('INSERT INTO logs (taskId, type, content, createdAt) VALUES (?, ?, ?, ?)');
  log.run(1, 'plan', 'The plan v1', at());
  log.run(1, 'plan', 'The plan v2', at());
  log.run(1, 'plan_accepted', 'The plan v2', at());
  log.run(1, 'progress', 'Reading files', at());
  log.run(1, 'stream', '{"type":"assistant"}', at());
  db.close();
  return {
    from,
    home,
    web,
    api,
    notes,
    db: dbFile,
    addComment(taskId, author, content) {
      const d = new Database(dbFile);
      d.prepare('INSERT INTO comments (taskId, author, content, createdAt) VALUES (?, ?, ?, ?)').run(taskId, author, content, new Date(Date.UTC(2026, 7, 1)).toISOString());
      d.close();
    },
  };
}

const args = (f: Fixture, apply: boolean, extra: string[] = []) => {
  const a = parseArgs(['--from', f.from, '--home', f.home, '--map', 'K360=r1', ...(apply ? ['--apply'] : []), ...extra]);
  assert.ok(typeof a === 'object', String(a));
  return a;
};

function target(f: Fixture) {
  const dataDir = path.join(f.home, '.agent-office');
  const db = openKanbanDb(kanbanDbPath(dataDir));
  return { dataDir, db, repo: new KanbanRepository(db), settings: new KanbanSettingsStore(dataDir), building: new Building(dataDir, f.home) };
}

test('the rules: statuses, authors and kinds, verdicts, dedupe, paths, skills', () => {
  assert.deepEqual(mapStatus('reviewable'), { status: 'review' });
  assert.deepEqual(mapStatus('history'), { status: 'archived' });
  assert.deepEqual(mapStatus('in_progress'), { status: 'waiting', waiting: true });
  assert.deepEqual(mapStatus('pr-katselmointi'), { status: 'review', tag: 'pr-katselmointi' });
  assert.deepEqual(mapComment({ author: 'claude', content: '**Katselmointi:**\nok\nREVIEW: APPROVED' }, 'claude', 'codex'), { authorKind: 'agent', authorName: 'Codex', tool: 'codex', kind: 'review', run: { phase: 'review', role: 'reviewer', verdict: 'approved' } });
  assert.equal(mapComment({ author: 'claude', content: '**Jatko:** x' }, 'codex', 'claude').run?.phase, 'resume');
  assert.equal(mapComment({ author: 'claude', content: 'hello' }, 'claude', 'claude').kind, 'message');
  assert.equal(reviewVerdict('REVIEW: APPROVED\n...\nREVIEW: CHANGES_REQUESTED'), 'changes_requested', 'the last line decides');
  assert.equal(reviewVerdict('**REVIEW: APPROVED**'), 'approved');
  const d = new SystemDedupe(2);
  const kept = ['x', 'x', 'y', 'x', 'y', 'x', 'y'].map((t) => d.keep({ author: 'system', content: t }));
  assert.deepEqual(kept, [true, false, true, true, true, false, false]);
  assert.deepEqual([d.consecutive, d.flood], [1, 2]);
  const rw = pathRewriter(['/Users/me/.ai-kanban/data'], { uploads: '/o/kanban/uploads/ai-kanban', reports: '/o/kanban/reports' });
  assert.deepEqual(rw('a /Users/me/.ai-kanban/data/uploads/x.png and /Users/me/.ai-kanban/data/reports/task-3/r.md'), { text: 'a /o/kanban/uploads/ai-kanban/x.png and /o/kanban/reports/task-3/r.md', count: 2 });
  assert.deepEqual(parseSkillText('claude: /jopox-pr, kanban-dev / codex: pull-req', ['pr']).selection, { pr: { claude: ['jopox-pr', 'kanban-dev'], codex: ['pull-req'] } });
  assert.deepEqual(parseSkillText('kanban-dev, "odd name!"', ['plan']).unread, ['"odd', 'name!"']);
});

test('a dry run writes nothing into the office and reports what --apply would do', async () => {
  const f = fixture();
  const before = existsSync(path.join(f.home, '.agent-office', 'floors.json'));
  const report = await run(args(f, false));
  assert.equal(report.apply, false);
  assert.equal(report.tasks.created, 7);
  assert.equal(existsSync(path.join(f.home, '.agent-office', 'floors.json')), before);
  assert.equal(existsSync(kanbanDbPath(path.join(f.home, '.agent-office'))), false);
  assert.equal(existsSync(path.join(f.home, 'Migrated (unassigned)')), false);
  assert.equal(existsSync(path.join(f.home, '.agent-office', 'kanban', 'uploads')), false);
  assert.equal(report.files.uploads, 1);
  assert.match(formatReport(report), /DRY RUN/);
});

test('--apply: projects, tasks with their ids, comments, runs, plans, files, settings', async () => {
  const f = fixture();
  const r = await run(args(f, true));
  assert.equal(r.tasks.created, 7);
  assert.deepEqual(r.repositoryNames, { distinct: 4, resolved: 2, mapped: 1, unassigned: 1, unresolved: [{ name: 'devella-web-wt-1', tasks: 1 }] });
  const t = target(f);
  // Floors, as Building keeps them (and reads them back).
  const floors = t.building.list();
  const web = floors.find((d) => d.dir === f.web)!;
  assert.ok(web, 'the repository became a floor');
  assert.deepEqual(projectRepos(web).map((x) => [x.name, x.kind, x.baseBranch ?? null]), [['web', 'git', null], ['Backend API', 'git', 'develop']], 'its linked folder that is there, as a repository');
  assert.ok(floors.some((d) => d.dir === f.notes), 'the folder became a floor');
  const unassigned = floors.find((d) => d.name === 'Migrated (unassigned)')!;
  assert.ok(unassigned && existsSync(unassigned.dir));
  assert.ok(!floors.some((d) => d.dir.endsWith('missing')), 'no floor for a folder that is not there');
  assert.ok(r.warnings.some((w) => /missing/.test(w)));
  const saved = JSON.parse(readFileSync(path.join(t.dataDir, 'floors.json'), 'utf8')) as Record<string, unknown>[];
  assert.deepEqual(Object.keys(saved.find((d) => d.dir === f.web)!).sort(), ['addedAt', 'addedBy', 'dir', 'id', 'name', 'palette', 'repos'].concat(saved.find((d) => d.dir === f.web)!.repo ? ['repo'] : []).sort());
  // Tasks, by their old ids, in the right projects and columns.
  const task = (id: number) => t.repo.getTask(id)!;
  assert.equal(task(1).project, web.id);
  assert.equal(task(1).status, 'review');
  assert.equal(task(1).ticket, 'UYT-1');
  assert.equal(task(1).branch, 'gh-1/login');
  assert.equal(task(1).effort, 'max');
  assert.equal(task(1).runState, 'idle');
  assert.equal(task(1).legacy?.id, 1);
  assert.equal(task(2).project, web.id, 'an orphan repoId: by its name');
  assert.deepEqual(task(2).tags, ['pr-stage']);
  assert.deepEqual(task(7).tags, ['pr-katselmointi']);
  assert.equal(task(3).project, unassigned.id);
  assert.equal(task(3).status, 'archived');
  assert.equal(task(4).project, floors.find((d) => d.dir === f.notes)!.id, 'a folder task in its folder project');
  assert.equal(task(5).project, web.id, '--map K360=r1');
  assert.equal(task(5).status, 'waiting');
  assert.equal(task(5).waitingReason, 'interrupted');
  assert.equal(task(5).tool, 'claude', 'copilot: the default tool');
  assert.equal(r.tasks.toolChanged, 1);
  assert.equal(t.repo.nextTaskId(), 8, 'new ids carry on after the old ones');
  // Uploads copied, paths rewritten.
  const uploads = path.join(t.dataDir, 'kanban', 'uploads', 'ai-kanban');
  assert.ok(existsSync(path.join(uploads, 'abc-shot.png')));
  assert.equal(task(1).description, `See ${path.join(uploads, 'abc-shot.png')}`);
  assert.ok(t.repo.listComments(1).comments.some((c) => c.text === `Another shot: ${path.join(uploads, 'abc-shot.png')}`));
  assert.ok(existsSync(path.join(t.dataDir, 'kanban', 'reports', 'task-3', 'report.md')));
  assert.equal(task(3).summary, `Report in ${path.join(t.dataDir, 'kanban', 'reports', 'task-3', 'report.md')}`);
  // Comments, runs, plans.
  const comments = t.repo.listComments(1).comments;
  assert.deepEqual(comments.map((c) => `${c.authorKind}:${c.kind}`), ['system:status', 'user:message', 'agent:plan', 'agent:result', 'agent:review', 'agent:result', 'agent:review', 'user:message']);
  const runs = t.repo.listRuns(1);
  assert.deepEqual(runs.map((x) => `${x.phase}${x.round ?? ''}:${x.tool}:${x.verdict ?? ''}`), ['plan:claude:', 'implement:claude:', 'review1:codex:changes_requested', 'fix1:claude:', 'review2:codex:approved']);
  assert.equal(task(1).reviewRound, 2);
  assert.deepEqual(t.repo.listPlans(1).map((p) => `${p.version}:${p.status}:${p.text}`), ['1:superseded:The plan v1', '2:accepted:The plan v2']);
  assert.equal(task(1).flags.planAccepted, true);
  assert.ok(t.repo.listEvents(1).some((e) => e.kind === 'ai-kanban.progress'));
  assert.equal(r.streamLogs.skipped, 1);
  // The spam: 50 identical lines become one, the alternating flood is capped.
  const spam = t.repo.listComments(6, { limit: 500 }).comments.filter((c) => c.authorKind === 'system');
  assert.equal(spam.filter((c) => c.text === 'Ei vapaata worktreetä').length, 1);
  assert.equal(spam.filter((c) => c.text === 'A').length, 15, 'alternating lines are not consecutive repeats');
  assert.equal(r.comments.dedupedConsecutive, 49);
  // Settings.
  const ps = t.settings.project(web.id);
  assert.equal(ps.generalInstructions, 'Run npm test');
  assert.equal(ps.branchInstructions, 'gh-{issue}/slug');
  assert.equal(ps.testingInstructions, 'Use the debugger');
  assert.equal(ps.prompts['kanban.pr.create'], 'Use /hellewi-pr to open the PRs');
  assert.match(ps.prompts['kanban.implement'] ?? '', /Always write tests first/);
  assert.match(ps.prompts['kanban.implement'] ?? '', /custom role words/);
  assert.equal(ps.prompts['kanban.review'], undefined, 'the default review guidance is not a custom prompt');
  assert.deepEqual(ps.skills.plan, { claude: ['kanban-dev', 'kanban-ui-screenshots'] });
  const office = t.settings.get();
  assert.deepEqual([office.review.tool, office.review.model, office.review.effort, office.review.rounds], ['codex', 'gpt-5-codex', 'high', 3]);
  assert.deepEqual([office.defaults.model, office.defaults.effort], ['opus', 'high']);
  assert.ok(r.settings.reported.some((s) => /done column's action/.test(s)));
  t.db.close();
});

test('running it again brings in only what is new, and never a task changed in 3d-kanban', async () => {
  const f = fixture();
  await run(args(f, true));
  const again = await run(args(f, true));
  assert.equal(again.tasks.created, 0);
  assert.equal(again.tasks.updated, 7);
  assert.equal(again.comments.imported, 0);
  assert.equal(again.plans.imported, 0);
  assert.equal(again.runs.reconstructed, 0);
  let t = target(f);
  const before = t.repo.countComments(1);
  assert.equal(t.building.list().length, 3, 'no second floor for the same folders');
  // Someone edits task 2 here; ai-kanban meanwhile gets a new comment on task 1.
  t.repo.updateTask(2, { title: 'Edited here' });
  t.db.close();
  f.addComment(1, 'claude', '**Jatko:**\nMore work');
  f.addComment(2, 'user', 'late comment');
  const third = await run(args(f, true));
  assert.deepEqual(third.tasks.skippedEdited, [2]);
  assert.equal(third.comments.imported, 1);
  assert.equal(third.runs.reconstructed, 1);
  t = target(f);
  assert.equal(t.repo.getTask(2)!.title, 'Edited here');
  assert.equal(t.repo.countComments(1), before + 1);
  assert.equal(t.repo.listRuns(1).at(-1)!.phase, 'resume');
  t.db.close();
});

test('an id 3d-kanban already uses for a task of its own stops the migration before anything is written', async () => {
  const f = fixture();
  const t = target(f);
  t.repo.insertTaskWithId(3, { project: 'x', title: 'Mine', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'me' });
  t.db.close();
  await assert.rejects(run(args(f, true)), /already has tasks of its own with ids .*#3/);
  const after = target(f);
  assert.equal(after.repo.listTasks(null, { includeArchived: true }).length, 1);
  assert.equal(after.building.list().length, 0, 'no floors made');
  after.db.close();
  await assert.rejects(run(args(f, false)), /#3/, 'the dry run says so too');
});

test('the source is only read', async () => {
  const f = fixture();
  const before = readFileSync(f.db);
  await run(args(f, true));
  assert.ok(readFileSync(f.db).equals(before));
  assert.equal(existsSync(`${f.db}-wal`), false);
});
