// The reviewer's spot behind a seat in the 3D office (client/kanban/watch3d.ts): it stands behind the
// seat on the seat's own frame, and shows even while the seat is put away (a bean bag nobody sits on:
// its implementer went home, and the next review round still stands behind it).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { seatView } from '../src/client/kanban/watch3d';
import type { DeskView } from '../src/client/world/office';
import type { World } from '../src/client/world/world';
import { BEANBAGS, DESKS, watchSpotOf } from '../src/shared/layout';
import { OFFICE_PLAN } from '../src/shared/maps/index';

/** A seat's view as the office builds one (see buildBeanbag / buildDesk): its group, anchors and chair. */
function seat(def: DeskView['def'], chairZ: number, laptopZ: number): DeskView {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, 0.45, laptopZ);
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.32, chairZ);
  seatAnchor.rotation.y = Math.PI;
  group.add(laptopAnchor, seatAnchor, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  return { def, group, laptopAnchor, seatAnchor, stage: new THREE.Object3D(), chair: new THREE.Group(), vacancy: new THREE.Group(), vacancyY: 1 };
}

function officeWith(...views: DeskView[]) {
  const root = new THREE.Group();
  const desks = new Map<string, DeskView>();
  for (const v of views) {
    root.add(v.group);
    desks.set(v.def.id, v);
  }
  return { root, world: { plan: OFFICE_PLAN, desks } as unknown as World };
}

/** Whether `o` shows: it and every one of its parents visible. */
function shows(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

test("a reviewer behind a bean bag that's put away still shows, and can be aimed at", () => {
  const bag = seat(BEANBAGS[0], 0.04, -0.8);
  bag.group.visible = false; // nobody on it: put away (Office.setBeanbags)
  const { root, world } = officeWith(bag);
  const spot = seatView(world, watchSpotOf(bag.def.id));
  assert.ok(spot, 'a view for the spot behind it');
  assert.equal(world.desks.get(watchSpotOf(bag.def.id)), spot, 'kept with the seats');
  assert.equal(seatView(world, watchSpotOf(bag.def.id)), spot, 'made once');
  const reviewer = new THREE.Group();
  spot.seatAnchor.add(reviewer);
  assert.ok(shows(reviewer), 'the reviewer shows');
  // Aimed at, the ray's hit finds the spot's own interactable, not the bean bag's.
  reviewer.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.5)));
  root.updateMatrixWorld(true);
  let it: unknown;
  for (let o: THREE.Object3D | null = reviewer; o; o = o.parent) it ??= o.userData.interact;
  assert.equal((it as { deskId?: string })?.deskId, watchSpotOf(bag.def.id));
  // Out again, and put away again: the spot doesn't follow either way.
  bag.group.visible = true;
  assert.ok(shows(reviewer));
});

test('the spot is behind the chair, in the seat’s frame, turned toward its screen', () => {
  for (const def of [DESKS[0], DESKS[2], BEANBAGS[6]]) {
    const view = seat(def, 0.93, -0.06);
    const { root, world } = officeWith(view);
    const spot = seatView(world, watchSpotOf(def.id))!;
    root.updateMatrixWorld(true);
    const at = spot.seatAnchor.getWorldPosition(new THREE.Vector3());
    const chair = view.seatAnchor.getWorldPosition(new THREE.Vector3());
    const screen = view.laptopAnchor.getWorldPosition(new THREE.Vector3());
    assert.ok(at.distanceTo(screen) > chair.distanceTo(screen), `${def.id}: further from the screen than the chair`);
    assert.ok(at.distanceTo(chair) < 1, `${def.id}: right behind the chair`);
    // It looks along +z of its anchor (as a seated worker does): toward the screen.
    const ahead = new THREE.Vector3(0, 0, 1).applyQuaternion(spot.seatAnchor.getWorldQuaternion(new THREE.Quaternion()));
    const toScreen = screen.clone().sub(at).setY(0).normalize();
    assert.ok(ahead.setY(0).normalize().dot(toScreen) > 0.95, `${def.id}: facing the screen`);
  }
});

test('a seat the map has, or no view for an id that is neither', () => {
  const desk = seat(DESKS[0], 0.93, -0.06);
  const { world } = officeWith(desk);
  assert.equal(seatView(world, DESKS[0].id), desk);
  assert.equal(seatView(world, 'nowhere'), undefined);
  assert.equal(seatView(world, watchSpotOf(DESKS[1].id)), undefined, "no view behind a seat the map didn't build");
});
