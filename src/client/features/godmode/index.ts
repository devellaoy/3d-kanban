/**
 * God mode: Ctrl+N (or Alt+N) and you fly, through walls and floors, wherever you look; again and you
 * land on whatever's under you. The flying itself is the player's (PlayerController.fly); this is the
 * key, what it gets you out of first, and the activity that lands you whenever anything else starts
 * (a car, fishing, a trip, going to a desk). Only you fly: everyone else just sees you up in the air.
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

  /** Whether you were flying last frame: landing some other way (sitting down, a car taking hold) takes the toast away too. */
  let wasFlying = false;
  ctx.ticks.add('hud', () => {
    if (wasFlying && !player.flying) said?.remove();
    wasFlying = player.flying;
  });

  /** Down you come, saying so if you asked to (otherwise something else is going on now: just the toast goes). */
  function land(asked: boolean) {
    player.setFlying(false);
    wasFlying = false;
    if (asked) say('🕊️ God mode off');
    else said?.remove();
  }

  // An activity like any other, so whatever starts or takes you somewhere lands you (stopAll, whatever
  // the reason), but a passive one: you can still use things while you fly.
  ctx.activities.add({ id: 'godmode', passive: true, active: () => player.flying, stop: () => land(false) });

  function toggle() {
    if (player.flying) return land(true);
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
