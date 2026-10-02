import './results.css';
import { h, openModal } from '../../ui/dom';
import { lapTime } from './laps';
import type { Bests, RaceResult } from './records';

// The race records window: your best lap, your best race and the last few races, and the ghost's switch.
// ✕ or Esc closes it (the modal's own), which puts you straight back into mouse-look.

export interface ResultsDeps {
  results: readonly RaceResult[];
  /** Which cars these are the records of ("supercars", "4x4s"): the classes race and keep their records apart. */
  label: string;
  /** The all-time best race and lap, which outlast the capped list of results. */
  bests: Bests;
  /** Your fastest lap of the loop (any lap, race or not), and the ghost's. */
  bestLap: number | null;
  ghostTime: number | null;
  ghostOn: boolean;
  onGhost(on: boolean): void;
}

export function openResults(deps: ResultsDeps) {
  const ghostBtn = h('button.btn.rr-ghost', { type: 'button' });
  let on = deps.ghostOn;
  const paint = () => {
    ghostBtn.textContent = on ? '👻 Ghost: on' : '👻 Ghost: off';
    ghostBtn.setAttribute('aria-pressed', String(on));
    ghostBtn.title = deps.ghostTime === null ? 'Your best lap, replayed as a ghost car: drive a lap to get one' : `Your best lap (${lapTime(deps.ghostTime)}), replayed as a ghost car`;
  };
  paint();
  ghostBtn.addEventListener('click', () => {
    on = !on;
    deps.onGhost(on);
    paint();
  });

  const race = deps.bests.total;
  const lap = deps.bests.lap;
  const stat = (label: string, value: string) => h('div.rr-stat', {}, h('div.rr-v', {}, value), h('div.rr-l', {}, label));
  const rows = deps.results.map((r, i) =>
    h(
      'tr',
      { class: race !== null && r.total === race ? 'best' : '' },
      h('td', {}, String(i + 1)),
      h('td', {}, new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      h('td.num', {}, lapTime(r.total)),
      h('td.laps', {}, r.laps.map(lapTime).join(' · ')),
      h('td', {}, r.penalty ? `+${r.penalty}s jump start` : ''),
    ),
  );
  const el = h(
    'div.modal.race-results',
    { role: 'dialog', 'aria-label': 'Race records' },
    h('header', {}, h('h2', {}, `🏁 Race records: ${deps.label}`), ghostBtn),
    h(
      'div.body',
      {},
      h('div.rr-stats', {}, stat('best lap', deps.bestLap !== null ? lapTime(deps.bestLap) : lap !== null ? lapTime(lap) : '–'), stat('best race', race !== null ? lapTime(race) : '–'), stat('races', String(deps.results.length))),
      rows.length
        ? h('table.rr-table', {}, h('thead', {}, h('tr', {}, ...['#', 'When', 'Total', 'Laps', ''].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows))
        : h('div.rr-none', {}, 'No races yet. Drive a car to the start line on the street and press Z for five red lights.'),
    ),
  );
  return openModal(el, { doing: 'checking the race records' });
}
