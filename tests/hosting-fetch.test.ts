// The office's fetch of a worktree's base branch reads a private repository on Azure DevOps or
// Bitbucket over HTTPS with the tokens set in the office (worktrees.ts fetchEnv), with nothing stored
// on the machine: git asks the office's credential helper, which answers from hosting-secrets.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openHosting } from '../src/server/hosting/index.js';
import { fetchEnv } from '../src/server/worktrees.js';

const HELPER = path.join(import.meta.dirname, '..', 'bin', 'office-git-credential.js');

test("git's credentials for the base branch's fetch come from the office's tokens, not the machine's", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hosting-fetch-'));
  const data = path.join(root, 'data');
  mkdirSync(path.join(data, 'bin'), { recursive: true });
  // The command writeOfficeCommands puts there: the helper run with the office's node.
  const command = path.join(data, 'bin', 'office-git-credential');
  writeFileSync(command, `#!/bin/sh\nexec '${process.execPath}' '${HELPER}' "$@"\n`);
  chmodSync(command, 0o700);
  writeFileSync(path.join(data, 'hosting-secrets.json'), JSON.stringify({ bitbucket: { token: 'bb-office-token', email: 'o@x.y' }, azure: { token: 'az-office-token', org: 'contoso' } }), { mode: 0o600 });
  // An account's own token comes after the office's for a read nobody in particular asked for.
  mkdirSync(path.join(data, 'homes', 'acc123456'), { recursive: true });
  writeFileSync(path.join(data, 'homes', 'acc123456', 'hosting.json'), JSON.stringify({ bitbucket: { token: 'bb-account-token' } }));
  openHosting(data);
  // A machine with no git credentials of its own: an empty home, no system or global config.
  const home = path.join(root, 'home');
  mkdirSync(home);
  const env = fetchEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'none') });
  assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'never waits for a password');
  const fill = (host: string) => execFileSync('git', ['credential', 'fill'], { env, input: `protocol=https\nhost=${host}\npath=acme/widget.git\n\n`, encoding: 'utf8' });
  assert.match(fill('bitbucket.org'), /username=x-bitbucket-api-token-auth\npassword=bb-office-token\n/);
  assert.match(fill('dev.azure.com'), /password=az-office-token\n/);
  // GitHub is left to the machine as before: no answer from the office's helper (and no prompt).
  assert.throws(() => fill('github.com'));
});
