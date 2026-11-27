# `screenshot.mjs` — full reference

Run it with the **absolute path of this skill's base directory**:

```
node "<skill-base>/scripts/screenshot.mjs" <url> [options]
node "<skill-base>/scripts/screenshot.mjs" --flow <path.json>
node "<skill-base>/scripts/screenshot.mjs" --flow <a.json> --flow <b.json>
node "<skill-base>/scripts/screenshot.mjs" --flow <folder>
node "<skill-base>/scripts/screenshot.mjs" --list-devices
```

**Output contract:** `stdout` = image paths only, one per line (last line = most recent image).
Everything else — measurements, progress, warnings — goes to `stderr`. So the path can always be
picked from stdout, even in a multi-image run.

It renders client-side SPAs, captures the **full page height** by default, and ignores all
SSL/certificate errors (browser launch flags *and* context setting), so an "insecure" https dev
address works. If https does not answer at all it retries over `http://`. It uses the system
browser — **Chrome first, then Edge** — so no separate Chromium download is needed.

Errors caused by bad input (unknown device, missing element, malformed flow) print a single
clear line and exit with code `2`.

## Viewport, mobile and devices

| Option | Meaning |
|---|---|
| `--device "iPhone 14"` | Playwright device preset: viewport + dpr + isMobile + touch + user agent. |
| `--list-devices` | Print every available preset name. |
| `--width 390` / `--height 844` | Explicit viewport size (default 1280x900). |
| `--mobile` | Mobile layout (isMobile + hasTouch). |
| `--dpr 2` | Device pixel ratio; 2 gives a retina-sharp image. |
| `--viewport-only` | Capture just the viewport instead of the full page ("above the fold"). |

Individual options override the preset: `--device "iPhone 14" --dpr 1`.

## Element close-ups and measurements

| Option | Meaning |
|---|---|
| `--clip-selector "<sel>"` | Capture only that element. |
| `--clip-padding 16` | Margin around the clip (default 16). |
| `--scroll-to "<sel>"` | Scroll the element into view before capturing. |
| `--measure "<sel>"` | Print measurements as JSON on stderr. Repeatable. |

`--measure` output fields:

```json
{
  "selector": ".checkout",
  "text": "Send registration and proceed to payment",
  "rect": { "width": 324, "height": 40 },
  "styles": { "display": "inline-flex", "whiteSpace": "nowrap", "height": "40px",
              "padding": "12px 24px", "fontSize": "16px", "lineHeight": "normal",
              "overflow": "visible" },
  "lines": 1,
  "contentWidth": 276,
  "textWidth": 342,
  "textOverflowPx": 66,
  "clippedHorizontally": true,
  "pageHorizontalOverflowPx": 0,
  "layoutViewportWidth": 390,
  "hasViewportMeta": true
}
```

`textWidth` is measured with a DOM `Range`, not `scrollWidth`, because `scrollWidth` does not
reveal overflow inside `inline-flex` elements (a very common button pattern).

**Check `layoutViewportWidth` first when a mobile bug refuses to reproduce.** If you asked for a
390px device but this says `980` and `hasViewportMeta` is `false`, the page has no
`<meta name="viewport">`, so the browser falls back to the 980px legacy layout width and the
mobile layout never engages. That is a bug in the page, not in the emulation — and it may well be
the actual cause of the ticket.

## Actions before the shot

| Option | Meaning |
|---|---|
| `--click "<selector>"` | Click an element. Repeatable: `--click a --click b`. |
| `--eval "<js>"` | Run JS in the page context (`await` allowed). |
| `--eval-file "<path>"` | Same but multi-line JS from a file. |
| `--post-delay <ms>` | Wait after the actions (animations, modals). |
| `--wait-selector "<sel>"` | Wait for real content before capturing. |
| `--delay <ms>` | Extra settle time after load (default 800, not run when `--wait-selector` is given; an explicit `--delay` always runs; `--delay 0` means none). |
| `--no-settle` | Skip the idle wait and the `load` wait after navigation. |
| `--settle` | Force the idle wait (`networkidle`) even where it would be skipped. |
| `--settle-timeout <ms>` | Cap of the idle wait (default 2000; 8000 is the old behaviour). |
| `--timeout <ms>` | Navigation/selector timeout (default 30000). |
| `--channel chrome\|msedge` | Force a browser channel. |

**SPA tip:** point `--wait-selector` at something that only exists once real content has
rendered (`"main h1"`, `"[data-loaded]"`) — **not** a bare root like `#app`, which is in the DOM
immediately and proves nothing.

### Waiting: `waitSelector` instead of delays

A `waitSelector` (flow step) or `--wait-selector` (single shot) is the right way to say "the page
is ready": it waits exactly as long as the content needs, and the fixed 800 ms delay is not run
after it. Use it instead of `--delay` / `wait`.

After a navigation the script also settles the page:

- The idle wait (`networkidle`) is **skipped** when the step has a `waitSelector`, or has
  `assertions` and no `click`/`actions`/`eval` (those run before the assertions, so an assertion
  would not protect them from a half-hydrated page). Otherwise it is capped at 2 s, because a page
  with a permanent connection (SSE, polling) never goes idle.
- When the idle wait is skipped, the script still waits for the `load` state, up to 2 s, so
  images and styles are in.
- `--no-settle` / top-level `"settle": false` skips both. `--settle` / top-level or step
  `"settle": true` forces the idle wait. `--settle-timeout <ms>` / top-level `"settleTimeout"`
  sets the cap.

If a picture still shows a half-loaded page, fix it with a better `waitSelector` (something that
exists only when the part you photograph is complete) or with `"settle": true` on that step,
not with a longer delay.

## Logged-in pages

Hand the session to the browser before navigating:

| Option | Meaning |
|---|---|
| `--cookie "name=value"` | Cookie on the target URL's domain. Repeatable. |
| `--local-storage "key=value"` | localStorage value set before the page's own scripts run. Repeatable. |
| `--session-storage "key=value"` | Same for sessionStorage. Repeatable. |
| `--storage-file "<path.json>"` | Many values at once. |

`--storage-file` format (object values are serialised to JSON strings automatically):

```json
{
  "cookies": [{ "name": "sid", "value": "..." }],
  "localStorage": { "user": { "id": 1 } },
  "sessionStorage": {}
}
```

Values may contain `=` — only the first one splits. Where to get them: a logged-in browser's
DevTools → Application → Cookies/Storage, or the login response for a test user.

## Sessions across separate runs — `--state`

`--state <path.json>` loads the session before the run and writes it back afterwards (cookies +
localStorage + sessionStorage). That is what makes a multi-run path work. The file does not need
to exist beforehand.

```
# run 1: add to cart
node "<skill-base>/scripts/screenshot.mjs" http://localhost:$PORT/product/1 \
  --state /tmp/session.json --click "button.add-to-cart" --post-delay 1500 --name added

# run 2: the cart still has the item
node "<skill-base>/scripts/screenshot.mjs" http://localhost:$PORT/cart \
  --state /tmp/session.json --device "iPhone 14" --measure ".checkout" --name cart
```

**Log in once, share the `--state`.** Run a login flow with `--state s.json`, then pass the same
`--state s.json` to every later run, including a suite run (see below), so no flow has to log in
again. A state file that more than one job of a run uses is read-only: it is not written back, so
parallel jobs cannot overwrite each other's session. A job whose origin has nothing in the file
prints a warning and its `FLOW` line says `state=missing-origin`; the page is then probably a
login page.

With two addresses (`--before-url` and `--after-url`, below) `--state s.json` means
`s.before.json` and `s.after.json`, because localStorage belongs to one origin and a login
against one address does not hold on the other. Run the login flow once with both addresses and
both files are made. If a side's file is missing but `s.json` exists, that job uses `s.json`
read-only and says so on stderr.

## Multi-step flows — `--flow`

When the path needs several steps and several screenshots, a flow file is more reliable than
chaining runs: one browser, one session, no state file needed.

```
node "<skill-base>/scripts/screenshot.mjs" --flow /tmp/flow.json
```

```json
{
  "name": "cart-mobile",
  "baseUrl": "http://localhost:9036",
  "viewport": { "device": "iPhone 14" },
  "state": "/tmp/session.json",
  "steps": [
    { "goto": "/product/1", "waitSelector": "button.add-to-cart" },
    { "click": "button.add-to-cart", "wait": 2000 },
    { "goto": "/cart" },
    { "measure": ".checkout", "shot": "01-cart", "viewportOnly": true },
    { "shot": "02-button-closeup", "clipSelector": ".checkout" },
    { "viewport": { "width": 1440, "height": 900, "mobile": false }, "shot": "03-desktop" }
  ]
}
```

Top level: `name`, `baseUrl` (prefix for relative `goto`s), `viewport`, `state`, `settle`,
`settleTimeout`, `steps`. At least one `goto` step is required.

Step keys, executed in this order within one step:

`goto` → `viewport` → `waitSelector` → `wait` → `click` → `actions` → `eval`/`evalFile` → `postDelay` →
`scrollTo` → `measure` → `assertions` → `shot`

For native input/drag/keyboard actions, retrying assertions, JSON test reports, network-failure
simulation and traces, read [ui-testing.md](ui-testing.md). Existing screenshot commands remain
valid; every flow additionally writes a report whose path appears on stderr as `REPORT <path>`.
An assertion failure exits nonzero. A flow without assertions is reported as `capture-only`.

One step may combine several keys; if you need a different order, split it into several steps.
`click` and `measure` also accept arrays. A `shot` step accepts `clipSelector`, `clipPadding`
and `viewportOnly`. Relative `evalFile` paths resolve from the flow file's own directory.

**Changing the viewport mid-flow keeps the session.** If the change needs a new browser context
(mobile↔desktop, or a different dpr), cookies and storage are carried over and the page is
reloaded at the same URL — so the cart does not empty.

## Several flows in one call

Two or more pictures or paths of the same app go through one call, not one call per picture:
each call starts a browser, and a suite shares it.

```
node "<skill-base>/scripts/screenshot.mjs" --flow a.json --flow b.json
node "<skill-base>/scripts/screenshot.mjs" --flow flows/*.json
node "<skill-base>/scripts/screenshot.mjs" --flow flows/ --concurrency 2 --state /tmp/s.json
```

- `--flow` may be repeated, may be followed by several `.json` files (a shell glob), or may name a
  folder: its `*.json` files, sorted, not recursive. A file without a `steps` array is skipped.
- Jobs run in parallel in separate contexts of one browser. `--concurrency <n>` sets how many at
  once (default 4; `1` runs them one after another).
- One failing flow does not stop the others. The exit code is `2` if any failed.
- `stdout` stays image paths only, one per line, printed as each image is taken (the order
  between flows is not guaranteed). `stderr` starts with `JOBS <n>: <names>`; per job it prints
  `FLOW <name>[@before|@after] <passed|failed|capture-only> shots=<n> report=<path>`, and for a
  failed job `failed-step=<i> <action|assertion|step> <j> <type>: <reason>, matches=<k>`;
  a multi-job run ends with `SUITE <passed>/<total> passed, <f> failed, <c> capture-only, <ms> ms`
  and `SUITE-REPORT <path>` (a JSON file listing every job).
- Flows that write to the same database should not run in parallel against it; see
  [ui-testing.md](ui-testing.md).

## Before/after against two addresses

Run the same flows against the app before and after a change in one call:

```
node "<skill-base>/scripts/screenshot.mjs" --flow flows/ \
  --before-url http://localhost:$PORT --after-url http://localhost:$((PORT+1)) \
  --out-dir /path/to/images
```

| Option | Meaning |
|---|---|
| `--base-url <url>` | Overrides every flow's `baseUrl`. Cannot be combined with `--before-url` / `--after-url`. |
| `--before-url <url>` / `--after-url <url>` | Run every flow against each address given (one or both) in one call. Each job is named `<flow>@before` / `<flow>@after`. |
| `--side before\|after` | Names the side of a one-address run (a flow or a single URL; a single URL then needs `--name`). |
| `--out-dir <dir>` | Receives the requested shots (created if missing). |
| `--concurrency <n>` | Jobs at once (default 4). |

- Absolute `goto` URLs ignore the address override; a warning is printed.
- A `url` assertion's `expected` may start with `/`; it is then resolved against the job's base
  URL, so the same flow asserts on either address.
- With a side known **and** `--out-dir` given, files are named `<subject>-<side>.png`, with no
  timestamp, and overwrite an older file. With a side but no `--out-dir` they stay in the OS temp
  directory with the side and a timestamp in the name. The subject is the step's `shot` name in a flow and `--name` in
  single mode (lower-cased, only `[a-z0-9._-]`, at most 80 characters). Two shots that resolve to
  the same name are an error before the browser starts.
- Reports, traces and failure screenshots always stay in the OS temp directory, not in
  `--out-dir`.
- Without these options the output is as before: the OS temp directory and timestamped names.
- If only one side exists yet (the before side is taken before the change is made), give only
  `--before-url` (or `--side before`) now, and `--after-url` later with the same flows.

## Before/after comparison for a visual fix

Prefer an actual pre-change capture. If unavailable, reconstruct the old CSS with inline styles
without reverting git, and label this as a reconstructed comparison, not an actual before run:

```
node "<skill-base>/scripts/screenshot.mjs" <url> --device "iPhone 14" \
  --eval "const b=document.querySelector('.checkout'); \
          b.style.setProperty('white-space','nowrap','important'); \
          b.style.setProperty('height','2.5em','important')" \
  --measure ".checkout" --clip-selector ".checkout" --name before
```

Then run the same command **without** `--eval` for the "after" image. Report both the images and
the `--measure` numbers — the numbers are what make the fix verifiable.

The same trick works inside a flow: an `eval` step applies the old styles, the next `shot` step
captures "before", and a following `eval` step removes them again for "after".
