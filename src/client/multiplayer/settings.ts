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

  // Asks for the state now; index.ts keeps this browser watching, so closing the pane never unwatches.
  net.send({ t: 'mp.watch' });

  function floorRow(f: MpFloorShare) {
    const box = h('input', { type: 'checkbox', disabled: !f.shareable }) as HTMLInputElement;
    box.checked = f.shared;
    box.addEventListener('change', () => net.send({ t: 'mp.share', floor: f.id, on: box.checked }));
    return h('label.mp-floor', { title: f.shareable ? '' : (f.why ?? '') }, box, h('span', {}, f.name), h('span.setting-note', {}, f.shareable ? 'Share with the multiplayer server' : (f.why ?? 'Can’t be shared')));
  }

  // The two text fields are made once and kept, so a repaint never costs them their focus or what
  // was typed; everything around them is rebuilt on every `mp` update, whatever has focus.
  const online = h('div.mp-row');
  const status = h('p.setting-note');
  const sign = h('div');
  const floors = h('div');
  const skeleton = [
    setting('Server', 'office', h('div.mp-row', {}, url, pass), online, status, h('p.setting-note', {}, 'Offline keeps the server settings; you just aren’t connected, and can still work in your own office.')),
    setting('Your GitHub account', 'office', sign),
    setting('Floors other players may visit', 'office', floors, h('p.setting-note', {}, 'Visitors only see a shared floor if they also have access to its GitHub repositories, and can’t change anything.')),
  ];

  function paint() {
    const mp = store.mp;
    if (!store.me.admin) {
      el.replaceChildren(h('p.setting-note', {}, 'Only an admin can change the multiplayer settings.'));
      return;
    }
    if (!skeleton[0].isConnected) el.replaceChildren(...skeleton);
    if (!urlTouched && document.activeElement !== url) url.value = mp.url;
    pass.placeholder = mp.passwordSet ? 'saved' : 'Password (if the server has one)';
    const connected = mp.status === 'online' || mp.status === 'connecting';
    const connect = h('button.btn.primary', { type: 'button', onclick: () => net.send({ t: 'mp.connect', url: url.value.trim(), ...(pass.value ? { password: pass.value } : {}) }) }, connected ? '🔄 Reconnect' : '🔌 Connect');
    const toggle = h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.online', on: mp.offline }) }, mp.offline ? '🟢 Go online' : '⚪ Go offline') as HTMLButtonElement;
    toggle.disabled = !mp.configured;
    online.replaceChildren(connect, toggle);
    status.className = `setting-note${mp.status === 'error' && !mp.offline ? ' bad' : ''}`;
    status.textContent = (mp.offline ? '⚪ Offline' : (STATUS[mp.status] ?? mp.status)) + (mp.error && !mp.offline ? ` — ${mp.error}` : '');
    const device = mp.device;
    sign.replaceChildren(
      h('p.setting-note', {}, mp.login ? `Signed in as @${mp.login}.` : 'Other players know this office by its GitHub login. Verify yours to connect.'),
      device
        ? h('div.mp-device', {}, h('p', {}, 'Open ', h('a', { href: device.url, target: '_blank', rel: 'noopener noreferrer' }, device.url), ' and type this code:'), h('code.mp-code', {}, device.code), h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.identity.cancel' }) }, 'Cancel'))
        : h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.identity.start' }) }, mp.login ? '🔁 Verify again' : '🔑 Verify GitHub account'),
      // The token only proves who you are, but whoever holds it can say so on any relay with the same password.
      ...(mp.login ? [h('button.btn', { type: 'button', onclick: () => net.send({ t: 'mp.identity.forget' }) }, '🗑 Forget GitHub account'), h('p.setting-note', {}, 'Deletes the stored token and disconnects. To revoke it on GitHub too: Settings → Applications → Authorized OAuth Apps → the server’s app → Revoke.')] : []),
    );
    floors.replaceChildren(...(mp.floors.length ? mp.floors.map(floorRow) : [h('p.setting-note', {}, 'No floors yet.')]));
  }

  const off = store.on('mp', paint);
  const offMe = store.on('me', paint);
  paint();
  return {
    el,
    close() {
      off();
      offMe();
    },
  };
}
