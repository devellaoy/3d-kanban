import * as THREE from 'three';
import type { Interactable } from '../../world/types';
import { mesh, textSprite, toon } from '../../world/toon';
import { SPOTS, type Spot } from './spots';

// What there is to see of fishing: a signpost at each spot (the thing you press E at), and your rod, line
// and bobber. It all hangs off one group that sits at the street's height (the street drops as floors
// stack, so the group follows it: see FishingWorld.setStreet), and what's in it is in meters above the
// street, like spots.ts.

const ROD_LENGTH = 2.3;
const LINE_POINTS = 18;

export class FishingWorld {
  readonly group = new THREE.Group();
  /** The spots' signposts, one each. */
  readonly interactables: Interactable[] = [];
  readonly spotOf = new Map<Interactable, Spot>();
  /** Everything of the rig, shown only while you fish. */
  private readonly rig = new THREE.Group();
  private readonly rod: THREE.Group;
  private readonly line: THREE.Line;
  private readonly bobber: THREE.Group;
  private readonly ripple: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly bang: THREE.Sprite;
  private rippleAt = -10;
  private readonly tip = new THREE.Vector3();

  constructor() {
    this.group.name = 'fishing';
    for (const spot of SPOTS) this.addPost(spot);

    this.rod = new THREE.Group();
    const geo = new THREE.CylinderGeometry(0.012, 0.03, ROD_LENGTH, 6);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, ROD_LENGTH / 2);
    this.rod.add(mesh(geo, toon('#6b4226'), 0, 0, 0, false));
    const grip = new THREE.CylinderGeometry(0.04, 0.04, 0.32, 8);
    grip.rotateX(Math.PI / 2);
    grip.translate(0, 0, 0.1);
    this.rod.add(mesh(grip, toon('#2b2d42'), 0, 0, 0, false));
    this.rod.add(mesh(new THREE.SphereGeometry(0.05, 8, 6), toon('#bdbdbd'), 0, -0.07, 0.3, false));

    const lineGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: LINE_POINTS }, () => new THREE.Vector3()));
    this.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#f4f1de' }));
    this.line.frustumCulled = false;

    this.bobber = new THREE.Group();
    this.bobber.add(mesh(new THREE.SphereGeometry(0.085, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), toon('#e63946'), 0, 0, 0, false));
    this.bobber.add(mesh(new THREE.SphereGeometry(0.085, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), toon('#f8f9fa'), 0, 0, 0, false));
    this.bobber.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 4), toon('#e63946'), 0, 0.13, 0, false));
    this.bang = textSprite('!', { bg: '#ffd166', color: '#2b2d42', size: 56, border: '#2b2d42' });
    this.bang.position.set(0, 0.55, 0);
    this.bang.visible = false;
    this.bobber.add(this.bang);

    this.ripple = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.14, 28), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.ripple.rotation.x = -Math.PI / 2;
    this.ripple.visible = false;

    this.rig.add(this.rod, this.line, this.bobber, this.ripple);
    this.rig.visible = false;
    this.group.add(this.rig);
  }

  /** A post with a sign on it, a bucket at its foot, and a rod leaning on it. */
  private addPost(spot: Spot) {
    const it: Interactable = { kind: 'fishing', x: spot.post.x, y: spot.deck, z: spot.post.z, radius: 2.5 };
    const post = new THREE.Group();
    post.position.set(spot.post.x, spot.deck, spot.post.z);
    post.rotation.y = spot.post.rotY;
    const wood = toon('#7f5539');
    post.add(mesh(new THREE.BoxGeometry(0.12, 1.25, 0.12), wood, 0, 0.62, 0));
    post.add(mesh(new THREE.BoxGeometry(0.85, 0.42, 0.06), toon('#2a9bd4'), 0, 1.3, 0.04));
    post.add(mesh(new THREE.BoxGeometry(0.9, 0.06, 0.08), wood, 0, 1.54, 0.04));
    const bucket = mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.28, 10), toon('#e63946'), 0.45, 0.14, 0.1);
    post.add(bucket);
    const label = textSprite('🎣', { size: 64 });
    label.scale.multiplyScalar(0.9);
    label.position.set(0, 1.3, 0.12);
    post.add(label);
    post.traverse((o) => (o.userData.interact = it));
    this.group.add(post);
    this.interactables.push(it);
    this.spotOf.set(it, spot);
  }

  /** The street is `street` high (see PlayerController.street). */
  setStreet(street: number) {
    this.group.position.y = street;
  }

  /** Whether the rig is drawn (while you fish). */
  showRig(on: boolean) {
    this.rig.visible = on;
    if (!on) this.bang.visible = false;
  }

  /** Where the rod's tip is, after the last `drawRod`. */
  get tipAt(): THREE.Vector3 {
    return this.tip;
  }

  /** The rod from `base`, pointing along `heading` and up `pitch`. */
  drawRod(base: THREE.Vector3, heading: number, pitch: number) {
    this.rod.position.copy(base);
    this.rod.rotation.set(-pitch, heading, 0, 'YXZ');
    const c = Math.cos(pitch);
    this.tip.set(base.x + Math.sin(heading) * c * ROD_LENGTH, base.y + Math.sin(pitch) * ROD_LENGTH, base.z + Math.cos(heading) * c * ROD_LENGTH);
  }

  /** The bobber at `at`, with the line from the rod's tip to it (`slack` 0–1: how much it sags); the "!" shows while it's biting. */
  drawBobber(at: THREE.Vector3, slack: number, tilt: number, bang: boolean) {
    this.bobber.position.copy(at);
    this.bobber.rotation.z = tilt;
    this.bang.visible = bang;
    const pos = this.line.geometry.attributes.position as THREE.BufferAttribute;
    const sag = 0.15 + slack * 0.9;
    for (let i = 0; i < LINE_POINTS; i++) {
      const u = i / (LINE_POINTS - 1);
      pos.setXYZ(i, this.tip.x + (at.x - this.tip.x) * u, this.tip.y + (at.y + 0.1 - this.tip.y) * u - Math.sin(u * Math.PI) * sag, this.tip.z + (at.z - this.tip.z) * u);
    }
    pos.needsUpdate = true;
  }

  /** A ring spreads from `(x, y, z)` (the bobber came down, nibbled, was pulled under), at time `now` (seconds). */
  ring(x: number, y: number, z: number, now: number) {
    this.ripple.position.set(x, y + 0.02, z);
    this.rippleAt = now;
  }

  /** Spreads and fades the ring. */
  update(now: number) {
    const k = (now - this.rippleAt) / 1.1;
    const on = k >= 0 && k < 1 && this.rig.visible;
    this.ripple.visible = on;
    if (!on) return;
    this.ripple.scale.setScalar(1 + k * 5);
    this.ripple.material.opacity = 0.7 * (1 - k);
  }
}
