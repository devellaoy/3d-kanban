import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, SKILL_NAME_RE, USER_SKILL_EXCLUDES, discoverSkills, parseFrontmatter, skillHash } from '../src/server/kanban/integrations/skills/registry.js';
import { AIKANBAN_MARKER, USER_MARKER, syncUserSkills } from '../src/server/kanban/integrations/userskills/sync.js';
import { createUserSkillsPlugin, syncUserSkillsNow } from '../src/server/kanban/integrations/userskills/index.js';
import { createSkills } from '../src/server/kanban/integrations/skills/index.js';
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
  assert.equal(marker.hash, skillHash(path.join(s.source, 'claude', 'alpha'), { exclude: USER_SKILL_EXCLUDES }));
});

test('a second run changes nothing', () => {
  const s = setup();
  s.run();
  const marker = path.join(s.claudeHome, 'skills', 'alpha', USER_MARKER);
  const old = new Date(Date.now() - 60_000);
  utimesSync(marker, old, old);
  assert.deepEqual(statuses(s.run()), ['alpha (claude):current', 'beta (codex):current']);
  assert.equal(Math.round(statSync(marker).mtimeMs), Math.round(old.getTime()), 'no writes');
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

test('a failed install is reported, the others go on, and the next run installs it', () => {
  const s = setup();
  // The Claude home's skills/ is a file: nothing can be made under it, on any platform or user.
  mkdirSync(s.claudeHome, { recursive: true });
  const skills = path.join(s.claudeHome, 'skills');
  writeFileSync(skills, '');
  const res = s.run();
  assert.equal(res.find((r) => r.name === 'alpha (claude)')?.status, 'failed');
  assert.equal(res.find((r) => r.name === 'beta (codex)')?.status, 'installed');
  rmSync(skills);
  assert.equal(s.run().find((r) => r.name === 'alpha (claude)')?.status, 'installed');
});

// chmod 000 doesn't stop Windows or root from reading the file.
test('a failed first install leaves no folder behind, and the next run installs it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const s = setup();
  // An unreadable file: cpSync cannot copy it.
  const locked = path.join(s.source, 'claude', 'alpha', 'scripts', 'run.js');
  chmodSync(locked, 0o000);
  const res = s.run();
  assert.equal(res.find((r) => r.name === 'alpha (claude)')?.status, 'failed');
  const skills = path.join(s.claudeHome, 'skills');
  assert.ok(!existsSync(path.join(skills, 'alpha')), 'no unmarked folder');
  assert.deepEqual(existsSync(skills) ? readdirSync(skills) : [], [], 'no temp folder either');
  assert.ok(!existsSync(path.join(s.claudeHome, '.office-user-skills-tmp')), 'and the tmp root is gone');
  chmodSync(locked, 0o644);
  assert.equal(s.run().find((r) => r.name === 'alpha (claude)')?.status, 'installed');
});

test('a copy with our current marker and also .aikanban-sync is brought back and the ai-kanban marker removed', () => {
  const s = setup();
  s.run();
  const dest = path.join(s.claudeHome, 'skills', 'alpha');
  writeFileSync(path.join(dest, AIKANBAN_MARKER), 'abc');
  writeFileSync(path.join(dest, 'scripts', 'run.js'), '// ai-kanban version\n');
  assert.equal(s.run().find((r) => r.name === 'alpha (claude)')?.status, 'updated');
  assert.equal(readFileSync(path.join(dest, 'scripts', 'run.js'), 'utf8'), '// one\n');
  assert.ok(!existsSync(path.join(dest, AIKANBAN_MARKER)));
  assert.equal(s.run().find((r) => r.name === 'alpha (claude)')?.status, 'current');
});

test('an update swaps the copy in whole: files removed from the source disappear, node_modules stays, nothing is left in skills/', () => {
  const s = setup();
  s.run();
  const dest = path.join(s.claudeHome, 'skills', 'alpha');
  writeFileSync(path.join(s.source, 'claude', 'alpha', 'old.txt'), 'x');
  s.run();
  assert.ok(existsSync(path.join(dest, 'old.txt')));
  mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
  writeFileSync(path.join(dest, 'node_modules', 'keep.js'), 'x');
  rmSync(path.join(s.source, 'claude', 'alpha', 'old.txt'));
  assert.equal(s.run().find((r) => r.name === 'alpha (claude)')?.status, 'updated');
  assert.ok(!existsSync(path.join(dest, 'old.txt')));
  assert.ok(existsSync(path.join(dest, 'node_modules', 'keep.js')));
  assert.deepEqual(readdirSync(path.join(s.claudeHome, 'skills')), ['alpha']);
  assert.ok(!existsSync(path.join(s.claudeHome, '.office-user-skills-tmp')));
});

test('a symlinked target is never written through', { skip: process.platform === 'win32' }, () => {
  const s = setup();
  const real = skill(path.join(s.tmp, 'elsewhere'), 'alpha', 'mine');
  mkdirSync(path.join(s.claudeHome, 'skills'), { recursive: true });
  symlinkSync(real, path.join(s.claudeHome, 'skills', 'alpha'));
  writeFileSync(path.join(real, USER_MARKER), JSON.stringify({ hash: 'old' }));
  assert.equal(s.run().find((r) => r.name === 'alpha (claude)')?.status, 'user-owned');
  assert.match(readFileSync(path.join(real, 'SKILL.md'), 'utf8'), /# mine/);
});

test("a dead process's leftovers in the tmp root are cleaned, a living one's stay, a lost skill comes back", () => {
  const s = setup();
  s.run();
  const tmpRoot = path.join(s.claudeHome, '.office-user-skills-tmp');
  mkdirSync(path.join(tmpRoot, 'x-2147483646'), { recursive: true });
  mkdirSync(path.join(tmpRoot, `y-${process.ppid}`), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'lost-2147483646.old'), { recursive: true });
  writeFileSync(path.join(tmpRoot, 'lost-2147483646.old', 'SKILL.md'), 'back');
  s.run();
  assert.deepEqual(readdirSync(tmpRoot).sort(), [`y-${process.ppid}`]);
  assert.equal(readFileSync(path.join(s.claudeHome, 'skills', 'lost', 'SKILL.md'), 'utf8'), 'back');
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

test('skillHash with the exclusion set ignores node_modules and the sync markers; the default hash does not', () => {
  const s = setup();
  const dir = path.join(s.source, 'claude', 'alpha');
  const plain = skillHash(dir);
  const lean = skillHash(dir, { exclude: USER_SKILL_EXCLUDES });
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
  writeFileSync(path.join(dir, USER_MARKER), '{}');
  writeFileSync(path.join(dir, AIKANBAN_MARKER), 'abc');
  assert.equal(skillHash(dir, { exclude: USER_SKILL_EXCLUDES }), lean);
  assert.notEqual(skillHash(dir), plain);
});

const tick = () => new Promise((r) => setImmediate(r));
const withMode = async (mode: string | undefined, fn: () => unknown | Promise<unknown>) => {
  const keep = process.env.AGENT_OFFICE_USER_SKILLS;
  if (mode === undefined) delete process.env.AGENT_OFFICE_USER_SKILLS;
  else process.env.AGENT_OFFICE_USER_SKILLS = mode;
  try {
    return await fn();
  } finally {
    if (keep === undefined) delete process.env.AGENT_OFFICE_USER_SKILLS;
    else process.env.AGENT_OFFICE_USER_SKILLS = keep;
  }
};

test('the plugin: off blocks, a linked git worktree blocks unless on, a main checkout and a plain install go', async () => {
  const ctx = makeCtx();
  const s = setup();
  const mk = (name: string, git: 'dir' | 'file' | 'none') => {
    const root = path.join(s.tmp, name);
    const source = path.join(root, 'user-skills');
    skill(path.join(source, 'claude'), 'alpha');
    if (git === 'dir') mkdirSync(path.join(root, '.git'));
    if (git === 'file') writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    return source;
  };
  const wt = mk('wt', 'file');
  const main = mk('main', 'dir');
  const plain = mk('plain', 'none');
  const start = async (source: string) => {
    const home = path.join(tmpDir(), 'claude');
    const p = createUserSkillsPlugin(ctx, { homes: () => ({ source, claudeHome: home, codexHome: path.join(home, '..', 'codex') }) });
    p.start!();
    await tick();
    p.stop!();
    return existsSync(path.join(home, 'skills', 'alpha', 'SKILL.md'));
  };
  await withMode('off', async () => assert.equal(await start(main), false, 'off'));
  await withMode(undefined, async () => {
    assert.equal(await start(wt), false, 'linked worktree');
    assert.equal(await start(main), true, 'main checkout');
    assert.equal(await start(plain), true, 'no git at all');
  });
  await withMode('on', async () => assert.equal(await start(wt), true, 'on overrides the worktree guard'));
  await withMode('off', async () => assert.equal(await start(wt), false, 'off beats on'));
});

test('the admin sync runs the user-skills sync through the skills hook, under the same guards', async () => {
  const ctx = makeCtx();
  const s = setup();
  const roots = { claudeHome: s.claudeHome, codexHome: s.codexHome, accountHomes: [], repoDirs: [] };
  const plugin = createUserSkillsPlugin(ctx, { homes: () => ({ source: s.source, claudeHome: s.claudeHome, codexHome: s.codexHome }) });
  const skills = createSkills(ctx, { roots: () => roots });
  await withMode(undefined, async () => {
    plugin.start!();
    await tick();
    rmSync(path.join(s.claudeHome, 'skills', 'alpha'), { recursive: true });
    assert.ok(skills.sync().some((r) => r.name === 'alpha (claude)' && r.status === 'installed'));
    plugin.stop!();
    rmSync(path.join(s.claudeHome, 'skills', 'alpha'), { recursive: true });
    assert.ok(!skills.sync().some((r) => r.name === 'alpha (claude)'), 'unregistered on stop');
  });
});

test('the admin sync respects off', async () => {
  const s = setup();
  const homes = { source: s.source, claudeHome: s.claudeHome, codexHome: s.codexHome };
  await withMode('off', () => {
    assert.deepEqual(syncUserSkillsNow(homes), []);
    assert.ok(!existsSync(s.claudeHome));
  });
  await withMode(undefined, () => assert.equal(syncUserSkillsNow(homes).length, 2));
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

test('the two kanban-ui-screenshots copies differ only in SKILL.md and agents/', () => {
  const walk = (root: string, rel = ''): string[] =>
    readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') return [];
      return e.isDirectory() ? walk(root, r) : [r];
    });
  const list = (tool: string) => walk(path.join(REPO, 'user-skills', tool, 'kanban-ui-screenshots')).filter((f) => f !== 'SKILL.md' && !f.startsWith('agents/'));
  const sum = (tool: string, f: string) => createHash('sha256').update(readFileSync(path.join(REPO, 'user-skills', tool, 'kanban-ui-screenshots', f))).digest('hex');
  const claude = list('claude').sort();
  assert.deepEqual(list('codex').sort(), claude);
  assert.ok(claude.length > 0);
  for (const f of claude) assert.equal(sum('codex', f), sum('claude', f), `${f} is the same in both`);
});
