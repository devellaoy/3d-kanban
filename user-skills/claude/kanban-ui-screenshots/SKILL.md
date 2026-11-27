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

## Contents

- **Test behavior, not just pictures** — assertions, `references/ui-testing.md`
- **Never build your own browser driver** — use `scripts/screenshot.mjs`
- **1. Start the dev server in the background** — pick a free port, never the default
- **2. Wait until the server responds** — poll before capturing
- **3. Capture** — command, output contract, common options, mobile, measure
- **4. Look at the image** — open it with Read
- **More than one picture: one call** — flows, suites, before/after pair, shared `--state`, `waitSelector`
- **Several people at once** — one environment owner, several browsers, subagents
- **Saving before/after images to the kanban task** — `--out-dir` and `--side`, the names, and when to take each
- **5. Clean up** — stop the server, test data, privacy

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

- **Pick the port first, and never the framework default (3000/5173).** Other tasks may run on the
  same machine.
  - Use the ports the project's instructions name. Otherwise pick a free high port and check it is
    free before you start the server (for example `lsof -i :$PORT`, or try to connect to it).
  - Pass it the framework's own way: `npm run dev -- --port $PORT` (Vite/Nuxt), `next dev -p $PORT`,
    or `PORT=$PORT npm run dev`.
  - Need more than one port (a separate backend/API, HMR, a before and an after server)? Pick
    consecutive ports.
  - **Watch out:** some backends read a bare `PORT` env var that is already set in the
    environment for something else. If the server starts on an unexpected port or dies with
    `EADDRINUSE`, pass the port explicitly with the framework's own flag.
- **Keep the process id** so you can shut it down afterwards (Windows: `taskkill /PID <pid> /T /F`).

## 2. Wait until the server responds

Build the URL from the port you picked and poll it until it answers before capturing anything.

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
| `--flow <path.json>` | Multi-step click path in one browser session, several screenshots. Repeatable, or a folder, or a glob: several flows in one call. |
| `--base-url <url>` | Overrides a flow's `baseUrl`. |
| `--before-url <url>` / `--after-url <url>` | Run every flow against each address given, in one call. |
| `--side before\|after` | Names the side of a one-address run; with `--out-dir` the files are `<subject>-<side>.png`. |
| `--out-dir <dir>` | Write the requested shots into this folder (created if missing). |
| `--concurrency <n>` | Flows run at once in a suite (default 4; 1 = one after another). |
| `--no-settle` / `--settle` / `--settle-timeout <ms>` | Skip, force or cap the wait for the page to go idle after navigation. |

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

## More than one picture: one call

Two or more pictures of the same app go through **one flow or one suite run**, never through
separate single-shot calls: every call starts a browser, and a flow shares one.

- Several views or paths: put them in one flow as steps with a `shot` each, or in several flow
  files run together (`--flow a.json --flow b.json`, `--flow flows/*.json` or `--flow <folder>`).
  The flows run in parallel in one browser; a failing flow does not stop the others (exit code 2
  if any failed). Read the `FLOW` and `SUITE` lines on stderr.
- A before/after pair: one call with `--before-url` and `--after-url` (or `--side before` now and
  `--side after` later with the same flow), with `--out-dir` when the pictures are to be kept.
- Logged-in pages: log in once with a flow and `--state s.json`, then pass the same `--state` to
  every later call; in a two-address run it means `s.before.json` and `s.after.json`.
- Use a `waitSelector` (or `--wait-selector`) that exists only when the view is ready, instead of
  delays; the script then also skips its idle wait and its default 800 ms delay. A half-loaded
  picture is fixed with a better `waitSelector` or `"settle": true`, not with a longer delay.

Details: **[references/cli.md](references/cli.md)** ("Several flows in one call", "Before/after
against two addresses") and **[references/ui-testing.md](references/ui-testing.md)**.

## Several people at once

One owner starts and stops the servers (and picks the ports). Several may drive a browser at the
same time against the same servers. Flows that write to the same database need their own test
data or account, or must run one after another (`--concurrency 1`).

After the environment is up, the owner may hand test paths to subagents. The brief names the URL,
the `--state` file and the test data to use; a subagent never starts a server and never stops
one.

## Saving before/after images to the kanban task

When the task's prompt names an images folder (a "UI testing" block with a path that ends in
`grants/task-<id>/ui`), the kanban keeps the pictures of a UI change there: the task's Images
tab shows them, the reviewer reads them and the office adds them to the pull request's
description. Write the captures straight into that folder with `--out-dir <images folder>` plus
`--side before|after` (one address) or `--before-url` / `--after-url` (both in one call); the
script creates the folder and names the files for you:

- The files are named `<subject>-before.png` and `<subject>-after.png`, with no timestamp; a
  later run overwrites an older file. The subject is the step's `shot` name in a flow and
  `--name` in single mode, and says what the view is (`login-form`, `board-narrow`): lowercase
  letters, digits, `.`, `_` and `-` only. A before and an after of the same view share their
  subject; other names are ignored by the office. The office lists at most 40 images per task.
- If the prompt lists a folder for each repository (`.../ui/<repo>`), the task changes several
  repositories: use the folder of the repository whose UI the picture shows as `--out-dir` (the
  pull request of that repository gets it). A picture saved straight in the images folder goes to
  every pull request of the task. Keep a view's before and after in the same folder, and retake an
  after picture under the same name in the same folder.
- Take the **before** image before you change any code, and the **after** image of the same
  view, in the same state and at the same viewport, once the change works. A view that is new
  has only an after image.
- In a side-named run always give the first step a `waitSelector` (or an assertion), so that a
  login page or an error page is not saved as the picture.
- After a later fix that changes the view, take the after image again under the **same name**;
  leave the before image as it is, and delete images that no longer apply.
- Use test data and test accounts: these images may end up in a pull request.

If the prompt names no images folder, leave the captures where the script put them.

## 5. Clean up

Shut down only the dev server you started and check its port is free. Clean up identifiable
test data created by this run when authorized; do not delete pre-existing user data.

Reports omit entered values, raw console messages and URL paths/queries by default. Screenshots,
session files and opt-in traces can still contain personal data and secrets. Use isolated test
accounts, keep artifacts private, and do not commit them. Do not enable `includeValues` or
`trace` on sensitive pages without appropriate authorization.

Notes:
- Without `--out-dir`, images go to the OS temp directory, outside the target repo, so **do not
  commit them** — they will not appear in the target repo's git status. Reports, traces and failure
  screenshots always stay in the OS temp directory. With `--out-dir`, do not commit the folder
  either unless it is the kanban images folder, which lives outside the repo.
- If the script reports that `playwright-core` is missing, install it once in this skill's
  directory with `npm ci` (or `npm install` if the lockfile is unavailable).
