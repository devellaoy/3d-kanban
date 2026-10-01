# `screenshot.mjs` — full reference

Run it with the **absolute path of this skill's base directory**:

```
node "<skill-base>/scripts/screenshot.mjs" <url> [options]
node "<skill-base>/scripts/screenshot.mjs" --flow <path.json>
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
| `--delay <ms>` | Extra settle time after load (default 800). |
| `--timeout <ms>` | Navigation/selector timeout (default 30000). |
| `--channel chrome\|msedge` | Force a browser channel. |

**SPA tip:** point `--wait-selector` at something that only exists once real content has
rendered (`"main h1"`, `"[data-loaded]"`) — **not** a bare root like `#app`, which is in the DOM
immediately and proves nothing.

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
node "<skill-base>/scripts/screenshot.mjs" http://localhost:$KANBAN_PORT_BASE/product/1 \
  --state /tmp/session.json --click "button.add-to-cart" --post-delay 1500 --name added

# run 2: the cart still has the item
node "<skill-base>/scripts/screenshot.mjs" http://localhost:$KANBAN_PORT_BASE/cart \
  --state /tmp/session.json --device "iPhone 14" --measure ".checkout" --name cart
```

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

Top level: `name`, `baseUrl` (prefix for relative `goto`s), `viewport`, `state`, `steps`.
At least one `goto` step is required.

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
