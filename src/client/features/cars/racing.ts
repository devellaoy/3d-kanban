import { CARS } from '../../../shared/garage';
import { ROAD, STREET_Y } from '../../../shared/layout';
import type { Ctx } from '../../core/context';
import { key } from '../../core/hint';
import { h, toast } from '../../ui/dom';
import type { Driver } from './controller';
import { GhostCar } from './ghostcar';
import { GhostRecorder, ghostDone, poseAt, type GhostPath } from './ghost';
import { lapTime, type LapTimer } from './laps';
import { Race, atLine, LIGHTS, JUMP_PENALTY, JUMP_SPEED, type RaceEvent } from './race';
import { addResult } from './records';
import { loadGhost, loadGhostOn, loadResults, saveGhost, saveGhostOn, saveResults } from './racestore';
import { openResults } from './results';
import { startLights } from './startlights';

// Racing, on top of the lap timer: Z at the line starts the lights, the race is three timed laps, and
// your best lap is replayed as a ghost car on the next ones. The keys: Z race (or call it off), Y the
// ghost on or off, U the records. Everything it remembers is in racestore.ts.

export interface RacingDeps {
  driver: Driver;
  laps: LapTimer;
}

export function raceTrack(ctx: Ctx, deps: RacingDeps) {
  const { driver, laps } = deps;
  const fleet = ctx.office.cars;

  // The lights over the line, down on the street with the cars.
  const lights = startLights();
  lights.group.position.y = STREET_Y;
  fleet.group.add(lights.group);

  const race = new Race();
  let results = loadResults();
  let ghost: GhostPath | null = loadGhost();
  let ghostOn = loadGhostOn();
  /** The ghost that's racing you on this lap (the best one as the lap began), and which car it's drawn as. */
  let playing: GhostPath | null = null;
  let ghostCar: GhostCar | null = null;
  const recorder = new GhostRecorder();
  let seen = laps.crossings;
  let clock = 0;
  let greenUntil = 0;

  // The five lights on screen too, since the gantry is behind you as you wait at it.
  const dots = Array.from({ length: LIGHTS }, () => h('span.rl-dot'));
  const say = h('div.rl-say');
  const board = h('div.race-lights', { hidden: true }, h('div.rl-row', {}, ...dots), say);
  document.body.append(board);

  function paint(n: number, text = '', go = false) {
    dots.forEach((d, i) => d.classList.toggle('on', i < n));
    say.textContent = text;
    board.classList.toggle('go', go);
    lights.show(n, go);
  }

  function hide() {
    board.hidden = true;
    paint(0);
  }

  function show() {
    board.hidden = false;
  }

  function react(events: RaceEvent[], now: number) {
    for (const e of events) {
      if (e.t === 'light') {
        show();
        paint(e.n, race.jumped ? `Jump start! +${JUMP_PENALTY}s` : '');
        ctx.sound.arcade('land');
      } else if (e.t === 'jump') {
        show();
        say.textContent = `Jump start! +${JUMP_PENALTY}s`;
        ctx.sound.arcade('over');
        toast(`🚦 Jump start: +${JUMP_PENALTY}s on your total`, 'warn');
      } else if (e.t === 'go') {
        paint(0, 'GO!', true);
        greenUntil = now + 1.6;
        laps.begin(now);
        ctx.sound.arcade('clear');
      } else if (e.t === 'lap') {
        toast(`🏁 Race lap ${e.n}/${race.total}: ${lapTime(e.time)}${e.best ? ' (fastest lap yet!)' : ''}`, 'info');
      } else if (e.t === 'finish') {
        const r = addResult(results, e.result);
        results = r.list;
        saveResults(results);
        ctx.sound.golf('cheer');
        const pen = e.result.penalty ? ` (incl. +${e.result.penalty}s jump start)` : '';
        toast(`🏆 Race done in ${lapTime(e.result.total)}${pen}${r.record ? ' — a new record!' : ''}`, 'info');
        hide();
      } else if (e.t === 'abort') {
        hide();
        toast('🚦 Race called off', 'info');
      }
    }
  }

  /** A lap of the loop is done (from the line to the line, every checkpoint): the ghost keeps it if it's the best. */
  function lapRecorded(now: number, pose: { x: number; z: number; rotY: number }) {
    const path = recorder.finish(now, pose);
    if (path && (!ghost || path.time < ghost.time)) {
      ghost = path;
      saveGhost(path);
    }
  }

  function kind() {
    return CARS[driver.car ?? 0].kind;
  }

  function showGhost(now: number) {
    const want = ghostOn && playing && laps.crossed !== null && driver.driving;
    const t = laps.crossed === null ? 0 : now - laps.crossed;
    if (!want || !playing || ghostDone(playing, t - 1)) {
      ghostCar?.place(null);
      return;
    }
    if (!ghostCar || ghostCar.kind !== kind()) {
      ghostCar?.dispose();
      ghostCar = new GhostCar(kind(), STREET_Y);
      fleet.group.add(ghostCar.root);
    }
    ghostCar.place(poseAt(playing, t));
  }

  /** Each frame in the car (or out of it: `lap` is what the lap timer made of this frame). */
  function tick(now: number, lap: number | null) {
    clock = now;
    const pose = driver.pose;
    if (!driver.driving || !pose) {
      stop();
      return;
    }
    // The ghost's lap runs from the line to the line.
    if (laps.crossings !== seen) {
      seen = laps.crossings;
      if (lap !== null) lapRecorded(now, pose);
      recorder.begin(now);
      playing = ghost;
    }
    recorder.sample(now, pose);
    if (race.phase === 'countdown') react(race.update(now, pose), now);
    if (lap !== null) react(race.lapDone(lap, laps.done?.best ?? false), now);
    if (race.phase === 'racing' && now > greenUntil && board.classList.contains('go')) hide();
    showGhost(now);
  }

  /** Out of the car (or somewhere else): the race is off, the lap doesn't count and the ghost is gone. */
  function stop() {
    if (race.running) react(race.abort(), clock);
    recorder.cancel();
    playing = null;
    seen = laps.crossings;
    ghostCar?.place(null);
  }

  function startRace() {
    const pose = driver.pose;
    if (!driver.driving || !pose) return;
    if (race.running) return react(race.abort(), clock);
    if (!atLine(pose.x, pose.z, ROAD)) return toast('🏁 Drive up to the start line on the street first (Z there)', 'warn');
    if (Math.abs(pose.speed) > JUMP_SPEED) return toast('🚦 Stop at the line first', 'warn');
    laps.reset();
    seen = laps.crossings;
    race.start(clock, pose);
    show();
    paint(0, `${race.total} laps: wait for the lights to go out`);
    toast(`🚦 ${race.total}-lap race: don't move till the lights go out`, 'info');
  }

  function toggleGhost() {
    ghostOn = !ghostOn;
    saveGhostOn(ghostOn);
    toast(ghostOn ? (ghost ? `👻 Ghost on: your best lap, ${lapTime(ghost.time)}` : '👻 Ghost on: drive a lap to leave one') : '👻 Ghost off', 'info');
  }

  function records() {
    openResults({
      results,
      bestLap: laps.best,
      ghostTime: ghost?.time ?? null,
      ghostOn,
      onGhost: (on) => {
        ghostOn = on;
        saveGhostOn(on);
      },
    });
  }

  return {
    tick,
    stop,
    /** The race keys in a car (true if it was one). */
    key(e: KeyboardEvent): boolean {
      if (e.code !== 'KeyZ' && e.code !== 'KeyY' && e.code !== 'KeyU') return false;
      if (e.repeat) return true;
      if (e.code === 'KeyZ') startRace();
      else if (e.code === 'KeyY') toggleGhost();
      else records();
      return true;
    },
    /** What the drive hint says of the race (blank when there's none going), and its keys. */
    status(now: number): string {
      if (race.phase === 'countdown') return ` · 🚦 ${'🔴'.repeat(race.lights)}`;
      const t = race.elapsed(now);
      return t !== null ? ` · 🏁 ${race.laps.length + 1}/${race.total} ${lapTime(t)}${race.jumped ? ' (+5s)' : ''}` : '';
    },
    keys: () => [key('Z', race.running ? 'Stop the race' : 'Race'), key('Y', ghostOn ? 'Ghost off' : 'Ghost on'), key('U', 'Records')],
  };
}
