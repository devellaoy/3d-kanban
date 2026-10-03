import * as THREE from 'three';
import { LED_WAVE } from '../../../../shared/art';
import { FLOOR } from '../../../../shared/layout';
import type { Fixture } from '../fixture';

// The LED wave: a panel of vertical bars on the south wall that rise and fall in a slow ripple, their
// colour drifting round the wheel. One instanced mesh with a colour for each bar, so it is a single draw call.

const BARS = 24;

export const ledWave: Fixture = (site) => {
  const { x, y, width, height } = LED_WAVE;
  const pitch = width / BARS;
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(pitch * 0.62, 1, 0.05), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), BARS);
  bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BARS * 3), 3);
  bars.frustumCulled = false;
  const back = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, height + 0.2, 0.06), new THREE.MeshToonMaterial({ color: '#2b2d42' }));
  back.position.set(x, y + height / 2, FLOOR.maxZ - 0.03);
  const panel = new THREE.Group();
  panel.add(back, bars);
  // On the south wall, bars standing out from the backing, their bottoms on its lower edge.
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const apply = (t: number) => {
    for (let i = 0; i < BARS; i++) {
      const h = height * (0.35 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.9 + i * 0.45)));
      m.makeScale(1, h, 1).setPosition(x - width / 2 + pitch * (i + 0.5), y + 0.05 + h / 2, FLOOR.maxZ - 0.1);
      bars.setMatrixAt(i, m);
      c.setHSL(((t * 0.03 + (i / BARS) * 0.5) % 1 + 1) % 1, 0.9, 0.58);
      bars.setColorAt(i, c);
    }
    bars.instanceMatrix.needsUpdate = true;
    bars.instanceColor!.needsUpdate = true;
  };
  apply(0);
  site.group.add(panel);
  // No picture hangs over it.
  site.wall('south', x, y + height / 2, width + 0.5, height + 0.5);
  return { update: (t) => apply(t) };
};
