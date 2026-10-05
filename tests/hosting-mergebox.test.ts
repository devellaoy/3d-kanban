// The PR window's merge box for a pull request on Azure DevOps or Bitbucket (ui/github/merge.ts):
// how it stands and that it merges there, never a merge the office can't do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostedMergeStatus, mergeStatus } from '../src/client/ui/github/merge.js';
import type { GhPullDetail } from '../src/shared/protocol.js';

const detail = (o: Partial<GhPullDetail> = {}): GhPullDetail => ({
  number: 7, body: '', state: 'OPEN', isDraft: false, reviewDecision: '', headRefName: 'feat/x', baseRefName: 'main',
  // What hostedPullDetail sends: the host doesn't say whether it can merge.
  mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', commits: 0, comments: [], reviews: [], reviewComments: [], checks: [],
  repo: { nameWithOwner: 'azure:contoso/Web/api', methods: [] }, viewer: '', ...o,
});

test('a pull request elsewhere can never be merged from the office, whatever it says', () => {
  assert.equal(mergeStatus(detail()).can, true, "GitHub's own reading would offer the merge dialog");
  for (const d of [detail(), detail({ checks: [{ name: 'b', state: 'fail' }] }), detail({ checks: [{ name: 'b', state: 'pending' }] }), detail({ isDraft: true }), detail({ reviewDecision: 'CHANGES_REQUESTED' })]) {
    const st = hostedMergeStatus(d, 'Azure DevOps');
    assert.equal(st.can, false);
    assert.equal(st.auto, false);
  }
  assert.match(hostedMergeStatus(detail(), 'Bitbucket').text, /Merge it on Bitbucket/);
  assert.match(hostedMergeStatus(detail({ checks: [{ name: 'b', state: 'fail' }] }), 'Azure DevOps').text, /1 check failing\. Merge it on Azure DevOps/);
  assert.match(hostedMergeStatus(detail({ isDraft: true }), 'Azure DevOps').text, /draft: publish it on Azure DevOps/);
  assert.equal(hostedMergeStatus(detail({ state: 'MERGED' }), 'Azure DevOps').text, 'Merged.');
});
