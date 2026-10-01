// The Codex limits panel under the Claude one: the Codex sign-in's 5-hour and weekly allowance.
// Unlike the Claude panel it stays up while it's turned on, to say why there is nothing to show.
import type { PlanWindow } from '../../shared/protocol';
import { store } from '../state';
import { $, h } from '../ui/dom';
import { fmtReset, level, STALE_MS } from '../ui/limits';
import { panelHide } from '../ui/menu';
import './codex-limits.css';

const hhmm = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A dial: a ring filled to the share used. */
function dial(pct: number): HTMLElement {
  return h('div.dial', { class: level(pct), style: `--pct:${Math.min(100, Math.max(0, pct))}` }, h('b', {}, `${Math.round(pct)}`, h('small', {}, '%')));
}

function windowRow(w: PlanWindow, now: number): HTMLElement {
  const pct = Math.round(w.pct);
  const when = w.resetsAt ? new Date(w.resetsAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : '';
  return h(
    'div.cx-win',
    { title: `${w.label}: ${pct}% used${when ? `\nStarts over ${when}` : ''}`, role: 'progressbar', 'aria-label': w.label, 'aria-valuenow': pct },
    dial(w.pct),
    h('div.cx-text', {}, h('span.what', {}, w.label), w.resetsAt ? h('span.reset', {}, `resets ${fmtReset(w.resetsAt, now)}`) : null),
  );
}

/** What the panel says when it has no numbers (or they're old). */
function noteOf(s: typeof store.codexLimits): string {
  switch (s.status) {
    case 'signedOut':
      return 'Codex isn’t signed in with a ChatGPT plan';
    case 'missing':
      return 'Codex isn’t installed on the office’s machine';
    case 'error':
      return s.windows.length ? `Couldn’t read them just now · as of ${hhmm(s.at)}` : 'Couldn’t read them';
    case 'ready':
      return Date.now() - s.at > STALE_MS ? `As of ${hhmm(s.at)}` : '';
    default:
      return s.windows.length ? '' : 'Checking the Codex sign-in…';
  }
}

export function renderCodexLimits() {
  const s = store.codexLimits;
  const now = Date.now();
  const plan = s.plan ? s.plan.charAt(0).toUpperCase() + s.plan.slice(1) : '';
  const shown = s.status === 'ready' || s.status === 'error' || s.status === 'checking' || s.status === 'off' ? s.windows : [];
  const note = noteOf(s);
  $('codex-limits').replaceChildren(
    h('h3', {}, 'Codex limits', plan ? h('span.plan', {}, plan) : null, panelHide('codexLimits')),
    ...shown.map((w) => windowRow(w, now)),
    ...(note ? [h('div.row.muted', {}, note)] : []),
    h('div.row.muted.cx-whose', {}, 'Office’s Codex sign-in'),
  );
}
