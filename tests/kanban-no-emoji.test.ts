// The kanban's windows draw their icons with ui/icons.ts (Lucide), not with emoji or text glyphs. This is
// the ratchet that gets them there: the pictographs each file still has on its code lines (comments
// don't count) may only go down. A file not listed has none; a listed one may not have more, and a
// lower count forces its number down here, so the list only shrinks. Same shape as the raw-colour
// ratchet in appearance.test.ts.
//
// Counted: every Unicode Extended_Pictographic character plus the glyphs the UI used as icons
// (✕ ＋ ⋯ ↻ ↺ ↗ ▾ ▸ ×), in .ts and .css under src/client/kanban, src/client/shared, src/client/ui/github
// and the ui/ windows the kanban opens. Left alone for good: the tab title, canvas and 3D text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const client = path.join(root, 'src/client');
const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');

/** The folders read whole, and the single ui/ files (as name.ts and name.css). */
const DIRS = ['kanban', 'shared', 'ui/github'];
const UI_FILES = ['boards', 'changes', 'terminal', 'termtabs', 'prompt', 'ask', 'settings', 'appearance', 'dom'];

const PICTOGRAPH = /\p{Extended_Pictographic}|[✕＋⋯↻↺↗▾▸×]/gu;

/** The source without its comments (line and block ones in .ts, string-aware; block ones in .css). */
function withoutComments(src: string, css: boolean): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (!css && c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === "'" || c === '"' || c === '`') {
      // A string runs to its closing quote; a template's ${…} is code, but a comment can't hide in it in practice.
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(ts|css)$/.test(e.name)) out.push(f);
  }
  return out;
}

function files(): string[] {
  const out = DIRS.flatMap((d) => walk(path.join(client, d)));
  for (const n of UI_FILES) for (const ext of ['ts', 'css']) if (existsSync(path.join(client, 'ui', `${n}.${ext}`))) out.push(path.join(client, 'ui', `${n}.${ext}`));
  return out.sort();
}

/** The pictographs on a file's code lines. */
function count(file: string): number {
  return withoutComments(readFileSync(file, 'utf8'), file.endsWith('.css')).match(PICTOGRAPH)?.length ?? 0;
}

/** How many each file may still have, by repo path. */
const ALLOWED: Readonly<Record<string, number>> = {
  'src/client/kanban/attach.ts': 1,
  'src/client/kanban/attachbox.ts': 5,
  'src/client/kanban/board.ts': 12,
  'src/client/kanban/boardrepos.ts': 4,
  'src/client/kanban/browse.ts': 7,
  'src/client/kanban/browse3d.ts': 1,
  'src/client/kanban/browsefilters.ts': 1,
  'src/client/kanban/browseview.ts': 12,
  'src/client/kanban/card.ts': 13,
  'src/client/kanban/changesview.ts': 25,
  'src/client/kanban/changeswindow.ts': 4,
  'src/client/kanban/commentview.ts': 4,
  'src/client/kanban/create.ts': 7,
  'src/client/kanban/hireform.ts': 19,
  'src/client/kanban/holddialog.ts': 2,
  'src/client/kanban/holdview.ts': 1,
  'src/client/kanban/install3d.ts': 1,
  'src/client/kanban/issueactions.ts': 14,
  'src/client/kanban/issuecards.ts': 18,
  'src/client/kanban/issuelink.ts': 4,
  'src/client/kanban/issuelinkmodel.ts': 1,
  'src/client/kanban/issues.ts': 10,
  'src/client/kanban/issuetab.ts': 3,
  'src/client/kanban/issueview.ts': 3,
  'src/client/kanban/issuewindow.ts': 3,
  'src/client/kanban/jira-connections.ts': 5,
  'src/client/kanban/lounge3d.ts': 1,
  'src/client/kanban/loungemodel.ts': 2,
  'src/client/kanban/main.ts': 18,
  'src/client/kanban/newproject.ts': 8,
  'src/client/kanban/office.ts': 15,
  'src/client/kanban/office3d.ts': 12,
  'src/client/kanban/officecss.ts': 2,
  'src/client/kanban/prbuttons.ts': 5,
  'src/client/kanban/prfind.ts': 1,
  'src/client/kanban/prfindmodel.ts': 1,
  'src/client/kanban/prmine.ts': 2,
  'src/client/kanban/promptscope.ts': 4,
  'src/client/kanban/prowner.ts': 1,
  'src/client/kanban/prpicker.ts': 3,
  'src/client/kanban/pulls.ts': 1,
  'src/client/kanban/sendhome.ts': 2,
  'src/client/kanban/settings-sources.ts': 2,
  'src/client/kanban/settings.ts': 14,
  'src/client/kanban/settingsslot.ts': 2,
  'src/client/kanban/skills.ts': 3,
  'src/client/kanban/source-forms.ts': 4,
  'src/client/kanban/taskactionbar.ts': 15,
  'src/client/kanban/taskdetails.ts': 2,
  'src/client/kanban/taskoverview.ts': 3,
  'src/client/kanban/taskplan.ts': 2,
  'src/client/kanban/taskprs.ts': 2,
  'src/client/kanban/taskreports.ts': 3,
  'src/client/kanban/taskruns.ts': 3,
  'src/client/kanban/taskview.ts': 5,
  'src/client/kanban/taskwaiting.ts': 4,
  'src/client/kanban/vscode.ts': 2,
  'src/client/kanban/workerbar.ts': 4,
  'src/client/kanban/workerbarmodel.ts': 1,
  'src/client/shared/officeactions.ts': 4,
  'src/client/shared/workercard.ts': 11,
  'src/client/ui/ask.ts': 5,
  'src/client/ui/boards.ts': 31,
  'src/client/ui/changes.ts': 22,
  'src/client/ui/github/close.ts': 8,
  'src/client/ui/github/comment-box.ts': 2,
  'src/client/ui/github/issue-window.ts': 13,
  'src/client/ui/github/labels.ts': 6,
  'src/client/ui/github/merge.ts': 26,
  'src/client/ui/github/pieces.ts': 3,
  'src/client/ui/github/pull-window.ts': 24,
  'src/client/ui/github/pulldiff.css': 2,
  'src/client/ui/prompt.ts': 12,
  'src/client/ui/settings.ts': 23,
  'src/client/ui/terminal.css': 1,
  'src/client/ui/terminal.ts': 10,
  'src/client/ui/termtabs.ts': 2,
};

test('comments are not counted, strings and CSS content are', () => {
  assert.equal(withoutComments("// ✅ done\nconst a = 'x'; /* 🔥 */ const b = '✅';", false).match(PICTOGRAPH)?.length, 1);
  assert.equal(withoutComments("const u = 'https://x.y/✅'; // 🔥", false).match(PICTOGRAPH)?.length, 1);
  assert.equal(withoutComments("/* 🔥 */ a::after { content: '✕'; }", true).match(PICTOGRAPH)?.length, 1);
  assert.equal(withoutComments('const t = `a ${b} 🎯`;', false).match(PICTOGRAPH)?.length, 1);
});

test('emoji and glyph icons in the kanban’s windows only shrink', () => {
  const all = files();
  assert.ok(all.length > 100, `${all.length} files read`);
  const problems: string[] = [];
  for (const f of all) {
    const name = rel(f);
    const n = count(f);
    const allowed = ALLOWED[name] ?? 0;
    if (n > allowed) problems.push(`${name} has ${n} emoji or glyph icons, ${allowed} allowed: draw an icon from ui/icons.ts`);
    else if (n < allowed) problems.push(`${name} is down to ${n}: lower its number in ALLOWED (${allowed}) to ${n}${n ? '' : ', or remove it'}`);
  }
  const read = new Set(all.map(rel));
  for (const name of Object.keys(ALLOWED)) if (!read.has(name)) problems.push(`${name} is in ALLOWED but isn't a file the guard reads: remove it`);
  assert.deepEqual(problems, []);
});
