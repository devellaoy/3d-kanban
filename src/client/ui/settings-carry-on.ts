// ⚙️ Settings' "Carry on after the office restarts", under Workers: whether workers and kanban runs that
// were mid-task when the office stopped pick up again by themselves when it starts, for everyone
// (see server/carry-on-setting.ts). Admins change it, as they do the default worker.
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo } from './dom';
import { setting } from './settingrow';

/** The setting, kept up to date until `off`. */
export function carryOnSetting(net: Net): { section: HTMLElement; off: () => void } {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': 'Carry on after the office restarts' });
  const note = h('p.setting-note');
  const paint = () => {
    const { on, by, at } = store.carryOn;
    const admin = store.me.admin;
    row.classList.toggle('hidden', !admin);
    row.replaceChildren(
      ...([
        [true, '▶️ Carry on by themselves'],
        [false, '🪑 Wait at their desks'],
      ] as const).map(([value, label]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on === value),
            class: on === value ? 'on' : '',
            onclick: () => {
              if (store.carryOn.on !== value) net.send({ t: 'carryOn.set', on: value });
            },
          },
          label,
        ),
      ),
    );
    const now = on
      ? 'Workers and kanban runs that were in the middle of a task when the office stopped (Ctrl+C, or closed for an update) carry on by themselves when it starts again, each in its own session.'
      : 'Workers that were in the middle of a task when the office stopped wake up at their desks when it starts again and wait for you.';
    note.textContent = `${now} It’s the same for everyone in the building${by ? `, set by ${by}${at ? ` ${timeAgo(at)}` : ''}` : ''}.${admin ? '' : ' Admins can change it.'}`;
  };
  paint();
  const offs = [store.on('carryOn', paint), store.on('me', paint)];
  return { section: setting('Carry on after the office restarts', 'office', row, note), off: () => offs.forEach((off) => off()) };
}
