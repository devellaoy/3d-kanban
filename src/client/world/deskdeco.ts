import * as THREE from 'three';
import { DESKS, DESK_SIZE } from '../../shared/layout';
import type { Office } from './types';

// The holiday's decorations on the desks (jack-o'-lanterns, presents). Each hangs on its own desk's
// group, in the desk's frame, so it goes where the desk goes when build mode moves it, and is gone
// with it when it's taken out (see shared/arrange.ts). Holiday (holiday.ts) makes the parts.

/** What Holiday gives to dress a desk. */
export interface DeskParts {
  /** A jack-o'-lantern standing at the origin, `r` big, and its candlelight (a glow at the face, in the same frame). */
  pumpkin(r: number): { group: THREE.Object3D; glows: THREE.Points[] };
  /** A present, by the number of the desk (its wrapping). */
  present(i: number): THREE.Object3D;
}

/** The decorations of every desk: one group each for Halloween and for Christmas, shown for their holiday. */
export interface DeskDeco {
  halloween: THREE.Object3D[];
  christmas: THREE.Object3D[];
  glows: THREE.Points[];
}

/** Where on a desk's top the decoration stands: the back corner its own knick-knack leaves free (see buildDesk), facing whoever sits there. */
const spotOf = (i: number): [number, number] => [i % 3 === 1 ? 0.78 : -0.78, -0.28];

/** Hangs a pumpkin and a present on every desk of `office`, hidden until their holiday comes. */
export function hangDeskDeco(office: Office, parts: DeskParts): DeskDeco {
  const out: DeskDeco = { halloween: [], christmas: [], glows: [] };
  DESKS.forEach((d, i) => {
    const view = office.desks.get(d.id);
    if (!view) return;
    const [x, z] = spotOf(i);
    const make = (group: THREE.Object3D, rotY = 0) => {
      group.position.set(x, DESK_SIZE.height, z);
      group.rotation.y = rotY;
      group.visible = false;
      view.group.add(group);
      return group;
    };
    const p = parts.pumpkin(0.12);
    out.halloween.push(make(p.group));
    out.glows.push(...p.glows);
    out.christmas.push(make(parts.present(i), 0.3));
  });
  return out;
}
