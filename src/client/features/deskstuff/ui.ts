import './ui.css';
import { h, openModal } from '../../ui/dom';
import { DESK_ITEMS, ITEM_INFO, setLamp, toggleItem, type DeskConfig } from './model';

// The desk-stuff picker: five small things to put on your desk, each a button that ticks on or off, and
// the lamp's switch. Every click shows on the desk at once and is saved by `onChange`.

export interface PickerDeps {
  /** The desk's name, for the title. */
  desk: string;
  /** What's on the desk now. */
  config: DeskConfig;
  /** Called with the new config after each click. */
  onChange(config: DeskConfig): void;
}

export function openDeskStuff(deps: PickerDeps) {
  let config = deps.config;
  const grid = h('div.ds-grid', { role: 'group', 'aria-label': 'Things on your desk' });
  const lamp = h('button.btn.ds-lamp', { type: 'button' }) as HTMLButtonElement;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const el = h(
    'div.modal.deskstuff',
    { role: 'dialog', 'aria-label': `Desk stuff at ${deps.desk}` },
    h('header', {}, h('h2', {}, `🧸 Desk stuff · ${deps.desk}`), close),
    h('div.body', {}, grid, lamp),
    h('footer', {}, h('span.grow', {}, 'Only you see these, on this browser. Aim at the lamp and press E to switch it.')),
  );

  const render = () => {
    grid.replaceChildren(
      ...DESK_ITEMS.map((item) => {
        const on = config.items.includes(item);
        const { icon, label } = ITEM_INFO[item];
        return h(
          'button.ds-item',
          {
            type: 'button',
            class: on ? 'on' : '',
            'aria-pressed': String(on),
            onclick: () => {
              config = toggleItem(config, item);
              deps.onChange(config);
              render();
            },
          },
          h('span.ds-icon', {}, icon),
          h('span.ds-name', {}, label),
        );
      }),
    );
    const has = config.items.includes('lamp');
    lamp.hidden = !has;
    lamp.textContent = config.lampOn ? '💡 Lamp is on · turn it off' : '🔅 Lamp is off · turn it on';
    lamp.classList.toggle('primary', config.lampOn);
  };
  lamp.addEventListener('click', () => {
    config = setLamp(config, !config.lampOn);
    deps.onChange(config);
    render();
  });

  const modal = openModal(el, { doing: '🧸 arranging my desk' });
  close.addEventListener('click', () => modal.close());
  render();
  return modal;
}
