// A round footprint (a mountain's, a hill's) as boxes a car or a person can bump into: strips across
// it, each as wide as the circle is at the strip's far edge, so the boxes sit inside the circle.

export interface FootBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Strips tiling the disc of radius `r` round (x, z), about `step` meters deep each. */
export function discBoxes(x: number, z: number, r: number, step = 4): FootBox[] {
  const n = Math.max(2, Math.ceil((2 * r) / step));
  const dz = (2 * r) / n;
  const out: FootBox[] = [];
  for (let i = 0; i < n; i++) {
    const z0 = -r + i * dz;
    const z1 = z0 + dz;
    // The circle is narrowest at the strip's edge furthest from the middle.
    const far = Math.max(Math.abs(z0), Math.abs(z1));
    const half = Math.sqrt(Math.max(0, r * r - far * far));
    if (half < 0.5) continue;
    out.push({ minX: x - half, maxX: x + half, minZ: z + z0, maxZ: z + z1 });
  }
  return out;
}
