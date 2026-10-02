// The props lab, for checking a Blender-made prop by eye (Vite dev only, it isn't built:
// http://localhost:5173/lab/props.html). Each prop is built by the office's own code, so what it shows
// is what the office shows. Query params:
//   show=<name>        just that prop, close up (one of SHOW's names); without it, all of them in a row
//   view=<radians>     where the camera looks from, round the prop (0 looks from +z, the way models face;
//                      the default is three-quarters for one prop, nearly head-on for the row)
//   height=<m>         how high the camera is over the middle of the prop (default a little above)
//   dist=<m>           how far back the camera is (default: far enough to fit it)
//   t=<seconds>        steps the prop's update (if it has one) at 60 fps up to t, then draws one frame
//   floor=0            no floor, only its grid, to see what goes under it
//   seat=driver        with one car shown, look ahead from where its driver's eyes are instead
// Once it has drawn, window.__ready holds each prop's size, triangles, draw calls and material names.

import * as THREE from 'three';
import { lookFromSeed } from '../../shared/avatar';
import { isEmote } from '../../shared/emotes';
import { SEATS, type CarSeat } from '../../shared/garage';
import { DESKS } from '../../shared/layout';
import { buildCabinet } from '../features/cabinet/world';
import { offroad } from '../features/cars/offroad';
import { supercar } from '../features/cars/world';
import { buildGong } from '../features/gong/world';
import { buildJukebox } from '../features/jukebox/world';
import { Person } from '../world/character';
import { buildKitchen } from '../world/kitchen';
import { preloadModels } from '../world/models';
import { DESK_BOOKS, FLOOR_PLANTS, buildDesk, coffeeTable, deskBooks, deskMug, loungeCouch, plant, pouf } from '../world/office';
import { toon } from '../world/toon';
import { ready, stage } from './stage';

/** A prop as the lab shows it: what goes in the scene, and what moves it every frame, if anything. */
interface Shown {
  object: THREE.Object3D;
  update?: (dt: number, t: number) => void;
}

/** Every prop, built the way the office builds it. Add yours here. */
const SHOW: Record<string, () => Shown> = {
  jukebox: () => {
    const j = buildJukebox();
    j.show(true, 'Lab tune');
    return { object: j.group, update: (dt, t) => j.update(t, dt, Math.max(0, 1 - ((t * 2) % 1) * 4)) };
  },
  gong: () => {
    const g = buildGong();
    g.strike(1);
    return { object: g.group, update: (dt) => g.update(dt) };
  },
  cabinet: () => ({ object: buildCabinet().group }),
  kitchen: () => ({ object: buildKitchen().group }),
  plants: () => {
    // The floor plants at scale 1 side by side, then the desk succulent, to compare them. A param of
    // its own: plant=<species> keeps just that one.
    const object = new THREE.Group();
    const at = [0, 1.15, 2.25, 3];
    [...FLOOR_PLANTS, 'succulent' as const].forEach((species, i) => {
      if (!q.has('plant') || q.get('plant') === species) object.add(plant(species).translateX(at[i]));
    });
    return { object };
  },
  desk_props: () => {
    // The mug (in the first chair's color) and every arrangement of books side by side. desks=1 puts them
    // on real desks instead, built by buildDesk: the first desk, which has the mug, and the first three
    // with books, one of each arrangement.
    const object = new THREE.Group();
    if (q.get('desks') === '1') {
      [0, 2, 5, 8].forEach((index, i) => {
        const desk = buildDesk({ ...DESKS[index], x: i * 2.5, z: 0, rotY: 0 }, index, toon('#e8a87c'));
        desk.vacancy.visible = false;
        object.add(desk.group);
      });
    } else {
      [deskMug('#ff8a5b'), ...DESK_BOOKS.map((_, i) => deskBooks(i))].forEach((p, i) => object.add(p.translateX(i * 0.36)));
    }
    return { object };
  },
  lounge: () => {
    // The lounge's pieces side by side, as the office paints them: the sofa with its two pillows, the coffee
    // table, and a pouf in each of its colors.
    const object = new THREE.Group();
    const at = [0, 3.5, 5.3, 6.6];
    [loungeCouch(), coffeeTable(), pouf('#06d6a0'), pouf('#ffd166')].forEach((o, i) => object.add(o.translateX(at[i])));
    return { object };
  },
  chat: () => {
    // Someone saying a chat line in their speech bubble (say=<text> for another line), name tag under it;
    // doing=<text> puts a line under the name tag, emote=<id> has them emote over the bubble.
    const p = new Person('Ada', '#ef476f', lookFromSeed('ada'));
    p.setLabel('Ada', false);
    if (q.has('doing')) p.setDoing(q.get('doing')!);
    p.say(q.get('say') ?? 'Hey, the build on main is green again, can someone have a look at the PR before lunch?', 60, '#ef476f');
    const emote = q.get('emote');
    if (isEmote(emote)) p.emote(emote);
    return { object: p.root, update: (dt, t) => p.update(dt, t, false, false) };
  },
  lambo: () => ({ object: supercar('lambo', '#ffd166').root }),
  ferrari: () => ({ object: supercar('ferrari', '#ef476f').root }),
  offroad: () => ({ object: offroad('#2a9d8f').root }),
  // The 4x4 as it is with someone in it: the roof off, the seats and the windshield in.
  'offroad-in': () => {
    const m = offroad('#2a9d8f');
    m.top.visible = false;
    m.open.visible = true;
    return { object: m.root };
  },
};

const q = new URLSearchParams(location.search);
const only = q.get('show');
const names = only ? [only] : Object.keys(SHOW);
const stepTo = q.has('t') ? Number(q.get('t')) : null;
const { scene, camera, renderer, render } = stage(document.getElementById('c') as HTMLCanvasElement, q.get('floor') !== '0');

await preloadModels();
const shown = names.map((name) => {
  const make = SHOW[name];
  if (!make) throw new Error(`No prop called ${name} (there's ${Object.keys(SHOW).join(', ')})`);
  return { name, ...make() };
});

// Side by side along x, each as wide as it is plus a gap, centred front to back.
const boxes = shown.map((s) => new THREE.Box3().setFromObject(s.object));
let x = 0;
shown.forEach((s, i) => {
  const size = boxes[i].getSize(new THREE.Vector3());
  s.object.position.x += x - boxes[i].min.x;
  s.object.position.z -= (boxes[i].min.z + boxes[i].max.z) / 2;
  x += size.x + 0.8;
  scene.add(s.object);
});
const all = new THREE.Box3();
for (const s of shown) all.expandByObject(s.object);
const middle = all.getCenter(new THREE.Vector3());
const extent = all.getSize(new THREE.Vector3());

/** Round the props from `view`, far enough back to fit them all across and up. */
function aim() {
  const seat = q.get('seat') as CarSeat | null;
  if (seat && SEATS[seat] && shown.length === 1) {
    // About where a seated driver's eyes are (see player/camera.ts), looking ahead over the hood.
    const s = SEATS[seat];
    const car = shown[0].object;
    car.updateMatrixWorld(true);
    camera.fov = 55;
    camera.position.copy(car.localToWorld(new THREE.Vector3(s.x, 1.45, s.z)));
    camera.lookAt(car.localToWorld(new THREE.Vector3(s.x, 1.2, s.z + 10)));
    camera.updateProjectionMatrix();
    return;
  }
  const view = Number(q.get('view') ?? (only ? 0.6 : 0.15));
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fit = Math.max(extent.y / 2 / tan, extent.x / 2 / (tan * camera.aspect)) * 1.25 + extent.z / 2;
  const d = q.has('dist') ? Number(q.get('dist')) : fit;
  const up = q.has('height') ? Number(q.get('height')) : d * 0.25;
  camera.position.set(middle.x + Math.sin(view) * d, middle.y + up, middle.z + Math.cos(view) * d);
  camera.lookAt(middle);
  camera.updateProjectionMatrix();
}
aim();
addEventListener('resize', () => aim());

function facts() {
  const out: Record<string, unknown> = {};
  shown.forEach((s, i) => {
    const materials = new Set<string>();
    let tris = 0;
    let draws = 0;
    s.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      draws += Array.isArray(m.material) ? m.material.length : 1;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat.name || (mat as THREE.MeshToonMaterial).color?.getHexString?.() || mat.type);
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    const size = boxes[i].getSize(new THREE.Vector3());
    out[s.name] = { size: size.toArray().map((v) => +v.toFixed(3)), tris, draws, materials: [...materials] };
  });
  return out;
}

let t = 0;
const step = (dt: number) => {
  t += dt;
  for (const s of shown) s.update?.(dt, t);
};
if (stepTo !== null) {
  for (let i = 0; i < Math.round(stepTo * 60); i++) step(1 / 60);
  render();
  ready({ props: facts(), calls: renderer.info.render.calls });
} else {
  let last = performance.now();
  const frame = (now: number) => {
    step(Math.min((now - last) / 1000, 0.1));
    last = now;
    render();
    requestAnimationFrame(frame);
  };
  frame(last);
  ready({ props: facts(), calls: renderer.info.render.calls });
}
