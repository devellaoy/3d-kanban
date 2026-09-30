// A task's reviewer in the 3D office: it takes no desk of its own but stands behind its implementer's
// chair, over the shoulder, looking at the implementer's screen (the server hires it at the seat's
// watch spot, `watch-<seat id>`, see WATCH_SPOTS in shared/layout.ts). No map builds a view for those
// spots: the first time a worker is there, one is made here beside the watched seat's own view, placed
// and turned as that seat is (so it's where the seat is on whichever map), and kept in `world.desks`
// like any other seat, so everything that looks a worker's seat up there finds it. It isn't inside the
// seat's view: a bean bag nobody sits on is put away (hidden), and the reviewer behind it must still show.

import * as THREE from 'three';
import type { DeskView, Interactable } from '../world/office';
import type { World } from '../world/world';

/** How far to the side of the chair (to its right, seen from the chair) and back from it the reviewer stands. */
const SIDE = 0.55;
const BACK = 0.62;
/** Standing, a little bigger than a worker sunk into its chair (as a board agent standing at its kiosk). */
const SCALE = 1.1;
/** Its feet are a touch below the anchor (as at a kiosk). */
const FEET = -0.07;

/** The seat view for `deskId` on `world`: its own when the map has one, else, for a watch spot, one made (and kept) now. */
export function seatView(world: World, deskId: string): DeskView | undefined {
  const known = world.desks.get(deskId);
  if (known) return known;
  const def = world.plan.byId.get(deskId);
  const seat = def?.watch ? world.desks.get(def.watch) : undefined;
  if (!def || !seat) return undefined;
  const view = watchView(seat, def);
  world.desks.set(deskId, view);
  return view;
}

/** The spot behind `seat`'s chair, in the seat's own frame (its chair on +z, its desk toward -z). */
function watchView(seat: DeskView, def: DeskView['def']): DeskView {
  // In the seat's frame, but not in its group, so it shows whether or not the seat does.
  const group = new THREE.Group();
  group.position.copy(seat.group.position);
  group.quaternion.copy(seat.group.quaternion);
  group.scale.copy(seat.group.scale);
  (seat.group.parent ?? seat.group).add(group);
  const chair = seat.seatAnchor.position;
  const x = chair.x + SIDE;
  const z = chair.z + BACK;
  // Turned toward the screen on the desk (the seat's laptop), leaning in over the shoulder.
  const screen = seat.laptopAnchor.position;
  const yaw = Math.atan2(screen.x - x, screen.z - z);

  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(x, FEET * SCALE, z);
  seatAnchor.rotation.y = yaw;
  seatAnchor.scale.setScalar(SCALE);
  group.add(seatAnchor);

  // No laptop of its own: it reads the implementer's. The anchor is where its status globe floats from
  // (main.ts puts it beside the laptop's), up at its shoulder.
  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(x, 0.55, z);
  laptopAnchor.rotation.y = yaw + Math.PI;
  laptopAnchor.visible = false;
  group.add(laptopAnchor);

  // A merged pull request: it dances where it stands.
  const stage = new THREE.Object3D();
  stage.position.set(x, 0, z);
  stage.rotation.y = yaw + Math.PI;
  group.add(stage);

  // Aimed at, it's the reviewer's (E opens its terminal), not the implementer's desk it stands at.
  group.updateWorldMatrix(true, false);
  const at = group.localToWorld(new THREE.Vector3(x, 0, z));
  const it: Interactable = { kind: 'desk', deskId: def.id, x: at.x, z: at.z, radius: 0.8 };
  group.userData.interact = it;

  // Nothing in it: a free spot shows no '+', since nobody but a reviewer is ever hired here.
  const vacancy = new THREE.Group();
  group.add(vacancy);

  return { def, group, laptopAnchor, seatAnchor, stage, chair: new THREE.Group(), vacancy, vacancyY: 0 };
}
