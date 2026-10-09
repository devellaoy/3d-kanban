/**
 * God mode: Ctrl+N (or Alt+N) and you fly, through walls and floors, wherever you look; again and you
 * land on whatever's under you. The flying itself is the player's (PlayerController.fly); this is the
 * key and what it gets you out of first. Only you fly: everyone else just sees you up in the air.
 */
import type { Ctx } from '../../core/context';
import { isTyping } from '../../player';
import { modalOpen, toast } from '../../ui/dom';
import { isGodModeKey } from './key';

export interface GodModeDeps {
  /** Up off whatever you're sitting on (see features/seating). */
  standUp(): void;
  /** Stops a walk over to someone, if you're on one. */
  stopWalking(): void;
}

/** Listens for Ctrl+N / Alt+N on the window, outside text boxes and windows. */
export function installGodMode(ctx: Ctx, deps: GodModeDeps) {
  const { player } = ctx;
  /** What the last toggle said, which the next replaces. */
  let said: HTMLElement | null = null;

  function say(text: string, level: 'info' | 'warn' = 'info') {
    said?.remove();
    said = toast(text, level);
  }

  function toggle() {
    if (player.flying) {
      player.setFlying(false);
      return say('🕊️ God mode off');
    }
    // A car, the tee, the billiards table: they have hold of you.
    if (player.rig) return say('🕊️ No flying from here: get out first', 'warn');
    ctx.activities.stopAll('start');
    deps.stopWalking();
    if (player.seat) deps.standUp();
    player.setFlying(true);
    ctx.hint.invalidate();
    say('🕊️ God mode: W A S D fly where you look, Space goes up, Shift faster. Ctrl+N or Alt+N again to land');
  }

  // Not through the key chain: its guard turns away every Ctrl and Alt key (see input/keyboard.ts).
  window.addEventListener('keydown', (e) => {
    if (!isGodModeKey(e) || isTyping(e) || modalOpen() || ctx.trip()) return;
    e.preventDefault();
    if (!e.repeat) toggle();
  });
}
