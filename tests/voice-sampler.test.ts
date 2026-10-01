import test from 'node:test';
import assert from 'node:assert/strict';

// The voice level sampler (voice.ts) runs 25 times a second, so it runs only while there's a voice
// to sample. Everyone else in the 3D office gets a connection whether or not they're in voice, and a
// silent one mustn't keep it going.

/** An audio track that can be muted, unmuted and ended, like a remote one. */
class FakeTrack extends EventTarget {
  kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  set(muted: boolean) {
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
  }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakePeerConnection {
  ontrack: ((e: { track: FakeTrack; streams: object[] }) => void) | null = null;
  addTrack() {
    return {};
  }
  close() {}
}

Object.assign(globalThis, {
  RTCPeerConnection: FakePeerConnection,
  Audio: class {
    autoplay = false;
    srcObject: unknown = null;
    play = () => Promise.resolve();
  },
  AudioContext: class {
    createMediaStreamSource = () => ({ connect() {} });
    createAnalyser = () => ({ fftSize: 0, getByteTimeDomainData() {} });
    resume = () => Promise.resolve();
  },
});

const { Voice } = await import('../src/client/voice.js');
const { store } = await import('../src/client/state/index.js');

/** A Voice with someone else in the office, who isn't in voice, and their connection. */
function withPeer() {
  const voice = new Voice({ send() {} } as never);
  store.you = 'a';
  store.peers.set('b', { id: 'b' } as never);
  voice.syncPeers();
  const pc = (voice.conns.get('b') as unknown as { pc: FakePeerConnection }).pc;
  const sampling = () => (voice as unknown as { sampler: unknown }).sampler !== null;
  return { voice, pc, sampling };
}

test("someone in the office who isn't in voice doesn't start the sampler", (t) => {
  const { voice, sampling } = withPeer();
  t.after(() => voice.reset());
  assert.equal(voice.conns.size, 1);
  assert.equal(sampling(), false);
});

test('their voice arriving starts it, and muting, ending or leaving stops it again', (t) => {
  const { voice, pc, sampling } = withPeer();
  t.after(() => voice.reset());
  const track = new FakeTrack();
  pc.ontrack!({ track, streams: [{}] });
  assert.equal(sampling(), true);
  track.set(true);
  assert.equal(sampling(), false);
  track.set(false);
  assert.equal(sampling(), true);
  track.end();
  assert.equal(sampling(), false);

  const again = new FakeTrack();
  pc.ontrack!({ track: again, streams: [{}] });
  assert.equal(sampling(), true);
  store.peers.delete('b');
  voice.syncPeers();
  assert.equal(sampling(), false);
});
