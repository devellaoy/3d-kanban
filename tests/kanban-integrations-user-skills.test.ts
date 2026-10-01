import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, SKILL_NAME_RE, discoverSkills, parseFrontmatter, skillHash } from '../src/server/kanban/integrations/skills/registry.js';
import { AIKANBAN_MARKER, USER_MARKER, syncUserSkills } from '../src/server/kanban/integrations/userskills/sync.js';
import { createUserSkillsPlugin } from '../src/server/kanban/integrations/userskills/index.js';
import { makeCtx } from './kanban-integrations-ctx.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'user-skills-'));
const skill = (root: string, folder: string, body = 'one') => {
  mkdirSync(path.join(root, folder, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${folder} does things\n---\n\n# ${body}\n`);
  writeFileSync(path.join(root, folder, 'scripts', 'run.js'), `// ${body}\n`);
  return path.join(root, folder);
};
const statuses = (r: { name: string; status: string }[]) => r.map((x) => `${x.name}:${x.status}`).sort();

function setup() {
  const tmp = tmpDir();
  const source = path.join(tmp, 'user-skills');
  skill(path.join(source, 'claude'), 'alpha');
  skill(path.join(source, 'codex'), 'beta');
  const claudeHome = path.join(tmp, 'claude');
  const codexHome = path.join(tmp, 'codex');
  return { tmp, source, claudeHome, codexHome, run: () => syncUserSkills({ source, claudeHome, codexHome }) };
}

test('installs claude and codex skills with a marker, leaving node_modules and .DS_Store behind', () => {
  const s = setup();
  mkdirSync(path.join(s.source, 'claude', 'alpha', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(s.source, 'claude', 'alpha', 'node_modules', 'dep', 'i.js'), 'x');
  writeFileSync(path.join(s.source, 'claude', 'alpha', '.DS_Store'), 'x');
  assert.deepEqual(statuses(s.run()), ['alpha (claude):installed', 'beta (codex):installed']);
  const a = path.join(s.claudeHome, 'skills', 'alpha');
  assert.ok(existsSync(path.join(a, 'SKILL.md')) && existsSync(path.join(a, 'scripts', 'run.js')));
  assert.ok(!existsSync(path.join(a, 'node_modules')) && !existsSync(path.join(a, '.DS_Store')));
  assert.ok(existsSync(path.join(s.codexHome, 'skills', 'beta', 'SKILL.md')));
  const marker = JSON.parse(readFileSync(path.join(a, USER_MARKER), 'utf8'));
  assert.equal(marker.source, '3d-kanban');
  assert.equal(marker.hash, skillHash(path.join(s.source, 'claude', 'alpha'), { skipDeps: true }));
});

test('a second run changes nothing', () => {
  const s = setup();
  s.run();
  const marker = path.join(s.claudeHome, 'skills', 'alpha', USER_MARKER);
  const old = new Date(Date.now() - 60_000);
  utimesSync(marker, old, old);
  assert.deepEqual(statuses(s.run()), ['alpha (claude):current', 'beta (codex):current']);
  assert.equal(statSync(marker).mtimeMs, old.getTime());
});

test('a changed source updates the copy, over a hand edit, keeping what only the target has', () => {
  const s = setup();
  s.run();
  const dest = path.join(s.claudeHome, 'skills', 'alpha');
  mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
  writeFileSync(path.join(dest, 'node_modules', 'keep.js'), 'x');
  writeFileSync(path.join(dest, 'scripts', 'run.js'), '// hand edited\n');
  skill(path.join(s.source, 'claude'), 'alpha', 'two');
  assert.deepEqual(statuses(s.run()), ['alpha (claude):updated', 'beta (codex):current']);
  assert.equal(readFileSync(path.join(dest, 'scripts', 'run.js'), 'utf8'), '// two\n');
  assert.ok(existsSync(path.join(dest, 'node_modules', 'keep.js')));
  assert.deepEqual(statuses(s.run()), ['alpha (claude):current', 'beta (codex):current']);
});

test("a copy ai-kanban made is adopted: marker replaced, its .aikanban-sync removed", () => {
  const s = setup();
  const dest = path.join(s.codexHome, 'skills', 'beta');
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'SKILL.md'), 'old');
  writeFileSync(path.join(dest, AIKANBAN_MARKER), 'abc');
  assert.equal(s.run().find((r) => r.name === 'beta (codex)')?.status, 'updated');
  assert.ok(!existsSync(path.join(dest, AIKANBAN_MARKER)));
  assert.ok(existsSync(path.join(dest, USER_MARKER)));
  assert.match(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /name: beta/);
});

test('a skill nobody marked is the user\'s and stays untouched', () => {
  const s = setup();
  const dest = skill(path.join(s.claudeHome, 'skills'), 'alpha', 'mine');
  const res = s.run();
  assert.equal(res.find((r) => r.name === 'alpha (claude)')?.status, 'user-owned');
  assert.match(res[0].detail ?? '', /alpha/);
  assert.match(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /# mine/);
  assert.ok(!existsSync(path.join(dest, USER_MARKER)));
  assert.equal(res.find((r) => r.name === 'beta (codex)')?.status, 'installed', 'the others go on');
});

test('one failing skill does not stop the rest', () => {
  const s = setup();
  mkdirSync(s.claudeHome, { recursive: true });
  writeFileSync(path.join(s.claudeHome, 'skills'), 'a file where the folder should be');
  const res = s.run();
  assert.equal(res.find((r) => r.name === 'alpha (claude)')?.status, 'failed');
  assert.equal(res.find((r) => r.name === 'beta (codex)')?.status, 'installed');
});

test('the registry lists a synced Codex skill as the user\'s own', () => {
  const s = setup();
  s.run();
  const found = discoverSkills({ claudeHome: s.claudeHome, codexHome: s.codexHome, accountHomes: [], repoDirs: [] });
  const beta = found.find((x) => x.tool === 'codex' && x.name === 'beta');
  assert.equal(beta?.origin, 'user');
  assert.ok(found.some((x) => x.tool === 'claude' && x.name === 'alpha' && x.origin === 'user'));
  assert.ok(!existsSync(path.join(s.codexHome, 'skills', 'beta', MARKER)));
});

test('skillHash with skipDeps ignores node_modules and the sync markers; the default hash does not', () => {
  const s = setup();
  const dir = path.join(s.source, 'claude', 'alpha');
  const plain = skillHash(dir);
  const lean = skillHash(dir, { skipDeps: true });
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
  writeFileSync(path.join(dir, USER_MARKER), '{}');
  writeFileSync(path.join(dir, AIKANBAN_MARKER), 'abc');
  assert.equal(skillHash(dir, { skipDeps: true }), lean);
  assert.notEqual(skillHash(dir), plain);
});

test('the plugin: off blocks, a worktree source blocks unless on', () => {
  const keep = process.env.AGENT_OFFICE_USER_SKILLS;
  const ctx = makeCtx();
  try {
    const s = setup();
    const wt = path.join(s.tmp, '.agent-office', 'worktrees', 'bolt-1', 'user-skills');
    skill(path.join(wt, 'claude'), 'alpha');
    const start = (source: string) => {
      const home = path.join(tmpDir(), 'claude');
      createUserSkillsPlugin(ctx, { homes: () => ({ source, claudeHome: home, codexHome: path.join(home, '..', 'codex') }) }).start!();
      return existsSync(path.join(home, 'skills', 'alpha', 'SKILL.md'));
    };
    process.env.AGENT_OFFICE_USER_SKILLS = 'off';
    assert.equal(start(path.join(s.source)), false, 'off');
    delete process.env.AGENT_OFFICE_USER_SKILLS;
    assert.equal(start(wt), false, 'worktree');
    assert.equal(start(s.source), true, 'a normal checkout');
    process.env.AGENT_OFFICE_USER_SKILLS = 'on';
    assert.equal(start(wt), true, 'on overrides the worktree guard');
    process.env.AGENT_OFFICE_USER_SKILLS = 'off';
    assert.equal(start(wt), false, 'off beats on');
  } finally {
    if (keep === undefined) delete process.env.AGENT_OFFICE_USER_SKILLS;
    else process.env.AGENT_OFFICE_USER_SKILLS = keep;
  }
});

test("the repository's user-skills/ holds the agreed skills, well named, without installed dependencies", () => {
  const folders = (tool: string) => readdirSync(path.join(REPO, 'user-skills', tool), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(folders('claude'), ['kanban-dev', 'kanban-dev-sonnet', 'kanban-ui-screenshots']);
  assert.deepEqual(folders('codex'), ['kanban-dev', 'kanban-ui-screenshots']);
  for (const tool of ['claude', 'codex']) {
    for (const f of folders(tool)) {
      const name = parseFrontmatter(readFileSync(path.join(REPO, 'user-skills', tool, f, 'SKILL.md'), 'utf8')).name;
      assert.ok(name && SKILL_NAME_RE.test(name), `${tool}/${f} has a valid name`);
      assert.equal(name, f, `${tool}/${f}: the name is the folder's`);
    }
  }
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', 'user-skills'], { cwd: REPO, encoding: 'utf8' });
  } catch {
    return; // not a git checkout
  }
  assert.ok(!/(^|\/)node_modules\//m.test(tracked), 'no node_modules is committed');
});
