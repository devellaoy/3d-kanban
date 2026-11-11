// 🔎 Find PRs found pull requests it isn't sure of (they mention the task's ticket, or are older
// closed ones from a branch of the task): they are linked to the task only for the ones ticked here
// (kanban.pr.link). Built like the review picker (prpicker.ts).

import { h, toast } from '../ui/dom';
import type { KanbanPrBundleItem } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { safeUrl } from './issueactionsmodel';
import { PR_STATE_NAMES } from './labels';
import { prTone } from './model';
import { linkedText, prName } from './prfindmodel';
import { dialog, run, showDialog } from './ui';
import './prfind.css';

export function openFindWindow(api: KanbanApi, project: string, taskId: number, ticket: string | undefined, candidates: KanbanPrBundleItem[]) {
  const picked = new Set<KanbanPrBundleItem>();
  const link = h('button.btn.primary', { type: 'button', disabled: true }, 'Link selected') as HTMLButtonElement;
  const rows = candidates.map((p) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (box.checked) picked.add(p);
      else picked.delete(p);
      link.disabled = !picked.size;
    });
    const url = safeUrl(p.url);
    const name = url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, `${prName(p)} ↗`) : h('b', {}, prName(p));
    return h('li', {}, h('label', {}, box, name, h('span.kb-pr-title', { title: p.title }, p.title), h('span.kb-pr', { class: prTone(p.state) }, PR_STATE_NAMES[prTone(p.state)]), p.branch ? h('code', {}, p.branch) : ''));
  });
  const note = h('p.kb-note', {}, `These mention ${ticket ?? 'the task’s ticket'} or are older closed pull requests from one of the task’s branches, so they are not linked until you confirm.`);
  const d = dialog('kb-pr-find', 'Pull requests that may be this task’s', h('div.body', {}, note, h('ul.kb-pr-list', {}, ...rows)), h('footer', {}, h('span.grow'), link));
  const modal = showDialog(d);
  link.addEventListener('click', async () => {
    const prs = [...picked].map((p) => ({ repo: p.repo, number: p.number }));
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.pr.link', project, taskId, prs }), link);
    if (!ok) return;
    modal.close();
    toast(linkedText(prs));
  });
}
