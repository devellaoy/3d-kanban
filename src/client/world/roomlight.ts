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
 *   much of the glass a spot sees and how squarely (daylightAt). The sun's own beam doesn't: a patch
 *   of sunlight would need the sun's real direction, which indoors is the lamps' (see below);
 * - the shadow-casting light, which indoors comes from overhead (features/lamplight), is the lamps'
 *   light: their color and strength, only as far as they reach (lampCover), whatever the sun is doing
 *   outside, so the shadows under the desks and the people come from the lamps;
 * - each lamp also throws a soft pool of light round it, falling off with distance (lampsAt), on its
 *   own storey only (RoomLamp.floor and .top), so the meeting room's lights don't shine up through
 *   the boss office's floor;
 * - and a little light everywhere (BASE), so no corner is ever pitch black.
 *
 * The lamps are the fixtures themselves (RoomLamp, which the room, the loft, the meeting room and the
 * back office push to NightParts.roomLamps); the wall switches dim theirs (features/lights), and they
 * come up as it gets dark (lightRoom's `lampsOn`, the sky's), from DAY_LAMPS by day. It is a few
 * uniforms and two short loops, run only for fragments indoors: no extra three.js lights.
 */

/** As many lamps and panes of glass as the shader takes. */
export const MAX_ROOM_LAMPS = 12;
export const MAX_PANES = 12;

/**
 * A lamp in the room: where its light comes from, how far it reaches, its color and strength, how far
 * it's switched on (0–1), and the storey it lights, from `floor` up to `top`.
 */
export interface RoomLamp {
  x: number;
  y: number;
  z: number;
  reach: number;
  color: THREE.Color;
  power: number;
  level: number;
  floor: number;
  top: number;
}

/** How bright the lamps are by day, against 1 once it's dark (the sky's lampsOn): on, but outshone by the windows. */
export const DAY_LAMPS = 0.6;
/** The light from overhead indoors, under a lamp that's fully on: its color × strength. */
const LAMP_SUN = new THREE.Color('#ffe2b8').multiplyScalar(0.85);
/** How much light a corner no lamp or window reaches still gets. */
const BASE = new THREE.Color('#c9cde0').multiplyScalar(0.3);
/** How strongly the daylight carries in from the glass: more than a pane's own share, the walls and the floor pass it on. */
const PANE_GAIN = 3.5;
/** How far over its floor (and under its top) a lamp's storey reaches. */
const SPAN_GIVE = 0.05;

export const roomUniforms = {
  /** Each lamp that's on: where it is and its reach (.w); its color × strength × how far it's on, and that (.w); its storey. */
  skyRoomLamps: { value: Array.from({ length: MAX_ROOM_LAMPS }, () => new THREE.Vector4()) },
  skyRoomLampColors: { value: Array.from({ length: MAX_ROOM_LAMPS }, () => new THREE.Vector4()) },
  skyRoomLampSpans: { value: Array.from({ length: MAX_ROOM_LAMPS }, () => new THREE.Vector2()) },
  skyRoomLampCount: { value: 0 },
  /** Each pane's middle and its area (in .w), and how far it goes either way: a thin box in the wall. */
  skyPanes: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector4()) },
  skyPaneHalf: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector3()) },
  skyPaneCount: { value: 0 },
  skyLampSun: { value: LAMP_SUN.clone() },
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
/** How far up the lamps are for the hour (DAY_LAMPS by day to 1 at night), as lightRoom last set it. */
let hour = 1;

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

/** How far up a room's lamps are at the hour where the sky has its own lamps `lampsOn` (0 by day, 1 at night). */
export const lampHour = (lampsOn: number) => DAY_LAMPS + (1 - DAY_LAMPS) * lampsOn;
/** How far up the room's lamps are for the hour, as the sky last said (see lightRoom), for the bulbs to match. */
export const roomLampHour = () => hour;

/** The room's lamps as they are this frame, with the sky's own lamps `lampsOn` (0–1), in the shader. Only the lamps that are on go in. */
export function lightRoom(lamps: readonly RoomLamp[], lampsOn: number) {
  hour = lampHour(lampsOn);
  let n = 0;
  for (let i = 0; i < lamps.length && n < MAX_ROOM_LAMPS; i++) {
    const l = lamps[i];
    const on = l.level * hour;
    if (on <= 0) continue;
    roomUniforms.skyRoomLamps.value[n].set(l.x, l.y, l.z, l.reach);
    const k = l.power * on;
    roomUniforms.skyRoomLampColors.value[n].set(l.color.r * k, l.color.g * k, l.color.b * k, on);
    roomUniforms.skyRoomLampSpans.value[n].set(l.floor - SPAN_GIVE, l.top + SPAN_GIVE);
    n++;
  }
  roomUniforms.skyRoomLampCount.value = n;
}

type Point = { x: number; y: number; z: number };

/** How near `p` is to a lamp that's on, 0–1, at the hour lightRoom last set (lampCover in ROOM_LIGHT_PARS, in numbers). */
export function lampCover(p: Point, lamps: readonly RoomLamp[]): number {
  let sum = 0;
  for (let i = 0, n = Math.min(lamps.length, MAX_ROOM_LAMPS); i < n; i++) {
    const l = lamps[i];
    if (p.y < l.floor - SPAN_GIVE || p.y > l.top + SPAN_GIVE) continue;
    const dx = l.x - p.x;
    const dy = l.y - p.y;
    const dz = l.z - p.z;
    sum += l.level * hour * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / l.reach);
  }
  return Math.min(1, sum);
}

/** How much daylight gets to `p` facing `n`, 0–1 (daylightAt in ROOM_LIGHT_PARS, in numbers): near the glass, and facing it. */
export function daylightAt(p: Point, n: Point, list: readonly Pane[]): number {
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    const { at, half, area } = list[i];
    const dx = THREE.MathUtils.clamp(p.x, at.x - half.x, at.x + half.x) - p.x;
    const dy = THREE.MathUtils.clamp(p.y, at.y - half.y, at.y + half.y) - p.y;
    const dz = THREE.MathUtils.clamp(p.z, at.z - half.z, at.z + half.z) - p.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 < 1e-4) return 1;
    const r = Math.sqrt(r2);
    const through = 0.25 + (0.75 * Math.abs(half.x < half.z ? dx : dz)) / r;
    const facing = 0.35 + 0.65 * Math.max(0, (n.x * dx + n.y * dy + n.z * dz) / r);
    sum += (area * through * facing) / (area + r2);
  }
  return Math.min(1, sum * PANE_GAIN);
}

const UP = { x: 0, y: 1, z: 0 };

/** How lit `p` is indoors, 0–1, with the sky outside giving `outside` (1 a clear day): for your hands (Sky.lightAt). */
export function roomLevel(p: Point, lamps: readonly RoomLamp[], outside: number, list: readonly Pane[] = shown): number {
  return Math.min(1, 0.15 + lampCover(p, lamps) + daylightAt(p, UP, list) * outside);
}

/** For every lit material: the lamps' and the windows' light (see the top of this file). Mirrored by lampCover and daylightAt. */
export const ROOM_LIGHT_PARS = /* glsl */ `
uniform vec4 skyRoomLamps[ ${MAX_ROOM_LAMPS} ];
uniform vec4 skyRoomLampColors[ ${MAX_ROOM_LAMPS} ];
uniform vec2 skyRoomLampSpans[ ${MAX_ROOM_LAMPS} ];
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
    if ( p.y < skyRoomLampSpans[ i ].x || p.y > skyRoomLampSpans[ i ].y ) continue;
    vec3 d = skyRoomLamps[ i ].xyz - p;
    float r = length( d );
    float k = 1.0 - clamp( r / skyRoomLamps[ i ].w, 0.0, 1.0 );
    cover += k * skyRoomLampColors[ i ].w;
    sum += skyRoomLampColors[ i ].rgb * k * k * ( 0.3 + 0.7 * max( dot( n, d / max( r, 0.001 ) ), 0.0 ) );
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
 * Before the lights (after sky.ts's SURFACE, which gives skyN): how much of the room a fragment is in,
 * up to `top`, the lamps' and the windows' light there, and whether you're in the room to see the
 * lamps' light from overhead (from outside, that light would come the street's sun's way).
 */
export const roomLightBefore = (top: number) => /* glsl */ `
float skyRoom = skyOn * skyInside * skyInsideOf( vSkyWorld, ${top.toFixed(3)} );
float skyCover = 0.0;
vec3 skyLamp = vec3( 0.0 );
float skyDay = 1.0;
if ( skyRoom > 0.0 ) {
  skyLamp = skyRoomLampsAt( vSkyWorld, skyN, skyCover );
  skyDay = skyDaylightAt( vSkyWorld, skyN );
}
float skyLampIn = skyInsideOf( cameraPosition, ${top.toFixed(3)} );
float skyShade = 1.0;
`;

/**
 * three.js's lights_fragment_begin with the sun's light (the one directional light) made the lamps'
 * inside the room: their color and strength (skyLampSun × skyCover) in its shadows (skyShade), not the
 * sun's, so it's the same at noon and at midnight and never needs the sun to be up.
 */
const BEGIN = THREE.ShaderChunk.lights_fragment_begin;
const DIR = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const AFTER_DIR = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
const SHADOW = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]';
const SHADOW_END = ': 1.0;';
const CALL = 'RE_Direct( directLight';
const SHADOW_IF = '#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )';

function sunSplit(): string {
  const a = BEGIN.indexOf(DIR);
  const b = BEGIN.indexOf(AFTER_DIR);
  let dir = BEGIN.slice(a, b);
  const s = dir.indexOf(SHADOW);
  const e = s < 0 ? -1 : dir.indexOf(SHADOW_END, s);
  if (a < 0 || b < a || e < 0 || !dir.includes(CALL) || !dir.includes(SHADOW_IF)) throw new Error('roomlight: three.js lights_fragment_begin has changed');
  dir = `${dir.slice(0, s)}skyShade = ${dir.slice(s + 'directLight.color *= '.length, e + SHADOW_END.length)}\n\t\tdirectLight.color *= skyShade;${dir.slice(e + SHADOW_END.length)}`;
  dir = dir.replace(SHADOW_IF, `skyShade = 1.0;\n\t\t${SHADOW_IF}`);
  dir = dir.replace(CALL, `directLight.color = mix( directLight.color, skyLampSun * skyCover * skyShade * skyLampIn, skyRoom );\n\t\t${CALL}`);
  return BEGIN.slice(0, a) + dir + BEGIN.slice(b);
}
export const SUN_SPLIT = sunSplit();

/**
 * After the lights (lights_fragment_end): inside the room the sky's light only where the windows let
 * it in, and the lamps' pools and the base on top.
 */
export const ROOM_LIGHT = /* glsl */ `
if ( skyRoom > 0.0 ) {
  reflectedLight.indirectDiffuse *= 1.0 - skyRoom * ( 1.0 - skyDay );
  reflectedLight.indirectDiffuse += skyRoom * ( skyLamp + skyRoomBase ) * BRDF_Lambert( material.diffuseColor );
}
`;
