// WCAG contrast of the themes' text colours on the surfaces they sit on. Reads the token blocks of
// themes/tokens.css (the default) and each theme file's first `:root[data-theme=...]` block, resolves
// `var(--x)` chains (a theme's own tokens first, then the default's), and checks each pair below.
//
// Translucent colours: a surface with alpha (glossy's frosted --paper) is blended over the theme's --bg,
// the page that shows through it (or the token a pair's `over` names); a text colour with alpha is blended over the surface it is on.
// A theme with a colour wash over its page (glossy's --wash-* tokens) is checked over each wash colour too, alone and all together.
// A pair that does not resolve to a plain colour (gradient, color-mix, ...) fails loudly unless excepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APPEARANCES } from '../src/client/themes/index.ts';

const themes = path.join(import.meta.dirname, '../src/client/themes');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** What each pair is: the text, the surface, the least WCAG ratio, and why it matters. */
interface Pair {
  fg: string;
  bg: string;
  min: number;
  why: string;
  /** Themes (ids) where the pair is knowingly below `min`; say why. */
  except?: Record<string, string>;
  /** A translucent `bg` is blended over this token instead of --bg, per theme (glossy's frosted panels sit on --bg). */
  over?: Record<string, string>;
  /** Only these themes. */
  themes?: string[];
}

const PAIRS: Pair[] = [
  { fg: '--text', bg: '--paper', min: 4.5, why: 'body text on a panel, window or card', over: { glossy: '--bg' } },
  { fg: '--text', bg: '--paper-2', min: 4.5, why: 'text in a window header or footer, a bar, a hover row', over: { glossy: '--bg' } },
  { fg: '--text', bg: '--field', min: 4.5, why: 'a button\'s and an input\'s text' },
  { fg: '--text', bg: '--field-hover', min: 4.5, why: 'a hovered button or the selected row' },
  { fg: '--text', bg: '--bg', min: 4.5, why: 'text straight on the page (kanban, 2D view)' },
  { fg: '--muted', bg: '--bg', min: 4.5, why: 'secondary text straight on the page (the 2D view\'s meta lines, an empty list)', except: { default: 'the default look is frozen pixel-identical (#7a6f65 on #bfe3ff is 3.6:1)' } },
  { fg: '--muted', bg: '--paper', min: 4.5, why: 'secondary text (ids, hints, meta lines) on a panel', over: { glossy: '--bg' } },
  { fg: '--muted', bg: '--field', min: 4.5, why: 'secondary text on a button or row' },
  { fg: '--text-on-warn', bg: '--warn', min: 4.5, why: 'a working pill, a search or palette hit, a modified-file letter, the upgrading banner' },
  { fg: '--text-on-warn', bg: '--warn-hot', min: 4.5, why: 'a lost worker\'s pill' },
  { fg: '--text-on-info', bg: '--info', min: 4.5, why: 'a renamed file\'s letter (Changes, PR diff)' },
  { fg: '--text-on-strong', bg: '--strong', min: 4.5, why: 'count badges, the selected tab' },
  { fg: '--text-on-strong', bg: '--good', min: 4.5, why: 'a done pill, an \'on\' button, an added-file letter', except: { default: 'the default look is frozen pixel-identical (white on #06d6a0 is 1.9:1)' } },
  { fg: '--text-on-strong', bg: '--bad', min: 4.5, why: 'a needs-input pill, a danger button, the reconnecting banner', except: { default: 'the default look is frozen pixel-identical (white on #ef476f is 3.6:1)' } },
  { fg: '--text-on-strong', bg: '--purple', min: 4.5, why: 'a merged PR\'s pill' },
  { fg: '--text-on-accent', bg: '--accent', min: 4.5, why: 'a primary button, the sign-in button', except: { default: 'the default look is frozen pixel-identical (white on #ff8a5b is 2.3:1)' } },
  { fg: '--text-on-accent', bg: '--accent-hover', min: 4.5, why: 'a hovered primary button', except: { default: 'the default look is frozen pixel-identical (white on #ff8a5b is 2.3:1)' } },
  { fg: '--hint-text', bg: '--hint-bg', min: 4.5, why: 'the HUD\'s hint bubble: what the keys do, and "Click to look around"' },
  { fg: '--hint-title', bg: '--hint-bg', min: 4.5, why: 'the name of what you face, in the HUD\'s hint bubble' },
  { fg: '--hint-cost', bg: '--hint-bg', min: 4.5, why: 'the cost in the HUD\'s hint bubble' },
  { fg: '--hint-key-text', bg: '--hint-key-bg', min: 4.5, why: 'a key cap in the HUD\'s hint bubble', over: { glossy: '--hint-bg' } },
  { fg: '--code-text', bg: '--code-bg', min: 4.5, why: 'a code block, the terminal' },
  { fg: '--code-text-2', bg: '--code-bg', min: 4.5, why: 'code in a search hit' },
  { fg: '--text-on-color', bg: '--code-bg', min: 4.5, why: 'the terminal\'s drop/upload notice' },
  { fg: '--link', bg: '--field', min: 4.5, why: 'links' },
  ...(['--comment-implementer', '--comment-reviewer'] as const).flatMap((bg): Pair[] => [
    { fg: '--text', bg, min: 4.5, why: 'an agent\'s comment in a task\'s conversation' },
    { fg: '--muted', bg, min: 4.5, why: 'the time of an agent\'s comment' },
    { fg: '--link', bg, min: 4.5, why: 'a link (a file, a URL) in an agent\'s comment' },
  ]),
  { fg: '--accent-text', bg: '--field', min: 4.5, why: 'accent-coloured text (a menu\'s main action)', except: { default: 'the default look is frozen pixel-identical' } },
  // The kit (styles/kit-*.css): secondary text, and each soft fill with the text on it.
  { fg: '--text-2', bg: '--paper', min: 4.5, why: 'a tab, a section label, a quiet button on a window', over: { glossy: '--bg' } },
  { fg: '--text-2', bg: '--paper-2', min: 4.5, why: 'a quiet button in a bar or on the details rail', over: { glossy: '--bg' } },
  { fg: '--text-2', bg: '--field-hover', min: 4.5, why: 'a hovered quiet button' },
  { fg: '--text-neutral', bg: '--tint-grey', min: 4.5, why: 'a count badge, an archived pill' },
  { fg: '--accent-soft-ink', bg: '--accent-soft', min: 4.5, why: 'an active filter chip' },
  ...(['todo', 'progress', 'waiting', 'review', 'hold', 'done'] as const).flatMap((s): Pair[] => [
    { fg: `--st-${s}-ink`, bg: `--st-${s}-soft`, min: 4.5, why: `a task's status pill (${s})` },
    { fg: `--st-${s}`, bg: '--paper', min: 3, why: `a status icon and its column's line (${s}), which are graphics: 3:1`, over: { glossy: '--bg' } },
  ]),
  ...(['plan', 'implement', 'review', 'fix', 'pr'] as const).map((p): Pair => ({ fg: `--ph-${p}-ink`, bg: `--ph-${p}-soft`, min: 4.5, why: `a run phase badge (${p})` })),
  ...(['open', 'draft', 'merged', 'closed'] as const).map((p): Pair => ({ fg: `--pr-${p}-ink`, bg: `--pr-${p}-soft`, min: 4.5, why: `a pull request's state (${p})` })),
  // Status colours as text: the -ink tokens, never the fills (--bad, --warn, --good), which are for backgrounds.
  { fg: '--danger-ink', bg: '--paper', min: 4.5, why: 'an error line on a panel or window (a form error, a failed check)', over: { glossy: '--bg' } },
  { fg: '--bad-ink', bg: '--paper', min: 4.5, why: 'red status text on a panel', over: { glossy: '--bg' } },
  { fg: '--good-ink', bg: '--paper', min: 4.5, why: 'green status text on a panel (a passed check)', over: { glossy: '--bg' } },
  { fg: '--warn-ink', bg: '--paper', min: 4.5, why: 'amber status text on a panel (a pending check)', over: { glossy: '--bg' } },
  { fg: '--gutter-ink', bg: '--gutter-bg', min: 4.5, why: 'a diff\'s line numbers (the pull request window)', except: { default: 'the default look is frozen pixel-identical (#a39a91 on #faf6f0 is 2.6:1)', glossy: 'Glossy keeps its faint line numbers (2.5:1)' } },
  { fg: '--gutter-ink-2', bg: '--gutter-bg', min: 4.5, why: 'a diff\'s line numbers (the Changes window)', except: { default: 'the default look is frozen pixel-identical (2.9:1)', glossy: 'Glossy keeps its faint line numbers (3.1:1)' } },
  { fg: '--attn-ink', bg: '--attn-soft', min: 4.5, why: 'the "needs you" pill and a waiting card\'s note' },
  { fg: '--attn-icon', bg: '--paper', min: 3, why: 'the "needs you" icon on a panel, a graphic: 3:1', over: { glossy: '--bg' } },
  { fg: '--banner-title', bg: '--banner-bg', min: 4.5, why: 'the title of a waiting task\'s banner' },
  { fg: '--banner-text', bg: '--banner-bg', min: 4.5, why: 'the text of a waiting task\'s banner' },
];

/** A theme's tokens: the declarations of the first block that `selector` opens. */
function tokensOf(file: string, selector: RegExp): Map<string, string> {
  const css = stripComments(readFileSync(path.join(themes, file), 'utf8'));
  const open = selector.exec(css);
  assert.ok(open, `${file}: no ${selector} block`);
  const body = css.slice(open.index + open[0].length, css.indexOf('\n}', open.index));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const defaults = tokensOf('tokens.css', /:root,\s*:root\[data-theme="default"\]\s*\{/);
const themeTokens = (id: string) => (id === 'default' ? defaults : tokensOf(`${id}.css`, new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`)));

/** A token's value with `var(--x)` chains followed (the theme's own tokens first, then the default's). */
function resolve(name: string, own: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`${name}: var() chain too deep`);
  const raw = own.get(name) ?? defaults.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined`);
  const v = raw.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (_, ref: string) => resolve(ref, own, depth + 1));
  return v;
}

type Rgba = [number, number, number, number];

function parseColor(v: string): Rgba {
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let x = m[1];
    if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join('');
    assert.ok(x.length === 6 || x.length === 8, `bad hex ${v}`);
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), x.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((s) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)));
    assert.ok(p.length === 3 || p.length === 4, `bad rgb() ${v}`);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  if (v === 'white') return [255, 255, 255, 1];
  if (v === 'black') return [0, 0, 0, 1];
  throw new Error(`"${v}" is not a plain colour`);
}

/** `top` laid over the opaque `under`. */
const blend = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;

const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The coloured buttons' text is checked on their plain fill (--accent, --accent-hover, --bad above), which
// holds only while no theme lays a gradient or image over them.
test('no theme lays a gradient over a button', () => {
  for (const { id } of APPEARANCES) {
    if (id === 'default') continue;
    const css = stripComments(readFileSync(path.join(themes, `${id}.css`), 'utf8'));
    for (const m of css.matchAll(/([^{}]*(?:\.btn\b|\.card button)[^{}]*)\{([^}]*)\}/g)) {
      assert.doesNotMatch(m[2], /background(-image)?\s*:[^;]*gradient/, `${id}.css: ${m[1].trim()} has a gradient`);
    }
  }
});

test('the contrast helper matches the WCAG reference values', () => {
  assert.equal(Math.round(contrast([0, 0, 0, 1], [255, 255, 255, 1])), 21);
  assert.equal(contrast([255, 255, 255, 1], [255, 255, 255, 1]), 1);
  assert.deepEqual(blend([0, 0, 0, 0.5], [255, 255, 255, 1]).map(Math.round), [128, 128, 128, 1]);
});

for (const { id } of APPEARANCES) {
  test(`${id}: text colours keep their contrast on their surfaces`, () => {
    const own = themeTokens(id);
    const failures: string[] = [];
    for (const p of PAIRS) {
      const label = `${id}: ${p.fg} on ${p.bg} (${p.why})`;
      if (p.except?.[id] || (p.themes && !p.themes.includes(id))) continue;
      try {
        const base = parseColor(resolve(p.over?.[id] ?? '--bg', own));
        assert.equal(base[3], 1, `${p.over?.[id] ?? '--bg'} must be opaque`);
        // The page is --bg, and wherever the theme's colour wash (--wash-*) lies over it: each colour
        // alone and all of them together.
        const washes = [...own.keys()].filter((k) => k.startsWith('--wash-')).map((k) => parseColor(resolve(k, own)));
        const pages = [base, ...washes.map((w) => blend(w, base))];
        if (washes.length > 1) pages.push(washes.reduce((under, w) => blend(w, under), base));
        const worst = Math.min(
          ...pages.map((page) => {
            // Text straight on the page sits on the page itself, wash and all.
            const bg = p.bg === (p.over?.[id] ?? '--bg') ? page : blend(parseColor(resolve(p.bg, own)), page);
            return contrast(blend(parseColor(resolve(p.fg, own)), bg), bg);
          }),
        );
        if (worst < p.min) failures.push(`${label}: ${worst.toFixed(2)}:1, needs ${p.min}:1`);
      } catch (e) {
        failures.push(`${label}: ${(e as Error).message}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}
