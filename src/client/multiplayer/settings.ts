// What is in the 🌐 Multiplayer category: the server to connect to, who this office is there, and
// which floors other players may visit. Loaded the first time the category is shown (settingsslot.ts).
import './settings.css';
import type { MpFloorShare } from '../../shared/multiplayer/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h } from '../ui/dom';
import { setting } from '../ui/settingrow';

const STATUS: Record<string, string> = { off: '⚪ Not connected', connecting: '🟡 Connecting…', online: '🟢 Online', error: '🔴 Error' };

export function multiplayerPane(net: Net): { el: HTMLElement; close(): void } {
  const el = h('div.mp-set');
  const url = h('input', { type: 'text', inputmode: 'url', placeholder: 'https://relay.example.com', 'aria-label': 'Multiplayer server address', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const pass = h('input', { type: 'password', 'aria-label': 'Multiplayer server password', autocomplete: 'new-password' }) as HTMLInputElement;
  let urlTouched = false;
  url.addEventListener('input', () => (urlTouched = true));

  // The office asks the relay for the player list only while a browser watches.
  net.send({ t: 'mp.watch' });

  function floorRow(f: MpFloorShare) {
    const box = h('input', { type: 'checkbox', disabled: !f.shareable }) as HTMLInputElement;
    box.checked = f.shared;
    box.addEventListener('change', () => net.send({ t: 'mp.share', floor: f.id, on: box.checked }));
    return h('label.mp-floor', { title: f.shareable ? '' : (f.why ?? '') }, box, h('span', {}, f.name), h('span.setting-note', {}, f.shareable ? 'Share with the multiplayer server' : (f.why ?? 'Can’t be shared')));
  }

  function paint() {
    const mp = store.mp;
    if (!store.me.admin) {
      el.replaceChildren(h('p.setting-note', {}, 'Only an admin can change the multiplayer settings.'));
      return;
    }
    if (!urlTouched) url.value = mp.url;
    pass.placeholder = mp.passwordSet ? 'saved' : 'Password (if the server has one)';
    const connected = mp.status === 'online' || mp.status === 'connecting';
    const start = h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.identity.start' }) }, mp.login ? '🔁 Verify again' : '🔑 Verify GitHub account');
    const device = mp.device;
    const sign = [
      h('p.setting-note', {}, mp.login ? `Signed in as @${mp.login}.` : 'Other players know this office by its GitHub login. Verify yours to connect.'),
      device
        ? h('div.mp-device', {}, h('p', {}, 'Open ', h('a', { href: device.url, target: '_blank', rel: 'noopener noreferrer' }, device.url), ' and type this code:'), h('code.mp-code', {}, device.code), h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.identity.cancel' }) }, 'Cancel'))
        : start,
    ];
    const connect = h('button.btn.primary', { type: 'button', onclick: () => net.send({ t: 'mp.connect', url: url.value.trim(), ...(pass.value ? { password: pass.value } : {}) }) }, connected ? '🔄 Reconnect' : '🔌 Connect');
    const disconnect = h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.disconnect' }) }, 'Disconnect');
    (disconnect as HTMLButtonElement).disabled = mp.status === 'off';
    el.replaceChildren(
      setting('Server', 'office', h('div.mp-row', {}, url, pass), h('div.mp-row', {}, connect, disconnect), h('p.setting-note', { class: mp.status === 'error' ? 'bad' : '' }, STATUS[mp.status] ?? mp.status, mp.error ? ` — ${mp.error}` : '')),
      setting('Your GitHub account', 'office', ...sign),
      setting('Floors other players may visit', 'office', ...(mp.floors.length ? mp.floors.map(floorRow) : [h('p.setting-note', {}, 'No floors yet.')]), h('p.setting-note', {}, 'Visitors only see a shared floor if they also have access to its GitHub repositories, and can’t change anything.')),
    );
  }

  // Typing in a field must not lose focus to a repaint when the player list changes.
  const off = store.on('mp', () => {
    if (!el.contains(document.activeElement)) paint();
  });
  const offMe = store.on('me', paint);
  paint();
  return {
    el,
    close() {
      off();
      offMe();
      net.send({ t: 'mp.unwatch' });
    },
  };
}
