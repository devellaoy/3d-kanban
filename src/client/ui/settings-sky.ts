// ⚙️ Settings' Outside, under Building: what the sky's doing, which clock it keeps, and whether rain and
// lightning come, for everyone (see server/sky.ts).
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import type { SkyState } from '../../shared/protocol';

/**
 * The setting, made by `frame` from what goes in it: the sky now (`outside.describe` words it, so this file
 * stays clear of the 3D world's code), the real time of day or a whole day and night every hour as buttons,
 * Rain and Lightning switches (both off by default; the server keeps Lightning from going without Rain), and
 * a note. Kept up to date until `off`.
 */
export function outsideSetting(net: Net, outside: { live: boolean; describe: (s: SkyState) => string }, frame: (body: Node[]) => HTMLElement): { section: HTMLElement; off: () => void } {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': 'The sky’s clock' });
  const weather = h('div.seg', { 'aria-label': 'Rain and lightning' });
  const now = h('p.outside-now');
  const note = h('p.setting-note');
  const paint = () => {
    const real = !!store.sky?.realTime;
    if (store.sky) now.textContent = outside.describe(store.sky);
    row.replaceChildren(
      ...[true, false].map((r) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(real === r),
            class: real === r ? 'on' : '',
            onclick: () => r !== !!store.sky?.realTime && net.send({ t: 'sky.clock', real: r }),
          },
          r ? '🕰️ Real time (24 h)' : '⏩ A day every hour',
        ),
      ),
    );
    const rain = !!store.sky?.rain;
    const lightning = !!store.sky?.lightning;
    const toggle = (on: boolean, label: string, send: () => void) =>
      h('button.btn', { type: 'button', 'aria-pressed': String(on), class: on ? 'on' : '', onclick: send }, label);
    weather.replaceChildren(
      toggle(rain, '🌧️ Rain', () => net.send({ t: 'sky.weather', rain: !rain })),
      toggle(lightning, '⚡ Lightning', () => net.send({ t: 'sky.weather', lightning: !lightning })),
    );
    const wet = !rain
      ? 'Rain and thunderstorms are kept out: a rainy forecast shows as cloudy.'
      : lightning ? 'Rain and thunderstorms come as they come.' : 'Rain comes, and storms without lightning.';
    note.textContent = `Everyone sees the same sky: ${real ? 'the real time of day' : 'a whole day and night every hour'}, and ${outside.live ? 'the live weather where it is.' : 'weather that comes and goes. Start the office with --city to use a real city’s forecast.'} ${wet} Lightning brings the rain with it${outside.live ? '' : ', and made-up weather lets them in from its next spell'}.`;
  };
  paint();
  return { section: frame([now, row, weather, note]), off: store.on('sky', paint) };
}
