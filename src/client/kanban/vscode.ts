// The 🧩 VSCode button in every worker's terminal window header (the 3D office and the 2D view, kanban
// workers and ordinary ones alike): opens the worker's folder in VS Code on the office's machine, its
// worktree, or all its repositories' worktrees in one window. The office decides what to open
// (kanban.worker.vscode); only admins get the button, and the server lets only admins ask.
//
// It's a plain header button: Esc and ✕ close the window as before. After a click the terminal gets the
// keys back (focusTerminal), so typing goes on where it was.

import type { WorkerInfo } from '../../shared/protocol';
import type { Net } from '../net';
import { h } from '../ui/dom';
import { store } from '../state';
import { kanbanApi } from './api';
import { run } from './ui';

const CSS = `
.modal.term header .kb-vscode { white-space: nowrap; }
/* A narrow window: just the 🧩 (its aria-label still says what it does). */
@media (max-width: 640px) {
  .modal.term header .kb-vscode .kb-vscode-label { display: none; }
}
`;

function css() {
  if (document.getElementById('kb-vscode-css')) return;
  const el = document.createElement('style');
  el.id = 'kb-vscode-css';
  el.textContent = CSS;
  document.head.append(el);
}

/** Puts 🧩 VSCode into the header of worker `w`'s terminal window `el`, before its ✕. */
export function mountVsCodeButton(net: Net, w: WorkerInfo, el: HTMLElement, focusTerminal?: () => void): void {
  const header = el.querySelector(':scope > header');
  if (!header) return;
  css();
  const b = h(
    'button.btn.kb-vscode',
    { type: 'button', title: 'Open this worker’s folder in VS Code on the office’s computer: its worktree, or all its repositories’ worktrees in one window', 'aria-label': 'Open in VS Code' },
    '🧩',
    h('span.kb-vscode-label', {}, ' VSCode'),
  ) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    await run(() => kanbanApi(net).request({ t: 'kanban.worker.vscode', workerId: w.id }), b, 'Opening VS Code…');
    b.blur();
    focusTerminal?.();
  });
  header.insertBefore(b, header.querySelector(':scope > .btn.close'));
  const paint = () => b.classList.toggle('hidden', !store.me.admin);
  paint();
  // The window has no close hook for us: the subscription drops itself at the first change after it's gone.
  const off = store.on('me', () => (el.isConnected ? paint() : off()));
}
