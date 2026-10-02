import * as THREE from 'three';
import type { CarKind } from '../../../shared/garage';
import { toon } from '../../world/toon';
import { offroad } from './offroad';
import { supercar } from './supercar';
import type { CarModel } from './world';

// The garage has eleven cars but only three shapes. Each kind's geometry is built once, with a paint
// of a color nothing else uses, and every car of the kind is a clone of it that shares the geometry
// (so the GPU holds one copy of each part, not eleven) and takes its own color for the paint.

/** The color the shared model is painted in while it's built: no other part of any car is this. */
const SENTINEL = '#fe00ef';

type Part = 'tilt' | 'top' | 'open' | `wheel${number}` | `rear${number}`;

interface Template {
  model: CarModel;
  paint: THREE.Material;
}

const templates = new Map<CarKind, Template>();

function build(kind: CarKind): Template {
  const model = kind === 'offroad' ? offroad(SENTINEL) : supercar(kind, SENTINEL);
  const tag = (o: THREE.Object3D, part: Part) => {
    o.userData.part = part;
  };
  tag(model.tilt, 'tilt');
  tag(model.top, 'top');
  tag(model.open, 'open');
  model.wheels.forEach((w, i) => tag(w, `wheel${i}`));
  model.rear?.forEach((w, i) => tag(w, `rear${i}`));
  return { model, paint: toon(SENTINEL) };
}

/** A new car of `kind` painted `color`, sharing its parts' geometry with every other car of the kind. */
export function carOf(kind: CarKind, color: string): CarModel {
  let t = templates.get(kind);
  if (!t) templates.set(kind, (t = build(kind)));
  const root = t.model.root.clone(true);
  const paint = toon(color);
  const found = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    // Clones share the template's geometry and materials; only the paint is swapped for this car's.
    if (m.isMesh && m.material === t!.paint) m.material = paint;
    if (typeof o.userData.part === 'string') found.set(o.userData.part, o);
  });
  const all = (prefix: 'wheel' | 'rear', n: number) => Array.from({ length: n }, (_, i) => found.get(`${prefix}${i}`)!);
  return {
    root: root as THREE.Group,
    tilt: found.get('tilt') as THREE.Group,
    top: found.get('top')!,
    open: found.get('open')!,
    wheels: all('wheel', t.model.wheels.length),
    rear: t.model.rear ? all('rear', t.model.rear.length) : undefined,
  };
}
