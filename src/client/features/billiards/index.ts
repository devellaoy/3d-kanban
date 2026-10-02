/**
 * Billiards on the table in the game room (down in the garage): E at it steps up to the cue ball and
 * takes the shot (aim with the mouse, hold Space or the mouse button for power, let go to shoot), with
 * practice or two players taking turns, and the fewest shots you've cleared a rack in kept in this browser.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { toast } from '../../ui/dom';
import { BilliardsPlay } from './controller';
import { loadRecord, saveRecord } from './storage';
import { findTable } from './world';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    billiards: true;
  }
}

export interface BilliardsDeps {
  /** Up off whatever you're sitting on (see features/seating). */
  standUp(): void;
  /** Stops a walk over to someone, if you're on one. */
  stopWalking(): void;
  /** Puts your cigarette out, if you're on a smoke break (see features/smoke). */
  stopSmoking(): void;
}

export function installBilliards(ctx: Ctx, deps: BilliardsDeps) {
  const record = loadRecord();
  const play = new BilliardsPlay(ctx.player, ctx.camera, {
    sound: (kind, at, speed) => ctx.sound.billiards(kind, at, speed),
    say: (text) => void toast(text),
    cleared: (shots) => {
      if (record.best === null || shots < record.best) {
        record.best = shots;
        saveRecord(record);
        toast(`🏆 Table cleared in ${shots} shots, your best yet!`);
      } else toast(`🏆 Table cleared in ${shots} shots`);
    },
    mode: (mode) => {
      record.mode = mode;
      saveRecord(record);
      ctx.hint.invalidate();
    },
    done: () => ctx.hint.invalidate(),
    best: () => record.best,
    street: () => ctx.player.street,
  });

  ctx.activities.add({
    id: 'billiards',
    active: () => play.running,
    stop: () => play.leave(),
    // At the table E and Esc leave it (Esc puts you straight back in mouse-look); the keys of the table are its own.
    key: (e) => {
      if (e.code === 'Escape' || e.code === 'KeyE') {
        play.leave(e.code === 'Escape');
        return true;
      }
      if (e.code === 'KeyR') play.rerack();
      else if (e.code === 'KeyP') play.switchMode();
      // No emotes or desk keys at the table; walking is the table's (see BilliardsPlay).
      else if (!/^(?:Key[WASD]|Arrow\w+|Space|Shift\w+|Digit\d|Numpad\d|Key[FG])$/.test(e.code)) return false;
      return true;
    },
    hint: (el) => renderHint(el),
    takesCamera: true,
    // Your hands are on the cue, out of sight in first person.
    hidesHands: true,
    // Both hands are on the cue: no mug in them.
    bothHands: true,
  });
  ctx.ticks.add('play', ({ dt }) => {
    // Pulled away from the table (sat down, off up the ladder, into the elevator, a different floor): the cue goes back.
    if (play.running && (ctx.trip() || ctx.activities.running('hanger') || ctx.activities.running('climber') || ctx.player.seat || ctx.upTop())) play.leave();
    play.update(dt);
  });

  /** E at the table: step up to the cue ball. */
  function startPlaying() {
    if (play.running || ctx.trip() || ctx.activities.running('climber')) return;
    const view = findTable(ctx.office.group);
    if (!view) return;
    const carrying = ctx.carrying();
    if (carrying) return void toast('✋ Your hands are full: put the card down first (Q)', 'warn');
    if (ctx.player.seat) deps.standUp();
    ctx.activities.stopAll('start');
    deps.stopWalking();
    deps.stopSmoking();
    play.start(view, record.mode);
    ctx.hint.invalidate();
  }

  ctx.interactions.define('billiards', {
    reach: 3.5,
    hint: () => {
      const about = record.best !== null ? `your best clear: ${record.best} shots` : 'practice, or two players';
      return { k: `table|${about}`, parts: [hintTitle('🎱 Billiards table'), aside(about), key('E', 'Play')] };
    },
    use: onE(() => startPlaying()),
  });

  /** At the table: how to aim and shoot, or what to do with the cue ball in hand. */
  function renderHint(el: HTMLElement) {
    const stage = play.stage;
    const mode = play.game.mode === 'practice' ? 'Two players' : 'Practice';
    ctx.hint.draw(el, `billiards|${stage}|${mode}`, () =>
      stage === 'inhand'
        ? [hintTitle('🎱 Cue ball in hand'), key('W A S D', 'Slide it'), key('Space', 'Put it down'), key('E', 'Leave')]
        : stage === 'watch'
          ? [hintTitle('🎱 Watch the balls'), key('R', 'Rack'), key('E', 'Leave')]
          : stage === 'charge'
            ? [hintTitle('🎱 Let go to shoot'), aside('the longer you hold, the harder')]
            : [key('Space', 'Hold to shoot'), key('Mouse / A D', 'Aim (Shift: fine)'), key('R', 'Rack'), key('P', mode), key('E / Esc', 'Leave')],
    );
  }

  return { play };
}
