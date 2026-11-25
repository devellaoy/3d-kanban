import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
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
