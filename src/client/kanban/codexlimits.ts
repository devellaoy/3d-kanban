// A small readout of the Codex sign-in's allowance, next to where a task picks Codex (the task's
// Agent row, the create form). It asks the office to read the limits while one is on the page.
import type { Net } from '../net';
import { store } from '../state';
import { h } from '../ui/dom';
import { level, fmtReset } from '../ui/limits';
import './codexlimits.css';
import { wantCodexLimits } from '../codex-limits/watch';

const chips = new Set<{ el: HTMLElement; paint: () => void }>();
let sweep = 0;
let hold: Net | null = null;
let listening = false;

function text(): { text: string; tone: string } {
  const s = store.codexLimits;
  if (s.windows.length && s.status !== 'signedOut' && s.status !== 'missing') {
    const now = Date.now();
    const parts = s.windows.map((w) => `${/5/.test(w.label) ? '5h' : w.label.toLowerCase()} ${Math.round(w.pct)}%`);
    const next = s.windows.filter((w) => w.resetsAt).sort((a, b) => b.pct - a.pct)[0];
    if (next?.resetsAt) parts.push(`resets ${fmtReset(next.resetsAt, now)}`);
    return { text: parts.join(' · '), tone: level(Math.max(...s.windows.map((w) => w.pct))) };
  }
  const note = { signedOut: 'Codex not signed in', missing: 'Codex not installed', error: 'Codex limits unavailable' }[s.status as string];
  return { text: note ?? 'checking…', tone: '' };
}

/**
 * Drops the chips that left the page, and holds the watch while one is in view: a chip hidden with
 * its form field (the create form's, when Claude is picked) reads nothing. Call it after showing or hiding one.
 */
export function recheckCodexChips() {
  for (const c of chips) if (!c.el.isConnected) chips.delete(c);
  for (const c of chips) c.paint();
  if (!hold) return;
  wantCodexLimits(hold, 'kanban', [...chips].some((c) => !c.el.closest('.hidden')));
  if (!chips.size) {
    clearInterval(sweep);
    sweep = 0;
  }
}

/** The readout: it keeps itself up to date for as long as it is on the page. */
export function codexLimitsChip(net: Net): HTMLElement {
  const el = h('span.kb-codex-limits', { title: 'The office’s Codex sign-in' });
  const chip = {
    el,
    paint() {
      const t = text();
      el.textContent = t.text;
      el.className = `kb-codex-limits ${t.tone}`;
    },
  };
  chip.paint();
  if (!listening) {
    listening = true;
    store.on('codexLimits', recheckCodexChips);
  }
  chips.add(chip);
  hold = net;
  // Once it's on the page (it's made before it's added).
  setTimeout(recheckCodexChips, 0);
  if (!sweep) sweep = window.setInterval(recheckCodexChips, 30_000);
  return el;
}
