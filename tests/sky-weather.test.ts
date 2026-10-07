import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkyState, Weather } from '../src/shared/protocol.js';
import { Sky, tame, wander } from '../src/server/sky.js';

const off = { rain: false, lightning: false };
const rainOnly = { rain: true, lightning: false };
const both = { rain: true, lightning: true };
const WEATHERS: Weather[] = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];

test('tame turns rain into cloud and storms into rain while they are kept out', () => {
  assert.deepEqual(tame({ weather: 'rain', intensity: 0.5 }, off), { weather: 'cloudy', intensity: 0.8 });
  assert.deepEqual(tame({ weather: 'rain', intensity: 1 }, off), { weather: 'cloudy', intensity: 1 });
  assert.deepEqual(tame({ weather: 'storm', intensity: 0.8 }, off), { weather: 'cloudy', intensity: 1 });
  assert.deepEqual(tame({ weather: 'storm', intensity: 0.5 }, rainOnly), { weather: 'rain', intensity: 0.8 });
  assert.deepEqual(tame({ weather: 'storm', intensity: 1 }, rainOnly), { weather: 'rain', intensity: 1 });
  assert.deepEqual(tame({ weather: 'storm', intensity: 0.5 }, both), { weather: 'storm', intensity: 0.5 });
  assert.deepEqual(tame({ weather: 'rain', intensity: 0.5 }, rainOnly), { weather: 'rain', intensity: 0.5 });
  for (const w of ['clear', 'snow', 'fog', 'cloudy'] as Weather[]) assert.deepEqual(tame({ weather: w, intensity: 0.4 }, off), { weather: w, intensity: 0.4 });
  // Idempotent.
  for (const p of [off, rainOnly, both]) for (const w of WEATHERS) {
    const once = tame({ weather: w, intensity: 0.5 }, p);
    assert.deepEqual(tame(once, p), once);
  }
});

test('made-up weather never rains or storms unless let in', () => {
  for (let month = 0; month < 12; month++) {
    for (const south of [false, true]) {
      for (let i = 0; i < 2000; i++) {
        const prev = WEATHERS[i % WEATHERS.length];
        const w = wander(prev, month, south).weather;
        assert.ok(w !== 'rain' && w !== 'storm', `${w} in month ${month}`);
        assert.notEqual(wander(prev, month, south, rainOnly).weather, 'storm');
      }
    }
  }
});

test('the sky keeps rain and lightning out until they are let in, and remembers the pick', () => {
  const weatherFile = path.join(mkdtempSync(path.join(tmpdir(), 'sky-weather-')), 'sky-weather.json');
  const heard: SkyState[] = [];
  const sky = new Sky({ weather: 'storm', weatherFile }, (s) => heard.push(s));
  assert.equal(sky.state.weather, 'cloudy');
  assert.equal(sky.state.rain, undefined);
  assert.equal(sky.state.lightning, undefined);
  sky.setWeatherPrefs({ lightning: true });
  assert.equal(sky.state.weather, 'storm');
  assert.equal(sky.state.rain, true);
  assert.equal(sky.state.lightning, true);
  assert.equal(heard.at(-1)?.weather, 'storm');
  assert.deepEqual(new Sky({ weather: 'storm', weatherFile }, () => {}).state.weather, 'storm');
  sky.setWeatherPrefs({ lightning: false });
  assert.equal(sky.state.weather, 'rain');
  assert.equal(sky.state.lightning, undefined);
  assert.equal(sky.state.rain, true);
  sky.setWeatherPrefs({ lightning: true });
  sky.setWeatherPrefs({ rain: false });
  assert.equal(sky.state.weather, 'cloudy');
  assert.equal(sky.state.rain, undefined);
  assert.equal(sky.state.lightning, undefined);
  assert.deepEqual(new Sky({ weather: 'storm', weatherFile }, () => {}).weatherPrefs, off);
  // Conflicting input: rain off wins.
  sky.setWeatherPrefs({ rain: false, lightning: true });
  assert.deepEqual(sky.weatherPrefs, off);
});

for (const [code, expected] of [[95, 'storm'], [63, 'rain']] as const) {
  test(`a forecast of WMO ${code} shows as cloudy until it is let in`, async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ current: { weather_code: code, temperature_2m: 10 }, utc_offset_seconds: 0 }))) as typeof fetch;
    let sky: Sky | undefined;
    try {
      const first = new Promise<SkyState>((resolve) => {
        sky = new Sky({ city: '52.52,13.41' }, resolve);
      });
      sky!.start();
      const s = await first;
      assert.equal(s.weather, 'cloudy');
      assert.equal(s.rain, undefined);
      assert.equal(s.lightning, undefined);
      sky!.setWeatherPrefs({ lightning: true });
      assert.equal(sky!.state.weather, expected);
    } finally {
      globalThis.fetch = real;
      sky?.stop();
    }
  });
}
