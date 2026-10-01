// The appearances (themes/index.ts): parsing a saved choice, that every appearance has its sheet and
// every token, that the sheets keep to the tokens (colours come from tokens, not from the rule),
// and that every page sets its appearance before the first paint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPEARANCES, APPEARANCE_KEY, parseAppearance } from '../src/client/themes/index.ts';

const root = path.join(import.meta.dirname, '..');
const client = path.join(root, 'src/client');
const themes = path.join(client, 'themes');
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every file under a folder with one of the extensions, skipping node_modules. */
function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(f, ext, out);
    } else if (ext.test(e.name)) out.push(f);
  }
  return out;
}

test('parseAppearance keeps the known ids and makes anything else the default', () => {
  for (const a of APPEARANCES) assert.equal(parseAppearance(a.id), a.id);
  for (const bad of [null, undefined, '', 'Dark', 'neon', 42, {}, ['dark']]) assert.equal(parseAppearance(bad), 'default');
});

test('the appearances are well formed', () => {
  assert.equal(APPEARANCES[0].id, 'default');
  assert.equal(new Set(APPEARANCES.map((a) => a.id)).size, APPEARANCES.length);
  for (const a of APPEARANCES) {
    assert.match(a.themeColor, /^#[0-9a-f]{6}$/i, a.id);
    assert.ok(a.label && a.icon && a.blurb, a.id);
  }
});

test('every appearance has its stylesheet, imported by themes/index.css, and every sheet is an appearance', () => {
  const index = read(path.join(themes, 'index.css'));
  for (const a of APPEARANCES) {
    if (a.id === 'default') continue;
    assert.ok(readdirSync(themes).includes(`${a.id}.css`), `themes/${a.id}.css exists`);
    assert.match(index, new RegExp(`@import\\s+['"]\\./${a.id}\\.css['"]`), `themes/index.css imports ${a.id}.css`);
  }
  const ids = new Set<string>(APPEARANCES.map((a) => a.id));
  for (const f of readdirSync(themes).filter((f) => f.endsWith('.css') && f !== 'tokens.css' && f !== 'index.css')) {
    assert.ok(ids.has(f.slice(0, -4)), `${f} has a row in APPEARANCES`);
  }
});

/** The custom properties declared in tokens.css's first `:root` block. */
function tokenNames(): string[] {
  const css = stripComments(read(path.join(themes, 'tokens.css')));
  const open = css.indexOf(':root');
  assert.ok(open >= 0, 'tokens.css has a :root block');
  const start = css.indexOf('{', open);
  const end = css.indexOf('}', start);
  return [...css.slice(start, end).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
}

test('every theme defines every token', () => {
  const tokens = tokenNames();
  assert.ok(tokens.length > 20, 'tokens.css declares the tokens');
  for (const a of APPEARANCES) {
    if (a.id === 'default') continue;
    const css = stripComments(read(path.join(themes, `${a.id}.css`)));
    const missing = tokens.filter((t) => !new RegExp(`${t}\\s*:`).test(css));
    assert.deepEqual(missing, [], `${a.id}.css leaves tokens undefined`);
  }
});

// ---- The colour guard -------------------------------------------------------------------------------

/** The CSS inside the template strings of the files that carry their own (put on the page by code). */
const CSS_IN_TS = ['src/client/kanban/officecss.ts', 'src/client/kanban/worker3d.ts', 'src/client/kanban/vscode.ts'];

/** Every stylesheet the guard reads, as repo path → its CSS (comments out). */
function sheets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of walk(client, /\.css$/)) if (!f.startsWith(themes + path.sep)) out.set(rel(f), stripComments(read(f)));
  for (const f of CSS_IN_TS) {
    const src = read(path.join(root, f));
    out.set(f, [...src.matchAll(/`([^`]*)`/g)].map((m) => stripComments(m[1])).join('\n'));
  }
  return out;
}

test('no sheet uses --ink for text or for a heavy line', () => {
  const rules: [RegExp, string][] = [
    [/(?<![-\w])color\s*:\s*var\(--ink\)/, 'color: var(--ink): text uses --text (--ink is the line colour)'],
    [/(?<![-\w])background(-color)?\s*:\s*var\(--ink\)/, 'background: var(--ink): a dark fill uses --strong'],
    [/\b[23]px solid var\(--ink\)/, '2px/3px solid var(--ink): the width is var(--bw) or var(--bw-sm)'],
  ];
  const found: string[] = [];
  for (const [file, css] of sheets()) for (const [re, why] of rules) if (re.test(css)) found.push(`${file}: ${why}`);
  assert.deepEqual(found, []);
});

/**
 * The raw colours (hex and rgb()) each sheet may still have, by repo path. A sheet not listed has
 * none; a listed one may not have more, and one that now has fewer must have its number lowered
 * here, so the list only shrinks. New rules use tokens.
 */
// What's left is in the 3D office rather than its windows (the telescope, the fade between floors, a
// shared screen's black, the arcade) or content (the coffee meter, the avatars' colours).
const ALLOWED: Readonly<Record<string, number>> = {
  'src/client/features/hanging/ui.css': 3,
  'src/client/styles/hud.css': 22,
  'src/client/ui/boards.css': 2,
  'src/client/ui/changes.css': 2,
  'src/client/ui/character.css': 3,
  'src/client/ui/elevator.css': 1,
  'src/client/ui/floormenu.css': 1,
  'src/client/ui/floorplan.css': 1,
  'src/client/youtube/youtube.css': 4,
};

const RAW_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/gi;

test('raw colours in the sheets only shrink', () => {
  const problems: string[] = [];
  for (const [file, css] of sheets()) {
    const n = css.match(RAW_COLOUR)?.length ?? 0;
    const allowed = ALLOWED[file] ?? 0;
    if (n > allowed) problems.push(`${file} has ${n} raw colours, ${allowed} allowed: use a token from themes/tokens.css`);
    else if (n < allowed) problems.push(`${file} is down to ${n} raw colours: lower its number in ALLOWED (${allowed}) to ${n}${n ? '' : ', or remove it'}`);
  }
  for (const file of Object.keys(ALLOWED)) if (!sheets().has(file)) problems.push(`${file} is in ALLOWED but isn't a sheet the guard reads: remove it`);
  assert.deepEqual(problems, []);
});

// ---- The pages -------------------------------------------------------------------------------------

test('every page sets its appearance before the stylesheet', () => {
  for (const page of ['index', 'kanban', 'lite', 'login', 'join', 'claim']) {
    const html = read(path.join(client, `${page}.html`));
    const script = html.indexOf(`localStorage.getItem('${APPEARANCE_KEY}')`);
    assert.ok(script >= 0, `${page}.html has the boot script`);
    assert.ok(script < html.indexOf('rel="stylesheet"'), `${page}.html runs it before the stylesheet`);
    assert.equal(html.match(/name="theme-color"/g)?.length, 1, `${page}.html has one theme-color`);
  }
});
