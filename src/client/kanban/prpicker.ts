// Before a pull request is reviewed (Review or Review panel in upstream's PR window): which PRs
// the review takes. The ones that belong with it — the same branch in the project's other
// repositories, or the same task — come picked (kanban.pr.bundle); any other open PR of the project
// can be added. Several go to one reviewer together (kanban.pr.review). Just this one keeps
// upstream's own single-PR flow.

import { h, toast } from '../ui/dom';
import type { Net } from '../net';
import { store } from '../state';
import type { GhPull } from '../../shared/protocol';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { PR_REVIEW_MAX, type KanbanPrBundleItem, type PrRef } from '../../shared/kanban/types.js';
import { kanbanApi, type KanbanOk } from './api';
import { hostOfUrl } from '../../shared/hosting/remote';
import { repoOfItem } from './boardrepos';
import { pickerRows, refKey, reviewTaskOf } from './model';
import { btn } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import { prPickRow } from './prfind';
import { run } from './ui';

type BundleMsg = Extract<KanbanServerMsg, { t: 'kanban.pr.bundle' }>;

/**
 * Opens the picker for `pull` on the floor you're on. `single` is upstream's review of just this PR
 * (the Review prompt, or the meeting room's panel), for when that's all that's wanted.
 */
export function openReviewPicker(net: Net, pull: GhPull, mode: 'review' | 'panel', single: () => void) {
  const project = store.floor;
  const repo = repoOfItem(pull);
  // Nothing to bundle with outside a project, or for a PR the office can't place.
  if (!project || !repo) return single();
  const api = kanbanApi(net);
  const self = { repo, number: pull.number, title: pull.title, url: pull.url };
  let bundle: KanbanPrBundleItem[] = [];
  let loading = true;
  let error = '';
  const picked = new Set<string>([refKey(self)]);

  const list = h('div.kb-prs-body');
  const note = h('span.kb-prs-note', {}, 'Pull requests of the same branch or task in the project’s other repositories are picked with it. Add any other open pull request of the project.');
  const cancel = btn('Cancel', { kind: 'quiet' });
  const justThis = btn('Just this PR', { attrs: { title: 'Review only this pull request, as before' } });
  const go = btn('', { kind: 'primary' });
  const count = h('span', { 'aria-live': 'polite' });
  const shell = modalShell({
    cls: 'kb-prs w640',
    icon: mode === 'panel' ? 'users' : 'eye',
    title: mode === 'panel' ? 'Review panel: which pull requests?' : 'Review: which pull requests?',
    id: `${repo.split('/').pop()} #${pull.number}`,
    body: [h('div.kb-prs-body', {}, note, list)],
    footerLeft: [count],
    footerRight: [cancel, justThis, go],
  });
  const modal = openShell(shell);
  cancel.addEventListener('click', () => modal.close());

  const others = () =>
    store.pulls.items
      .filter((p) => p.state === 'OPEN')
      .map((p) => ({ repo: repoOfItem(p), number: p.number, title: p.title, url: p.url }))
      .filter((p) => p.repo);

  const row = (p: PrRef & { title: string; url: string }, cls = '') => {
    const k = refKey(p);
    const box = h('input', { type: 'checkbox', checked: picked.has(k) }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (box.checked) {
        if (picked.size >= PR_REVIEW_MAX) {
          box.checked = false;
          return toast(`One review takes at most ${PR_REVIEW_MAX} PRs`, 'warn');
        }
        picked.add(k);
      } else picked.delete(k);
      paintGo();
    });
    return prPickRow({ box, title: p.title, name: `${p.repo.split('/').pop()} #${p.number}`, url: p.url, branch: 'branch' in p ? (p as KanbanPrBundleItem).branch : undefined, cls });
  };

  const paint = () => {
    const rows = pickerRows(self, bundle, others());
    list.replaceChildren(
      h('div.list-box.kb-prs-list', {}, row(self, 'this')),
      ...(loading ? [h('span.kb-prs-note', {}, 'Looking for the pull requests that go with it…')] : []),
      ...(error ? [h('p.kb-prs-error', { role: 'alert' }, error)] : []),
      ...(rows.related.length ? [h('h3.kb-prs-h', {}, 'Belong with it'), h('div.list-box.kb-prs-list', {}, ...rows.related.map((p) => row(p)))] : !loading && !error ? [h('span.kb-prs-note', {}, 'No other pull requests share its branch or task.')] : []),
      ...(rows.rest.length ? [h('h3.kb-prs-h', {}, 'Other open pull requests in this project'), h('div.list-box.kb-prs-list', {}, ...rows.rest.map((p) => row(p)))] : []),
    );
    paintGo();
  };

  const onlySelf = () => picked.size === 1 && picked.has(refKey(self));
  // A pull request on Azure DevOps or Bitbucket is reviewed by the kanban's reviewer even alone: its
  // prompt tells it to use office-pr there, where upstream's single-PR review would use gh.
  const elsewhere = mode === 'review' && (hostOfUrl(pull.url) ?? 'github') !== 'github';
  const paintGo = () => {
    go.textContent = onlySelf() ? (mode === 'panel' ? 'Call the panel for this PR' : 'Review this PR') : `Review ${picked.size} PRs together`;
    go.disabled = picked.size === 0;
    count.textContent = `${picked.size} selected`;
  };

  /** The kanban's review of the PRs `keys` names (one task's keep their task; any other mix is a new task). */
  const reviewOf = async (keys: Set<string>, button: HTMLButtonElement) => {
    const all = [self, ...bundle, ...others()];
    const prs: PrRef[] = [];
    for (const k of keys) {
      const p = all.find((x) => refKey(x) === k);
      if (p) prs.push({ repo: p.repo, number: p.number });
    }
    const taskId = reviewTaskOf(keys, bundle);
    // The panel keeps being a panel for several PRs too: the meeting room reviews them as one change set.
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.pr.review', project, prs, ...(taskId ? { taskId } : {}), ...(mode === 'panel' ? { panel: true } : {}) }), button);
    return { ok, prs };
  };

  justThis.addEventListener('click', async () => {
    if (elsewhere) return void reviewed(await reviewOf(new Set([refKey(self)]), justThis));
    modal.close();
    single();
  });
  go.addEventListener('click', async () => {
    if (onlySelf() && !elsewhere) {
      modal.close();
      return single();
    }
    reviewed(await reviewOf(picked, go));
  });

  const reviewed = ({ ok, prs }: { ok: KanbanOk | undefined | null; prs: PrRef[] }) => {
    if (!ok) return;
    modal.close();
    // The review is a kanban task of its own now (or goes into the bundle's task).
    // No reviewer yet (a panel, or no room in the office: the review task is queued and starts by itself).
    const what = prs.length === 1 ? 'the PR' : `the ${prs.length} PRs`;
    if (ok.taskId && !ok.workerId && mode !== 'panel') toast(`The review of ${what} is queued: task #${ok.taskId} starts when the office has room`);
    else toast(ok.taskId ? `A reviewer takes ${what}${prs.length > 1 ? ' together' : ''}: task #${ok.taskId}` : `A reviewer takes ${what}${prs.length > 1 ? ' together' : ''}`);
  };

  paint();
  api
    .request<BundleMsg>({ t: 'kanban.pr.bundle', project, branch: pull.headRefName })
    .then((msg) => {
      bundle = [...msg.prs];
      error = msg.error ?? '';
      for (const b of bundle) if (picked.size < PR_REVIEW_MAX) picked.add(refKey(b));
    })
    .catch((err: Error) => {
      error = err.message;
    })
    .finally(() => {
      // The board's own PRs on the same branch in the project's other repositories belong with it
      // too, even when the office couldn't work the bundle out (no gh sign-in, say).
      const sameBranch = store.pulls.items.filter((p) => p.state === 'OPEN' && p.headRefName === pull.headRefName && refKey({ repo: repoOfItem(p), number: p.number }) !== refKey(self));
      for (const p of sameBranch) {
        const item: KanbanPrBundleItem = { repo: repoOfItem(p), number: p.number, url: p.url, title: p.title, state: 'OPEN', branch: p.headRefName };
        if (!item.repo || bundle.some((b) => refKey(b) === refKey(item))) continue;
        bundle.push(item);
        if (picked.size < PR_REVIEW_MAX) picked.add(refKey(item));
      }
      loading = false;
      paint();
    });
}
