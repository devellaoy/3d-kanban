// Whether the installed Codex knows `--dangerously-bypass-hook-trust` (older ones fail on an unknown flag),
// found once from `codex --help` when the office starts.
import { execFile, type ExecFileOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { WIN, defaultShell, shellRun } from '../../../workers/process.js';

const FLAG = '--dangerously-bypass-hook-trust';
let bypasses = false;

export function codexBypassesHookTrust(): boolean {
  return bypasses;
}

/** For tests and the probe; undefined is the default (not known, so not passed). */
export function setCodexHookTrust(v: boolean | undefined): void {
  bypasses = v ?? false;
}

export function helpMentionsHookTrust(help: string): boolean {
  return help.includes(FLAG);
}

type Exec = (file: string, args: string[], opts: ExecFileOptions, cb: (err: unknown, stdout: string, stderr: string) => void) => unknown;
type Deps = { find?: (cmd: string) => Promise<string | null>; exec?: Exec };

/** resolveCommand's PATH scan without its blocking login-shell fallback. */
async function findOnPath(cmd: string): Promise<string | null> {
  const exts = WIN && !path.extname(cmd) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd) + ext;
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** Runs `codex --help` the way workers start codex (directly, else through the login shell) and caches whether it names the flag. Never blocks the event loop. */
export function probeCodexHookTrust(deps: Deps = {}): Promise<boolean> {
  const find = deps.find ?? findOnPath;
  const exec = deps.exec ?? (execFile as unknown as Exec);
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string, stderr: string) => {
      const ok = !err && helpMentionsHookTrust(`${stdout}\n${stderr}`);
      if (!err && !ok) console.warn(`agent-office: this Codex has no ${FLAG}: its task workers may stop at Codex's "Hooks need review" screen`);
      setCodexHookTrust(ok);
      resolve(ok);
    };
    const opts = { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' as const };
    find('codex')
      .then((bin) => {
        // Node runs a Windows .cmd/.bat shim (npm's codex.cmd) only through a shell.
        if (bin) exec(bin, ['--help'], { ...opts, shell: /\.(?:cmd|bat)$/i.test(bin) }, done);
        else exec(defaultShell(), shellRun('exec codex --help'), opts, done);
      })
      .catch(() => done(new Error('spawn failed'), '', ''));
  });
}
