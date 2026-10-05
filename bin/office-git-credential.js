#!/usr/bin/env node
// office-git-credential: git's credential helper for Azure DevOps and Bitbucket, so a push over HTTPS
// goes out with the same token the office acts with there (see src/server/hosting/credentials.ts and
// gitconfig.ts). An account's git config runs it as
//   office-git-credential <the account's hosting.json> <the office's hosting-secrets.json> get
// and it answers with the first of those files that has a token for the host asked about; for any
// other host, or another operation (store, erase), it says nothing and git asks the next helper.
// Plain Node, no build step, no dependencies.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Which saved credential a host's push uses, and the user name git sends with it. */
export function hostKind(host) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com')) return { kind: 'azure', username: 'office' };
  if (h === 'bitbucket.org') return { kind: 'bitbucket', username: 'x-bitbucket-api-token-auth' };
  return undefined;
}

/** git's key=value lines. */
export function parseRequest(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

/** The answer for a request, from the saved files in order; '' when there's none. */
export function answer(request, files, read = (f) => readFileSync(f, 'utf8')) {
  if (request.protocol !== 'https') return '';
  const host = hostKind(request.host);
  if (!host) return '';
  for (const f of files) {
    let saved;
    try {
      saved = JSON.parse(read(f));
    } catch {
      continue;
    }
    const token = saved?.[host.kind]?.token;
    // A token never has a line break in it: one that did could add lines of its own to the answer.
    if (typeof token === 'string' && token && !/[\r\n\0]/.test(token)) return `username=${host.username}\npassword=${token}\n`;
  }
  return '';
}

async function main(argv) {
  const op = argv.at(-1);
  const files = argv.slice(0, -1);
  if (op !== 'get') return;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  process.stdout.write(answer(parseRequest(Buffer.concat(chunks).toString('utf8')), files));
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) await main(process.argv.slice(2));
