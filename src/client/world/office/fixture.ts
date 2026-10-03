import type * as THREE from 'three';
import type { Pose } from '../../../shared/arrange';
import type { WallId } from '../../../shared/decor';
import type { Collider, DeskView, Interactable, OfficeHandles } from '../types';
import type { Looks } from './materials';
import type { Door } from './shell';

// The office floor is put together from fixtures, built one after another in the order build.ts lists
// them (which is the order everything in the floor is made in, kept on purpose). Each builds its part
// into the site (the floor as it stands so far) and hands back what it gives the office to reach it
// by (see OfficeHandles), what it does each frame and what it does when you change floors.

/** The floor as it's being built: what a fixture builds into, and what the ones before it built. */
export interface Site {
  /** The floor's own group, what's in the way on it, and what there is to use on it. */
  readonly group: THREE.Group;
  readonly colliders: Collider[];
  readonly interactables: Interactable[];
  /**
   * Marks a stretch of wall `w` wide and `h` high, centered `u` along it and `y` up, as taken (a board,
   * a window, a door), so pictures don't hang over it (see Office.fixtures).
   */
  wall(wall: WallId, u: number, y: number, w: number, h: number): void;
  /** What each floor paints its own way (see Office.setLook). */
  readonly looks: Looks;
  /** The floor's planks, which the back office's floor is laid with too. */
  readonly planks: THREE.Material;
  /** Every seat by id (see Office.desks). */
  readonly desks: Map<string, DeskView>;
  /** The doors that open by themselves for anyone who comes up to them (see Office.update). */
  readonly doors: Door[];
  /** What stands in the way into the back office, and its collider, put away while that's built out. */
  readonly inTheWay: { group: THREE.Group; collider: Collider }[];
  /** The loose furniture the fixtures built so far, by id (see MovablePiece). */
  readonly movables: Map<string, MovablePiece>;
  /** What a fixture before this one gives the office. It throws if that one's further down the list. */
  get<K extends keyof OfficeHandles>(key: K): OfficeHandles[K];
}

/**
 * A piece of loose furniture build mode can move (see shared/arrange.ts and arrange.ts here): the
 * fixture that builds it says how to put it somewhere else.
 */
export interface MovablePiece {
  /** What moves, for aiming at it. */
  group: THREE.Object3D;
  /** What stands in the way of people because of it (changed in place, and in the floor's list only while it's there). */
  colliders: Collider[];
  /** Parts of it that are somebody else's (a seated worker) and stay as they are when it's drawn in a tint. */
  untinted?: THREE.Object3D[];
  /** Puts it at `pose`, or takes it out of the floor (null), and its colliders in the floor's list or out of it. `held`: carried about: drawn there, but nobody bumps into it or uses it. */
  place(pose: Pose | null, held?: boolean): void;
  /** Shows it even while it's put away (a bean bag nobody needs yet), or lets it go again. */
  reveal?(on: boolean): void;
}

/** Down on the street (see downstairs in ground.ts): what's built down there goes down with the street. */
export interface StreetSite extends Site {
  /**
   * The street under the floor, and what's in the way down there: on a floor above the bottom one,
   * all of it is that many storeys further down (see Office.setLevel).
   */
  readonly ground: THREE.Group;
  readonly groundColliders: Collider[];
}

/** What a fixture hands back once it's built. `K` names the fields of Office it gives (see OfficeHandles). */
export interface Built<K extends keyof OfficeHandles = never> {
  /** The fields of Office it gives. */
  handle?: Pick<OfficeHandles, K>;
  /** Its group, added to the floor's. */
  group?: THREE.Object3D;
  /** What's in the way and what there is to use, added to the floor's. */
  colliders?: readonly Collider[];
  interactables?: readonly Interactable[];
  /** Animates it, each frame (see Office.update). */
  update?(t: number, dt: number): void;
  /** You're on floor `index` of a building `count` floors tall (see Office.setLevel). */
  setLevel?(index: number, count: number, wings: readonly number[]): void;
}

/** One part of the office floor: it builds itself into the site, and says what it gives the office. */
export type Fixture<K extends keyof OfficeHandles = never, S extends Site = Site> = (site: S) => Built<K>;

/** The fields of Office fixture `F` gives it (see Built.handle). Any fixture at all is a Fixture (giving nothing, as far as it's known). */
export type Gives<F> = F extends (site: never) => { handle?: infer H } ? keyof NonNullable<H> : never;
