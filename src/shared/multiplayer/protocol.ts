// Multiplayer messages between a browser and its own office, riding the office's socket (see
// ClientMsg/ServerMsg in shared/protocol.ts). The office↔relay wire is wire.ts, not this.

/** A person on the relay, as the player list shows them. */
export interface MpPlayer {
  /** GitHub login, in its own case. */
  login: string;
  name?: string;
  online: boolean;
  /** In their own office, or visiting someone's. */
  where: 'home' | { visiting: string };
  /** The name of the floor they are on, only once a probe told this office (and so this viewer) the name. */
  floor?: string;
  /** This office's own owner. */
  me?: boolean;
}

/** One of the owner's own floors, for the share switches; sent to the own office's admin browser only. */
export interface MpFloorShare {
  /** The floor id. */
  id: string;
  name: string;
  shared: boolean;
  /** Whether it can be shared at all (it needs GitHub remotes); `why` says why not. */
  shareable: boolean;
  why?: string;
}

export interface MpState {
  status: 'off' | 'connecting' | 'online' | 'error';
  /** The relay's URL as saved (never the password). */
  url: string;
  /** A relay address is saved. Going online still needs a password and a GitHub sign-in; the status and `error` say when one is missing. */
  configured: boolean;
  /** The player chose to be offline: the settings stay saved, the office just isn't connected (and does not reconnect). */
  offline: boolean;
  passwordSet: boolean;
  /** Connecting waits for a GitHub sign-in (there is no token yet, or the relay refused it): offer the device flow. */
  needsIdentity?: boolean;
  /** The GitHub login this office is known as on the relay. */
  login?: string;
  /** A GitHub device-flow sign-in under way: type `code` at `url` before `expiresAt` (ms since epoch). */
  device?: { code: string; url: string; expiresAt: number };
  error?: string;
  players: MpPlayer[];
  floors: MpFloorShare[];
}

export type MpClientMsg =
  /** Connect to a relay; the password is saved when given and kept when left out. Admins only. */
  | { t: 'mp.connect'; url: string; password?: string }
  /** Go online with the saved settings, or offline (keeping them) and work in the own office alone. Admins only. */
  | { t: 'mp.online'; on: boolean }
  /** Sign in to GitHub (device flow) so the relay knows who this office is. */
  | { t: 'mp.identity.start' }
  | { t: 'mp.identity.cancel' }
  /** Forget the GitHub account: deletes the stored token and disconnects. Admins only. */
  | { t: 'mp.identity.forget' }
  /** Share a floor (or stop sharing it) with the relay's players. Off by default. */
  | { t: 'mp.share'; floor: string; on: boolean }
  /** This browser has the player list open (`mp.watch`) or closed: the office only probes while someone watches. */
  | { t: 'mp.watch' }
  | { t: 'mp.unwatch' }
  /** Which of a player's floors can I enter? Answered with mp.probe.res. */
  | { t: 'mp.probe'; to: string };

export type MpServerMsg =
  | { t: 'mp.state'; state: MpState }
  /** The floors `to` shows this viewer, as the owner's office named them (key is the owner's opaque floorKey). */
  | { t: 'mp.probe.res'; to: string; floors: { key: string; name: string }[] }
  /** A visit ended (the owner left, refused, or the link dropped); the browser goes back to its own office. */
  | { t: 'mp.ended'; reason: string };
