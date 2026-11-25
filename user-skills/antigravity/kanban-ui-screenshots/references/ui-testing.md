# Functional UI tests with the existing flow runner

Run `node "<skill-base>/scripts/screenshot.mjs" --flow /absolute/test.json`.
Use local/staging test accounts. Actions can save, upload or delete through the application:
they remain subject to the user's authorization. Only test a destructive workflow on disposable
data. Browser mobile emulation is not verification on a physical mobile device.

## A complete workflow

```json
{
  "name": "profile-save",
  "baseUrl": "http://localhost:9036",
  "failOnPageError": true,
  "steps": [
    { "goto": "/profile", "waitSelector": "form" },
    { "actions": [
      { "type": "fill", "locator": { "label": "Name" }, "value": "Test User" },
      { "type": "click", "locator": { "role": "button", "name": "Save" } }
    ], "assertions": [
      { "type": "text", "locator": "[role=status]", "expected": "Saved" }
    ] },
    { "actions": [{ "type": "reload" }], "assertions": [
      { "type": "value", "locator": { "label": "Name" }, "expected": "Test User" },
      { "type": "noHorizontalOverflow", "tolerance": 1 }
    ], "shot": "saved-after-reload" }
  ]
}
```

Choose the URL and port of your actual authorized test environment. `actions` execute in array
order; `assertions` run afterwards. Split steps to assert intermediate states. Legacy `click`,
`eval`, `measure`, `shot`, session and viewport options still work. Unknown action/assertion
types or fields are rejected before the first flow action; they are not silently skipped.

## Locators

Use a CSS selector string, `{ "role": "button", "name": "Save" }`,
`{ "label": "Email" }`, or `{ "testId": "editor-canvas" }`.
Role/name and label are exact by default; set `exact: false` for substring matching.
Prefer accessible names or stable test IDs over positional selectors. Actions target a single
element; an ambiguous locator is a failure, not permission to pick an arbitrary match.

## Actions

Each operation has `type` and the fields below; optional `timeout` is milliseconds (1–300000).
The CLI `--timeout` is the default per operation, not a total-flow timeout.

| Type | Fields |
|---|---|
| `click`, `hover` | `locator` |
| `fill` | `locator`, `value` string |
| `select` | `locator`, `values` option value string or array |
| `check` | `locator`, `checked` boolean |
| `press` | `locator`, `key`, e.g. `Tab`, `Escape`, `ControlOrMeta+z` |
| `drag` | source `locator`, destination `to` locator |
| `upload` | `locator`, `files` path or array, relative to the flow file |
| `reload` | no locator |

These use Playwright's native action APIs, not JavaScript property assignments. Drag behavior
still needs an assertion of the resulting order/position; not every custom canvas editor uses
the same drag protocol. For undo/redo, use the application's actual buttons or shortcuts and
assert the result; there is no synthetic history manipulation.

## Assertions

Each assertion polls until it passes or its timeout expires. It never retries a mutating
action. A timeout fails the run and preserves evidence. No arbitrary sleep is required for
eventually visible status messages or asynchronous saved values.

| Type | Fields / meaning |
|---|---|
| `visible`, `hidden` | `locator`; hidden also allows an absent element |
| `attached`, `detached` | `locator`; DOM presence, not visibility |
| `enabled`, `disabled`, `focused` | single `locator` |
| `text`, `value` | `locator`, string `expected` |
| `count` | `locator`, nonnegative integer `expected` |
| `checked` | `locator`, boolean `expected` |
| `url` | absolute string `expected` |
| `order` | list `locator`, `expected` array of trimmed element texts |
| `noHorizontalOverflow` | optional `tolerance` pixels, default 1 |

For layout, combine assertions with existing `measure` results and visual inspection. Run a
workflow in different top-level `viewport` configurations for independent responsive tests.
Mid-flow viewport changes preserve the session; a mobile/DPR context change reloads the page,
so save unsaved editor state first or explicitly test its loss behavior.

## Error recovery and diagnostics

To abort a known request a fixed number of times, add top-level:

```json
"networkFailures": [{ "url": "**/api/save", "times": 1 }]
```

Then click Save, assert the error and retained input, click Retry, and assert success plus
persistence. The report marks simulated failures. Counts apply to the whole flow, including
viewport context changes. This tests client recovery, not the reliability of the real server.
Do not intercept broad production traffic. Avoid service workers when testing interception;
browser-managed requests may not pass through Playwright routing.

Every flow writes a private JSON report in the OS temporary screenshot directory. Its path is
printed on stderr as `REPORT <path>`; stdout remains image paths only. The report includes:

- `status`: `passed` (assertions passed), `failed`, or `capture-only` (no assertions).
- Step/action/assertion outcomes and the failing step with expected/actual where safe.
- Failure screenshot path when capture succeeds, plus requested screenshots.
- Bounded console warning/error, JavaScript error, HTTP 4xx/5xx and failed-request metadata.
- Optional trace paths and explicit simulated network-failure events.

By default string assertion values are redacted, console/error text is omitted, and network
URLs are reduced to origins. Numeric/boolean comparisons remain readable. No request bodies,
headers or cookies are collected in the JSON report. Diagnostics alone do not fail a run
unless `failOnPageError: true` is set; expected HTTP failures may be part of a recovery test.
Top-level `includeValues: true` opts into textual assertion values and raw console/error text
(bounded); use only with nonsensitive test data. Legacy `eval`/`measure` and progress stderr
can expose page text or URLs and are not a secure logging channel.

Top-level `trace: true` captures Playwright traces (one per browser context) for detailed
inspection. **Traces, screenshots, session state and opt-in values may contain secrets.**
Use disposable test data, protect these files, and never commit them. Failure screenshots show
the viewport without scrolling the page to trigger extra lazy loads. Missing failure screenshots
or traces are marked in the report; never claim those artifacts were verified. A missing optional
trace does not change the outcome of completed assertions.

Success exits 0; failed flow/assertion exits 2. Invalid input or browser startup failures may
occur before a report exists. A successful fixture test or screenshot does not establish that
an untested application workflow is complete.
