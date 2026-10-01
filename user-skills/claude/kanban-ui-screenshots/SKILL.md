---
name: kanban-ui-screenshots
description: >-
  Test user workflows with real browser actions, retrying assertions and failure reports; capture screenshots,
  mobile/responsive emulation, logged-in pages, multi-step click paths and
  before/after comparisons. Use this skill whenever a task involves seeing how
  the UI actually looks or behaves: "test the UI", "take a screenshot", "show
  me the view", "how does this look on mobile", layout or responsive bugs,
  visual regressions, or verifying a CSS/markup change. It ships a ready-made
  browser automation script — use it instead of building your own browser
  driver (chromedriver, puppeteer, raw CDP).
---

# kanban-ui-screenshots

Verify a web UI by actually rendering it: start the dev server, drive a real browser, capture
images, and read measurements. Use it whenever seeing the real UI would make the work more
certain — UI changes, layout and responsive problems, visual regressions. Skip it for pure
backend/logic work. During planning do not start servers. During implementation or an authorized
UI investigation, use test accounts and test data; testing does not authorize unrelated writes.

## Test behavior, not just pictures

A screenshot is evidence of appearance; a passing assertion is evidence of behavior.
For interactive changes, define the expected workflow before running it, use native browser
actions, and assert the outcomes. Include save → reload → verify when persistence matters.
Do not use DOM mutation through `eval` as proof that a user's interaction works.

Read **[references/ui-testing.md](references/ui-testing.md)** for actions, assertions,
bounded waits, network-failure recovery tests, JSON reports and optional traces. These extend
the existing `--flow` runner; no extra browser driver or dependency is needed.

Report `passed`, `failed`, or `capture-only` accurately. A flow without assertions is not a
passing functional test. A mock/simulated network failure is explicitly simulated; passing
against a fixture does not prove the target application's integration works.

## Never build your own browser driver

Do not reach for chromedriver, puppeteer, raw CDP over a WebSocket, or a hand-rolled WebDriver
client. This skill's `scripts/screenshot.mjs` already handles SPAs, self-signed certificates,
mobile emulation, sessions, multi-step flows, element close-ups and measurements. A target
repo's own `node_modules/chromedriver` is almost always a different major version than the
installed Chrome and is a dead end. If the script genuinely cannot do what you need, say so
and ask — that is faster than writing an automation harness from scratch.

## 1. Start the dev server in the background

Read the project's `package.json` and work out the right start command (e.g. `npm run dev`,
`pnpm dev`, `vite`). Start it as a **background process** so you can keep running commands.

- **Always use the assigned port.** The system reserves a port block per task in
  **`KANBAN_PORT_BASE`** (`echo $KANBAN_PORT_BASE`, or `echo $env:KANBAN_PORT_BASE` in
  PowerShell). This prevents clashes when several tasks run in parallel. **Do not use the
  framework default port (3000/5173).**
  - Pass it the framework's way: `npm run dev -- --port $KANBAN_PORT_BASE` (Vite/Nuxt),
    `next dev -p $KANBAN_PORT_BASE`, or `PORT=$KANBAN_PORT_BASE npm run dev`.
  - Need more than one port (separate backend/API, HMR)? Use `KANBAN_PORT_BASE + 1`, `+ 2`, …
    (the block has 10 ports).
  - **Watch out:** some backends read a bare `PORT` env var that is already set in the
    environment for something else. If the server starts on an unexpected port or dies with
    `EADDRINUSE`, pass the port explicitly with the framework's own flag.
  - If `KANBAN_PORT_BASE` is unset, pick any free high port.
- **Keep the process id** so you can shut it down afterwards (Windows: `taskkill /PID <pid> /T /F`).

## 2. Wait until the server responds

Build the URL from the assigned port and poll it until it answers before capturing anything.

## 3. Capture

Use the **absolute path of this skill's base directory** — the same path you saw when the skill
was loaded ("Base directory for this skill"). Claude's working directory is the target repo's
worktree, so a relative path will not work.

```
node "<skill-base>/scripts/screenshot.mjs" <url> [options]
```

**Output contract:** `stdout` contains **only image paths, one per line** (last line = most
recent image). Measurements, progress and warnings go to `stderr`.

The most common options:

| Option | Use it for |
|---|---|
| `--name <label>` | Names the output file. |
| `--device "iPhone 14"` | Mobile emulation (viewport + dpr + touch + user agent). `--list-devices` lists all. |
| `--width 390 --height 844 --mobile --dpr 2` | Explicit viewport instead of a preset. Default is 1280x900. |
| `--wait-selector "<sel>"` | Wait for real content on a SPA before capturing. |
| `--clip-selector "<sel>"` | Close-up of one element instead of the whole page. |
| `--measure "<sel>"` | Print size, computed styles, line count and text overflow as JSON on stderr. |
| `--state <path.json>` | Keep the session (cookies + storage) across separate runs. |
| `--flow <path.json>` | Multi-step click path in one browser session, several screenshots. |

**A mobile-only bug cannot be reproduced at the default 1280px width** — always set the
viewport when the ticket is about mobile. If a mobile bug still refuses to reproduce, check
`layoutViewportWidth` in the `--measure` output: `980` means the page has no
`<meta name="viewport">` and never enters the mobile layout at all.

**Measure, don't just look.** `--measure` answers "is the text clipped or does it wrap" with
numbers (`clippedHorizontally`, `textOverflowPx`, `lines`, `pageHorizontalOverflowPx`). For a
layout bug that is stronger evidence than a picture — report both.

**Fixing a visual bug? Capture before AND after** from the same view when possible. Re-applying
old CSS with `--eval` is only a reconstruction, not an authentic before capture; label it so.

Full option reference, flow-file format, logged-in sessions and worked examples:
**[references/cli.md](references/cli.md)** — read it when you need more than the table above.

## 4. Look at the image

Pass the path to the **Read tool** — you will see the UI visually. Iterate: change, re-capture, verify.

## 5. Clean up

Shut down only the dev server you started and check its port is free. Clean up identifiable
test data created by this run when authorized; do not delete pre-existing user data.

Reports omit entered values, raw console messages and URL paths/queries by default. Screenshots,
session files and opt-in traces can still contain personal data and secrets. Use isolated test
accounts, keep artifacts private, and do not commit them. Do not enable `includeValues` or
`trace` on sensitive pages without appropriate authorization.

Notes:
- Images go to the OS temp directory, outside the target repo, so **do not commit them** — they
  will not appear in the target repo's git status.
- If the script reports that `playwright-core` is missing, install it once in this skill's
  directory with `npm ci` (or `npm install` if the lockfile is unavailable).
