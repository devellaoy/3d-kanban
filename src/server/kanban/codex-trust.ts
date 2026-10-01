// Trusting the office's own Codex hooks (docs/fork.md, "Codex hook trust"): the hook command names
// each floor's own path and Codex keeps one trusted hash per event, so a worker moving between
// projects would stop at "Hooks need review". The hashes go on the command line instead, for the
// office's hooks only: the user's and the project's own hooks still need review.
import { createHash } from 'node:crypto';
import { CODEX_HOOK_EVENTS } from '../codex.js';

const shellQuote = (v: string) => `'${v.replaceAll("'", "'\"'\"'")}'`; // as upstream's codex.ts

/** The command codexHookArgs gives an event's hook. */
export function officeHookCommand(hookPath: string, event: string): string {
  return [process.execPath, hookPath, event].map(shellQuote).join(' ');
}

const snake = (event: string) => event.replace(/(?<=[a-z])(?=[A-Z])/g, '_').toLowerCase();

/** JSON with every object's keys sorted, as Codex's version_for_toml makes it. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)])) : v;

/** Codex's hook_hash for an event's one command hook (timeout 3, as codexHookArgs): sha256 of its sorted-key JSON identity. */
export function hookTrustHash(label: string, command: string): string {
  const identity = { event_name: label, hooks: [{ type: 'command', command, timeout: 3, async: false }] };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;
}

/** Where Codex says the session flags' hooks come from (its synthetic_layer_path: resolved against `C:\` on Windows, `/` elsewhere). */
export function sessionFlagsSource(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml';
}

/** `-c hooks.state={…}` marking the office's hooks for this hook path trusted (their key is the session flags' config). */
export function codexHookTrustArgs(hookPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const source = sessionFlagsSource(platform);
  const entries = CODEX_HOOK_EVENTS.map((event) => {
    const label = snake(event);
    return `${JSON.stringify(`${source}:${label}:0:0`)}={trusted_hash=${JSON.stringify(hookTrustHash(label, officeHookCommand(hookPath, event)))}}`;
  });
  return ['-c', `hooks.state={${entries.join(',')}}`];
}
