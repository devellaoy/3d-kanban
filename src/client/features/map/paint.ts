import { CREEK, FARM, FOOTHILLS, LAKE, LIGHTHOUSE, RIDGE, TUNNEL } from '../../../shared/scenic';
import { FLOOR } from '../../../shared/layout';
import { LOT, SIDE_LOT } from '../../../shared/garage';
import { WORLD, STREET_LINE, loopLine, pierLine, shoreLine, visibleMountains, type Marker, type Projection } from './geometry';

// Draws the map on a 2D canvas, in the office's toon colours: flat fills with a dark outline. The
// terrain is drawn once (to an offscreen canvas, by map.ts); only the "you" arrow is drawn per frame.

const INK = '#2a2a3c';
const COLORS = {
  grass: '#b9e39b',
  sea: '#6ecbe9',
  sand: '#f3e2a2',
  lake: '#5bb4e6',
  asphalt: '#5d6070',
  walk: '#d9d4c4',
  pines: '#5fae66',
  hill: '#8ccf78',
  rock: '#a4a9bd',
  rockDark: '#878ca3',
  snow: '#ffffff',
  field: '#e8d98a',
  field2: '#d4c06e',
  roof: '#e9b872',
  office: '#f2a65a',
  tarmac: '#8d90a0',
  creek: '#5bb4e6',
};

export interface Building {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

type G = CanvasRenderingContext2D;

function outline(g: G, width = 1.5) {
  g.lineWidth = width;
  g.strokeStyle = INK;
  g.stroke();
}

function rect(g: G, p: Projection, b: Building, fill: string, line = true) {
  g.fillStyle = fill;
  g.beginPath();
  g.rect(p.x(b.minX), p.y(b.minZ), (b.maxX - b.minX) * p.scale, (b.maxZ - b.minZ) * p.scale);
  g.fill();
  if (line) outline(g, 1.2);
}

function strokeRoad(g: G, p: Projection, pts: { x: number; z: number }[], half: number, color: string) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  pts.forEach((q, i) => (i ? g.lineTo(p.x(q.x), p.y(q.z)) : g.moveTo(p.x(q.x), p.y(q.z))));
  // The road's dark edge first, then the asphalt on top of it.
  g.strokeStyle = INK;
  g.lineWidth = Math.max(4, half * 2 * p.scale * 1.7 + 2.5);
  g.stroke();
  g.strokeStyle = color;
  g.lineWidth = Math.max(2.5, half * 2 * p.scale * 1.7);
  g.stroke();
}

/** The ground, water, mountains, roads and buildings: everything that stays where it is. */
export function paintTerrain(g: G, p: Projection, w: number, h: number, buildings: readonly Building[]): void {
  g.fillStyle = COLORS.grass;
  g.fillRect(0, 0, w, h);

  // The sea in the west, with a sandy beach along it.
  const shore = shoreLine(6);
  g.beginPath();
  g.moveTo(0, p.y(WORLD.minZ));
  shore.forEach(([x, z]) => g.lineTo(p.x(x + 12), p.y(z)));
  g.lineTo(0, p.y(WORLD.maxZ));
  g.closePath();
  g.fillStyle = COLORS.sand;
  g.fill();
  g.beginPath();
  g.moveTo(0, p.y(WORLD.minZ));
  shore.forEach(([x, z]) => g.lineTo(p.x(x), p.y(z)));
  g.lineTo(0, p.y(WORLD.maxZ));
  g.closePath();
  g.fillStyle = COLORS.sea;
  g.fill();
  g.beginPath();
  shore.forEach(([x, z], i) => (i ? g.lineTo(p.x(x), p.y(z)) : g.moveTo(p.x(x), p.y(z))));
  outline(g, 1.5);

  // The pines along the road between the farm and the mountains.
  const loop = loopLine(6);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  loop.filter((q) => q.place === 'forest').forEach((q, i) => (i ? g.lineTo(p.x(q.x), p.y(q.z)) : g.moveTo(p.x(q.x), p.y(q.z))));
  g.strokeStyle = COLORS.pines;
  g.lineWidth = 78 * p.scale;
  g.stroke();

  // Foothills, then the mountains on top of them.
  for (const [x, z, r] of FOOTHILLS) {
    g.beginPath();
    g.arc(p.x(x), p.y(z), r * p.scale, 0, Math.PI * 2);
    g.fillStyle = COLORS.hill;
    g.fill();
    outline(g, 1.2);
  }
  // The ridge the tunnel goes through.
  g.beginPath();
  g.roundRect(p.x(TUNNEL.x1 - 24), p.y(TUNNEL.z - RIDGE.north), (TUNNEL.x0 - TUNNEL.x1 + 48) * p.scale, (RIDGE.north + RIDGE.south) * p.scale, 14 * p.scale);
  g.fillStyle = COLORS.rock;
  g.fill();
  outline(g, 1.2);
  for (const [x, z, r, ht] of visibleMountains()) {
    g.beginPath();
    g.arc(p.x(x), p.y(z), r * p.scale, 0, Math.PI * 2);
    g.fillStyle = COLORS.rockDark;
    g.fill();
    outline(g, 1.2);
    g.beginPath();
    g.arc(p.x(x), p.y(z), r * p.scale * 0.42, 0, Math.PI * 2);
    g.fillStyle = ht > 150 ? COLORS.snow : COLORS.rock;
    g.fill();
  }

  // The farm's fields and pasture.
  FARM.fields.forEach((f, i) => rect(g, p, f, i ? COLORS.field2 : COLORS.field));
  rect(g, p, FARM.pasture, COLORS.hill);
  rect(g, p, { minX: FARM.barn.x - 7, maxX: FARM.barn.x + 7, minZ: FARM.barn.z - 5, maxZ: FARM.barn.z + 5 }, '#d9574f');

  // The lake and the creek.
  g.beginPath();
  g.ellipse(p.x(LAKE.x), p.y(LAKE.z), LAKE.rx * p.scale, LAKE.rz * p.scale, 0, 0, Math.PI * 2);
  g.fillStyle = COLORS.lake;
  g.fill();
  outline(g, 1.5);
  g.beginPath();
  CREEK.forEach(([x, z], i) => (i ? g.lineTo(p.x(x), p.y(z)) : g.moveTo(p.x(x), p.y(z))));
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = COLORS.creek;
  g.lineWidth = Math.max(2.5, 5 * p.scale);
  g.stroke();

  // The lighthouse's rock, and the pier.
  g.beginPath();
  g.arc(p.x(LIGHTHOUSE.x), p.y(LIGHTHOUSE.z), 9 * p.scale, 0, Math.PI * 2);
  g.fillStyle = COLORS.rock;
  g.fill();
  outline(g, 1.2);
  const pier = pierLine();
  rect(g, p, { minX: pier.x1, maxX: pier.x0, minZ: pier.z - pier.width / 2, maxZ: pier.z + pier.width / 2 }, '#b98a56');
  // The lake's dock is short: a stub on the north shore.
  rect(g, p, { minX: LAKE.x - 7.2, maxX: LAKE.x - 4.8, minZ: LAKE.z - LAKE.rz - 2, maxZ: LAKE.z - LAKE.rz + 7 }, '#b98a56');

  // The scenic loop, the street, and the tunnel part of it drawn dashed under the rock.
  strokeRoad(g, p, loop, 4, COLORS.asphalt);
  strokeRoad(g, p, [{ x: STREET_LINE.x0, z: STREET_LINE.z }, { x: STREET_LINE.x1, z: STREET_LINE.z }], STREET_LINE.half, COLORS.asphalt);
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(p.x(TUNNEL.x0), p.y(TUNNEL.z));
  g.lineTo(p.x(TUNNEL.x1), p.y(TUNNEL.z));
  g.strokeStyle = '#f5f1e0';
  g.lineWidth = 1.5;
  g.stroke();
  g.setLineDash([]);

  // The lots in front of the garage, the neighbours along the street, and the office on top.
  rect(g, p, LOT, COLORS.tarmac);
  rect(g, p, SIDE_LOT, COLORS.tarmac);
  for (const b of buildings) rect(g, p, b, COLORS.roof);
  rect(g, p, { minX: FLOOR.minX - 0.3, maxX: FLOOR.maxX + 0.3, minZ: FLOOR.minZ - 0.3, maxZ: FLOOR.maxZ + 0.3 }, COLORS.office);

  // The compass.
  g.fillStyle = INK;
  g.font = '900 15px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('N', p.x(WORLD.maxX) - 22, p.y(WORLD.minZ) + 36);
  g.beginPath();
  g.moveTo(p.x(WORLD.maxX) - 22, p.y(WORLD.minZ) + 8);
  g.lineTo(p.x(WORLD.maxX) - 29, p.y(WORLD.minZ) + 26);
  g.lineTo(p.x(WORLD.maxX) - 15, p.y(WORLD.minZ) + 26);
  g.closePath();
  g.fill();
}

/** One marker: its emoji on a round chip, and (on the big map) its name under it. */
export function paintMarker(g: G, p: Projection, m: Marker, labels: boolean, size = 24): void {
  const x = p.x(m.x);
  const y = p.y(m.z);
  g.beginPath();
  g.arc(x, y, size * 0.62, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.fill();
  outline(g, 1.5);
  g.font = `${size * 0.8}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = INK;
  g.fillText(m.icon, x, y + 1);
  if (!labels) return;
  g.font = '800 12px system-ui, sans-serif';
  const r = size * 0.62 + 4;
  const side = m.side ?? 's';
  g.textAlign = side === 'e' ? 'left' : side === 'w' ? 'right' : 'center';
  g.textBaseline = 'middle';
  const tx = x + (side === 'e' ? r : side === 'w' ? -r : 0);
  const ty = y + (side === 's' ? r + 5 : side === 'n' ? -r - 5 : 0);
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,.95)';
  g.lineJoin = 'round';
  g.strokeText(m.label, tx, ty);
  g.fillText(m.label, tx, ty);
}

/** The "you are here" arrow, pointing along `heading` (0 is +z, down the map). */
export function paintYou(g: G, x: number, y: number, heading: number, size = 12): void {
  g.save();
  g.translate(x, y);
  g.rotate(-heading);
  g.beginPath();
  // Drawn pointing down the screen (+z), turned by -heading.
  g.moveTo(0, size);
  g.lineTo(size * 0.72, -size * 0.8);
  g.lineTo(0, -size * 0.35);
  g.lineTo(-size * 0.72, -size * 0.8);
  g.closePath();
  g.fillStyle = '#ef476f';
  g.fill();
  g.lineJoin = 'round';
  outline(g, 2);
  g.restore();
}
