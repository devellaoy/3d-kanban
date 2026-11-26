// Before a pull request is reviewed (Review or Review panel in upstream's PR window): which PRs
// the review takes. The ones that belong with it — the same branch in the project's other
// repositories, or the same task — come picked (kanban.pr.bundle); any other open PR of the project
// can be added. A review is always a kanban task (kanban.pr.review), of one PR or of several
// together; a panel on several opens the meeting form with the office's brief (kanban.pr.brief), and
// on just this one keeps upstream's own form.

import { h, toast } from '../ui/dom';
import type { Net } from '../net';
import { store } from '../state';
import type { GhPull } from '../../shared/protocol';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { PR_REVIEW_MAX, type KanbanPrBundleItem, type PrRef } from '../../shared/kanban/types.js';
import { kanbanApi, type KanbanOk } from './api';
import { repoOfItem } from './boardrepos';
import { pickerRows, refKey } from './model';
import { briefPreset, briefRequest, goLabel, goTitle, POST_KEY, postLabel, readFlag, reviewRequest, reviewFailure, reviewToast, REVIEW_WAIT_MS, UI_TEST_KEY, UI_TEST_LABEL, writeFlag, type PickerMode } from './prpickmodel';
import type { MeetingPreset } from '../ui/meeting';
import { btn, checkLine } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import { prPickRow } from './prfind';
import { run } from './ui';

type BundleMsg = Extract<KanbanServerMsg, { t: 'kanban.pr.bundle' }>;
type BriefMsg = Extract<KanbanServerMsg, { t: 'kanban.pr.brief' }>;

/**
 * Opens the picker for `pull` on the floor you're on. `single` is upstream's own flow for just this
 * PR: the Review prompt where the kanban can't take the review (no project on the floor, or a PR it
 * can't place), and the meeting room's form for a panel on this PR alone. `meeting` opens the
 * meeting form with a preset, for a panel on several.
 */
export function openReviewPicker(net: Net, pull: GhPull, mode: PickerMode, single: () => void, meeting?: (preset: MeetingPreset) => void) {
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
  const justThis = btn('Just this PR', { attrs: { title: mode === 'panel' ? 'Call the panel for only this pull request' : 'Review only this pull request, as a kanban task' } });
  const go = btn('', { kind: 'primary' });
  const count = h('span', { 'aria-live': 'polite' });
  // What the review also does (not a panel's: its meeting form has its own choices). Off until ticked, remembered in this browser.
  const post = checkLine('', { checked: readFlag(POST_KEY) });
  const uiTest = checkLine(UI_TEST_LABEL, { checked: readFlag(UI_TEST_KEY) });
  const postWords = post.el.querySelector('span')!;
  post.box.addEventListener('change', () => writeFlag(POST_KEY, post.box.checked));
  uiTest.box.addEventListener('change', () => writeFlag(UI_TEST_KEY, uiTest.box.checked));
  const opts = mode === 'review' ? h('div.kb-prs-opts', { role: 'group', 'aria-label': 'What the review also does' }, post.el, uiTest.el) : null;
  const shell = modalShell({
    cls: 'kb-prs w640',
    icon: mode === 'panel' ? 'users' : 'eye',
    title: mode === 'panel' ? 'Review panel: which pull requests?' : 'Review: which pull requests?',
    id: `${repo.split('/').pop()} #${pull.number}`,
    body: [h('div.kb-prs-body', {}, note, list, opts)],
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
  const paintGo = () => {
    go.textContent = goLabel(mode, picked.size, onlySelf());
    go.disabled = picked.size === 0;
    go.title = goTitle(mode, picked.size);
    postWords.textContent = postLabel(picked.size);
    count.textContent = `${picked.size} selected`;
  };

  /** The kanban's review of the PRs `keys` names: a kanban task (one task's PRs keep their task). */
  const review = async (keys: Set<string>, button: HTMLButtonElement) => {
    const req = reviewRequest(project, keys, [self, ...bundle, ...others()], bundle, { post: post.box.checked, uiTest: uiTest.box.checked });
    const ok = await run(() => api.request<KanbanOk>(req, REVIEW_WAIT_MS).catch((err: Error) => Promise.reject(new Error(reviewFailure(err.message)))), button);
    if (!ok) return;
    modal.close();
    toast(reviewToast(req.prs.length, ok));
  };

  /** A panel on several PRs: the office writes the brief, and the meeting form opens with it. A refusal stays here, in the picker. */
  const panel = async () => {
    if (go.disabled) return;
    go.disabled = true;
    try {
      const brief = await api.request<BriefMsg>(briefRequest(project, picked, [self, ...bundle, ...others()], bundle));
      modal.close();
      if (meeting) meeting(briefPreset(brief));
      else single();
    } catch (err) {
      error = (err as Error).message;
      paint();
    }
  };

  justThis.addEventListener('click', () => {
    if (mode === 'review') return void review(new Set([refKey(self)]), justThis);
    modal.close();
    single();
  });
  go.addEventListener('click', () => {
    if (mode === 'review') return void review(picked, go);
    if (!onlySelf()) return void panel();
    modal.close();
    single();
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
