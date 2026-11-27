import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise only the shipped CLI, never a second browser driver. Requires system Chrome/Edge.
const cli = fileURLToPath(new URL('../scripts/screenshot.mjs', import.meta.url));
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI flow fixture</title><style>body{font:16px sans-serif;margin:16px}input,select,button{display:block;margin:8px 0}li{padding:12px;border:1px solid}#tip{visibility:hidden}#help:hover+#tip{visibility:visible}</style>
<main><h1>Editor</h1><label>Name<input id="name"></label>
<label>Size<select id="size"><option>Small</option><option>Large</option></select></label>
<label>Published<input type="checkbox" id="published"></label>
<label>Attachment<input type="file" id="file"></label><p id="filename"></p>
<button id="help">Help</button><p id="tip">Helpful tip</p>
<ul><li draggable="true" id="first">First</li><li draggable="true" id="second">Second</li></ul>
<button id="save">Save</button><button disabled id="disabled">Unavailable</button><p id="status">Ready</p>
<button id="open">Open dialog</button><dialog><button id="close">Close</button></dialog>
<button id="problem">Trigger browser error</button><button id="flood">Flood diagnostics</button></main>
<script>
const nameInput=document.querySelector('#name'), status=document.querySelector('#status');
const stored=JSON.parse(localStorage.getItem('saved')||'null');
if(stored){nameInput.value=stored.name;document.querySelector('#size').value=stored.size;document.querySelector('#published').checked=stored.published;}
document.querySelector('#file').onchange=e=>document.querySelector('#filename').textContent=e.target.files[0].name;
document.querySelector('#first').ondragstart=e=>e.dataTransfer.setData('text/plain','first');
document.querySelector('#second').ondragover=e=>e.preventDefault();
document.querySelector('#second').ondrop=e=>{e.preventDefault();e.currentTarget.after(document.querySelector('#first'));};
document.querySelector('#save').onclick=async()=>{status.textContent='Saving';try{const r=await fetch('/save',{method:'POST'});if(!r.ok)throw Error('failed');localStorage.setItem('saved',JSON.stringify({name:nameInput.value,size:document.querySelector('#size').value,published:document.querySelector('#published').checked}));status.textContent='Saved';}catch{status.textContent='Save failed';}};
document.querySelector('#open').onclick=()=>document.querySelector('dialog').showModal();
document.querySelector('#close').onclick=()=>document.querySelector('dialog').close();
document.querySelector('#problem').onclick=()=>{console.error('PRIVATE_CONSOLE_VALUE');setTimeout(()=>{throw Error('PRIVATE_PAGE_ERROR')},0)};
document.querySelector('#flood').onclick=()=>{for(let i=0;i<201;i++)console.warn('warning '+i);setTimeout(()=>{throw Error('AFTER_CAP_ERROR')},0)};
</script>`;

function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test('real browser: actions, persistence, fault recovery, reports and legacy CLI', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-ui-flow-test-'));
  const artifacts = new Set();
  let saves = 0;
  const server = createServer((req, res) => {
    if (req.url === '/save') { saves++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (process.env.KEEP_UI_FLOW_ARTIFACTS === '1') {
      for (const file of artifacts) t.diagnostic(`Artifact: ${file}`);
    } else {
      for (const file of artifacts) await rm(file, { force: true });
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'attachment.txt'), 'fixture upload');
  const run = async (name, flow) => {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify({ name, baseUrl, ...flow }));
    const result = await execute(['--flow', path, '--timeout', '3000', '--delay', '1']);
    const reportPath = result.stderr.match(/^REPORT (.+)$/m)?.[1];
    assert.ok(reportPath, result.stderr);
    artifacts.add(reportPath);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    for (const path of [...report.screenshots, ...report.traces]) artifacts.add(path);
    const paths = result.stdout.trim().split('\n').filter(Boolean);
    for (const path of paths) { assert.match(path, /\.png$/); assert.ok((await stat(path)).size > 0); }
    assert.deepEqual(paths, report.screenshots);
    return { ...result, report };
  };
  const action = (type, locator, extra = {}) => ({ type, locator, ...extra });
  const check = (type, locator, extra = {}) => ({ type, locator, ...extra });
  const passed = await run('workflow', {
    trace: true, viewport: { width: 390, height: 844 }, networkFailures: [{ url: '**/save', times: 1 }],
    steps: [
      { goto: '/', assertions: [check('visible', 'main'), check('hidden', 'dialog'), check('disabled', '#disabled'), check('enabled', '#save'), check('count', 'li', { expected: 2 }), { type: 'url', expected: baseUrl + '/' }] },
      { actions: [action('fill', { label: 'Name' }, { value: 'Saved fixture name' }), action('select', '#size', { values: 'Large' }), action('check', '#published', { checked: true }), action('upload', '#file', { files: ['attachment.txt'] })], assertions: [check('value', '#name', { expected: 'Saved fixture name' }), check('checked', '#published', { expected: true }), check('text', '#filename', { expected: 'attachment.txt' })] },
      { actions: [action('hover', '#help')], assertions: [check('visible', '#tip')] },
      { actions: [action('drag', '#first', { to: '#second' })], assertions: [check('order', 'li', { expected: ['Second', 'First'] })] },
      { actions: [action('click', { role: 'button', name: 'Open dialog' })], assertions: [check('visible', 'dialog'), check('focused', '#close')] },
      { actions: [action('press', '#close', { key: 'Escape' })], assertions: [check('hidden', 'dialog')] },
      { actions: [action('click', { role: 'button', name: 'Save' })], assertions: [check('text', '#status', { expected: 'Save failed' }), check('value', '#name', { expected: 'Saved fixture name' })] },
      { actions: [action('click', '#save')], assertions: [check('text', '#status', { expected: 'Saved' })], shot: 'saved' },
      { actions: [{ type: 'reload' }], assertions: [check('value', '#name', { expected: 'Saved fixture name' }), check('value', '#size', { expected: 'Large' }), check('checked', '#published', { expected: true }), { type: 'noHorizontalOverflow' }], shot: 'persisted-mobile' },
      { viewport: { width: 1280, height: 900 }, assertions: [{ type: 'noHorizontalOverflow' }], shot: 'desktop' },
      { viewport: { width: 390, height: 844, mobile: true, dpr: 2 }, assertions: [check('value', '#name', { expected: 'Saved fixture name' }), { type: 'noHorizontalOverflow' }] },
      { actions: [action('click', '#save')], assertions: [check('text', '#status', { expected: 'Saved' })], shot: 'mobile-context' },
    ],
  });
  assert.equal(passed.code, 0, passed.stderr + JSON.stringify(passed.report));
  assert.equal(passed.report.status, 'passed');
  assert.equal(saves, 2, 'first save intercepted; retry and save after context recreation reach actual server');
  assert.equal(passed.report.diagnostics.filter(d => d.type === 'simulated-network-failure').length, 1);
  assert.ok(passed.report.diagnostics.some(d => d.type === 'requestfailed'));
  assert.ok(passed.report.traces.length > 0);
  assert.ok(!JSON.stringify(passed.report).includes('Saved fixture name'), 'assertion values redacted by default');

  const failed = await run('expected-failure', { steps: [{ goto: '/' }, { actions: [action('click', '#problem')], assertions: [check('text', '#status', { expected: 'PRIVATE_EXPECTED_VALUE', timeout: 150 })] }] });
  assert.notEqual(failed.code, 0);
  assert.equal(failed.report.status, 'failed');
  assert.equal(failed.report.steps[1].failure.type, 'text');
  assert.equal(failed.report.steps[1].failure.expected, '[redacted]');
  assert.ok(failed.report.screenshots.some(path => path.endsWith('-failure.png')));
  assert.ok(failed.report.diagnostics.some(d => d.type === 'pageerror'));
  assert.ok(failed.report.diagnostics.some(d => d.type === 'console'));
  assert.ok(!JSON.stringify(failed.report).includes('PRIVATE_'));

  const flooded = await run('diagnostic-cap', { failOnPageError: true, steps: [{ goto: '/' }, { actions: [action('click', '#flood')], wait: 1 }, { wait: 150, assertions: [check('visible', 'main')] }] });
  assert.notEqual(flooded.code, 0, 'page error must fail even after diagnostic cap');
  assert.equal(flooded.report.status, 'failed');
  assert.ok(flooded.report.pageErrorCount > 0);
  assert.equal(flooded.report.diagnostics.length, 200);
  assert.ok(flooded.report.droppedDiagnostics > 0);

  const legacy = await run('legacy-flow', { steps: [{ goto: '/', click: '#open' }, { waitSelector: 'dialog[open]', measure: 'dialog', shot: 'legacy' }] });
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(legacy.report.status, 'capture-only');
  assert.match(legacy.stderr, /MEASURE /);
  const single = await execute([baseUrl, '--name', 'legacy-single', '--delay', '1', '--wait-selector', 'main']);
  assert.equal(single.code, 0, single.stderr);
  const image = single.stdout.trim();
  artifacts.add(image);
  assert.match(image, /\.png$/);
  assert.ok((await stat(image)).size > 0);
});

test('real browser: flow suite with a failing job, and before/after runs into an out dir', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-ui-suite-test-'));
  const artifacts = new Set();
  const listen = async heading => {
    const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><title>x</title><main><h1>${heading}</h1><button id="go">Go</button></main>`); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  const before = await listen('Old heading');
  const after = await listen('New heading');
  t.after(async () => {
    for (const { server } of [before, after]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const file of artifacts) await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const note = (stderr, pattern) => {
    for (const m of stderr.matchAll(pattern)) artifacts.add(m[1]);
  };
  const writeFlow = async (name, steps) => {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify({ name, baseUrl: before.url, steps }));
    return path;
  };

  // Two flows in one call: one passes, one fails on a missing element.
  const good = await writeFlow('suite-good', [{ goto: '/', waitSelector: 'main', assertions: [{ type: 'visible', locator: 'main h1' }], shot: 'home' }]);
  const bad = await writeFlow('suite-bad', [{ goto: '/', waitSelector: 'main' }, { actions: [{ type: 'click', locator: '#missing-button', timeout: 300 }] }]);
  const suite = await execute(['--flow', good, '--flow', bad, '--timeout', '3000']);
  note(suite.stderr, /REPORT (.+)$/gm);
  note(suite.stderr, /SUITE-REPORT (.+)$/gm);
  assert.equal(suite.code, 2, suite.stderr);
  const flowLines = suite.stderr.split('\n').filter(line => line.startsWith('FLOW '));
  assert.equal(flowLines.length, 2, suite.stderr);
  assert.ok(flowLines.some(line => /^FLOW suite-good passed shots=1 /.test(line)));
  const badLine = flowLines.find(line => line.startsWith('FLOW suite-bad failed'));
  assert.match(badLine, /failed-step=2 action 1 click: not-found, matches=0$/);
  assert.match(suite.stderr, /^SUITE 1\/2 passed, 1 failed, 0 capture-only, \d+ ms$/m);
  const paths = suite.stdout.trim().split('\n').filter(Boolean);
  assert.equal(paths.length, 2);
  for (const path of paths) { artifacts.add(path); assert.match(path, /\.png$/); }
  const badReport = JSON.parse(await readFile(suite.stderr.match(/\[suite-bad\] REPORT (.+)$/m)[1], 'utf8'));
  assert.equal(badReport.steps[1].failure.reason, 'not-found');
  assert.equal(badReport.steps[1].failure.matches, 0);
  assert.ok(!JSON.stringify(badReport).includes('missing-button'));

  // The same flow against two addresses, shots named by side in --out-dir.
  const outDir = join(directory, 'out');
  const flow = await writeFlow('compare', [{ goto: '/', waitSelector: 'main h1', assertions: [{ type: 'url', expected: '/' }], shot: 'Home Page' }]);
  const compare = await execute(['--flow', flow, '--before-url', before.url, '--after-url', after.url, '--out-dir', outDir, '--timeout', '3000']);
  note(compare.stderr, /REPORT (.+)$/gm);
  note(compare.stderr, /SUITE-REPORT (.+)$/gm);
  assert.equal(compare.code, 0, compare.stderr);
  assert.deepEqual((await readdir(outDir)).sort(), ['home-page-after.png', 'home-page-before.png']);
  assert.deepEqual(compare.stdout.trim().split('\n').map(path => path.split('/').pop()).sort(), ['home-page-after.png', 'home-page-before.png']);
  assert.match(compare.stderr, /^FLOW compare@before passed shots=1 /m);
  assert.match(compare.stderr, /^FLOW compare@after passed shots=1 /m);
  for (const name of await readdir(outDir)) assert.ok((await stat(join(outDir, name))).size > 0);

  // Two shots that would write the same side-named file are refused before any browser starts.
  const clash = await writeFlow('clash', [{ goto: '/', waitSelector: 'main', shot: 'Same' }, { shot: 'same' }]);
  const refused = await execute(['--flow', clash, '--side', 'after', '--out-dir', outDir]);
  assert.equal(refused.code, 2);
  assert.equal(refused.stdout, '');
});

test('real browser: sessionStorage state is bound to its origin (iframes, other addresses)', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-ui-origin-test-'));
  const artifacts = new Set();
  const reports = [];
  const page = (frame) => `<!doctype html><title>x</title><main><p id="tok">pending</p>${frame ? `<iframe src="${frame}/frame"></iframe>` : ''}</main>
<script>document.getElementById('tok').textContent = sessionStorage.getItem('token') || 'none'</script>`;
  const listen = async (frameOf) => {
    let own = '';
    const server = createServer((req, res) => {
      if (req.url.startsWith('/report')) { reports.push(decodeURIComponent(req.url.split('t=')[1])); res.writeHead(200); res.end('ok'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (req.url === '/frame') res.end(`<!doctype html><script>fetch('/report?t='+encodeURIComponent(sessionStorage.getItem('token')))</script>`);
      else res.end(page(frameOf() ? own : ''));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    return { server, url, setFrame: value => { own = value; } };
  };
  let embed = true;
  const a = await listen(() => embed);
  const b = await listen(() => false);
  a.setFrame(b.url);
  t.after(async () => {
    for (const { server } of [a, b]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const file of artifacts) await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const run = async (name, baseUrl, steps, state) => {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify({ name, baseUrl, steps }));
    const result = await execute(['--flow', path, '--state', state, '--timeout', '3000', '--delay', '1']);
    for (const m of result.stderr.matchAll(/REPORT (.+)$/gm)) artifacts.add(m[1]);
    return result;
  };
  const state = join(directory, 'state.json');
  const read = (selector, expected) => ({ type: 'text', locator: selector, expected });

  // Run 1: a login that lives only in sessionStorage is saved with its origin.
  const first = await run('save', a.url, [{ goto: '/', waitSelector: '#tok', eval: "sessionStorage.setItem('token', 'T1')" }], state);
  assert.equal(first.code, 0, first.stderr);
  const saved = JSON.parse(await readFile(state, 'utf8'));
  assert.deepEqual(saved.cookies, []);
  assert.equal(saved.sessionStorage.token, 'T1');
  assert.equal(saved.sessionStorageOrigin, a.url);
  assert.equal((await stat(state)).mode & 0o777, 0o600);

  // Run 2: same address sees the token; the cross-origin iframe on the page does not.
  reports.length = 0;
  const second = await run('restore', a.url, [{ goto: '/', waitSelector: '#tok', wait: 400, assertions: [read('#tok', 'T1')] }], state);
  assert.equal(second.code, 0, second.stderr);
  assert.ok(!second.stderr.includes('state=missing-origin'), second.stderr);
  assert.ok(reports.length > 0, 'the iframe reported its storage');
  assert.ok(reports.every(value => value === 'null'), `iframe got ${JSON.stringify(reports)}`);

  // Run 3: another address never gets it.
  const third = await run('other', b.url, [{ goto: '/', waitSelector: '#tok', assertions: [read('#tok', 'none')] }], state);
  assert.equal(third.code, 0, third.stderr);
  assert.match(third.stderr, /state=missing-origin/);

  // A legacy file (sessionStorage, no recorded origin) is restored nowhere, not even at its own address.
  const legacyState = origin => JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [] }], sessionStorage: { token: 'T2' } });
  await writeFile(state, legacyState(a.url));
  reports.length = 0;
  const noOrigin = await run('legacy-a', a.url, [{ goto: '/', waitSelector: '#tok', wait: 400, assertions: [read('#tok', 'none')] }], state);
  assert.equal(noOrigin.code, 0, noOrigin.stderr);
  assert.match(noOrigin.stderr, /sessionStorage has no recorded origin and is not restored/);
  assert.ok(reports.every(value => value === 'null'), `iframe got ${JSON.stringify(reports)}`);
  // After that run the state was saved again, now with the page's origin.
  assert.equal(JSON.parse(await readFile(state, 'utf8')).sessionStorageOrigin, a.url);
  const otherAddress = await run('legacy-b', b.url, [{ goto: '/', waitSelector: '#tok', assertions: [read('#tok', 'none')] }], (await writeFile(state, legacyState(a.url)), state));
  assert.equal(otherAddress.code, 0, otherAddress.stderr);
  // The explicit field is the only way to declare the origin.
  await writeFile(state, JSON.stringify({ cookies: [], origins: [], sessionStorage: { token: 'T3' }, sessionStorageOrigin: a.url }));
  const explicit = await run('explicit', a.url, [{ goto: '/', waitSelector: '#tok', assertions: [read('#tok', 'T3')] }], state);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.ok(!explicit.stderr.includes('no recorded origin'));
});

test('real browser: cookies stay on their host across a viewport change, URLs are scrubbed, single-shot failures are classified', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-ui-cookie-test-'));
  const artifacts = new Set();
  const received = { a: [], b: [] };
  const listen = async key => {
    const server = createServer((req, res) => {
      received[key].push(req.headers.cookie ?? '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>x</title><main><h1>Host page</h1></main>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { server, port: server.address().port };
  };
  const a = await listen('a');
  const b = await listen('b');
  const urlA = `http://127.0.0.1:${a.port}`;
  const urlB = `http://localhost:${b.port}`;
  t.after(async () => {
    for (const { server } of [a, b]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const file of artifacts) await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const steps = [
    { goto: '/', waitSelector: 'main' },
    { goto: `${urlB}/private?token=SECRETQ`, waitSelector: 'main' },
    { viewport: { width: 390, height: 800, mobile: true }, waitSelector: 'main', shot: 'mobile-b' },
    { goto: '/again', waitSelector: 'main' },
  ];
  const paths = [];
  for (const name of ['cookie-one', 'cookie-two']) {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify({ name, baseUrl: urlA, steps }));
    paths.push(path);
  }
  const result = await execute(['--flow', paths[0], '--flow', paths[1], '--cookie', 'sid=COOKIE_SECRET', '--timeout', '3000', '--delay', '1']);
  assert.equal(result.code, 0, result.stderr);
  const texts = [result.stdout, result.stderr];
  for (const m of result.stderr.matchAll(/(?:REPORT|SUITE-REPORT) (.+)$/gm)) { artifacts.add(m[1]); texts.push(await readFile(m[1], 'utf8')); }
  for (const path of result.stdout.trim().split('\n')) artifacts.add(path);
  assert.ok(received.b.length > 0);
  assert.ok(received.b.every(cookie => !cookie.includes('COOKIE_SECRET')), `host B got ${JSON.stringify(received.b)}`);
  assert.ok(received.a.some(cookie => cookie.includes('COOKIE_SECRET')), 'host A still has the cookie');
  assert.ok(received.a.at(-1).includes('COOKIE_SECRET'), 'host A has it after the switch too');
  for (const text of texts) assert.ok(!text.includes('SECRETQ') && !text.includes('/private'), 'no URL path or query in output');
  assert.ok(result.stderr.includes(`goto ${urlB}`));

  // Single-shot failures: one sanitized line, exit 2, no selector.
  for (const [extra, line] of [[['--wait-selector', '#no-such-secret'], '--wait-selector: not-found, matches=0'], [['--click', '#gone-secret'], '--click 1: not-found, matches=0'], [['--clip-selector', '#clip-secret'], '--clip-selector: not-found, matches=0']]) {
    const single = await execute([`${urlA}/p?token=SECRETQ`, '--timeout', '1000', '--delay', '1', ...extra]);
    assert.equal(single.code, 2, single.stderr);
    assert.ok(single.stderr.includes(`Virhe: ${line}`), single.stderr);
    assert.ok(!/secret/i.test(single.stderr + single.stdout), single.stderr);
    assert.equal(single.stdout, '');
  }
});

test('real browser: includeValues shows full URLs only for the flow that opted in', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-ui-optin-test-'));
  const artifacts = new Set();
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>x</title><main>ok</main>'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const file of artifacts) await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const flows = [];
  for (const [name, includeValues, marker] of [['quiet', false, 'HIDDENQ'], ['loud', true, 'SHOWNQ']]) {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify({ name, baseUrl, includeValues, steps: [{ goto: `/p(1)/x?t=${marker}`, waitSelector: 'main', shot: name }] }));
    flows.push(path);
  }
  const result = await execute(['--flow', flows[0], '--flow', flows[1], '--timeout', '3000', '--delay', '1']);
  assert.equal(result.code, 0, result.stderr);
  const texts = [result.stdout, result.stderr];
  for (const m of result.stderr.matchAll(/(?:REPORT|SUITE-REPORT) (.+)$/gm)) { artifacts.add(m[1]); texts.push(await readFile(m[1], 'utf8')); }
  for (const path of result.stdout.trim().split('\n')) artifacts.add(path);
  for (const text of texts) assert.ok(!text.includes('HIDDENQ'), 'the quiet flow leaks no URL');
  assert.match(result.stderr, new RegExp(`\\[loud\\] askel 1/1: goto ${baseUrl.replace(/[.]/g, '\\.')}/p\\(1\\)/x\\?t=SHOWNQ`));
  assert.match(result.stderr, new RegExp(`\\[quiet\\] askel 1/1: goto ${baseUrl.replace(/[.]/g, '\\.')}$`, 'm'));
});
