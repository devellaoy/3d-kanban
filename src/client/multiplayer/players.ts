// 🌐 Players: who is on the multiplayer server, with a Visit button for each. While visiting, your
// browser's socket is piped to the other office, so `mp.*` can't reach your own office: the window
// then only says whose office this is and offers the way home.
import type { MpPlayer } from '../../shared/multiplayer/protocol';
import type { HudAction } from '../ui/menu';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from '../ui/dom';
import { goHome, goVisit, visiting } from './visit';

/** The ☰ menu's entry for it: offered once a server is saved (to go online from it), or while visiting. */
export function playersAction(net: Net): HudAction {
  return { id: 'players', icon: '🌐', label: 'Players', section: 'Together', shown: () => store.mp.configured || !!visiting(), status: () => store.mp.configured && !visiting(), chip: () => (store.mp.offline ? '⚪ Offline' : store.mp.status === 'online' ? '🟢 Online' : store.mp.status === 'error' ? '🔴 Error' : '🟡 Connecting…'), title: () => 'Who is on the multiplayer server, and visit their offices', run: () => openPlayers(net) };
}

function where(p: MpPlayer): string {
  if (!p.online) return 'offline';
  if (typeof p.where === 'object') return `visiting @${p.where.visiting}`;
  const name = p.floor ?? store.mpFloors[p.login.toLowerCase()]?.[0]?.name;
  return name ? `in their office · ${name}` : 'in their office';
}

export function openPlayers(net: Net) {
  const list = h('div.body.mp-players');
  const home = () => h('button.btn', { type: 'button', onclick: goHome }, '🏠 Back to my office');
  const owner = visiting();
  const probed = new Set<string>();

  function row(p: MpPlayer) {
    const visit = p.me ? null : h('button.btn.small', { type: 'button', disabled: !p.online, onclick: () => goVisit(p.login) }, 'Visit');
    return h('div.mp-player', {}, h('span.dot', { class: p.online ? 'on' : '', title: p.online ? 'Online' : 'Offline' }), h('span.mp-who', {}, h('b', {}, p.name ? `${p.name} ` : '', h('span.mp-login', {}, `@${p.login}`)), h('small', {}, p.me ? 'you · ' : '', where(p))), p.me ? home() : visit);
  }

  function paint() {
    if (owner) return list.replaceChildren(h('p.mp-visiting', {}, `👀 You are visiting @${owner}’s office. It is read-only: you can look around, but not change anything.`), home());
    const mp = store.mp;
    const players = mp.offline ? [] : mp.players;
    const toggle = h('button.btn.small', { type: 'button', onclick: () => net.send({ t: 'mp.online', on: mp.offline }) }, mp.offline ? '🟢 Go online' : '⚪ Go offline');
    const mine = h('div.mp-player', {}, h('span.dot', { class: mp.offline ? '' : mp.status === 'online' ? 'on' : '' }), h('span.mp-who', {}, h('b', {}, 'You are ', mp.offline ? 'offline' : mp.status === 'online' ? 'online' : 'connecting…'), h('small', {}, mp.offline ? 'Not connected to the server; your own office works as usual.' : 'Go offline to leave the server without losing its settings.')), toggle);
    const empty = mp.offline ? 'You are offline, so no players are shown.' : 'Nobody else is here yet.';
    list.replaceChildren(mine, ...(players.length ? players.map(row) : [h('p.setting-note', {}, empty)]));
    // Ask each online player which floors they show us, once per open.
    for (const p of players) {
      if (p.me || !p.online || probed.has(p.login)) continue;
      probed.add(p.login);
      net.send({ t: 'mp.probe', to: p.login });
    }
  }

  const el = h('div.modal.mp-players-modal', { role: 'dialog', 'aria-label': 'Players' }, h('header', {}, h('h2', {}, '🌐 Players')), list);
  if (!owner) net.send({ t: 'mp.watch' });
  const off = owner ? () => {} : store.on('mp', paint);
  paint();
  openModal(el, {
    doing: '🌐 looking at the players',
    onClose: () => {
      off();
      if (!owner) net.send({ t: 'mp.unwatch' });
    },
  });
}
