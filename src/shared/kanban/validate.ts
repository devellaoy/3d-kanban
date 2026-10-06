// The kanban protocol's limits and the field validators its parsers are built from. They live apart
// from protocol.ts (and issueops.ts) so both can use them without importing each other.

import { DESK_BY_ID } from '../layout.js';
// A pull request's repository as the office names it, on any host (shared/hosting/remote.ts).
export { isRepoName } from '../hosting/remote.js';

/** A request may carry `rid`; the server answers it exactly once. */
export type Req<T> = T & { rid?: string };

export const KANBAN_LIMITS = {
  rid: 64,
  title: 300,
  description: 100_000,
  comment: 50_000,
  answer: 50_000,
  /** Room for the longest keys the issue sources make: `gh:<owner>/<name>#<n>` takes GH_REPO_RE's 201 characters and more. */
  ticket: 400,
  url: 2000,
  goal: 20_000,
  tag: 40,
  tags: 20,
  model: 100,
  attachments: 20,
  repoIds: 16,
  /** The same keys as ticket. */
  issueKey: 400,
  branch: 200,
  promptText: 20_000,
  secret: 4096,
  commentsPage: 200,
  /** owner/name (GH_REPO_RE, up to 201 characters) or a GitHub URL of it. */
  remote: 300,
  /**
   * How big a settings object the browser may send, as JSON. A project's settings hold three
   * instruction texts and a rewrite of every kanban prompt (PROMPT_MAX each), and JSON can double
   * that with escapes; still under the office's 2 MB WebSocket messages.
   */
  settingsJson: 1_500_000,
} as const;

/** A floor id (see Building.newDef). */
export const PROJECT_ID_RE = /^[a-z0-9-]{1,40}$/;
/** A person's id: a Jira account id (`712020:ab-cd`, `557058:…`), or a GitHub login. */
export const PERSON_ID_RE = /^[\w:@.-]{1,200}$/;
/** Claude aliases (opus, sonnet[1m]) and Codex ids (gpt-5.1-codex), nothing that looks like a flag. */
export const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]-]{0,99}$/;

// --- Validators -----------------------------------------------------------------------------------

export class Bad extends Error {}
export const bad = (why: string): never => {
  throw new Bad(why);
};

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export function text(v: unknown, name: string, max: number, opts: { empty?: boolean } = {}): string {
  if (typeof v !== 'string') bad(`${name} must be text`);
  const s = (v as string).replace(/\r\n?/g, '\n');
  if (s.length > max) bad(`${name} is too long (at most ${max.toLocaleString('en-US')} characters)`);
  if (!opts.empty && !s.trim()) bad(`${name} can't be empty`);
  return s;
}
export function optText(v: unknown, name: string, max: number): string | undefined {
  return v === undefined ? undefined : text(v, name, max, { empty: true });
}
/** undefined: leave it; null: clear it. */
export function nullableText(v: unknown, name: string, max: number): string | null | undefined {
  if (v === null) return null;
  return optText(v, name, max);
}
export function id(v: unknown, name = 'id'): number {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) bad(`${name} must be a task number`);
  return v as number;
}
export function workerId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 100) bad('workerId must be a worker id');
  return v as string;
}
export function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return v as number;
}
export function bool(v: unknown, name: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') bad(`${name} must be true or false`);
  return v as boolean;
}
export function oneOf<T extends string>(v: unknown, name: string, all: readonly T[]): T {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) bad(`${name} must be one of ${all.join(', ')}`);
  return v as T;
}
export function optOneOf<T extends string>(v: unknown, name: string, all: readonly T[]): T | undefined {
  return v === undefined ? undefined : oneOf(v, name, all);
}
export function project(v: unknown): string {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('project must be a floor id');
  return v as string;
}
/** A seat a task's worker can be hired at: a desk or bean bag of the layout, not a board agent's kiosk, a meeting chair or a reviewer's spot behind a seat. */
export function deskId(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const desk = typeof v === 'string' && v.length <= 40 ? DESK_BY_ID.get(v) : undefined;
  if (!desk || desk.station || desk.room || desk.watch) bad('deskId must be a desk of the floor');
  return v as string;
}
export function model(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !MODEL_RE.test(v)) bad('model must be a model id like opus or gpt-5-codex');
  return v as string;
}
export function list<T>(v: unknown, name: string, max: number, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) bad(`${name} must be a list`);
  const arr = v as unknown[];
  if (arr.length > max) bad(`${name} can have at most ${max} entries`);
  return [...new Set(arr.map(item))];
}
