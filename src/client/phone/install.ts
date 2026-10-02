// The phone (phone/ui.ts) in the 3D office: Y and ☰ → 📲 Phone open it. One install line in main.ts
// (Parts.phone). While it's open the office's keys are off (a window is), so the phone listens for its
// own: Y puts it away, the arrows move down its list, ← or Backspace go back.
import type { Ctx } from '../core/context';
import type { Parts } from '../core/parts';
import { promptTaskWorker } from '../kanban/office3d';
import { isTyping } from '../player';
import { findWorker } from '../state/workers';
import { openPrompt } from '../ui/prompt';
import { openPhone, type OpenPhone } from './ui';
import { phoneWatch } from './watch';

export type PhoneParts = Pick<Parts, 'waiting'>;

export function installPhone(ctx: Ctx, parts: PhoneParts) {
  const { net } = ctx;
  const watch = phoneWatch(net);
  let phone: OpenPhone | null = null;

  const openWorker = (id: string) => parts.waiting.openWorkerTerminal(id);

  /** ✍️ on a card: a message on a task worker's task, else a prompt typed in, as the 2D view does. */
  function promptWorker(id: string) {
    const w = findWorker(id);
    if (!w) return;
    if (promptTaskWorker(net, w, () => openWorker(id))) return;
    openPrompt({
      title: `✍️ Prompt ${w.name}`,
      subtitle: w.status === 'working' ? `${w.name} is busy, so this waits in its input box until it's done.` : undefined,
      placeholder: w.kind === 'shell' ? 'npm run dev' : 'What should it do next?',
      submitLabel: 'Send',
      onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: id, prompt: text }),
    });
  }

  function open() {
    if (phone) return;
    phone = openPhone({ watch, openWorker, promptWorker }, () => (phone = null));
  }
  const close = () => phone?.modal.close();
  const isOpen = () => !!phone;

  ctx.keys.bind({ code: 'KeyY', repeat: false, run: () => open() });

  // The phone's own keys, before the office's (which a window turns off), and only while it's on top.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!phone || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const root = document.getElementById('modal-root');
      if (root?.lastElementChild !== phone.modal.backdrop) return;
      let took = true;
      if (e.code === 'KeyY') {
        if (!e.repeat) close();
      } else if (e.key === 'ArrowDown') phone.step(1);
      else if (e.key === 'ArrowUp') phone.step(-1);
      else if (e.key === 'ArrowLeft' || e.key === 'Backspace') took = phone.back();
      else took = false;
      if (!took) return;
      // Not on to the office's keys, where the Y that closed it would open it again.
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  return { open, close, toggle: () => (phone ? close() : open()), isOpen };
}
