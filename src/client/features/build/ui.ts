import './ui.css';
import { MOVABLE_BY_ID, nameOf } from '../../../shared/arrange';
import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { PIECE_KINDS, PIECES, type PieceKind } from './model';

const ICONS: Record<string, string> = { desk: '🖥️', beanbag: '🫘', couch: '🛋️', pouf: '🫘', whiteboard: '📝', rug: '🟦' };

/**
 * The catalogue: every piece of furniture as a card. Picking one closes it and hands you the piece to
 * place; its ✕ (top right) or Esc just closes it, and the game takes the mouse straight back (see ui/dom).
 * Under it, the office's own furniture: the pieces the floor has taken out, to bring back, and a reset
 * of the whole floor's layout.
 */
export function openCatalogue(opts: { current: PieceKind | null; onPick(kind: PieceKind): void; onClose(): void; bringBack(id: string): void; reset(): void }): Modal {
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
  const furniture = store.floorPlan.furniture;
  const gone = Object.entries(furniture).flatMap(([id, p]) => (MOVABLE_BY_ID.has(id) && 'removed' in p ? [MOVABLE_BY_ID.get(id)!] : []));
  const moved = Object.keys(furniture).length;
  const backCards = gone.map((m) =>
    h(
      'button.btn.bd-card',
      { type: 'button', title: `Put ${nameOf(m)} back: aim at the floor and click`, onclick: () => (picked = true, modal.close(), opts.bringBack(m.id)) },
      h('span.bd-icon', {}, ICONS[m.kind] ?? '🪑'),
      h('span.bd-name', {}, m.label),
      h('span.bd-size', {}, 'taken out: place again'),
    ),
  );
  const office = h(
    'section.bd-office',
    {},
    h('h3', {}, '🏢 The office’s own furniture'),
    h('p.bd-help', {}, 'The desks, bean bags, couch, poufs, whiteboard and rugs are the floor’s, not yours alone: whatever you move or take out, everyone on this floor sees, and it stays. Aim at one and press E to move it (R turns it, click puts it down), X to take it out, H to put it back where it comes.'),
    ...(backCards.length ? [h('div.bd-grid', {}, ...backCards)] : [h('p.bd-none', {}, 'Nothing has been taken out of this floor.')]),
    h('button.btn.bd-reset', { type: 'button', disabled: moved === 0, title: moved ? 'Put everything back where the office comes' : 'It is all where it comes already', onclick: () => confirmReset(moved, () => (modal.close(), opts.reset())) }, `↺ Reset the floor’s layout${moved ? ` (${moved} changed)` : ''}`),
  );
  const el = h(
    'div.modal.build',
    {},
    h('header', {}, h('h2', {}, '🛠️ Build mode')),
    h(
      'div.body',
      {},
      h('p.bd-help', {}, 'Pick a piece, then aim at the floor. Click places it, R turns it, E picks up a piece you aim at, X removes it. Pieces from this list are yours: they are kept in this browser, per floor.'),
      h('div.bd-grid', {}, ...cards),
      office,
    ),
  );
  const modal = openModal(el, { doing: '🛠️ furnishing the office', onClose: () => !picked && opts.onClose() });
  return modal;
}

/** Asks before every desk, bean bag, the couch, poufs, whiteboard and rugs go back where the office comes (for everyone on the floor). */
function confirmReset(moved: number, reset: () => void): Modal {
  const yes = h('button.btn.primary', { type: 'button', onclick: () => (modal.close(), reset()) }, `↺ Put it all back (${moved})`);
  const no = h('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel');
  const el = h(
    'div.modal.build-confirm',
    {},
    h('header', {}, h('h2', {}, '↺ Reset the floor’s layout?')),
    h('div.body', {}, h('p', {}, `${moved} piece${moved === 1 ? ' is' : 's are'} not where the office comes. Resetting puts every desk, bean bag, the couch, the poufs, the whiteboard and the rugs back, and brings back the ones taken out. This is for everyone on the floor.`), h('div.bd-actions', {}, yes, no)),
  );
  const modal = openModal(el, { doing: '🛠️ furnishing the office' });
  return modal;
}
