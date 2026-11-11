// The task view's Plan tab: the plan's versions, and the box that approves a draft or asks for changes
// (taskview.ts). Whether the box shows is taskactions.ts's.

import { h, toast } from '../ui/dom';
import type { KanbanPlan, PlanStatus } from '../../shared/kanban/types.js';
import { fmtTime } from './labels';
import { renderMarkdown } from './md';
import { actionsAt } from './taskactionbar';
import type { Detail, TaskCtx } from './taskctx';

const PLAN_STATUS_NAMES: Record<PlanStatus, string> = { draft: 'draft', accepted: 'accepted', superseded: 'superseded' };

export function planPane(c: TaskCtx, d: Detail): HTMLElement[] {
  const task = d.task;
  const plans = [...d.plans].sort((a, b) => b.version - a.version);
  if (!plans.length) return [h('p.kb-muted', {}, task.usePlan ? 'No plan yet: it’s written when the task starts.' : 'This task runs without a plan.')];
  const latest = plans[0];
  const out: HTMLElement[] = [];
  const here = actionsAt('plan', task, c);
  if (here.length) {
    const fb = c.fileBox('planChanges', { rows: 4, placeholder: 'What should change in the plan? (paste or drop files)', 'aria-label': 'Request changes' });
    const { ta, attach, wrap } = fb;
    const approve = h('button.btn.primary', { type: 'button', 'data-focus': 'act-approve' }, '✅ Approve the plan') as HTMLButtonElement;
    const changes = h('button.btn', { type: 'button', 'data-focus': 'act-send-plan-feedback' }, '✍️ Request changes') as HTMLButtonElement;
    approve.addEventListener('click', () => void c.req({ t: 'kanban.plan.approve', id: task.id, planId: latest.id }, approve, 'Plan approved'));
    const go = async () => {
      const text = ta.value.trim();
      const ids = attach.ids();
      if (!text && !ids.length) return ta.focus();
      if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
      if (await c.req({ t: 'kanban.plan.requestChanges', id: task.id, text, ...(ids.length ? { attachmentIds: ids } : {}) }, changes, 'Sent to the planner')) {
        ta.value = '';
        attach.clear();
        c.drafts().delete('planChanges');
      }
    };
    changes.addEventListener('click', () => void go());
    fb.go = () => void go();
    wrap.replaceChildren(ta, h('div.kb-row', {}, attach.el, h('span.grow'), here.includes('send-plan-feedback') ? changes : null, here.includes('approve') ? approve : null));
    out.push(h('section.kb-plan-act', {}, h('h4', {}, `Plan v${latest.version} waits for you`), wrap));
  }
  for (const p of plans) out.push(planItem(p, (id) => c.openTask(id)));
  return out;
}

function planItem(p: KanbanPlan, openTask: (id: number) => void): HTMLElement {
  return h(
    'details.kb-plan',
    { class: p.status, open: p.status !== 'superseded' },
    h(
      'summary',
      {},
      h('b', {}, `Version ${p.version}`),
      h('span.kb-plan-status', { class: p.status }, PLAN_STATUS_NAMES[p.status]),
      h('small.kb-muted', {}, p.acceptedAt ? `accepted by ${p.acceptedBy ?? ''}, ${fmtTime(p.acceptedAt)}` : fmtTime(p.createdAt)),
    ),
    p.feedback ? h('blockquote.kb-feedback', {}, h('b', {}, 'Asked to change: '), p.feedback) : null,
    renderMarkdown(p.text, openTask),
  );
}
