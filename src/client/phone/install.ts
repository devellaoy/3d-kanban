// The phone (phone/ui.ts) in the 3D office: Y and ☰ → 📲 Phone open it. One install line in main.ts
// (Parts.phone). While it's open the office's keys are off (a window is), so the phone listens for its
// own: Y puts it away, the arrows move down its list, ← or Backspace go back.
import type { Ctx } from '../core/context';
import type { Parts } from '../core/parts';
import { promptTaskWorker } from '../kanban/office3d';
import { isTyping } from '../player';
import { saveSettings } from '../state';
import { findWorker } from '../state/workers';
import { openPrompt } from '../ui/prompt';
import { openPhone, type OpenPhone, type PhoneTab } from './ui';
import { installPhoneMusic } from './music';
import { installMusicChip } from './music-chip';
import type { MusicTabDeps } from './music-ui';
import { phoneWatch } from './watch';

export type PhoneParts = Pick<Parts, 'waiting' | 'settings' | 'youtube'>;

export function installPhone(ctx: Ctx, parts: PhoneParts) {
  const { net } = ctx;
  const watch = phoneWatch(net);
  /** The phone's music: its player, and starting, controlling and leaving a session (for the Music tab). */
  const music = installPhoneMusic(ctx, parts);
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

  const musicTab: MusicTabDeps = {
    net,
    music,
    settings: () => parts.settings,
    setVolume(level) {
      const s = parts.settings;
      s.music = Math.max(0, Math.min(1, level));
      saveSettings(s);
      ctx.sound.setMusicVolume(s.music, s.musicMuted);
    },
    tvControls: () => parts.youtube.controlsSource(),
    openTv() {
      close();
      parts.youtube.watch();
    },
  };

  function open(tab?: PhoneTab) {
    if (phone) return;
    phone = openPhone({ watch, openWorker, promptWorker, music: musicTab }, () => {
      phone = null;
      chip.render();
    }, tab);
    chip.render();
  }
  const close = () => phone?.modal.close();
  const isOpen = () => !!phone;
  const chip = installMusicChip({ music, phoneOpen: isOpen, openMusic: () => open('music') });

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

  return { open, close, toggle: () => (phone ? close() : open()), isOpen, music };
}
