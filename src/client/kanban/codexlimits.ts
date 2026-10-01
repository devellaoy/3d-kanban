// A small readout of the Codex sign-in's allowance, next to where a task picks Codex (the task's
// Agent row, the create form). It asks the office to read the limits while one is on the page.
import type { Net } from '../net';
import { store } from '../state';
import { h } from '../ui/dom';
import type { CodexLimits } from '../../shared/codex-limits/protocol';
import { fmtReset, hhmm, isOld, level } from '../ui/limits';
import './codexlimits.css';
import { wantCodexLimits } from '../codex-limits/watch';

const chips = new Set<{ el: HTMLElement; paint: () => void }>();
let tick = 0;
let hold: Net | null = null;
let listening = false;

/** What the chip says for a state: the text, its tone class and the full sentence for its tooltip. */
export function codexChipText(s: CodexLimits, now = Date.now()): { text: string; tone: string; title: string } {
  if (s.windows.length && s.status !== 'signedOut' && s.status !== 'missing') {
    const parts = s.windows.map((w) => `${w.label === '5-hour' ? '5h' : w.label === 'Weekly' ? 'week' : w.label} ${Math.round(w.pct)}%`);
    const tone = level(Math.max(...s.windows.map((w) => w.pct)));
    const failed = s.status === 'error';
    if (isOld(s, now)) {
      const when = hhmm(s.at);
      return {
        text: `${parts.join(' · ')} · as of ${when}${failed ? ' (couldn’t refresh)' : ''}`,
        tone: `old ${tone}`.trim(),
        title: failed ? `Couldn’t read the Codex limits just now; these are from ${when}` : `The Codex limits were last read at ${when}`,
      };
    }
    const next = s.windows.filter((w) => w.resetsAt).sort((a, b) => b.pct - a.pct)[0];
    if (next?.resetsAt) parts.push(`resets ${fmtReset(next.resetsAt, now)}`);
    return { text: parts.join(' · '), tone, title: 'The office’s Codex sign-in' };
  }
  const note = { signedOut: 'Codex not signed in', missing: 'Codex not installed', error: 'Codex limits unavailable' }[s.status as string];
  return { text: note ?? 'checking…', tone: '', title: 'The office’s Codex sign-in' };
}

/**
 * Drops the chips that left the page, and holds the watch while one is in view: a chip hidden with
 * its form field (the create form's, when Claude is picked) reads nothing.
 */
export function recheckCodexChips() {
  for (const c of chips) if (!c.el.isConnected) chips.delete(c);
  for (const c of chips) c.paint();
  if (!hold) return;
  wantCodexLimits(hold, 'kanban', [...chips].some((c) => !c.el.closest('.hidden, [hidden]')));
  if (!chips.size) {
    watcher?.disconnect();
    watching = false;
    clearInterval(tick);
    tick = 0;
  }
}

// Closing a view or hiding a field changes the page: look again at once (once a frame at most).
let queued = false;
let watcher: MutationObserver | null = null;
const onChange = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    recheckCodexChips();
  });
};
let watching = false;

/** The readout: it keeps itself up to date for as long as it is on the page. */
export function codexLimitsChip(net: Net): HTMLElement {
  const el = h('span.kb-codex-limits', { title: 'The office’s Codex sign-in' });
  const chip = {
    el,
    paint() {
      const t = codexChipText(store.codexLimits);
      // Only what changed: the page watcher would see a rewrite as a change and look again.
      const cls = `kb-codex-limits ${t.tone}`;
      if (el.title !== t.title) el.title = t.title;
      if (el.textContent !== t.text) el.textContent = t.text;
      if (el.className !== cls) el.className = cls;
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
  if (!watching) {
    watching = true;
    watcher ??= new MutationObserver(onChange);
    watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  // The countdown ("resets in 2h") moves on its own.
  if (!tick) tick = window.setInterval(() => document.visibilityState === 'visible' && chips.forEach((c) => c.paint()), 30_000);
  return el;
}
