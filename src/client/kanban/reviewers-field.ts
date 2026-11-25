// The additional reviewers of the review settings (settings → Reviews, and a project's own review
// settings): a list of rows, each a reviewer (tool), its model and its effort, at most MAX_EXTRA_REVIEWERS.
import { h } from '../ui/dom';
import { icon, withIcon } from '../ui/icons';
import { KANBAN_TOOLS, MAX_EXTRA_REVIEWERS, type KanbanEffort, type KanbanTool, type ReviewerSpec } from '../../shared/kanban/types.js';
import { effortSelect, modelInput } from './agentfields';
import { toolName } from './labels';
import { field, select } from './ui';

export function extraReviewersField(list: ReviewerSpec[] | undefined): { el: HTMLElement; value(): ReviewerSpec[] } {
  type Row = { el: HTMLElement; name: HTMLElement; read(): ReviewerSpec };
  const rows: Row[] = [];
  const box = h('div.kb-repos');
  const add = h('button.btn.small.kb-admin', { type: 'button', title: `Up to ${MAX_EXTRA_REVIEWERS} besides the main reviewer` }, ...withIcon('plus', 'Add a reviewer'));
  const paint = () => {
    add.classList.toggle('hidden', rows.length >= MAX_EXTRA_REVIEWERS);
    // Numbered from 2 (the main reviewer is the first), as on their terminals' tabs (tasktabs.ts).
    rows.forEach((r, i) => r.name.replaceChildren(...withIcon('bot', `Reviewer ${i + 2}`)));
  };
  const makeRow = (spec: ReviewerSpec): Row => {
    const tool = select<KanbanTool>(KANBAN_TOOLS.map((t) => [t, toolName(t)] as const), spec.tool, { 'aria-label': 'Reviewer' });
    const model = modelInput(spec.model ?? '', () => tool.value as KanbanTool);
    const effort = effortSelect(spec.effort, 'Default');
    tool.addEventListener('change', () => model.refresh());
    const remove = h('button.btn.small.kb-admin', { type: 'button', 'aria-label': 'Remove this reviewer', title: 'Remove this reviewer' }, icon('x', { size: 14 }));
    const name = h('b.kb-icon-row');
    const el = h(
      'div.kb-repo',
      {},
      h('div.kb-repo-head', {}, name, h('span.grow'), remove),
      h('div.kb-three', {}, field('Reviewer', tool), field('Model', model.el), field('Effort', effort)),
    );
    const row: Row = {
      el,
      name,
      read: () => ({
        tool: tool.value as KanbanTool,
        ...(model.input.value.trim() ? { model: model.input.value.trim() } : {}),
        ...(effort.value ? { effort: effort.value as KanbanEffort } : {}),
      }),
    };
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      el.remove();
      paint();
    });
    return row;
  };
  for (const spec of (list ?? []).slice(0, MAX_EXTRA_REVIEWERS)) rows.push(makeRow(spec));
  box.append(...rows.map((r) => r.el));
  add.addEventListener('click', () => {
    if (rows.length >= MAX_EXTRA_REVIEWERS) return;
    const row = makeRow({ tool: 'claude' });
    rows.push(row);
    box.append(row.el);
    paint();
  });
  paint();
  const el = h(
    'div.kb-extra-reviewers',
    {},
    h('b', {}, 'Additional reviewers'),
    h('small.kb-hint', {}, 'All reviewers review the change at the same time; the main reviewer then combines their results.'),
    box,
    add,
  );
  return { el, value: () => rows.map((r) => r.read()) };
}
