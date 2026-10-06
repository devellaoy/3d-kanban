// gates.withHosts: the credentials for work on checkouts that may each be on another host. GitHub's
// sign-in only when one of them is on GitHub; each other host's token as the asker's (else the
// office's), and git set up to push there with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gates } from '../src/server/office/gates.js';
import { forgetRemotes, openHosting } from '../src/server/hosting/index.js';
import type { Ctx } from '../src/server/office/context.js';
import type { Client } from '../src/server/office/client.js';
import type { HostPick } from '../src/server/hosting/provider.js';

const AZ_REPO = { host: 'azure' as const, owner: 'contoso' };

function checkout(root: string, name: string, url: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
  return dir;
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hosting-gates-'));
  const data = path.join(root, 'data');
  mkdirSync(path.join(data, 'bin'), { recursive: true });
  writeFileSync(path.join(data, 'bin', 'office-git-credential'), '');
  // The office has an Azure DevOps token; nobody has a Bitbucket one.
  writeFileSync(path.join(data, 'hosting-secrets.json'), JSON.stringify({ azure: { token: 'x'.repeat(52), org: 'contoso', who: 'Office' } }), { mode: 0o600 });
  openHosting(data);
  forgetRemotes();
  const dirs = {
    gh: checkout(root, 'gh', 'https://github.com/o/web.git'),
    az: checkout(root, 'az', 'https://dev.azure.com/contoso/Web/_git/api'),
    bb: checkout(root, 'bb', 'git@bitbucket.org:acme/ui.git'),
  };
  const githubAsked: string[] = [];
  const sent: unknown[] = [];
  const warned: string[] = [];
  const ctx = {
    signins: {
      githubReady: () => true,
      ghAs: (id: string) => (githubAsked.push(id), { key: id, env: { HOME: '/h', GIT_CONFIG_GLOBAL: `/homes/${id}/gitconfig` } }),
    },
    warn: (_c: Client, text?: string) => void (text && warned.push(text)),
    sendTo: (_c: Client, m: unknown) => void sent.push(m),
  } as unknown as Ctx;
  const g = gates(ctx);
  const c = { accountId: 'acc123456' } as Client;
  return { g, c, dirs, githubAsked, sent, warned };
}

test('only on Azure DevOps: no GitHub sign-in asked, the office’s token there, and git pushes with the helper as them', () => {
  const { g, c, dirs, githubAsked } = setup();
  let got: { as: unknown; hosts: HostPick } | undefined;
  g.withHosts(c, [dirs.az], (as, hosts) => (got = { as, hosts }));
  assert.ok(got);
  assert.equal(got.as, undefined);
  assert.equal(got.hosts.get(AZ_REPO)?.key, 'office');
  const env = got.hosts.git!;
  assert.equal(env.GIT_CONFIG_GLOBAL, '/homes/acc123456/gitconfig', 'their own git config (it may also carry their identity)');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.https://dev.azure.com.helper');
  assert.match(env.GIT_CONFIG_VALUE_1, /office-git-credential' '.*homes\/acc123456\/hosting\.json' '.*hosting-secrets\.json'$/, "the office's own push for them: their token, else the office's");
  assert.equal(env.GIT_CONFIG_KEY_2, 'credential.https://dev.azure.com.useHttpPath', 'the path names the organization');
  assert.deepEqual(githubAsked, ['acc123456'], 'read for their git environment only: no GitHub gate');
});

test('a GitHub repository and one on Azure DevOps: the GitHub sign-in and the Azure DevOps token both', () => {
  const { g, c, dirs } = setup();
  let got: { as: unknown; hosts: HostPick } | undefined;
  g.withHosts(c, [dirs.gh, dirs.az], (as, hosts) => (got = { as, hosts }));
  assert.deepEqual(got?.as, { key: 'acc123456', env: { HOME: '/h', GIT_CONFIG_GLOBAL: '/homes/acc123456/gitconfig' } }, "GitHub's as before, untouched");
  assert.equal(got?.hosts.get(AZ_REPO)?.key, 'office');
});

test('the host the work is on decides: a missing Bitbucket token is asked for, not a GitHub one', () => {
  const { g, c, dirs, sent, warned } = setup();
  let ran = false;
  const refused: string[] = [];
  g.withHosts(c, [dirs.gh, dirs.bb], () => (ran = true), (why) => refused.push(why));
  assert.equal(ran, false);
  assert.match(refused[0], /Set your Bitbucket token first/);
  assert.deepEqual(sent, [{ t: 'signins.needed', which: 'bitbucket', why: refused[0] }]);
  assert.deepEqual(warned, []);
  // A GitHub-only piece of work needs no other token.
  let plain: { hosts: HostPick } | undefined;
  g.withHosts(c, [dirs.gh], (_as, hosts) => (plain = { hosts }));
  assert.equal(plain?.hosts.git, undefined);
});

test('a repository in another Azure DevOps organization than the token’s is asked for its own, with why', () => {
  const { g, c, sent } = setup();
  const root = mkdtempSync(path.join(os.tmpdir(), 'hosting-gates-org-'));
  forgetRemotes();
  const other = checkout(root, 'fab', 'https://dev.azure.com/fabrikam/Web/_git/api');
  const refused: string[] = [];
  g.withHosts(c, [other], () => assert.fail('no token reaches fabrikam'), (why) => refused.push(why));
  assert.match(refused[0], /The office's Azure DevOps token is for contoso, and this is in fabrikam: set yours for fabrikam/);
  assert.equal((sent.at(-1) as { which: string }).which, 'azure');
});
