// Registers the service worker (public/sw.js) on the 3D office, /lite and /kanban, each
// through its own <script type="module" src="./pwa.ts"> (docs/configuration.md#pwa). Only in a
// production build and a secure context (https, or localhost): a browser won't run one otherwise,
// and under the vite dev server it would only get in the way.
//
// A new version waits (sw.js has no skipWaiting of its own): this shows an "update available"
// toast, and its Reload hands over to the new worker and reloads once it has taken control.
import { h } from './ui/dom';

const HOURLY = 60 * 60 * 1000;

if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

async function register(): Promise<void> {
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (err) {
    // A self-signed certificate the device doesn't trust, a private window…: the office works without it.
    console.warn('service worker not registered:', (err as Error).message);
    return;
  }
  // Only a reload the person asked for: the first install claims the page too, and that's no reason to reload.
  let asked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!asked) return;
    asked = false;
    location.reload();
  });
  const offer = (waiting: ServiceWorker) =>
    updateToast(() => {
      // Another tab already took it (or a newer one replaced it): a plain reload picks it up.
      if (waiting.state === 'activated' || waiting.state === 'redundant') return location.reload();
      asked = true;
      waiting.postMessage({ type: 'skip-waiting' });
    });
  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    next?.addEventListener('statechange', () => {
      if (next.state === 'installed' && navigator.serviceWorker.controller) offer(next);
    });
  });
  // An office tab stays open for days: look for a new version now and then.
  setInterval(() => void reg.update().catch(() => {}), HOURLY);
}

let shown: HTMLElement | undefined;

/** A toast (upstream's look, in the page's #toasts) that stays until Reload or ✕. */
function updateToast(reload: () => void): void {
  shown?.remove();
  // The toasts don't take the mouse (in the 3D office); these buttons do.
  const btn = 'pointer-events:auto;margin-left:8px';
  const el = h(
    'div.toast',
    { class: 'info', role: 'status' },
    '⬆️ Update available',
    h('button.btn.small', { type: 'button', style: btn, onclick: () => { el.remove(); reload(); } }, 'Reload'),
    h('button.btn.small', { type: 'button', style: btn, 'aria-label': 'Dismiss', title: 'Later', onclick: () => el.remove() }, '✕'),
  );
  shown = el;
  (document.getElementById('toasts') ?? document.body).append(el);
}
