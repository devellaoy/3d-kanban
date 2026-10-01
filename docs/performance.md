# Performance and battery

Back to the [README](../README.md). [How it works](how-it-works.md) has the rest of the architecture.

The 3D office draws only as often as it needs to. Sitting in it, or reading a window, costs a fraction of what walking around does.

## How often the office is drawn

The office picks one of four modes, and changes mode by itself.

| Mode | Drawn | When |
|---|---|---|
| Active | Every screen refresh | Any input in the last 2.5 seconds. Walking, jumping or falling. An activity such as golf or a car. Something that has the screen to itself, like the telescope or the arcade up close. The drunk vision. The elevator ride. A mouse button held. The field of view easing in or out, or the camera still moving (an ease settling, a turn into a seat): it stays at full rate until the camera has been still for 300 ms. |
| Idle | 30 frames a second | Nothing is going on and you haven't touched anything for 2.5 seconds. |
| Covered | 15 frames a second | A window is open over the office (help, a terminal, the queue and so on). |
| Background | 30 frames a second | The page doesn't have focus, for example you are typing in another window next to it. It may still be in plain sight on a second screen, so it gets the idle rate. |

A hidden tab is as before: the browser stops drawing altogether.

The office doesn't sleep on a timer. It skips screen refreshes evenly: every 2nd or 4th at 60 Hz, every 4th or 8th at 120 Hz. Drawn frames stay evenly spaced, so motion looks smooth. Any input draws on the very next refresh, so the office never feels slow to wake. Animations keep their speed, because they follow real elapsed time, not the number of frames.

The [2D view offer](features.md) for slow computers counts only frames drawn at full rate. The calmer rates while you're idle or a window is open don't trigger it. A slow computer whose user only ever walks in bursts shorter than ten seconds is never offered it, since the count starts over whenever the office drops to a calmer rate.

To turn pacing off, run this in the browser console and reload. The office then draws every refresh again.

```js
localStorage.setItem('agent-office.pace', 'full')
```

`__office.pace` in the console shows the mode, and how many frames were drawn and skipped, and the work time (`workMs`). `__office.pace.force('idle')` pins a mode for measuring, and `__office.pace.force(null)` lets the office choose again.

## What else changed

- **GPU.** The office asks for the default GPU, not the high-performance one. A laptop with two GPUs no longer wakes the discrete one. Apple Silicon has one GPU, so nothing changes there. The picture is identical: same antialiasing, pixel ratio of `min(devicePixelRatio, 2)`, shadows and outlines.
- **Voice level sampler.** It ran 25 times a second all the time. It now runs only while you're in voice or connected to someone.
- **Aim raycast.** What you're pointing at is reused for up to 100 ms while the camera hasn't moved.
- **Per-frame allocations.** Positions arrays and snowflakes are no longer created again every frame.
- **Typing sound.** It is scheduled 250 ms ahead, so it doesn't stutter at 15 frames a second.

## Measurements

Method: a local office with 6 workers (fake agents) at their desks. Headless Chrome 154 driven by Playwright on an Apple Silicon Mac, 1280×900, device pixel ratio 1. It used software GL (SwiftShader), so the GPU work ran on the CPU. Absolute numbers are higher than on a real GPU. The ratios are what count.

- Main thread ms is the time spent inside the `requestAnimationFrame` callback.
- CPU is all of headless Chrome's processes (`ps` cumulative CPU time over 18 seconds).

Before, then after:

| | Drawn frames/s | Main thread ms per second | ms per drawn frame | Draw calls per frame | Chrome CPU |
|---|---|---|---|---|---|
| Idle in the office | 60 → 30 | 692 → 317 | 11.6 → 10.6 | about 2100–2700 (depends on the view) | 140% → 48% of a core |
| Walking | 60 → 60 | 633 → 671 | 10.6 → 11.2 | about 1700–2100 | not measured |
| A window open (help) | 60 → 15 | 394 → 136 | 6.6 → 9.0 | about 1700 | 84% → 24% |

Walking draws every frame in both, so it should not change. The small difference is noise.

The scene has about 3340 objects, about 2500 meshes and about 1240 that cast shadows. `scene.updateMatrixWorld` takes about 0.25–0.5 ms per frame. There are 29–32 shader programs and about 65 textures.

The shadow map is rendered once per drawn frame. The outline pass turns shadows off, and the hands' scene has no shadow-casting light. So there is nothing to gain there without lowering how often shadows follow moving people.

### CPU or GPU

Each frame costs about 10–11 ms of main-thread time. Most of it is submitting about 2000–2700 draw calls: the scene, its shadow pass and the toon outline pass, plus the hands. The JavaScript per frame (animation, raycast, matrices) is small next to that.

So the cost scales with the number of frames drawn. That is why pacing is the big win. On a real GPU, the GPU side also scales with frames drawn.

### Energy

Not measured here. `powermetrics` needs `sudo`, and Activity Monitor needs a person. To be filled in.

To measure it:

- Open Activity Monitor, go to the **Energy** tab, and watch the **Energy Impact** of the Chrome (or Agent Office) helper. Take a few minutes each of idling in the office, with a window open, and walking, before and after the change.
- Or run `sudo powermetrics --samplers cpu_power,gpu_power -i 5000 -n 12`.

## What was done, and what wasn't

Ranked by gain against risk.

Done:

1. **Pacing.** Big gain, low risk.
2. **Default GPU.** Big on Intel Macs with two GPUs, none on Apple Silicon, no visual change. If the integrated GPU can't hold the frame rate on a big display, this can be reverted.
3. **Timers and per-frame allocations.** Small gain, no risk.

Not done:

- **A lower pixel ratio while moving.** It lowers the quality.
- **Refreshing shadows less often than drawing.** Shadows would lag behind moving people.
- **`matrixAutoUpdate = false` on static objects.** `updateMatrixWorld` is at most 0.5 ms, and there is a risk of freezing doors, the elevator or the jukebox.
- **Merging or instancing static meshes to cut draw calls.** This is the next real gain, because draw calls dominate. It is a bigger and riskier change, worth a task of its own.
- **Sleeping between drawn frames with a timer.** It would cut wake-ups further, but frames would land late on the screen refresh and motion would be uneven.
