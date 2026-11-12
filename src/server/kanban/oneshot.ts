// One-shot Claude runs: a single prompt to Claude Code, no tools, no session, one answer (the task prompt
// drafted from an issue). Like the worker-naming run in server/tasks.ts. Claude only: Codex can't switch its
// tools off (`exec --sandbox read-only` still runs shell commands), and the issue text is not to be trusted.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type OneShotResult = { text: string } | { error: string };

export const ONESHOT_TIMEOUT_MS = 45_000;
const REASON_MAX = 200;

/** The arguments of a run; the prompt goes in on stdin and the system text in `systemFile`, so every argument is a plain token. */
export function oneShotCommand(model: string | undefined, systemFile: string): { args: string[] } {
  return {
    args: [
      '-p',
      ...(model ? ['--model', model] : []),
      '--output-format', 'json',
      '--system-prompt-file', systemFile,
      '--tools', '',
      // Not the user's or the project's settings: no hooks, no MCP servers, no plugins, no transcript.
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ],
  };
}

export type SpawnPlan = { file: string; args: string[]; windowsVerbatimArguments?: boolean } | { error: string };

/**
 * What to spawn for `cmd args`. On Windows a `.cmd`/`.bat` (the npm shim) can't be started directly, so it goes
 * through cmd.exe with every token in double quotes; characters cmd.exe would still act on inside them are refused.
 */
export function spawnPlan(cmd: string, args: string[], windows: boolean = process.platform === 'win32', comSpec: string = process.env.ComSpec || 'cmd.exe'): SpawnPlan {
  if (!windows || !/\.(cmd|bat)$/i.test(cmd)) return { file: cmd, args };
  const all = [cmd, ...args];
  if (all.some((a) => /["%\r\n]/.test(a))) return { error: 'The agent is a .cmd file and an argument has a character cmd.exe would misread' };
  // A backslash run before the closing quote is doubled so it can't escape it.
  const quote = (a: string) => `"${a.replace(/(\\+)$/, '$1$1')}"`;
  return { file: comSpec, args: ['/d', '/s', '/c', `"${all.map(quote).join(' ')}"`], windowsVerbatimArguments: true };
}

export interface OneShotOptions {
  /** The agent's binary. */
  cmd: string;
  model?: string;
  system: string;
  input: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface OneShotRun {
  /** Never rejects. */
  done: Promise<OneShotResult>;
  /** Ends the run; `done` then resolves to `{ error: 'cancelled' }`. */
  kill(): void;
}

const clip = (s: string) => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s);
const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

export function runOneShot(o: OneShotOptions): OneShotRun {
  let stop: (() => void) | undefined;
  let cancelled = false;
  const win = process.platform === 'win32';
  const done = (async (): Promise<OneShotResult> => {
    // The system text goes in a file of a fresh folder, so no argument carries text (a .cmd shim can't take it safely).
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), 'kanban-oneshot-'));
      const file = path.join(dir, 'system.txt');
      await writeFile(file, o.system, 'utf8');
      if (cancelled) return { error: 'cancelled' };
      const plan = spawnPlan(o.cmd, oneShotCommand(o.model, file).args);
      if ('error' in plan) return plan;
      const res = await new Promise<{ code: number | null; out: string; err: string; error?: string }>((resolve) => {
        let out = '';
        let err = '';
        let settled = false;
        const finish = (v: { code: number | null; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ...v, out, err });
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(plan.file, plan.args, {
            // The temp dir, away from any project and its CLAUDE.md.
            cwd: os.tmpdir(),
            env: { ...o.env, MAX_THINKING_TOKENS: '0' },
            stdio: ['pipe', 'pipe', 'pipe'],
            // A group of its own (not on Windows), so whatever the agent started ends with it.
            detached: !win,
            ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            windowsHide: true,
          });
        } catch (e) {
          return resolve({ code: null, out, err, error: (e as Error).message });
        }
        /** Ends the agent and what it started, and answers now: a grandchild holding the pipes open must not keep the run waiting. */
        const end = (error: string) => {
          try {
            if (win) {
              // child.kill() would end only cmd.exe, not the node process under it, and ending cmd.exe first
              // would leave taskkill no tree to walk: it is only what's left when taskkill can't start.
              if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL')).unref();
              else child.kill('SIGKILL');
            } else if (child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          finish({ code: null, error });
        };
        const timer = setTimeout(() => end('took too long'), o.timeoutMs ?? ONESHOT_TIMEOUT_MS);
        stop = () => end('cancelled');
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (d: string) => (out += d));
        // Only the tail of stderr matters (the reason is its last line).
        child.stderr?.on('data', (d: string) => (err = (err + d).slice(-2000)));
        child.on('error', (e) => finish({ code: null, error: e.message }));
        child.on('close', (code) => finish({ code }));
        child.stdin?.on('error', () => {});
        child.stdin?.end(o.input);
      });
      if (cancelled) return { error: 'cancelled' };
      if (res.error) return { error: clip(res.error) };
      // Claude says why in its JSON even when it exits with an error (a limit reached, an unknown model): that reads better than stderr's last line.
      if (res.code !== 0) {
        try {
          const j = JSON.parse(res.out) as { result?: unknown };
          if (typeof j.result === 'string' && j.result.trim()) return { error: clip(j.result.trim()) };
        } catch {
          // no JSON: stderr it is
        }
        return { error: clip(lastLine(res.err) || `exited with code ${res.code}`) };
      }
      try {
        const j = JSON.parse(res.out) as { result?: unknown; is_error?: unknown };
        if (j.is_error || typeof j.result !== 'string') return { error: clip(typeof j.result === 'string' && j.result ? j.result : 'no answer') };
        return { text: j.result };
      } catch {
        return { error: 'unreadable answer' };
      }
    } catch (e) {
      return { error: clip((e as Error).message || 'failed') };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return {
    done,
    kill() {
      cancelled = true;
      stop?.();
    },
  };
}

const LOOK_AGAIN_MS = 60_000;

/**
 * `resolve` (which may run a login shell, see resolveCommand) looked up on first need and cached;
 * a miss is looked for again after a minute, never on every request.
 */
export function cachedClaudeBin(resolve: () => string | null, now: () => number = Date.now): () => string | null {
  let seen: { path: string | null; at: number } | undefined;
  return () => {
    if (seen && (seen.path !== null || now() - seen.at < LOOK_AGAIN_MS)) return seen.path;
    seen = { path: resolve(), at: now() };
    return seen.path;
  };
}
