import './ui.css';
import { RARITY_NAMES, SPECIES, lengthText, speciesById, weightText, type Species, type Water } from './catch';
import { totals, type Journal } from './journal';
import { h, openModal, timeAgo } from '../../ui/dom';

// The fishing journal: a window listing every species with how many you've caught and your personal
// bests (the ones you haven't caught yet are question marks), and the latest catches. Its ✕ and Esc come
// with openModal, which gives you the mouse look back.

const WATERS: [Water, string][] = [
  ['lake', '🏞️ Lake (and junk from both)'],
  ['sea', '🌊 Sea'],
];

function card(s: Species, j: Journal): HTMLElement {
  const r = j.species[s.id];
  if (!r) return h('li.fj-card.unknown', { title: `${RARITY_NAMES[s.rarity]}: not caught yet` }, h('div.fj-icon', {}, '❔'), h('div.fj-name', {}, '???'), h('div.fj-sub', {}, RARITY_NAMES[s.rarity]));
  const best = s.kind === 'fish' ? `best ${lengthText(r.bestCm)} · ${weightText(r.bestKg)}` : 'junk';
  return h('li.fj-card', { class: `r${s.rarity}`, title: RARITY_NAMES[s.rarity] }, h('div.fj-icon', {}, s.icon), h('div.fj-name', {}, s.name), h('div.fj-sub', {}, `×${r.n} · ${best}`));
}

/** Opens the journal; `onClose` runs when it closes (✕, Esc or a click outside). */
export function openJournal(j: Journal, onClose: () => void): void {
  const t = totals(j);
  const kinds = SPECIES.filter((s) => s.kind === 'fish').length;
  const body = h('div.body.fj-body', {}, h('p.fj-top', {}, `${t.fish} fish of ${t.kinds}/${kinds} kinds · ${t.junk} junk · ${j.casts} casts · ${j.missed} got away`));
  for (const [water, title] of WATERS) {
    const here = SPECIES.filter((s) => s.waters.includes(water) && (s.waters.length === 1 || water === 'lake'));
    body.append(h('h3', {}, title), h('ul.fj-grid', {}, ...here.map((s) => card(s, j))));
  }
  body.append(h('h3', {}, '🕒 Latest'));
  if (!j.recent.length) body.append(h('p.fj-empty', {}, 'Nothing yet: walk to the end of the lake dock or the beach pier and press E at the sign.'));
  else {
    const rows = j.recent.map((e) => {
      const s = speciesById(e.id)!;
      return h('li', {}, `${s.icon} ${s.name}${s.kind === 'fish' ? ` · ${lengthText(e.cm)} · ${weightText(e.kg)}` : ''}`, h('span.fj-when', {}, ` ${e.spot}${e.at ? `, ${timeAgo(e.at)}` : ''}`));
    });
    body.append(h('ul.fj-recent', {}, ...rows));
  }
  const el = h('div.modal.fishing-journal', { role: 'dialog', 'aria-label': 'Fishing journal' }, h('header', {}, h('h2', {}, '🎣 Fishing journal')), body);
  openModal(el, { doing: '🎣 reading the fishing journal', reading: true, onClose });
}
