import * as THREE from 'three';
import { BALCONY_DOOR, FLOOR, WALL_T, WINDOWS, type Opening } from '../../shared/layout';
import { wingWindows } from './tower';

/*
 * The light indoors in the office (#81): the room's own lamps, and the daylight (or the moonlight)
 * that comes in through its windows and its glass doors, and nothing else. The office has no roof as
 * far as the sun and the sky are concerned (they light the whole scene, see core/scene.ts), so every
 * lit material inside the room's walls (see sky.ts) puts them out again and lights itself from here:
 *
 * - the sky's even light (the hemisphere and the ambient light) gets in only near the windows, by how
 *   much of the glass a spot sees and how squarely (daylightAt);
 * - the sun's direct light, which indoors comes from overhead (features/lamplight), is the lamps': as
 *   bright and as warm as they are, and only as far as they reach (lampCover), so the shadows under
 *   the desks and the people come from the lamps;
 * - each lamp also throws a soft pool of light round it, falling off with distance (lampsAt);
 * - and a little light everywhere (BASE), so no corner is ever pitch black.
 *
 * The lamps are the fixtures themselves (RoomLamp, which the room, the loft, the meeting room and the
 * back office push to NightParts.roomLamps); the wall switches dim theirs (features/lights). It is a
 * few uniforms and two short loops, run only for fragments indoors: no extra three.js lights.
 */

/** As many lamps and panes of glass as the shader takes. */
export const MAX_ROOM_LAMPS = 12;
export const MAX_PANES = 12;

/** A lamp in the room: where its light comes from, how far it reaches, its color and strength, and how far it's switched on (0–1). */
export interface RoomLamp {
  x: number;
  y: number;
  z: number;
  reach: number;
  color: string;
  power: number;
  level: number;
}

/** The light from overhead indoors (the sun's, swung up there by features/lamplight), under a lamp: its color × strength. */
const LAMP_SUN = new THREE.Color('#ffe2b8').multiplyScalar(0.85);
/** How much light a corner no lamp or window reaches still gets. */
const BASE = new THREE.Color('#c9cde0').multiplyScalar(0.3);
/** How strongly the daylight carries in from the glass: more than a pane's own share, the walls and the floor pass it on. */
const PANE_GAIN = 3.5;

export const roomUniforms = {
  skyRoomLamps: { value: Array.from({ length: MAX_ROOM_LAMPS }, () => new THREE.Vector4()) },
  skyRoomLampColors: { value: Array.from({ length: MAX_ROOM_LAMPS }, () => new THREE.Color()) },
  /** How far each is switched on, 0–1 (RoomLamp.level), for how far its light from overhead reaches. */
  skyRoomLampLevels: { value: Array.from({ length: MAX_ROOM_LAMPS }, () => 0) },
  skyRoomLampCount: { value: 0 },
  /** Each pane's middle and its area (in .w), and how far it goes either way: a thin box in the wall. */
  skyPanes: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector4()) },
  skyPaneHalf: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector3()) },
  skyPaneCount: { value: 0 },
  /** What the sun's light is multiplied by indoors under a lamp, so it's the lamps' light (see setLampSun). */
  skyLampSun: { value: new THREE.Color() },
  skyRoomBase: { value: BASE.clone() },
};

/** A pane of glass (or an open way out) the daylight comes in through: a thin box in its wall. */
export interface Pane {
  at: THREE.Vector3;
  half: THREE.Vector3;
  area: number;
}

/** Where an opening in an outside wall is, as a Pane. */
export function paneOf(o: Opening): Pane {
  const y = (o.y0 + o.y1) / 2;
  const h = (o.y1 - o.y0) / 2;
  const across = o.wall === 'north' || o.wall === 'south';
  const at =
    o.wall === 'north' ? new THREE.Vector3(o.u, y, FLOOR.minZ - WALL_T / 2)
    : o.wall === 'south' ? new THREE.Vector3(o.u, y, FLOOR.maxZ + WALL_T / 2)
    : o.wall === 'west' ? new THREE.Vector3(FLOOR.minX - WALL_T / 2, y, o.u)
    : new THREE.Vector3(FLOOR.maxX + WALL_T / 2, y, o.u);
  const half = across ? new THREE.Vector3(o.width / 2, h, WALL_T / 2) : new THREE.Vector3(WALL_T / 2, h, o.width / 2);
  return { at, half, area: o.width * (o.y1 - o.y0) };
}

/** The office's glass on a floor built out `wing` rows: its windows, the balcony's glass doors and the back office's windows. */
export function panes(wing: number): Pane[] {
  return [...WINDOWS, BALCONY_DOOR, ...wingWindows(wing)].map(paneOf).slice(0, MAX_PANES);
}

/** The floor's glass as it is now (see setPanes). */
let shown: Pane[] = [];

/** Puts the floor's glass in the shader: `wing` rows of back office (see Sky.setWing). */
export function setPanes(wing: number) {
  const list = (shown = panes(wing));
  list.forEach((p, i) => {
    roomUniforms.skyPanes.value[i].set(p.at.x, p.at.y, p.at.z, p.area);
    roomUniforms.skyPaneHalf.value[i].copy(p.half);
  });
  roomUniforms.skyPaneCount.value = list.length;
}
setPanes(0);

/** The room's lamps as they are this frame, and the sun as the sky has lit it (see setLampSun), in the shader. */
export function lightRoom(lamps: readonly RoomLamp[], sun: THREE.DirectionalLight) {
  setLampSun(sun);
  const n = Math.min(lamps.length, MAX_ROOM_LAMPS);
  for (let i = 0; i < n; i++) {
    const l = lamps[i];
    roomUniforms.skyRoomLamps.value[i].set(l.x, l.y, l.z, l.reach);
    roomUniforms.skyRoomLampColors.value[i].set(l.color).multiplyScalar(l.power * l.level);
    roomUniforms.skyRoomLampLevels.value[i] = l.level;
  }
  roomUniforms.skyRoomLampCount.value = n;
}

/**
 * The sun as the sky has lit it this frame: indoors its light is made the lamps' (LAMP_SUN) by
 * multiplying it by this, per channel, wherever it comes from and however bright it is outside.
 */
function setLampSun(sun: THREE.DirectionalLight) {
  const c = sun.color;
  const k = Math.max(sun.intensity, 1e-3);
  roomUniforms.skyLampSun.value.setRGB(LAMP_SUN.r / Math.max(c.r * k, 1e-3), LAMP_SUN.g / Math.max(c.g * k, 1e-3), LAMP_SUN.b / Math.max(c.b * k, 1e-3));
}

type Point = { x: number; y: number; z: number };

/** How near `p` is to a lamp that's on, 0–1 (lampCover in ROOM_LIGHT_PARS, in numbers). */
export function lampCover(p: Point, lamps: readonly RoomLamp[]): number {
  let sum = 0;
  for (const l of lamps.slice(0, MAX_ROOM_LAMPS)) sum += l.level * Math.max(0, 1 - Math.hypot(l.x - p.x, l.y - p.y, l.z - p.z) / l.reach);
  return Math.min(1, sum);
}

/** How much daylight gets to `p` facing `n`, 0–1 (daylightAt in ROOM_LIGHT_PARS, in numbers): near the glass, and facing it. */
export function daylightAt(p: Point, n: Point, list: readonly Pane[]): number {
  let sum = 0;
  for (const w of list) {
    const d = {
      x: THREE.MathUtils.clamp(p.x, w.at.x - w.half.x, w.at.x + w.half.x) - p.x,
      y: THREE.MathUtils.clamp(p.y, w.at.y - w.half.y, w.at.y + w.half.y) - p.y,
      z: THREE.MathUtils.clamp(p.z, w.at.z - w.half.z, w.at.z + w.half.z) - p.z,
    };
    const r2 = d.x * d.x + d.y * d.y + d.z * d.z;
    if (r2 < 1e-4) return 1;
    const r = Math.sqrt(r2);
    const through = 0.25 + (0.75 * Math.abs(w.half.x < w.half.z ? d.x : d.z)) / r;
    const facing = 0.35 + 0.65 * Math.max(0, (n.x * d.x + n.y * d.y + n.z * d.z) / r);
    sum += (w.area * through * facing) / (w.area + r2);
  }
  return Math.min(1, sum * PANE_GAIN);
}

/** How lit `p` is indoors, 0–1, with the sky outside giving `outside` (1 a clear day): for your hands (Sky.lightAt). */
export function roomLevel(p: Point, lamps: readonly RoomLamp[], outside: number, list: readonly Pane[] = shown): number {
  return Math.min(1, 0.15 + lampCover(p, lamps) + daylightAt(p, { x: 0, y: 1, z: 0 }, list) * outside);
}

/** For every lit material: the lamps' and the windows' light (see the top of this file). Mirrored by lampCover and daylightAt. */
export const ROOM_LIGHT_PARS = /* glsl */ `
uniform vec4 skyRoomLamps[ ${MAX_ROOM_LAMPS} ];
uniform vec3 skyRoomLampColors[ ${MAX_ROOM_LAMPS} ];
uniform float skyRoomLampLevels[ ${MAX_ROOM_LAMPS} ];
uniform int skyRoomLampCount;
uniform vec4 skyPanes[ ${MAX_PANES} ];
uniform vec3 skyPaneHalf[ ${MAX_PANES} ];
uniform int skyPaneCount;
uniform vec3 skyLampSun;
uniform vec3 skyRoomBase;

// The lamps' pools of light at p facing n, and in cover how near p is to one that's on (0–1).
vec3 skyRoomLampsAt( vec3 p, vec3 n, out float cover ) {
  vec3 sum = vec3( 0.0 );
  cover = 0.0;
  for ( int i = 0; i < ${MAX_ROOM_LAMPS}; i ++ ) {
    if ( i >= skyRoomLampCount ) break;
    vec3 d = skyRoomLamps[ i ].xyz - p;
    float r = length( d );
    float k = 1.0 - clamp( r / skyRoomLamps[ i ].w, 0.0, 1.0 );
    cover += k * skyRoomLampLevels[ i ];
    sum += skyRoomLampColors[ i ] * k * k * ( 0.3 + 0.7 * max( dot( n, d / max( r, 0.001 ) ), 0.0 ) );
  }
  cover = min( cover, 1.0 );
  return sum;
}

// How much of the daylight gets in to p facing n through the glass, 0–1.
float skyDaylightAt( vec3 p, vec3 n ) {
  float sum = 0.0;
  for ( int i = 0; i < ${MAX_PANES}; i ++ ) {
    if ( i >= skyPaneCount ) break;
    vec3 h = skyPaneHalf[ i ];
    vec3 d = clamp( p, skyPanes[ i ].xyz - h, skyPanes[ i ].xyz + h ) - p;
    float r2 = dot( d, d );
    if ( r2 < 1e-4 ) return 1.0;
    float r = sqrt( r2 );
    float through = 0.25 + 0.75 * abs( h.x < h.z ? d.x : d.z ) / r;
    float facing = 0.35 + 0.65 * max( dot( n, d ) / r, 0.0 );
    float area = skyPanes[ i ].w;
    sum += area * through * facing / ( area + r2 );
  }
  return min( sum * ${PANE_GAIN.toFixed(2)}, 1.0 );
}
`;

/**
 * three.js's lights_fragment_begin, keeping apart what the sun (the one directional light) gives
 * (skySunD, skySunS) from the rest, so that indoors it can be made the lamps' (ROOM_LIGHT).
 */
const DIR = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const AFTER_DIR = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
const BEGIN = THREE.ShaderChunk.lights_fragment_begin;
if (!BEGIN.includes(DIR) || !BEGIN.includes(AFTER_DIR)) throw new Error('roomlight: three.js lights_fragment_begin has changed');
export const SUN_SPLIT = BEGIN.replace(DIR, `vec3 skyD0 = reflectedLight.directDiffuse;\nvec3 skyS0 = reflectedLight.directSpecular;\n${DIR}`).replace(
  AFTER_DIR,
  `vec3 skySunD = reflectedLight.directDiffuse - skyD0;\nvec3 skySunS = reflectedLight.directSpecular - skyS0;\n${AFTER_DIR}`,
);

/**
 * After the lights (lights_fragment_end): inside the room (skyRoom, 0–1) the sky's light only where
 * the windows let it in, the sun's light the lamps', as far as they reach, and the lamps' pools and
 * the base on top. Needs skyN (sky.ts's SURFACE) and skyRoom.
 */
export const ROOM_LIGHT = /* glsl */ `
if ( skyRoom > 0.0 ) {
  float skyCover;
  vec3 skyLamp = skyRoomLampsAt( vSkyWorld, skyN, skyCover );
  float skyDay = skyDaylightAt( vSkyWorld, skyN );
  reflectedLight.indirectDiffuse *= 1.0 - skyRoom * ( 1.0 - skyDay );
  vec3 skyToLamp = skyRoom * ( skyLampSun * skyCover - 1.0 );
  reflectedLight.directDiffuse += skyToLamp * skySunD;
  reflectedLight.directSpecular += skyToLamp * skySunS;
  reflectedLight.indirectDiffuse += skyRoom * ( skyLamp + skyRoomBase ) * BRDF_Lambert( material.diffuseColor );
}
`;
