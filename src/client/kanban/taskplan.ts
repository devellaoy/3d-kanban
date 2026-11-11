// The task view's Plan tab: the plan's versions, and the box that asks for changes to a draft
// (taskview.ts). Approving it is the footer's button. Whether the box shows is taskactions.ts's.

import { h, toast } from '../ui/dom';
import { btn } from '../ui/kit';
import type { KanbanPlan, PlanStatus } from '../../shared/kanban/types.js';
import { fmtTime } from './labels';
import { sendHint } from './sendkey';
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
  if (actionsAt('plan', task, c).includes('send-plan-feedback')) {
    const fb = c.fileBox('planChanges', { rows: 4, placeholder: 'What should change in the plan? (paste or drop files)', 'aria-label': 'Request changes' });
    const { ta, attach, wrap } = fb;
    const send = btn('Send', { icon: 'send', size: 'sm', attrs: { 'data-focus': 'act-send-plan-feedback', title: 'Send this to the planner: it writes the plan again' } });
    const go = async () => {
      const text = ta.value.trim();
      const ids = attach.ids();
      if (!text && !ids.length) return ta.focus();
      if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
      if (await c.req({ t: 'kanban.plan.requestChanges', id: task.id, text, ...(ids.length ? { attachmentIds: ids } : {}) }, send, 'Sent to the planner')) {
        ta.value = '';
        attach.clear();
        c.drafts().delete('planChanges');
      }
    };
    send.addEventListener('click', () => void go());
    fb.go = () => void go();
    wrap.replaceChildren(ta, h('div.composite-bar', {}, attach.el, h('span.composite-note', {}, sendHint()), send));
    out.push(h('section.kb-sec.kb-plan-act', {}, h('div.kb-sec-head', {}, h('h4', {}, `Plan v${latest.version} waits for you`), h('small.kb-muted', {}, 'Approve it below, or say what should change.')), wrap));
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
      h('span.st-pill.kb-plan-status', { class: p.status }, PLAN_STATUS_NAMES[p.status]),
      h('small.kb-muted', {}, p.acceptedAt ? `accepted by ${p.acceptedBy ?? ''}, ${fmtTime(p.acceptedAt)}` : fmtTime(p.createdAt)),
    ),
    p.feedback ? h('blockquote.kb-feedback', {}, h('b', {}, 'Asked to change: '), p.feedback) : null,
    renderMarkdown(p.text, openTask),
  );
}
