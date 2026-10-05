import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubVerifier, TokenRejected } from '../src/server/multiplayer/github-user.js';

const answer = (status: number, body: unknown = {}) => (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

test('GitHub saying 401 rejects the token; every other trouble is a plain error', async () => {
  await assert.rejects(githubVerifier({ fetch: answer(401) }).login('t'), TokenRejected);
  for (const status of [500, 502, 403, 429]) {
    await assert.rejects(githubVerifier({ fetch: answer(status) }).login('t'), (err: Error) => !(err instanceof TokenRejected) && /GitHub answered/.test(err.message), String(status));
  }
  const down = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  await assert.rejects(githubVerifier({ fetch: down }).login('t'), (err: Error) => !(err instanceof TokenRejected));
});

test('a 200 gives the login, and a 200 without one rejects the token', async () => {
  assert.equal(await githubVerifier({ fetch: answer(200, { login: 'alice' }) }).login('t'), 'alice');
  await assert.rejects(githubVerifier({ fetch: answer(200, {}) }).login('t'), TokenRejected);
});
