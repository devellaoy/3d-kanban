/**
 * The cars in the garage: getting in (behind the wheel, or beside whoever's driving), driving, the
 * horn, laps of the scenic loop, and a car shoving you out of its way. Placing you anywhere gets you
 * out first: see the driver's activity, and placeAt in core/place.ts.
 */
import { CARS, carClass, driveOf, seatHips, roughAt, type CarClass, type CarKind, type CarSeat } from '../../../shared/garage';
import { PLACES, placeAt as loopPlace } from '../../../shared/scenic';
import type { Ctx, Hint } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { Driver } from './controller';
import { DriveEffects } from './effects';
import { Speedo } from './speedo';
import { DESK_KEYS } from '../../interaction';
import { LapTimer, lapTime } from './laps';
import { raceTrack } from './racing';
import { loadLapBest, saveLapBest } from './racestore';
import { store } from '../../state';
import { clip, h, toast } from '../../ui/dom';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    car: true;
  }
}

/** The icon in a car's name in the hint bar. */
const icon = (kind: CarKind) => (kind === 'offroad' ? '🚙' : '🏎️');

export interface CarsDeps {
  /** Up off whatever you're sitting on (see features/seating). */
  standUp(): void;
  /** Stops a walk over to someone, if you're on one. */
  stopWalking(): void;
}

/** Registers the office's first message router (a floor's cars snap to where they are): install it before any other `onAny`. */
export function installCars(ctx: Ctx, deps: CarsDeps) {
  const { office } = ctx;
  // Behind the wheel of one of the garage's cars.
  const driver = new Driver(ctx.player, office.cars, {
    moved: (car, p) => ctx.net.send({ t: 'car.drive', car, x: p.x, z: p.z, rotY: p.rotY, speed: p.speed, steer: p.steer }),
    bump: (at, speed) => {
      ctx.sound.crash({ x: at.x, y: ctx.player.street + 0.5, z: at.z }, speed);
      ctx.shake(Math.min(0.8, speed / 15));
    },
  });
  /** car.enter and car.leave of yours the office hasn't answered yet: until it has, you're where you say you are. */
  let carPending = 0;

  /** Where car `i` is, at about the height of its horn. */
  function carAt(i: number): { x: number; y: number; z: number } {
    const p = office.cars.cars[i]?.pose ?? CARS[i];
    return { x: p.x, y: ctx.player.street + 0.6, z: p.z };
  }

  /** E at a car: behind the wheel if nobody's driving it, else beside whoever is. */
  function getIn(i: number) {
    const c = store.cars[i];
    const def = CARS[i];
    if (ctx.trip() || driver.active || !c || !def) return;
    if (ctx.carrying()) return toast('🗂️ Your hands are full: put the card back first (Q)', 'warn');
    if (ctx.holdingBall()) return toast('🏀 Put the ball down first (Q)', 'warn');
    const seat: CarSeat | null = !c.driver ? 'driver' : !c.passenger ? 'passenger' : null;
    if (!seat) return toast(`🏎️ The ${def.name} is full`, 'warn');
    if (ctx.player.seat) deps.standUp();
    ctx.activities.stopAll('start');
    deps.stopWalking();
    driver.enter(i, seat);
    ctx.me.sit(seatHips(def.kind));
    carPending++;
    ctx.net.send({ t: 'car.enter', car: i, seat });
    ctx.sound.carDoor(carAt(i));
    ctx.hint.invalidate();
  }

  ctx.interactions.define('car', {
    reach: 4,
    hint: (it) => {
      const c = store.cars[it.car ?? -1];
      const def = CARS[it.car ?? -1];
      if (!c || !def) return { k: '', parts: [] };
      const name = (id?: string) => (id ? clip(store.peers.get(id)?.name ?? 'Someone', 20) : '');
      const [at, beside] = [name(c.driver), name(c.passenger)];
      const k = `${it.car}|${at}|${beside}`;
      if (!at) return { k, parts: [hintTitle(`${icon(def.kind)} ${def.name}`), aside(beside ? `${beside} is waiting in it` : 'keys in the ignition'), key('E', 'Drive it')] };
      if (!beside) return { k, parts: [hintTitle(`${icon(def.kind)} ${def.name}`), aside(`${at} is driving`), key('E', 'Hop in')] };
      return { k, parts: [hintTitle(`${icon(def.kind)} ${def.name}`), aside(`${at} and ${beside} · full`)] };
    },
    use: onE((it) => {
      if (it.car !== undefined) getIn(it.car);
    }),
  });

  /** E in a car: out onto your feet beside it; `anyway`, even with no room there. False if you couldn't. */
  function getOut(anyway = false): boolean {
    const i = driver.car;
    if (i === null) return true;
    if (!driver.leave(anyway)) {
      toast('🚪 No room to open the door here', 'warn');
      return false;
    }
    leftCar(i);
    return true;
  }

  /** Out of the car wherever you are: something else is moving you (to another floor, a desk). */
  function dropCar() {
    const i = driver.car;
    if (i === null) return;
    driver.drop();
    leftCar(i);
  }

  function leftCar(i: number) {
    ctx.me.sit(null);
    carPending++;
    ctx.net.send({ t: 'car.leave' });
    ctx.sound.carDoor(carAt(i));
    ctx.hint.invalidate();
  }

  ctx.activities.add({
    id: 'driver',
    active: () => driver.active,
    // Out onto your feet for a trip to another floor, or let go of where you are for a desk. Walking over
    // to someone gets you out first itself (it can't, with no room at the door), and nothing else does.
    stop: (why) => {
      if (why === 'trip') getOut(true);
      else if (why === 'desk') dropCar();
    },
    // In a car, E gets you out and H honks (W A S D and Space drive, see Driver); nothing else is in reach.
    key: (e) => {
      if (racing.key(e)) return true;
      if (e.code !== 'KeyE' && e.code !== 'KeyH' && e.code !== 'KeyF' && !(e.code in DESK_KEYS)) return false;
      if (e.repeat) return true;
      if (e.code === 'KeyE') getOut();
      else if (e.code === 'KeyH') honk();
      return true;
    },
    hint: (el) => renderDriveHint(el),
    hidesHands: true,
  });

  /** H in a car: its horn, for everyone on the floor. */
  let honkedAt = 0;
  function honk() {
    const i = driver.car;
    const now = performance.now();
    if (i === null || now - honkedAt < 300) return;
    honkedAt = now;
    ctx.sound.honk(carAt(i), CARS[i].kind);
    ctx.net.send({ t: 'car.honk' });
  }

  /** Laps of the scenic loop you've driven (see LapTimer), and your fastest in each class of car, kept in this browser (see racestore.ts). */
  const laps = new LapTimer(null);
  /** The class of car `laps.best` is for: it switches to the other class's best when you get into a car of that class. */
  let lapClass: CarClass | null = null;
  /** Races from the line, and the ghost of your best lap (see racing.ts). */
  const racing = raceTrack(ctx, { driver, laps });
  function lapDone(time: number) {
    const done = laps.done;
    if (done?.best && lapClass) saveLapBest(lapClass, time);
    if (done?.best) ctx.sound.golf('cheer');
    else ctx.sound.arcade('clear');
    toast(done?.best ? `🏁 Lap of the scenic loop: ${lapTime(time)}, your best yet!` : `🏁 Lap of the scenic loop: ${lapTime(time)} (best ${lapTime(laps.best ?? time)})`, 'info');
  }

  const fx = new DriveEffects();
  office.cars.group.add(fx.group);
  const dash = new Speedo();
  /** How much wider the view is for speed (degrees), eased. */
  const feel = { fov: 0 };
  ctx.view.add({ fov: (fov) => fov + feel.fov });

  ctx.ticks.add('vehicles', ({ dt, now }) => {
    // The cars first, so whoever's riding in one sits in it where it's got to.
    office.cars.update(dt, store.cars, store.carsAt, now, driver.active ? { car: driver.car!, driving: driver.driving } : null, ctx.camera.position);
    // Smoke, skid marks, dust and flames, and the cars leaning into corners; then the dash, and the view
    // widening and rumbling with speed (see view below).
    fx.update(dt, office.cars.cars, driver.driving ? { car: driver.car!, nitro: driver.nitroOn } : null);
    const pose = driver.driving ? driver.pose : null;
    const v = pose ? Math.hypot(pose.speed, pose.slip ?? 0) : 0;
    const fast = pose ? Math.min(1, v / driveOf(CARS[driver.car!].kind).top) ** 1.4 : 0;
    feel.fov += ((pose ? 17 * fast + (driver.nitroOn ? 9 : 0) : 0) - feel.fov) * Math.min(1, dt * 3);
    if (pose && v > 12) ctx.shake(0.012 + 0.035 * fast + (driver.nitroOn ? 0.035 : 0) + (roughAt(pose.x, pose.z) ? 0.02 * fast : 0));
    dash.show(!!pose);
    if (pose) dash.update({ kind: CARS[driver.car!].kind, speed: pose.speed, slip: pose.slip ?? 0, nitro: pose.nitro ?? 1, boost: driver.nitroOn, rough: roughAt(pose.x, pose.z) > 0 });
  });
  /** When a car last shoved you out of its way. */
  let shovedAt = 0;
  ctx.ticks.add('moved', ({ now }) => {
    // Timing a lap of the scenic loop, behind the wheel.
    if (driver.driving && driver.pose) {
      // The 4x4s and the supercars each have their own best lap.
      const cls = carClass(CARS[driver.car!].kind);
      if (cls !== lapClass) {
        lapClass = cls;
        laps.best = loadLapBest(cls);
      }
      const lap =laps.update(driver.pose.x, driver.pose.z, now / 1000);
      if (lap !== null) lapDone(lap);
      if (laps.thrownOut !== null) {
        laps.thrownOut = null;
        toast('🏁 That lap doesn’t count: you left the road a long way behind', 'warn');
      }
      racing.tick(now / 1000, lap);
    } else {
      laps.reset();
      racing.stop();
    }
    // A car coming at you where you stand: out of its way, with a thump if it was going.
    const player = ctx.player;
    if (ctx.inOffice() && !driver.active && !ctx.upTop() && !ctx.trip()) {
      const hit = office.cars.shove(player.pos, null);
      if (hit > 1.5 && now - shovedAt > 600) {
        shovedAt = now;
        ctx.sound.crash({ x: player.pos.x, y: player.pos.y + 0.8, z: player.pos.z }, hit / 2);
        ctx.shake(Math.min(0.7, hit / 12));
      }
    }
  });
  ctx.ticks.add('others', () => {
    // The engines of the cars being driven on this floor, yours (by how hard you're on the gas) and theirs.
    const engines: Parameters<typeof ctx.sound.setEngines>[0] = [];
    if (!ctx.upTop() && ctx.inOffice()) {
      for (const [i, c] of store.cars.entries()) {
        const mine = driver.car === i && driver.driving;
        if (!c.driver && !mine) continue;
        const pose = office.cars.cars[i]?.pose ?? c;
        engines.push({ car: i, kind: CARS[i].kind, at: { x: pose.x, y: ctx.player.street + 0.5, z: pose.z }, speed: Math.hypot(pose.speed, pose.slip ?? 0), gas: mine ? driver.gas : Math.min(1, Math.abs(pose.speed) / 10), boost: mine ? driver.nitroOn : fx.burning(i) });
      }
    }
    ctx.sound.setEngines(engines);
  });

  /**
   * The office said who's in which car (`answer`: answering a car.enter or car.leave of yours). Once
   * it has answered them all, where it has you is where you are: out, if someone got in first.
   */
  function carNews(answer: boolean) {
    if (answer) carPending = Math.max(0, carPending - 1);
    if (carPending > 0) return;
    const mine = store.carOf(store.you);
    if (driver.active) {
      if (mine?.car === driver.car && mine.seat === driver.seat) return;
      const who = store.cars[driver.car!]?.[driver.seat!];
      getOut(true);
      toast(`🏎️ ${(who && store.peers.get(who)?.name) || 'Someone'} got in there first`, 'warn');
    } else if (mine) {
      // You got out while it was answering something else of yours.
      carPending++;
      ctx.net.send({ t: 'car.leave' });
    }
  }

  ctx.messages.on('cars', (msg) => carNews(!!msg.answer));
  ctx.messages.on('car.honk', (msg) => {
    if (msg.car >= 0 && msg.car < CARS.length) ctx.sound.honk(carAt(msg.car), CARS[msg.car].kind);
  });
  // A floor's cars where they are before anything asks if there's room to stand beside one (see welcome):
  // right after the store has them, before any other message handler.
  ctx.messages.onAny((msg) => {
    if (msg.t === 'welcome' || msg.t === 'floor.enter') office.cars.snap(store.cars);
  });

  /** Back after a reconnect, which let go of your seat for you: back into it if it's still free. */
  function carAgain() {
    carPending = 0;
    const i = driver.car;
    const seat = driver.seat;
    if (i === null || seat === null) return;
    const c = store.cars[i];
    if (!c || c[seat]) {
      getOut(true);
      return;
    }
    carPending++;
    ctx.net.send({ t: 'car.enter', car: i, seat });
    const p = driver.driving ? driver.pose : null;
    if (p) ctx.net.send({ t: 'car.drive', car: i, x: p.x, z: p.z, rotY: p.rotY, speed: p.speed, steer: p.steer });
  }

  /** Where someone on your floor is sitting in a car, if they're in one. */
  function rideOf(id: string): { x: number; y: number; z: number; rotY: number } | undefined {
    const at = store.carOf(id);
    return at && office.cars.seatAt(at.car, at.seat);
  }

  /** In a car: how fast, who with, and the keys. */
  function renderDriveHint(el: HTMLElement) {
    const i = driver.car!;
    const c = store.cars[i];
    const name = (id?: string) => (id && id !== store.you ? (store.peers.get(id)?.name ?? '') : '');
    let hint: Hint;
    // Where you are on the scenic loop, and how the lap's going.
    const pose = office.cars.cars[i]?.pose;
    const place = pose ? loopPlace(pose.x, pose.z) : null;
    const where = place ? ` · ${PLACES[place].icon} ${PLACES[place].name}` : '';
    if (driver.driving) {
      const other = name(c?.passenger);
      const now = performance.now() / 1000;
      const done = laps.done && now - laps.done.at < 6 ? laps.done : null;
      const running = laps.running(now);
      const lap = (done ? ` · 🏁 ${lapTime(done.time)}${done.best ? ' best!' : ''}` : running !== null ? ` · ⏱ ${lapTime(running)}` : '') + racing.status(now);
      hint = {
        k: `drive|${other}|${where}|${lap}`,
        parts: [h('span.title', {}, `${icon(CARS[i].kind)} ${CARS[i].name}`), aside(`${where}${lap}${other ? ` · with ${clip(other, 20)}` : ''}`.replace(/^ · /, '')), key('W A S D', 'Drive'), key('Shift', 'Nitro'), key('Space', 'Handbrake'), key('H', 'Honk'), ...racing.keys(), key('E', 'Get out')],
      };
    } else {
      const at = name(c?.driver);
      hint = { k: `ride|${at}|${where}`, parts: [h('span.title', {}, `${icon(CARS[i].kind)} ${CARS[i].name}`), aside(`${at ? `${clip(at, 24)} is driving` : 'nobody at the wheel'}${where}`), key('H', 'Honk'), key('E', 'Get out')] };
    }
    ctx.hint.draw(el, `car|${hint.k}`, () => hint.parts);
  }

  return { driver, getIn, getOut, carAgain, rideOf };
}
