// WCAG contrast of the themes' text colours on the surfaces they sit on. Reads the token blocks of
// themes/tokens.css (the default) and each theme file's first `:root[data-theme=...]` block, resolves
// `var(--x)` chains (a theme's own tokens first, then the default's), and checks each pair below.
//
// Translucent colours: a surface with alpha (glossy's frosted --paper) is blended over the theme's --bg,
// the page that shows through it (or the token a pair's `over` names); a text colour with alpha is blended over the surface it is on.
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
  /** A colour laid over `bg` first (a gradient's light end), for pairs a plain token can't say. */
  overlay?: string;
  /** Only these themes. */
  themes?: string[];
}

const PAIRS: Pair[] = [
  { fg: '--text', bg: '--paper', min: 4.5, why: 'body text on a panel, window or card', over: { glossy: '--bg' } },
  { fg: '--text', bg: '--paper-2', min: 4.5, why: 'text in a window header or footer, a bar, a hover row', over: { glossy: '--bg' } },
  { fg: '--text', bg: '--field', min: 4.5, why: 'a button\'s and an input\'s text' },
  { fg: '--text', bg: '--field-hover', min: 4.5, why: 'a hovered button or the selected row' },
  { fg: '--text', bg: '--bg', min: 4.5, why: 'text straight on the page (kanban, 2D view)' },
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
  { fg: '--text-on-accent', bg: '--accent', overlay: 'rgba(255, 255, 255, .1)', themes: ['glossy'], min: 4.5, why: 'glossy\'s coloured button at the light top of its gradient (glossy.css .btn.primary/.btn.on and the sign-in button)' },
  { fg: '--text-on-accent', bg: '--accent-hover', overlay: 'rgba(255, 255, 255, .1)', themes: ['glossy'], min: 4.5, why: 'the same, hovered' },
  { fg: '--text-on-strong', bg: '--bad', overlay: 'rgba(255, 255, 255, .1)', themes: ['glossy'], min: 4.5, why: 'glossy\'s danger button at the top of its gradient' },
  { fg: '--hint-title', bg: '--strong', min: 4.5, why: 'the name of what you face, in the HUD\'s hint bubble' },
  { fg: '--hint-cost', bg: '--strong', min: 4.5, why: 'the cost in the HUD\'s hint bubble' },
  { fg: '--code-text', bg: '--code-bg', min: 4.5, why: 'a code block, the terminal' },
  { fg: '--code-text-2', bg: '--code-bg', min: 4.5, why: 'code in a search hit' },
  { fg: '--text-on-color', bg: '--code-bg', min: 4.5, why: 'the terminal\'s drop/upload notice' },
  { fg: '--link', bg: '--field', min: 4.5, why: 'links' },
  { fg: '--accent-text', bg: '--field', min: 4.5, why: 'accent-coloured text (a menu\'s main action)', except: { default: 'the default look is frozen pixel-identical' } },
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
        const page = parseColor(resolve(p.over?.[id] ?? '--bg', own));
        assert.equal(page[3], 1, `${p.over?.[id] ?? '--bg'} must be opaque`);
        let bg = blend(parseColor(resolve(p.bg, own)), page);
        if (p.overlay) bg = blend(parseColor(p.overlay), bg);
        const fg = blend(parseColor(resolve(p.fg, own)), bg);
        const ratio = contrast(fg, bg);
        if (ratio < p.min) failures.push(`${label}: ${ratio.toFixed(2)}:1, needs ${p.min}:1`);
      } catch (e) {
        failures.push(`${label}: ${(e as Error).message}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}
