// 3d-kanban: YouTube on the Office TV. Telling YouTube links apart (shared/youtube/link.ts), what a
// floor's TV keeps (server/youtube/tv.ts), and the real office's messages: two browsers on a floor,
// the jukebox going quiet, a late joiner's welcome, the end of a video said once.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { YoutubeTv } from '../src/server/youtube/tv.js';
import { youtubeTvOf } from '../src/server/youtube/handlers.js';
import { youtubeTitles } from '../src/server/youtube/titles.js';
import { isYoutubeUrl, parseStart, parseYoutubeLink, youtubeTitle, youtubeUrl } from '../src/shared/youtube/link.js';
import type { ServerMsg } from '../src/shared/protocol.js';

const ID = 'dQw4w9WgXcQ';

// ---- Links ----------------------------------------------------------------------------------------

test('a YouTube link in any of its shapes is the video it points at', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&feature=share`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc123`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `  https://www.youtube.com/watch?v=${ID}  `,
  ]) {
    assert.deepEqual(parseYoutubeLink(url), { videoId: ID, start: 0 }, url);
    assert.equal(isYoutubeUrl(url), true, url);
  }
});

test('a start time from t=, start= or #t=, in the shapes YouTube writes it', () => {
  assert.equal((parseYoutubeLink(`https://youtu.be/${ID}?t=90`) as { start: number }).start, 90);
  assert.equal((parseYoutubeLink(`https://www.youtube.com/watch?v=${ID}&t=1m30s`) as { start: number }).start, 90);
  assert.equal((parseYoutubeLink(`https://www.youtube.com/embed/${ID}?start=42`) as { start: number }).start, 42);
  assert.equal((parseYoutubeLink(`https://www.youtube.com/watch?v=${ID}#t=1h2m3s`) as { start: number }).start, 3723);
  assert.equal(parseStart('90s'), 90);
  assert.equal(parseStart('01:30'), 90);
  assert.equal(parseStart('1:02:03'), 3723);
  assert.equal(parseStart('nonsense'), 0);
  assert.equal(parseStart('-5'), 0);
  assert.equal(parseStart('999999'), 86_400, 'at most a day in');
});

test('playlists: a playlist link, a video in one with index=, and mixes played as the video alone', () => {
  assert.deepEqual(parseYoutubeLink('https://www.youtube.com/playlist?list=PLabc123'), { list: 'PLabc123', index: 0, start: 0 });
  assert.deepEqual(parseYoutubeLink(`https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=3`), { videoId: ID, list: 'PLabc123', index: 2, start: 0 });
  // Without index= it isn't known where in the list the video is: it plays on its own.
  assert.deepEqual(parseYoutubeLink(`https://www.youtube.com/watch?v=${ID}&list=PLabc123`), { videoId: ID, start: 0 });
  // YouTube Music's links carry a mix made for whoever's listening: the video plays on its own.
  assert.deepEqual(parseYoutubeLink(`https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`), { videoId: ID, start: 0 });
  assert.deepEqual(parseYoutubeLink('https://music.youtube.com/playlist?list=OLAK5uy_abc'), { list: 'OLAK5uy_abc', index: 0, start: 0 });
});

test("links that aren't a YouTube video say why", () => {
  const error = (raw: unknown) => (parseYoutubeLink(raw) as { error?: string }).error;
  assert.equal(error(''), 'Paste a YouTube link');
  assert.equal(error(42), 'Paste a YouTube link');
  assert.match(error('not a link')!, /isn't a web link/);
  assert.equal(error('https://vimeo.com/123'), "That isn't a YouTube link");
  assert.equal(error(`javascript:alert(1)//youtube.com/watch?v=${ID}`), "That isn't a YouTube link");
  assert.equal(error('https://www.youtube.com/watch?v=short'), "That YouTube link's video id doesn't look right");
  assert.equal(error('https://youtu.be/<script>'), "That YouTube link's video id doesn't look right");
  assert.equal(error('https://www.youtube.com/@somechannel'), "That YouTube link isn't a video or a playlist");
  assert.equal(error('https://www.youtube.com/'), "That YouTube link isn't a video or a playlist");
  assert.equal(error(`https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(2100)}`), 'That link is too long');
  assert.equal(isYoutubeUrl('https://example.com/watch?v=x'), false);
  assert.equal(isYoutubeUrl('https://evil-youtube.com/watch?v=x'), false);
  assert.equal(isYoutubeUrl(undefined), false);
});

test('the link to open it on YouTube, and what it is called before its title is known', () => {
  assert.equal(youtubeUrl({ videoId: ID, start: 90 }), `https://www.youtube.com/watch?v=${ID}&t=90s`);
  assert.equal(youtubeUrl({ list: 'PLabc123', index: 0, start: 0 }), 'https://www.youtube.com/playlist?list=PLabc123');
  assert.equal(youtubeUrl({ videoId: ID, list: 'PLabc123', index: 2, start: 0 }), `https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=3`);
  assert.equal(youtubeTitle({ videoId: ID }), `YouTube ${ID}`);
  assert.equal(youtubeTitle({ videoId: ID, title: 'Never Gonna Give You Up' }), 'Never Gonna Give You Up');
  assert.equal(youtubeTitle({ list: 'PLabc123', index: 2 }), 'YouTube playlist, #3');
});

// ---- A floor's TV ----------------------------------------------------------------------------------

test("a floor's TV keeps what's on and since when, checks every link, and keeps it across a restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'youtube-tv-'));
  try {
    let now = 1_000_000;
    let n = 0;
    const tv = new YoutubeTv(dir, () => now, () => `play-${++n}`);
    assert.equal(tv.state(), null);
    assert.deepEqual(tv.play('https://vimeo.com/1', 'Ada'), { error: "That isn't a YouTube link" });
    assert.equal(tv.state(), null);

    const r = tv.play(`https://youtu.be/${ID}?t=30`, 'Ada');
    assert.ok('state' in r);
    assert.deepEqual(r.state, { videoId: ID, start: 30, url: `https://www.youtube.com/watch?v=${ID}&t=30s`, id: 'play-1', by: 'Ada', startedAt: 1_000_000, elapsed: 0 });
    now += 5000;
    assert.equal(tv.state()?.elapsed, 5000, 'how far it has played, for a browser whose clock is not compared yet');
    assert.equal(tv.titled('play-0', 'Wrong play'), false, 'a title for another play is dropped');
    assert.equal(tv.titled('play-1', 'Never Gonna Give You Up'), true);

    const again = new YoutubeTv(dir, () => now);
    assert.deepEqual(again.state(), { ...tv.state(), elapsed: 5000 }, 'the office picks it up where it was after a restart');
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'youtube-tv.json'), 'utf8')).videoId, ID);

    // The end, said by every browser on the floor: only the first one counts.
    assert.equal(tv.ended('play-0', false), null, 'an older play');
    assert.equal(tv.ended(1_000_000, false), null, 'a play is named by its id, not its start time');
    assert.equal(tv.ended('play-1', false), 'stopped');
    assert.equal(tv.ended('play-1', false), null);
    assert.equal(tv.state(), null);
    assert.equal(new YoutubeTv(dir).state(), null);
    assert.equal(tv.stop(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a playlist goes on to its next video when a browser says there is one, and comes off after the last", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'youtube-tv-'));
  try {
    let now = 5000;
    let n = 0;
    const tv = new YoutubeTv(dir, () => now, () => `play-${++n}`);
    assert.ok('state' in tv.play(`https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=1&t=20`, 'Bo'));
    tv.titled('play-1', 'My list');
    now = 9000;
    assert.equal(tv.ended('play-1', true), 'next');
    const s = tv.state()!;
    assert.deepEqual([s.list, s.index, s.start, s.startedAt, s.id, s.videoId, s.title, s.by], ['PLabc123', 1, 0, 9000, 'play-2', undefined, undefined, 'Bo']);
    assert.equal(s.url, 'https://www.youtube.com/playlist?list=PLabc123&index=2');
    assert.deepEqual(new YoutubeTv(dir, () => now).state(), tv.state(), 'kept across a restart at its place in the list');
    assert.equal(tv.ended('play-1', true), null, 'the same end, said again by a slower browser');
    assert.equal(tv.ended('play-2', false), 'stopped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two plays in the same millisecond are two plays: a late title or end for the first leaves the second alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'youtube-tv-'));
  try {
    const tv = new YoutubeTv(dir, () => 42);
    const first = tv.play(`https://youtu.be/${ID}`, 'Ada');
    const second = tv.play('https://youtu.be/aqz-KE-bpKQ', 'Bo');
    assert.ok('state' in first && 'state' in second);
    assert.equal(first.state.startedAt, second.state.startedAt);
    assert.notEqual(first.state.id, second.state.id);
    assert.equal(tv.titled(first.state.id, 'Never Gonna Give You Up'), false);
    assert.equal(tv.ended(first.state.id, false), null);
    assert.equal(tv.state()?.videoId, 'aqz-KE-bpKQ');
    assert.equal(tv.state()?.title, undefined);
    assert.equal(new YoutubeTv(dir).state()?.id, second.state.id, 'the id is kept across a restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The real office ---------------------------------------------------------------------------------

type Office = Awaited<ReturnType<typeof startServer>>;
type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

let tmp = '';
let office: Office;
let base = '';
let cookie = '';
const PASSWORD = 'youtube-tv-test';
const realFetch = youtubeTitles.fetch;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** A browser's end of the socket: what it was sent, taken in order by type. */
class Browser {
  private inbox: ServerMsg[] = [];
  private wake: (() => void) | undefined;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.inbox.push(JSON.parse(raw.toString()));
      this.wake?.();
    });
  }

  static open(name: string): Promise<Browser> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?name=${name}`, { headers: { cookie, origin: base } });
      const b = new Browser(ws);
      ws.once('open', () => resolve(b));
      ws.once('error', reject);
    });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  async take<T extends ServerMsg['t']>(t: T, ok: (m: Msg<T>) => boolean = () => true, ms = 5000): Promise<Msg<T>> {
    const until = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === t && ok(m as Msg<T>));
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Msg<T>;
      const left = until - Date.now();
      if (left <= 0) throw new Error(`no ${t} within ${ms}ms; got ${this.inbox.map((m) => m.t).join(', ') || 'nothing'}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  /** Waits a moment for what's on its way, and says whether a `t` came. */
  async got(t: ServerMsg['t'], ms = 300): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.inbox.some((m) => m.t === t);
  }

  close() {
    this.ws.close();
  }
}

before(async () => {
  youtubeTitles.fetch = async (url) => (url.includes(ID) ? 'Never Gonna Give You Up' : undefined);
  tmp = mkdtempSync(path.join(tmpdir(), 'kanban-youtube-tv-'));
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const publicDir = path.join(tmp, 'public');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, project, publicDir, path.join(publicDir, 'assets'), bin, path.join(tmp, 'projects')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(project, 'README.md'), '# youtube tv\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: project });
  }
  for (const page of ['index', 'login', 'claim', 'join', 'lite']) writeFileSync(path.join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  const claude = path.join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o755);
  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_OFFICE_')) delete process.env[k];
  const port = await freePort();
  const cfg = loadConfig([project, '--home', home, '--projects', path.join(tmp, 'projects'), '--port', String(port), '--password', PASSWORD, '--no-open', '--weather', 'clear', '--agent', claude]);
  office = await startServer(cfg, { publicDir });
  base = `http://127.0.0.1:${port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

after(() => {
  youtubeTitles.fetch = realFetch;
  office?.shutdown();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('the floor sees and hears the same video: the jukebox goes quiet, a late joiner comes in at the same point, the end is said once', async () => {
  const a = await Browser.open('Ada');
  const b = await Browser.open('Bo');
  const welcome = await a.take('welcome');
  assert.equal(welcome.youtube, null, 'nothing on the TV to start with');
  await b.take('welcome');

  // The jukebox is on; a YouTube link goes on the TV, and the jukebox goes off for it.
  a.send({ t: 'jukebox.skip' });
  assert.equal((await b.take('jukebox')).state.on, true);
  a.send({ t: 'tv.youtube.play', url: `https://youtu.be/${ID}?t=1m` });
  assert.equal((await b.take('jukebox', (m) => !m.state.on)).state.on, false);
  const on = (await b.take('tv.youtube')).state!;
  assert.deepEqual([on.videoId, on.start, on.by], [ID, 60, 'Ada']);
  assert.equal(typeof on.startedAt, 'number');
  const titled = (await b.take('tv.youtube', (m) => !!m.state?.title)).state!;
  assert.equal(titled.title, 'Never Gonna Give You Up');
  assert.equal(titled.id, on.id);
  assert.equal((await b.take('toast', (m) => m.text.startsWith('📺'))).text, '📺 Ada put “Never Gonna Give You Up” on the TV (the jukebox is off meanwhile)');

  // Someone coming in later is told where it started, on the office's clock, and how far it's got.
  const c = await Browser.open('Cy');
  const late = (await c.take('welcome')).youtube!;
  assert.equal(late.id, on.id);
  assert.equal(late.startedAt, on.startedAt);
  assert.equal(late.title, 'Never Gonna Give You Up');
  assert.ok(late.elapsed >= 0 && late.elapsed < 5000);

  // A link that isn't YouTube's is turned away, and nothing changes.
  a.send({ t: 'tv.youtube.play', url: 'https://vimeo.com/1' });
  assert.equal((await a.take('toast', (m) => m.level === 'warn')).text, "That isn't a YouTube link");

  // Every browser says it has ended: the floor hears it once.
  a.send({ t: 'tv.youtube.ended', id: on.id });
  b.send({ t: 'tv.youtube.ended', id: on.id });
  assert.equal((await c.take('tv.youtube')).state, null);
  assert.equal(await c.got('tv.youtube'), false, 'said once');

  // Pasted into the jukebox's stream box, a YouTube link goes on the TV too, instead of failing.
  b.send({ t: 'jukebox.play', url: `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}` });
  const fromJukebox = (await a.take('tv.youtube', (m) => m.state?.by === 'Bo')).state!;
  assert.deepEqual([fromJukebox.videoId, fromJukebox.list, fromJukebox.by], [ID, undefined, 'Bo']);
  assert.equal(office.floors()[0].jukebox.state().on, false, "the jukebox didn't take it as a stream");

  // Putting a tune on the jukebox takes YouTube off the TV, so two songs never play at once.
  a.send({ t: 'jukebox.play', track: 'coffee-break' });
  assert.equal((await c.take('tv.youtube', (m) => m.state === null)).state, null);
  assert.equal((await c.take('toast', (m) => m.text.includes('while the jukebox plays'))).text, '📺 YouTube is off the TV while the jukebox plays');

  // And ⏹️ Stop takes it off.
  a.send({ t: 'tv.youtube.play', url: `https://www.youtube.com/watch?v=${ID}` });
  await c.take('tv.youtube', (m) => !!m.state);
  c.send({ t: 'tv.youtube.stop' });
  assert.equal((await a.take('tv.youtube', (m) => m.state === null)).state, null);
  assert.equal((await a.take('toast', (m) => m.text.includes(' took '))).text, '📺 Cy took “Never Gonna Give You Up” off the TV');

  // YouTube won't play it here: a private or removed video (100) is told apart from one kept off other sites (150).
  for (const [code, said] of [
    [100, '🚫 “Never Gonna Give You Up” is private, or was taken down'],
    [150, '🚫 YouTube won\'t let “Never Gonna Give You Up” play outside youtube.com'],
  ] as const) {
    a.send({ t: 'tv.youtube.play', url: `https://www.youtube.com/watch?v=${ID}` });
    // The play that's on now, as the floor was told it (earlier plays' messages are still in the inbox).
    const blocked = (await c.take('tv.youtube', (m) => !!m.state?.title && m.state.id === youtubeTvOf(office.floors()[0]).state()?.id)).state!;
    b.send({ t: 'tv.youtube.ended', id: blocked.id, blocked: code });
    assert.equal((await c.take('toast', (m) => m.text.startsWith('🚫'))).text, said);
  }

  for (const x of [a, b, c]) x.close();
});
