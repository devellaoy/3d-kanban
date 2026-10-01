import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MARKER, bundledSkillsDir, discoverSkills, findSkill, parseFrontmatter, skillHash, type SkillRoots } from '../src/server/kanban/integrations/skills/registry.js';
import { PLUGIN_NAME, pluginDir, syncCodexSkills } from '../src/server/kanban/integrations/skills/delivery.js';
import { checkSelection, createSkills, pickedSkills, skillPhase } from '../src/server/kanban/integrations/skills/index.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

const skill = (root: string, folder: string, name: string, description = `${name} does things`) => {
  mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return path.join(root, folder);
};

function roots(tmp: string, repoDir: string): SkillRoots {
  const r: SkillRoots = { bundled: path.join(tmp, 'bundled'), claudeHome: path.join(tmp, 'claude'), codexHome: path.join(tmp, 'codex'), accountHomes: [path.join(tmp, 'homes', 'acc1', 'claude')], repoDirs: [repoDir] };
  skill(path.join(r.bundled!, 'claude'), 'office-task-refs', 'office-task-refs');
  skill(path.join(r.bundled!, 'codex'), 'office-task-refs', 'office-task-refs');
  skill(path.join(r.claudeHome, 'skills'), 'kanban-dev', 'kanban-dev');
  skill(path.join(r.codexHome, 'skills'), 'my-codex', 'my-codex');
  skill(path.join(r.accountHomes[0], 'skills'), 'acct-skill', 'acct-skill');
  skill(path.join(repoDir, '.claude', 'skills'), 'repo-pr', 'hellewi-pr', 'Opens PRs across the Hellewi repos');
  return r;
}

test('SKILL.md frontmatter: name and description, folded values and quotes too', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a-b\ndescription: "Does x: y"\n---\nbody'), { name: 'a-b', description: 'Does x: y' });
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: >\n  one\n  two\n---\n'), { name: 'x', description: 'one two' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('the registry finds bundled, user, account, Codex and repository skills', () => {
  const ctx = makeCtx();
  const repoDir = path.join(ctx.tmp, 'repo');
  const found = discoverSkills(roots(ctx.tmp, repoDir));
  const line = (s: (typeof found)[number]) => `${s.tool}:${s.origin}:${s.name}`;
  assert.deepEqual(found.map(line).sort(), ['claude:account:acct-skill', 'claude:bundled:office-task-refs', 'claude:repo:hellewi-pr', 'claude:user:kanban-dev', 'codex:bundled:office-task-refs', 'codex:user:my-codex'].sort());
  assert.equal(found.find((s) => s.name === 'hellewi-pr')?.description, 'Opens PRs across the Hellewi repos');
  assert.equal(findSkill(found, 'claude', 'hellewi-pr', [repoDir])?.origin, 'repo');
  assert.equal(findSkill(found, 'claude', 'hellewi-pr', ['/elsewhere']), undefined, "another project's repository skill isn't this one's");
  assert.deepEqual(checkSelection({ plan: { claude: ['kanban-dev', 'nope'], codex: ['my-codex'] } }, found), ["nope (claude, plan) isn't installed anywhere the office looks"]);
  assert.ok(bundledSkillsDir() && existsSync(path.join(bundledSkillsDir()!, 'claude', 'office-task-refs', 'SKILL.md')), 'the office ships office-task-refs');
});

test('claude: a plugin folder of the picked bundled and repository skills, the same folder for the same skills', () => {
  const ctx = makeCtx();
  const repoDir = path.join(ctx.tmp, 'repo');
  const found = discoverSkills(roots(ctx.tmp, repoDir));
  const picks = found.filter((s) => s.tool === 'claude' && (s.origin === 'bundled' || s.origin === 'repo'));
  const dir = pluginDir(ctx.filesDir, picks);
  assert.match(path.basename(dir), /^plugin-[a-f0-9]{12}$/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name, PLUGIN_NAME);
  assert.ok(existsSync(path.join(dir, 'skills', 'repo-pr', 'SKILL.md')));
  assert.ok(existsSync(path.join(dir, 'skills', 'office-task-refs', 'SKILL.md')));
  assert.equal(pluginDir(ctx.filesDir, [...picks].reverse()), dir);
  writeFileSync(path.join(repoDir, '.claude', 'skills', 'repo-pr', 'SKILL.md'), '---\nname: hellewi-pr\n---\nchanged');
  assert.notEqual(pluginDir(ctx.filesDir, picks), dir, 'a changed skill makes a new folder');
});

test('codex: bundled skills synced with a marker; a copy changed by hand is never overwritten', () => {
  const ctx = makeCtx();
  const r = roots(ctx.tmp, path.join(ctx.tmp, 'repo'));
  const bundled = discoverSkills(r).filter((s) => s.tool === 'codex' && s.origin === 'bundled');
  assert.deepEqual(syncCodexSkills(r.codexHome, bundled).map((x) => x.status), ['installed']);
  const copy = path.join(r.codexHome, 'skills', 'office-task-refs');
  assert.ok(existsSync(path.join(copy, MARKER)));
  assert.equal(skillHash(copy), skillHash(bundled[0].location), 'the marker is not part of the hash');
  assert.deepEqual(syncCodexSkills(r.codexHome, bundled).map((x) => x.status), ['current']);
  assert.deepEqual(discoverSkills(r).find((s) => s.tool === 'codex' && s.origin === 'bundled')?.installedIn, [r.codexHome]);
  // A new version ships: an untouched copy is updated.
  writeFileSync(path.join(bundled[0].location, 'extra.md'), 'v2');
  assert.deepEqual(syncCodexSkills(r.codexHome, bundled).map((x) => x.status), ['updated']);
  // Someone edits the copy, then another version ships: left as it is, "update available".
  writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: office-task-refs\n---\nmine');
  writeFileSync(path.join(bundled[0].location, 'extra.md'), 'v3');
  const res = syncCodexSkills(r.codexHome, bundled);
  assert.equal(res[0].status, 'update-available');
  assert.equal(readFileSync(path.join(copy, 'SKILL.md'), 'utf8'), '---\nname: office-task-refs\n---\nmine');
  // A skill of that name the office didn't put there: the user's own.
  const other = skill(path.join(ctx.tmp, 'codex2', 'skills'), 'office-task-refs', 'office-task-refs');
  assert.equal(syncCodexSkills(path.join(ctx.tmp, 'codex2'), bundled)[0].status, 'user-owned');
  assert.equal(existsSync(path.join(other, MARKER)), false);
});

test('a task worker: its picked skills by phase and tool, delivered, hinted, missing ones warned about', () => {
  const repoDir = path.join(makeCtx().tmp, 'repo');
  const ctx = makeCtx([def('app', repoDir)]);
  mkdirSync(repoDir, { recursive: true });
  const r = roots(ctx.tmp, repoDir);
  ctx.settings.setProject('app', { skills: { plan: { claude: ['kanban-dev', 'hellewi-pr', 'ghost'] }, review: { codex: ['my-codex'] } } });
  const t = ctx.repo.createTask({ project: 'app', title: 't', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'u' });
  const skills = createSkills(ctx, { roots: () => r });
  assert.equal(skillPhase('fix'), 'implement');
  assert.equal(skillPhase('pr-fix'), 'pr');
  assert.deepEqual(pickedSkills({ plan: { claude: ['a'] } }, { plan: { claude: ['b'] } }, 'plan', 'claude'), ['b'], "the task's own pick wins");
  const args = skills.workerArgs(t.id, 'claude', 'plan');
  assert.equal(args[0], '--plugin-dir');
  assert.ok(existsSync(path.join(args[1], 'skills', 'repo-pr')), 'the repository skill is delivered');
  assert.ok(existsSync(path.join(args[1], 'skills', 'office-task-refs')), 'and the office’s own');
  assert.ok(!existsSync(path.join(args[1], 'skills', 'kanban-dev')), "the user's own loads from their home");
  assert.equal(skills.skillHint(t.id, 'claude', 'plan'), 'Use these skills in this phase (the Skill tool): kanban-dev, hellewi-pr.');
  assert.equal(skills.skillHint(t.id, 'claude', 'implement'), '');
  assert.equal(skills.skillHint(t.id, 'codex', 'review'), 'Use these skills in this phase: my-codex.');
  assert.equal(ctx.toasts.filter((x) => /ghost/.test(x.text)).length, 1, 'warned once');
  assert.deepEqual(skills.workerArgs(t.id, 'codex', 'review'), []);
  assert.ok(existsSync(path.join(r.codexHome, 'skills', 'office-task-refs', MARKER)), "codex gets the office's own skill in its home");
  const c = client(false);
  skills.plugin.ws!['kanban.skills.sync']!(c, { t: 'kanban.skills.sync', rid: 'x' });
  assert.equal(c.got.at(-1)?.t, 'kanban.error', 'only admins install');
  skills.plugin.ws!['kanban.skills.list']!(c, { t: 'kanban.skills.list', rid: 'y' });
  assert.equal((c.got.at(-1) as { skills: unknown[] }).skills.length, 6);
});
