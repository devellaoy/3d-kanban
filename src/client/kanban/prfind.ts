// Find PRs found pull requests it isn't sure of (they mention the task's ticket, or are older
// closed ones from a branch of the task): they are linked to the task only for the ones ticked here
// (kanban.pr.link). The list is the one the review picker shows too (prpicker.ts uses prPickRow).

import { h, toast } from '../ui/dom';
import { btn, prPill } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import type { KanbanPrBundleItem, KanbanTask } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { safeUrl } from './issueactionsmodel';
import { PR_LINK_MAX, canPickMore, linkedText, pickedText, prName, taskLabel } from './prfindmodel';
import { run } from './ui';
import './prfind.css';

export interface PrPickRow {
  box: HTMLInputElement;
  title: string;
  /** "3d-kanban #143", in mono; a link when `url` is one. */
  name: string;
  url?: string;
  branch?: string;
  state?: KanbanPrBundleItem['state'];
  /** The row's own class ("this" for the pull request the picker was opened on). */
  cls?: string;
}

/** A pull request as a row of a list box: its tick box, its title over its name and branch, and its state. */
export function prPickRow(r: PrPickRow): HTMLElement {
  const url = safeUrl(r.url);
  const name = url ? h('a.kb-prs-name', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the pull request' }, r.name) : h('span.kb-prs-name', {}, r.name);
  return h(
    'label.kb-prs-row',
    { class: r.cls ?? '' },
    r.box,
    h('span.kb-prs-main', {}, h('span.kb-prs-title', { title: r.title }, r.title), h('span.kb-prs-meta', {}, name, r.branch ? h('code', {}, r.branch) : null)),
    r.state ? prPill(r.state) : null,
  );
}

export function openFindWindow(api: KanbanApi, task: Pick<KanbanTask, 'id' | 'title' | 'project' | 'ticket'>, candidates: KanbanPrBundleItem[]) {
  const { project, ticket } = task;
  const taskId = task.id;
  const picked = new Set<KanbanPrBundleItem>();
  const link = btn('Link selected', { kind: 'primary', attrs: { disabled: true } });
  const cancel = btn('Cancel', { kind: 'quiet' });
  const count = h('span', { 'aria-live': 'polite' }, pickedText(0, candidates.length));
  const rows = candidates.map((p) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (box.checked && !canPickMore(picked.size)) {
        box.checked = false;
        return toast(`One go links at most ${PR_LINK_MAX} pull requests: link these, then search again`, 'warn');
      }
      if (box.checked) picked.add(p);
      else picked.delete(p);
      link.disabled = !picked.size;
      count.textContent = pickedText(picked.size, candidates.length);
    });
    return prPickRow({ box, title: p.title, name: prName(p).replace('#', ' #'), url: p.url, branch: p.branch, state: p.state });
  });
  const who = h('strong.kb-prs-task', {}, taskLabel(task));
  const note = h('span.kb-prs-note', {}, `These mention ${ticket ?? 'the task’s ticket'} or are older closed pull requests from one of the task’s branches, or are on a branch another task uses too, so they are not linked until you pick them.`);
  const shell = modalShell({
    cls: 'kb-prs w640',
    icon: 'git-pull-request',
    title: 'Link pull requests',
    id: `#${taskId}`,
    label: `Link pull requests to task ${taskId}`,
    body: h('div.kb-prs-body', {}, who, note, h('div.list-box.kb-prs-list', {}, ...rows)),
    footerLeft: [count],
    footerRight: [cancel, link],
  });
  const modal = openShell(shell);
  cancel.addEventListener('click', () => modal.close());
  link.addEventListener('click', async () => {
    const prs = [...picked].map((p) => ({ repo: p.repo, number: p.number }));
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.pr.link', project, taskId, prs }), link);
    if (!ok) return;
    modal.close();
    toast(linkedText(prs));
  });
}
