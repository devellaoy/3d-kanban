// Azure DevOps and Bitbucket tokens: per account and the office's own, checked with the host when
// set, kept readable by the office alone, and never sent back to a browser (server/hosting/credentials.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authOf, HostCredentials } from '../src/server/hosting/credentials.js';
import type { HostAs, HostingProvider } from '../src/server/hosting/provider.js';

const TOKEN = 'a'.repeat(52);

function store(whoAmI: (as: HostAs) => Promise<string> = async () => 'Jane Doe') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hosting-creds-'));
  const seen: HostAs[] = [];
  const orgs: (string | undefined)[] = [];
  const provider = { whoAmI: async (as: HostAs, _f: unknown, o?: { org?: string }) => (seen.push(as), orgs.push(o?.org), whoAmI(as)) } as unknown as HostingProvider;
  return { dir, seen, orgs, creds: new HostCredentials(dir, { azure: provider, bitbucket: provider }) };
}

test('a token is checked with the host, kept with whom it belongs to, readable by the office alone', async () => {
  const { dir, seen, creds } = store();
  assert.equal(await creds.set('acc123456', { kind: 'azure', token: TOKEN, org: 'contoso' }), undefined);
  assert.equal(seen[0].auth, `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`, "Azure DevOps: the PAT as Basic auth's password");
  const file = path.join(dir, 'homes', 'acc123456', 'hosting.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(creds.load('acc123456').azure, { token: TOKEN, org: 'contoso', who: 'Jane Doe' });
  const as = creds.as('acc123456', 'azure');
  assert.ok(typeof as === 'object');
  assert.equal(as.key, 'acc123456');
  assert.equal(as.who, 'Jane Doe');
});

test('Bitbucket takes the Atlassian e-mail with an API token, as Basic auth', async () => {
  const { creds, seen } = store();
  assert.match(String(await creds.set('acc123456', { kind: 'bitbucket', token: TOKEN })), /e-mail/);
  assert.equal(await creds.set('acc123456', { kind: 'bitbucket', token: TOKEN, email: 'jane@example.com' }), undefined);
  assert.equal(seen[0].auth, `Basic ${Buffer.from(`jane@example.com:${TOKEN}`).toString('base64')}`);
  assert.equal(authOf('bitbucket-server', { token: TOKEN }), `Bearer ${TOKEN}`);
});

test("a token the host turns down, or that doesn't look like one, isn't kept", async () => {
  const { creds } = store(async () => {
    throw new Error('Your Azure DevOps sign-in stopped working: set a new token in ☰ → 🔐 Your sign-ins');
  });
  assert.match(String(await creds.set('acc123456', { kind: 'azure', token: TOKEN, org: 'contoso' })), /Azure DevOps turned that token down/);
  assert.match(String(await creds.set('acc123456', { kind: 'azure', token: 'short', org: 'contoso' })), /doesn't look like/);
  assert.match(String(await creds.set('acc123456', { kind: 'azure', token: `${TOKEN}\nmore`, org: 'contoso' })), /doesn't look like/);
  assert.match(String(await creds.set('acc123456', { kind: 'bitbucket-server', token: TOKEN })), /isn't supported yet/);
  assert.deepEqual(creds.load('acc123456'), {});
  assert.throws(() => creds.file('../evil'), /Not an account id/);
});

test("whose credentials: the account's own, else the office's, else why not", async () => {
  const { creds } = store();
  assert.match(String(creds.as('acc123456', 'azure')), /Set your Azure DevOps token first/);
  assert.match(String(creds.as(undefined, 'azure')), /The office has no Azure DevOps token/);
  await creds.set(null, { kind: 'azure', token: TOKEN, org: 'contoso' });
  assert.equal((creds.as('acc123456', 'azure') as HostAs).key, 'office');
  assert.equal((creds.as(undefined, 'azure') as HostAs).key, 'office');
  await creds.set('acc123456', { kind: 'azure', token: 'b'.repeat(52), org: 'contoso' });
  assert.equal((creds.as('acc123456', 'azure') as HostAs).key, 'acc123456');
  creds.clear(null, 'azure');
  assert.equal((creds.as('acc654321', 'azure') as string).startsWith('Set your'), true);
});

test('the boards read with the office’s, else the account that set its own most recently', async () => {
  const { dir, creds } = store();
  assert.equal(creds.anyAs('bitbucket'), undefined);
  for (const [id, at] of [['older00001', 1_000], ['newer00002', 2_000]] as const) {
    const home = path.join(dir, 'homes', id);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'hosting.json'), JSON.stringify({ bitbucket: { token: TOKEN, email: 'a@b.c' } }));
    utimesSync(path.join(home, 'hosting.json'), at, at);
  }
  assert.equal(creds.anyAs('bitbucket')?.key, 'newer00002');
  await creds.set(null, { kind: 'bitbucket', token: TOKEN, email: 'office@b.c' });
  assert.equal(creds.anyAs('bitbucket')?.key, 'office');
});

test('a browser learns whether a token is set and whose, never the token', async () => {
  const { creds } = store();
  await creds.set('acc123456', { kind: 'bitbucket', token: TOKEN, email: 'jane@example.com' });
  await creds.set(null, { kind: 'azure', token: TOKEN, org: 'contoso' });
  const state = creds.state('acc123456', true);
  assert.ok(!JSON.stringify(state).includes(TOKEN));
  assert.deepEqual(state.hosts, [
    { kind: 'azure', office: { who: 'Jane Doe', org: 'contoso' } },
    { kind: 'bitbucket', mine: { who: 'Jane Doe', email: 'jane@example.com' } },
  ]);
  assert.equal(state.admin, true);
});

test('Bitbucket Server hosts: host names only, a few', () => {
  const { creds } = store();
  assert.equal(creds.setServerHosts(['https://Git.Example.com/', 'git.example.com', 'bb.local:7990']), undefined);
  assert.deepEqual(creds.serverHosts(), ['git.example.com', 'bb.local:7990']);
  assert.match(String(creds.setServerHosts(['not a host'])), /isn't a host name/);
  assert.match(String(creds.setServerHosts('x')), /Up to/);
});

test('Azure DevOps: the organization the PAT is for is asked for, and the token is checked there', async () => {
  const { creds, orgs } = store();
  assert.match(String(await creds.set('acc123456', { kind: 'azure', token: TOKEN })), /needs the organization/);
  assert.match(String(await creds.set('acc123456', { kind: 'azure', token: TOKEN, org: 'not an org!' })), /needs the organization/);
  assert.equal(await creds.set('acc123456', { kind: 'azure', token: TOKEN, org: 'https://dev.azure.com/contoso/Web' }), undefined);
  assert.deepEqual(orgs, ['contoso']);
  assert.equal(creds.load('acc123456').azure?.org, 'contoso');
});

test("git's environment for a push elsewhere: the office's helper with the account's tokens, then the office's", () => {
  const { dir, creds } = store();
  assert.deepEqual(creds.gitEnv({ A: '1' }, 'acc123456'), { A: '1' }, 'no helper installed: unchanged');
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'bin', 'office-git-credential'), '');
  const env = creds.gitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' }, 'acc123456');
  assert.equal(env.GIT_CONFIG_COUNT, '7', 'the one there, and a reset and a helper per host');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.x');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://dev.azure.com.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '', "the machine's own helpers for the host are left out");
  assert.equal(env.GIT_CONFIG_VALUE_2, `!'${path.join(dir, 'bin', 'office-git-credential')}' '${path.join(dir, 'homes', 'acc123456', 'hosting.json')}' '${path.join(dir, 'hosting-secrets.json')}'`);
  assert.equal(env.GIT_CONFIG_KEY_5, 'credential.https://bitbucket.org.helper');
  assert.ok(!creds.gitEnv({}, undefined).GIT_CONFIG_VALUE_1!.includes('homes'), "without an account, only the office's");
});
