import test from 'node:test';
import assert from 'node:assert/strict';
import { safeHref, safeUrl } from '../src/client/ui/url.js';

test('safeUrl lets only absolute http(s) addresses through', () => {
  assert.equal(safeUrl('https://github.com/a/b/pull/1'), 'https://github.com/a/b/pull/1');
  assert.equal(safeUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', '//evil.test/x', '/relative', 'not a url', '', undefined, null]) {
    assert.equal(safeUrl(bad), undefined, String(bad));
  }
});

test('safeHref also keeps the app\'s own relative paths', () => {
  assert.equal(safeHref('/lite'), '/lite');
  assert.equal(safeHref('#top'), '#top');
  assert.equal(safeHref('https://x.test/'), 'https://x.test/');
  assert.equal(safeHref('javascript:alert(1)'), undefined);
  assert.equal(safeHref('data:text/html,hi'), undefined);
});
