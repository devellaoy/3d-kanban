import { $, h } from '../../ui/dom';
import type { Billiards } from './game';
import './ui.css';

/** The ball colors, by number modulo eight (the same as the ones on the balls themselves: see world.ts). */
const CHIP = ['#18181c', '#f2c230', '#2f6fd1', '#d63a2f', '#6b3fa0', '#f08a24', '#2f9e55', '#8c2f39'];

/**
 * The panel along the top while you're at the table: the mode and whose turn it is, the shots and the
 * balls potted, the power meter while you hold the shot, and a ✕ that leaves.
 */
export class BilliardsPanel {
  private readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly rest: HTMLElement;
  private readonly info: HTMLElement;
  private readonly chips: HTMLElement;
  private shown = '';

  constructor(leave: () => void) {
    this.title = h('span.billiards-title', {}, '');
    const x = h('button.billiards-x', { type: 'button', 'aria-label': 'Leave the table', title: 'Leave the table (Esc)' }, '✕');
    x.addEventListener('click', leave);
    this.rest = h('span.billiards-rest');
    this.info = h('div.billiards-info');
    this.chips = h('div.billiards-balls');
    this.el = h('div.billiards.panel.hidden', { id: 'billiards', 'aria-label': 'Billiards' }, h('div.billiards-head', {}, this.title, x), h('div.billiards-meter', {}, this.rest), this.info, this.chips);
    $('hud').append(this.el);
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    this.shown = '';
  }

  /** Draws the game's state (only what changed) and the power meter (0–1). */
  render(game: Billiards, power: number, best: number | null): void {
    this.rest.style.width = `${(1 - power) * 100}%`;
    const two = game.mode === 'hotseat';
    const text = [
      `${two ? `🎱 Player ${game.turn + 1}'s turn` : '🎱 Practice'}`,
      `${game.shots} shot${game.shots === 1 ? '' : 's'}${two ? ` · ${game.score[0]}–${game.score[1]}` : ` · ${game.potted.length} potted`}`,
      game.phase === 'inhand' ? 'cue ball in hand' : best !== null ? `best clear ${best}` : '',
      game.potted.join(','),
    ].join('|');
    if (text === this.shown) return;
    this.shown = text;
    const [title, shots, extra] = text.split('|');
    this.title.textContent = title;
    this.info.textContent = [shots, extra].filter(Boolean).join(' · ');
    this.chips.replaceChildren(
      ...game.potted.map((id) => {
        const chip = h('span.billiards-chip', { title: `Ball ${id}` }, String(id));
        chip.style.background = CHIP[id % 8];
        if (id > 8) chip.style.boxShadow = 'inset 0 0 0 3px #fff';
        return chip;
      }),
    );
  }
}
