// Before a pull request is reviewed (🔍 Review or 🤝 Review panel in upstream's PR window): which PRs
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
import { repoOfItem } from './boardrepos';
import { pickerRows, refKey, reviewTaskOf } from './model';
import { officeCss } from './officecss';
import { dialog, run, showDialog } from './ui';

type BundleMsg = Extract<KanbanServerMsg, { t: 'kanban.pr.bundle' }>;

/**
 * Opens the picker for `pull` on the floor you're on. `single` is upstream's review of just this PR
 * (the 🔍 Review prompt, or the meeting room's panel), for when that's all that's wanted.
 */
export function openReviewPicker(net: Net, pull: GhPull, mode: 'review' | 'panel', single: () => void) {
  const project = store.floor;
  const repo = repoOfItem(pull);
  // Nothing to bundle with outside a project, or for a PR the office can't place.
  if (!project || !repo) return single();
  officeCss();
  const api = kanbanApi(net);
  const self = { repo, number: pull.number, title: pull.title, url: pull.url };
  let bundle: KanbanPrBundleItem[] = [];
  let loading = true;
  let error = '';
  const picked = new Set<string>([refKey(self)]);

  const list = h('div.kb-pr-lists');
  const note = h('p.kb-note', {}, 'PRs of the same branch or task in the project’s other repositories are picked with it. Add any other open PR of the project.');
  const justThis = h('button.btn', { type: 'button', title: 'Review only this pull request, as before' }, 'Just this PR') as HTMLButtonElement;
  const go = h('button.btn.primary', { type: 'button' }) as HTMLButtonElement;
  const d = dialog('kb-pr-picker', mode === 'panel' ? `🤝 Review panel for PR #${pull.number}: which PRs?` : `🔍 Review PR #${pull.number}: which PRs?`, h('div.body', {}, note, list), h('footer', {}, h('span.grow'), justThis, go));
  const modal = showDialog(d);

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
    return h('li', { class: cls }, h('label', {}, box, h('b', {}, `${p.repo.split('/').pop()} #${p.number}`), h('span.kb-pr-title', { title: p.title }, p.title)));
  };

  const paint = () => {
    const rows = pickerRows(self, bundle, others());
    list.replaceChildren(
      h('ul.kb-pr-list', {}, row(self, 'this')),
      ...(loading ? [h('p.kb-note', {}, 'Looking for the PRs that go with it…')] : []),
      ...(error ? [h('p.kb-err', {}, `⚠️ ${error}`)] : []),
      ...(rows.related.length ? [h('h5', {}, 'Belong with it'), h('ul.kb-pr-list', {}, ...rows.related.map((p) => row(p)))] : !loading && !error ? [h('p.kb-note', {}, 'No other PRs share its branch or task.')] : []),
      ...(rows.rest.length ? [h('h5', {}, 'Other open PRs in this project'), h('ul.kb-pr-list', {}, ...rows.rest.map((p) => row(p)))] : []),
    );
    paintGo();
  };

  const onlySelf = () => picked.size === 1 && picked.has(refKey(self));
  const paintGo = () => {
    go.textContent = onlySelf() ? (mode === 'panel' ? 'Call the panel for this PR' : 'Review this PR') : `Review ${picked.size} PRs together`;
    go.disabled = picked.size === 0;
  };

  justThis.addEventListener('click', () => {
    modal.close();
    single();
  });
  go.addEventListener('click', async () => {
    if (onlySelf()) {
      modal.close();
      return single();
    }
    const all = [self, ...bundle, ...others()];
    const prs: PrRef[] = [];
    for (const k of picked) {
      const p = all.find((x) => refKey(x) === k);
      if (p) prs.push({ repo: p.repo, number: p.number });
    }
    // One task's PRs keep their task, so the review is written into it; any other mix is a new task.
    const taskId = reviewTaskOf(picked, bundle);
    // 🤝 keeps being a panel for several PRs too: the meeting room reviews them as one change set.
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.pr.review', project, prs, ...(taskId ? { taskId } : {}), ...(mode === 'panel' ? { panel: true } : {}) }), go);
    if (!ok) return;
    modal.close();
    // The review is a kanban task of its own now (or goes into the bundle's task).
    toast(ok.taskId ? `A reviewer takes the ${prs.length} PRs together: task #${ok.taskId}` : `A reviewer takes the ${prs.length} PRs together`);
  });

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
