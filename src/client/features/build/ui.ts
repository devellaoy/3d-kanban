import './ui.css';
import { h, openModal, type Modal } from '../../ui/dom';
import { PIECE_KINDS, PIECES, type PieceKind } from './model';

/**
 * The catalogue: every piece of furniture as a card. Picking one closes it and hands you the piece to
 * place; its ✕ (top right) or Esc just closes it, and the game takes the mouse straight back (see ui/dom).
 */
export function openCatalogue(opts: { current: PieceKind | null; onPick(kind: PieceKind): void; onClose(): void }): Modal {
  let picked = false;
  const cards = PIECE_KINDS.map((kind) => {
    const def = PIECES[kind];
    return h(
      'button.btn.bd-card',
      { type: 'button', class: kind === opts.current ? 'sel' : '', title: `${def.label}: ${def.w} × ${def.d} m`, onclick: () => (picked = true, modal.close(), opts.onPick(kind)) },
      h('span.bd-icon', {}, def.icon),
      h('span.bd-name', {}, def.label),
      h('span.bd-size', {}, `${def.w} × ${def.d} m`),
    );
  });
  const el = h(
    'div.modal.build',
    {},
    h('header', {}, h('h2', {}, '🛠️ Build mode')),
    h('div.body', {}, h('p.bd-help', {}, 'Pick a piece, then aim at the floor. Click places it, R turns it, E picks up a piece you aim at, X removes it.'), h('div.bd-grid', {}, ...cards)),
  );
  const modal = openModal(el, { doing: '🛠️ furnishing the office', onClose: () => !picked && opts.onClose() });
  return modal;
}
