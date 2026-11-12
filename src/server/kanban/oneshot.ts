// One-shot agent runs: a single prompt to Claude Code or Codex, no tools, no session, one answer
// (the task prompt drafted from an issue). Like the worker-naming run in server/tasks.ts, but for either tool.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type OneShotTool = 'claude' | 'codex';
export type OneShotResult = { text: string } | { error: string };

export const ONESHOT_TIMEOUT_MS = 45_000;
const REASON_MAX = 200;

/** The arguments of a run; the prompt goes in on stdin, and `outFile` is where Codex writes its last message. */
export function oneShotCommand(tool: OneShotTool, model: string | undefined, system: string, outFile: string): { args: string[] } {
  if (tool === 'claude') {
    return {
      args: [
        '-p',
        ...(model ? ['--model', model] : []),
        '--output-format', 'json',
        '--system-prompt', system,
        '--tools', '',
        // Not the user's or the project's settings: no hooks, no MCP servers, no plugins, no transcript.
        '--setting-sources', '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
      ],
    };
  }
  // Codex has no system-prompt flag: the instructions go in front of the input on stdin.
  return { args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', ...(model ? ['-m', model] : []), '-o', outFile, '-'] };
}

export interface OneShotOptions {
  /** The agent's binary. */
  cmd: string;
  tool: OneShotTool;
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
  const done = (async (): Promise<OneShotResult> => {
    // Codex works in a folder of its own, empty, which also holds its answer; Claude in the temp dir, away from any CLAUDE.md.
    let dir: string | undefined;
    try {
      if (o.tool === 'codex') dir = await mkdtemp(path.join(os.tmpdir(), 'kanban-oneshot-'));
      if (cancelled) return { error: 'cancelled' };
      const outFile = dir ? path.join(dir, 'answer.txt') : '';
      const { args } = oneShotCommand(o.tool, o.model, o.system, outFile);
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
          child = spawn(o.cmd, args, {
            cwd: dir ?? os.tmpdir(),
            env: o.tool === 'claude' ? { ...o.env, MAX_THINKING_TOKENS: '0' } : o.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            // A group of its own (not on Windows), so whatever the agent started ends with it.
            detached: process.platform !== 'win32',
          });
        } catch (e) {
          return resolve({ code: null, out, err, error: (e as Error).message });
        }
        /** Ends the agent and what it started, and answers now: a grandchild holding the pipes open must not keep the run waiting. */
        const end = (error: string) => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
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
        child.stdin?.end(o.tool === 'codex' ? `${o.system}\n\n${o.input}` : o.input);
      });
      if (cancelled) return { error: 'cancelled' };
      if (res.error) return { error: clip(res.error) };
      // Claude says why in its JSON even when it exits with an error (a limit reached, an unknown model): that reads better than stderr's last line.
      if (o.tool === 'claude' && res.code !== 0) {
        try {
          const j = JSON.parse(res.out) as { result?: unknown };
          if (typeof j.result === 'string' && j.result.trim()) return { error: clip(j.result.trim()) };
        } catch {
          // no JSON: stderr it is
        }
      }
      if (res.code !== 0) return { error: clip(lastLine(res.err) || `exited with code ${res.code}`) };
      if (o.tool === 'codex') {
        const text = await readFile(outFile, 'utf8').catch(() => '');
        return text.trim() ? { text } : { error: 'wrote nothing' };
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
 * `resolve` (which may run a login shell, see resolveCommand) per tool, looked up on first need and cached;
 * a miss is looked for again after a minute, never on every request.
 */
export function cachedAgentBin(resolve: (tool: OneShotTool) => string | null, now: () => number = Date.now): (tool: OneShotTool) => string | null {
  const seen = new Map<OneShotTool, { path: string | null; at: number }>();
  return (tool) => {
    const was = seen.get(tool);
    if (was && (was.path !== null || now() - was.at < LOOK_AGAIN_MS)) return was.path;
    const path = resolve(tool);
    seen.set(tool, { path, at: now() });
    return path;
  };
}
