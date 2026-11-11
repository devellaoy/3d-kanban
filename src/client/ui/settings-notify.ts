// ⚙️ Settings' notification rows (ui/settings.ts): this browser's desktop notifications, and the
// office's Slack / Discord webhook that everyone shares.

import type { Net } from '../net';
import { store, type Settings } from '../state';
import { askNotifyPermission, notifyPermission, type DesktopNotifier } from '../notify';
import type { WebhookKind } from '../../shared/protocol';
import { h, timeAgo } from './dom';
import { withIcon } from './icons';

const WEBHOOK_NAME: Record<WebhookKind, string> = { slack: 'Slack', discord: 'Discord', other: 'a webhook' };

/** This browser's permission, then your own on/off. */
export function desktopNotifications(settings: () => Settings, change: (s: Settings) => void, notifier: DesktopNotifier): { row: HTMLElement; note: HTMLElement } {
  const notifyRow = h('div.seg');
  const notifyNote = h('p.setting-note');
  const paintNotify = () => {
    const perm = notifyPermission();
    const on = perm === 'granted' && settings().notify;
    notifyRow.replaceChildren();
    if (perm === 'default') {
      notifyRow.append(
        h(
          'button.btn.primary',
          {
            type: 'button',
            onclick: async () => {
              if ((await askNotifyPermission()) === 'granted') {
                change({ ...settings(), notify: true });
                notifier.sample();
              }
              paintNotify();
            },
          },
          ...withIcon('bell', 'Turn on notifications'),
        ),
      );
    } else if (perm === 'granted') {
      for (const [value, label] of [
        [true, 'On'],
        [false, 'Off'],
      ] as const) {
        notifyRow.append(
          h(
            'button.btn',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(on === value),
              class: on === value ? 'on' : '',
              onclick: () => {
                change({ ...settings(), notify: value });
                paintNotify();
              },
            },
            label,
          ),
        );
      }
      if (on) notifyRow.append(h('button.btn', { type: 'button', onclick: () => notifier.sample() }, 'Show me one'));
    }
    notifyNote.textContent =
      perm === 'unsupported'
        ? 'This browser can’t show notifications from the office here. They need https or localhost (an SSH tunnel counts).'
        : perm === 'denied'
          ? 'Your browser blocks notifications from the office. Allow them in the site settings (the icon left of the address), then open this again.'
          : 'When a worker needs input or finishes while you’re in another tab or app, you get a notification. Click it to jump to that worker’s terminal. The tab title counts the workers waiting on someone either way.';
  };
  paintNotify();
  return { row: notifyRow, note: notifyNote };
}

/** The webhook's box and buttons; `paint` follows `store.notify`. */
export function teamWebhook(net: Net) {
  const hookStatus = h('p.setting-note');
  const hookInput = h('input', { type: 'text', placeholder: 'https://hooks.slack.com/services/…', 'aria-label': 'Slack or Discord webhook URL', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const hookSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const hookTest = h('button.btn', { type: 'button' }, 'Send a test');
  const hookRemove = h('button.btn.danger', { type: 'button' }, 'Remove');
  const hookActions = h('div.seg.below', {}, hookTest, hookRemove);
  const paintHook = () => {
    const { webhook, error, lastSentAt } = store.notify;
    hookActions.classList.toggle('hidden', !webhook);
    hookSave.textContent = webhook ? 'Replace' : 'Save';
    hookStatus.classList.toggle('bad', !!error);
    hookStatus.textContent = !webhook
      ? 'Paste an incoming webhook from Slack or Discord, and the office posts to that channel when a worker needs input or finishes and nobody has its terminal open. It’s for everyone in the office.'
      : error
        ? `Posting to ${WEBHOOK_NAME[webhook.kind]} (${webhook.hint}) failed: ${error}`
        : `Posting to ${WEBHOOK_NAME[webhook.kind]} (${webhook.hint}), set by ${webhook.by} ${timeAgo(webhook.at)}${lastSentAt ? ` · last message ${timeAgo(lastSentAt)}` : ''}.`;
  };
  paintHook();
  const saveHook = () => {
    const url = hookInput.value.trim();
    if (!url) return hookInput.focus();
    net.send({ t: 'notify.webhook', url });
    hookInput.value = '';
  };
  hookSave.addEventListener('click', saveHook);
  hookInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveHook();
  });
  hookTest.addEventListener('click', () => net.send({ t: 'notify.test' }));
  hookRemove.addEventListener('click', () => net.send({ t: 'notify.webhook', url: '' }));
  return { input: hookInput, save: hookSave, actions: hookActions, status: hookStatus, paint: paintHook };
}
