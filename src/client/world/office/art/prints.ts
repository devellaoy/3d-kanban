import * as THREE from 'three';
import { PRINTS } from '../../../../shared/art';
import { FLOOR } from '../../../../shared/layout';
import { mulberry32 } from '../../../../shared/rng';
import { mesh, toon } from '../../toon';
import type { Fixture } from '../fixture';

// Two large framed abstract prints over the stairs: generated, so each is its own, from a seed, in the
// office's palette. A wide wooden frame and a white mount round a painted canvas.

const PALETTE = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#2b2d42', '#f78c6b', '#9b5de5', '#fffaf3'];

function painting(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 680;
  c.height = 460;
  const g = c.getContext('2d')!;
  const r = mulberry32(seed);
  g.fillStyle = '#fffaf3';
  g.fillRect(0, 0, c.width, c.height);
  // Big soft fields of colour, then lines and dots over them.
  for (let i = 0; i < 6; i++) {
    g.fillStyle = PALETTE[Math.floor(r() * PALETTE.length)];
    g.globalAlpha = 0.85;
    const w = 150 + r() * 300;
    const h = 100 + r() * 220;
    g.beginPath();
    g.roundRect(r() * (c.width - w), r() * (c.height - h), w, h, r() * 60);
    g.fill();
  }
  g.globalAlpha = 1;
  g.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    g.strokeStyle = PALETTE[Math.floor(r() * 5)];
    g.lineWidth = 4 + r() * 14;
    g.beginPath();
    g.moveTo(r() * c.width, r() * c.height);
    g.bezierCurveTo(r() * c.width, r() * c.height, r() * c.width, r() * c.height, r() * c.width, r() * c.height);
    g.stroke();
  }
  for (let i = 0; i < 14; i++) {
    g.fillStyle = PALETTE[Math.floor(r() * PALETTE.length)];
    g.beginPath();
    g.arc(r() * c.width, r() * c.height, 6 + r() * 26, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export const prints: Fixture = (site) => {
  for (const p of PRINTS) {
    const g = new THREE.Group();
    const frame = 0.09;
    g.add(mesh(new THREE.BoxGeometry(p.width + 2 * frame, p.height + 2 * frame, 0.06), toon('#8a5a3b'), 0, 0, 0.03, false));
    g.add(mesh(new THREE.BoxGeometry(p.width, p.height, 0.02), toon('#ffffff'), 0, 0, 0.065, false));
    const canvas = new THREE.Mesh(new THREE.PlaneGeometry(p.width - 0.22, p.height - 0.22), new THREE.MeshBasicMaterial({ map: painting(p.seed) }));
    canvas.position.z = 0.08;
    g.add(canvas);
    // On the south wall, facing north (into the room).
    g.position.set(p.x, p.y, FLOOR.maxZ - 0.09);
    g.rotation.y = Math.PI;
    site.group.add(g);
    site.wall('south', p.x, p.y, p.width + 0.4, p.height + 0.4);
  }
  return {};
};
