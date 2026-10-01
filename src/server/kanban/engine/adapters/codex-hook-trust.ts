// Whether the installed Codex knows `--dangerously-bypass-hook-trust` (older ones fail on an unknown flag),
// found once from `codex --help` when the office starts.
import { execFile } from 'node:child_process';
import { defaultShell, resolveCommand, shellRun } from '../../../workers/process.js';

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

/** Runs `codex --help` the way workers start codex (directly, else through the login shell) and caches whether it names the flag. */
export function probeCodexHookTrust(): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string, stderr: string) => {
      const ok = !err && helpMentionsHookTrust(`${stdout}\n${stderr}`);
      if (!err && !ok) console.warn(`agent-office: this Codex has no ${FLAG}: its task workers may stop at Codex's "Hooks need review" screen`);
      setCodexHookTrust(ok);
      resolve(ok);
    };
    const opts = { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' as const };
    try {
      const bin = resolveCommand('codex');
      // Node runs a Windows .cmd/.bat shim (npm's codex.cmd) only through a shell.
      if (bin) execFile(bin, ['--help'], { ...opts, shell: /\.(?:cmd|bat)$/i.test(bin) }, done);
      else execFile(defaultShell(), shellRun('exec codex --help'), opts, done);
    } catch {
      done(new Error('spawn failed'), '', '');
    }
  });
}
