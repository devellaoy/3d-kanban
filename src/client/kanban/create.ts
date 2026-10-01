// A new task, or changes to one that hasn't started: what it's about, where (the project and which of
// its repositories), how (implement or investigate, a plan first or not, how many review rounds and by
// whom, acceptance criteria) and by which agent. Unset fields take the project's and the office's defaults.

import { h, toast } from '../ui/dom';
import { CLAUDE_MODELS } from '../../shared/protocol';
import { KANBAN_EFFORTS, KANBAN_TOOLS, type KanbanEffort, type KanbanTask, type KanbanTool, type PlanApproval, type ReviewSettings, type TaskType } from '../../shared/kanban/types.js';
import { KANBAN_LIMITS, type KanbanTaskInput, type KanbanTaskPatch } from '../../shared/kanban/protocol.js';
import type { KanbanApi, KanbanOk } from './api';
import { attachBox } from './attachbox';
import { codexLimitsChip, recheckCodexChips } from './codexlimits';
import { KANBAN_DEFAULTS, REVIEW_DEFAULTS } from './defaults';
import { sameRepoPick } from './model';
import { isSendKey } from './sendkey';
import { kstore } from './store';
import { APPROVAL_NAMES, effortName, toolName } from './labels';
import { checkbox, dialog, field, numberInput, numberValue, run, select, showDialog, textArea, textInput } from './ui';

export interface CreateOptions {
  project?: string;
  /** Editing this task instead of making a new one. */
  task?: KanbanTask;
  /** Prefilled from an issue, say. */
  preset?: Partial<KanbanTaskInput>;
  created?(id: number): void;
}

let listSeq = 0;
/** A model box with the usual names to pick from (any id can be typed). */
export function modelInput(value: string, tool: () => KanbanTool): { el: HTMLElement; input: HTMLInputElement; refresh(): void } {
  const id = `kb-models-${++listSeq}`;
  const list = h('datalist', { id });
  const input = textInput(value, { list: id, maxlength: KANBAN_LIMITS.model, placeholder: 'Default', 'aria-label': 'Model' });
  const refresh = () => list.replaceChildren(...(tool() === 'claude' ? CLAUDE_MODELS : []).map((m) => h('option', { value: m })));
  refresh();
  return { el: h('span.kb-model', {}, input, list), input, refresh };
}

export function effortSelect(value: KanbanEffort | undefined, defaultLabel: string): HTMLSelectElement {
  return select<KanbanEffort | ''>([['', defaultLabel], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], value ?? '', { 'aria-label': 'Effort' });
}

export function openCreate(api: KanbanApi, o: CreateOptions = {}) {
  const editing = o.task;
  const s = kstore.settings;
  const defaults = s?.defaults;
  const pre = { ...o.preset };
  const projects = kstore.projects;
  if (!projects.length) return toast('No projects yet: add a floor in the 3D office first.', 'warn');

  // --- What and where
  const title = textInput(editing?.title ?? pre.title ?? '', { maxlength: KANBAN_LIMITS.title, required: true, autofocus: true, placeholder: 'What needs doing, in a line' });
  const desc = textArea(editing?.description ?? pre.description ?? '', { rows: 8, maxlength: KANBAN_LIMITS.description, placeholder: 'The details, in Markdown. Paste or drop screenshots and files here.', spellcheck: 'true' });
  const descWrap = h('div.kb-desc-box', {}, desc);
  const attach = attachBox({ target: desc, dropZone: descWrap, taskId: () => editing?.id, insertLinks: true });
  descWrap.append(attach.el, h('small.kb-hint', {}, 'Markdown. Files pasted or dropped are uploaded and linked.'));
  const ticket = textInput(editing?.ticket ?? pre.ticket ?? '', { maxlength: KANBAN_LIMITS.ticket, placeholder: 'UYT-1415 / gh:owner/repo#12' });
  const ticketUrl = textInput(editing?.ticketUrl ?? pre.ticketUrl ?? '', { maxlength: KANBAN_LIMITS.url, placeholder: 'https://…', type: 'url' });
  const projectSel = select(projects.map((p) => [p.id, p.name] as const), editing?.project ?? pre.project ?? o.project ?? kstore.project ?? projects[0].id, { disabled: !!editing });
  const repoBox = h('div.kb-repo-checks', { role: 'group', 'aria-label': 'Repositories' });
  let repoChecks: { id: string; box: HTMLInputElement; el: HTMLElement }[] = [];
  const paintRepos = (initial?: string[] | null) => {
    const p = kstore.projectOf(projectSel.value);
    const repos = p?.repos ?? [];
    repoChecks = repos.map((r) => {
      // The primary repository (the floor's own checkout) is always in: the engine works there whatever is picked.
      const c = checkbox(`${r.primary ? '⭐ ' : ''}${r.name}${r.kind === 'folder' ? ' (folder)' : ''}`, r.primary || (initial ? initial.includes(r.id) : true), { value: r.id, disabled: r.primary });
      if (r.primary) {
        c.el.title = 'Always included: the task works in the floor’s own checkout whatever else is picked';
        c.el.append(h('small.kb-muted', {}, ' (always included)'));
      }
      return { id: r.id, box: c.box, el: c.el };
    });
    repoBox.replaceChildren(...repoChecks.map((c) => c.el), ...(repos.length ? [] : [h('small.kb-muted', {}, 'The project has no repositories listed')]));
    repoBox.classList.toggle('single', repos.length < 2);
  };
  paintRepos(editing ? editing.repoIds : pre.repoIds);

  // --- How
  const type = select<TaskType>([['implement', 'Implement'], ['investigate', 'Investigate']], editing?.type ?? pre.type ?? 'implement');
  const usePlan = checkbox('Plan first', editing?.usePlan ?? pre.usePlan ?? defaults?.usePlan ?? KANBAN_DEFAULTS.defaults.usePlan);
  const projSettings = () => s?.projects[projectSel.value];
  const approvalDefault = () => projSettings()?.planApproval ?? defaults?.planApproval ?? KANBAN_DEFAULTS.defaults.planApproval;
  const approval = select<PlanApproval | ''>([['', ''], ['auto', APPROVAL_NAMES.auto], ['manual', APPROVAL_NAMES.manual]], editing ? editing.planApproval : (pre.planApproval ?? ''));
  const useReview = checkbox('Review rounds', editing?.useReview ?? pre.useReview ?? defaults?.useReview ?? KANBAN_DEFAULTS.defaults.useReview);
  const override = editing?.overrides.review ?? pre.review;
  const reviewOverride = checkbox('Choose the reviewer', !!override && Object.keys(override).length > 0);
  const baseReview = (): ReviewSettings => ({ ...(s?.review ?? REVIEW_DEFAULTS), ...projSettings()?.review }) as ReviewSettings;
  const rTool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, toolName(x)] as const), override?.tool ?? baseReview().tool);
  const rModel = modelInput(override?.model ?? '', () => rTool.value as KanbanTool);
  const rEffort = effortSelect(override?.effort, 'Default');
  const rRounds = numberInput(override?.rounds ?? baseReview().rounds ?? REVIEW_DEFAULTS.rounds, 1, 10, { 'aria-label': 'Rounds' });
  const rReRev = checkbox('Review the last fix too', override?.reReviewLastFix ?? baseReview().reReviewLastFix ?? REVIEW_DEFAULTS.reReviewLastFix);
  rTool.addEventListener('change', rModel.refresh);
  // The Codex sign-in's allowance, by whichever agent is Codex.
  const codexChip = (pick: () => string) => {
    const el = h('div.kb-codex-note', {}, codexLimitsChip(api.net));
    return { el, paint: () => (el.classList.toggle('hidden', pick() !== 'codex'), recheckCodexChips()) };
  };
  const reviewCodex = codexChip(() => rTool.value);
  rTool.addEventListener('change', reviewCodex.paint);
  const reviewFields = h(
    'div.kb-subfields',
    {},
    field('Reviewer', rTool),
    field('Model', rModel.el),
    field('Effort', rEffort),
    field('Rounds', rRounds, '1–10 review rounds, each followed by a fix when changes are asked for'),
    reviewCodex.el,
    rReRev.el,
  );
  const goal = textArea(editing?.goal ?? pre.goal ?? '', { rows: 3, maxlength: KANBAN_LIMITS.goal, placeholder: 'When is it done? One criterion per line.' });

  // --- Who
  const tool = select<KanbanTool | ''>([['', ''], ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], editing ? editing.tool : (pre.tool ?? ''));
  const model = modelInput(editing?.model ?? pre.model ?? '', () => ((tool.value || defaults?.tool || KANBAN_DEFAULTS.defaults.tool) as KanbanTool));
  const effort = effortSelect(editing?.effort ?? pre.effort, 'Default');
  tool.addEventListener('change', model.refresh);
  const toolCodex = codexChip(() => tool.value || defaults?.tool || KANBAN_DEFAULTS.defaults.tool);
  tool.addEventListener('change', toolCodex.paint);

  const paintDefaults = () => {
    (approval.options[0] as HTMLOptionElement).textContent = `Default (${APPROVAL_NAMES[approvalDefault()]})`;
    (tool.options[0] as HTMLOptionElement).textContent = `Default (${toolName(defaults?.tool ?? KANBAN_DEFAULTS.defaults.tool)})`;
    toolCodex.paint();
    reviewCodex.paint();
    model.input.placeholder = defaults?.model ? `Default (${defaults.model})` : 'Default';
    const inv = type.value === 'investigate';
    usePlan.box.disabled = inv;
    approval.disabled = !usePlan.box.checked || inv;
    reviewOverride.box.disabled = !useReview.box.checked;
    reviewFields.classList.toggle('hidden', !reviewOverride.box.checked || !useReview.box.checked);
  };
  for (const el of [usePlan.box, useReview.box, reviewOverride.box, type]) el.addEventListener('change', paintDefaults);
  projectSel.addEventListener('change', () => {
    paintRepos();
    paintDefaults();
  });

  const body = h(
    'form.body.kb-form',
    { novalidate: true },
    h('fieldset', {}, h('legend', {}, 'What'), field('Title', title), field('Description', descWrap), h('div.kb-two', {}, field('Ticket', ticket), field('Ticket link', ticketUrl))),
    h('fieldset', {}, h('legend', {}, 'Where'), field('Project', projectSel, editing ? 'A task stays in its project' : undefined), field('Repositories', repoBox, 'The repositories it works in: all of the project’s unless you pick some')),
    h(
      'fieldset',
      {},
      h('legend', {}, 'How'),
      field('Type', type, 'Investigate: read-only, it writes a report instead of changing code'),
      h('div.kb-two', {}, usePlan.el, field('Plan approval', approval)),
      h('div.kb-two', {}, useReview.el, reviewOverride.el),
      reviewFields,
      field('🎯 Acceptance criteria', goal, 'The agents check the work against these'),
    ),
    h('fieldset', {}, h('legend', {}, 'Who'), h('div.kb-three', {}, field('Agent', tool), field('Model', model.el), field('Effort', effort)), toolCodex.el),
  );

  const createBtn = h('button.btn', { type: 'button' }, editing ? 'Save' : 'Create') as HTMLButtonElement;
  const startBtn = h('button.btn.primary', { type: 'button' }, '▶️ Create and start') as HTMLButtonElement;
  const note = h('span.grow', {}, editing ? 'A task can be edited until it starts.' : 'Unset fields take the project’s and the office’s defaults.');
  const d = dialog('kb-create', editing ? `Edit #${editing.id}` : '✨ New task', body, h('footer', {}, note, createBtn, editing ? null : startBtn));
  const modal = showDialog(d, { backdropCloses: false });
  paintDefaults();

  const reviewValue = (): Partial<ReviewSettings> | undefined => {
    if (!useReview.box.checked || !reviewOverride.box.checked) return undefined;
    const out: Partial<ReviewSettings> = { tool: rTool.value as KanbanTool, rounds: numberValue(rRounds, 1, 10, REVIEW_DEFAULTS.rounds), reReviewLastFix: rReRev.box.checked };
    if (rModel.input.value.trim()) out.model = rModel.input.value.trim();
    if (rEffort.value) out.effort = rEffort.value as KanbanEffort;
    return out;
  };
  const repoIds = (): string[] | null => {
    const picked = repoChecks.filter((c) => c.box.checked).map((c) => c.id);
    return picked.length === repoChecks.length ? null : picked;
  };

  const submit = async (start: boolean, button: HTMLButtonElement) => {
    const name = title.value.trim();
    if (!name) {
      title.focus();
      return toast('Give it a title', 'warn');
    }
    const repos = repoIds();
    if (repos && !repos.length) return toast('Pick at least one repository', 'warn');
    if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
    if (editing) {
      const patch: KanbanTaskPatch = {};
      if (name !== editing.title) patch.title = name;
      if (desc.value !== editing.description) patch.description = desc.value;
      if (ticket.value.trim() !== (editing.ticket ?? '')) patch.ticket = ticket.value.trim() || null;
      if (ticketUrl.value.trim() !== (editing.ticketUrl ?? '')) patch.ticketUrl = ticketUrl.value.trim() || null;
      // The same repositories picked another way (the primary one, always in, left out of an old pick) is no change.
      if (!sameRepoPick(repos, editing.repoIds, kstore.projectOf(editing.project))) patch.repoIds = repos;
      if (type.value !== editing.type) patch.type = type.value as TaskType;
      if (tool.value && tool.value !== editing.tool) patch.tool = tool.value as KanbanTool;
      if (model.input.value.trim() !== (editing.model ?? '')) patch.model = model.input.value.trim() || null;
      if (effort.value !== (editing.effort ?? '')) patch.effort = (effort.value as KanbanEffort) || null;
      if (usePlan.box.checked !== editing.usePlan) patch.usePlan = usePlan.box.checked;
      if (approval.value && approval.value !== editing.planApproval) patch.planApproval = approval.value as PlanApproval;
      if (useReview.box.checked !== editing.useReview) patch.useReview = useReview.box.checked;
      if (goal.value.trim() !== (editing.goal ?? '')) patch.goal = goal.value.trim() || null;
      const rv = reviewValue();
      if (JSON.stringify(rv ?? null) !== JSON.stringify(editing.overrides.review && Object.keys(editing.overrides.review).length ? editing.overrides.review : null)) patch.review = rv ?? null;
      if (!Object.keys(patch).length) return modal.close();
      if (await run(() => api.request<KanbanOk>({ t: 'kanban.task.update', id: editing.id, patch }), button, 'Saved')) modal.close();
      return;
    }
    const task: KanbanTaskInput = { project: projectSel.value, title: name, repoIds: repos, type: type.value as TaskType, usePlan: usePlan.box.checked, useReview: useReview.box.checked };
    if (desc.value.trim()) task.description = desc.value;
    if (ticket.value.trim()) task.ticket = ticket.value.trim();
    if (ticketUrl.value.trim()) task.ticketUrl = ticketUrl.value.trim();
    if (approval.value) task.planApproval = approval.value as PlanApproval;
    if (tool.value) task.tool = tool.value as KanbanTool;
    if (model.input.value.trim()) task.model = model.input.value.trim();
    if (effort.value) task.effort = effort.value as KanbanEffort;
    if (goal.value.trim()) task.goal = goal.value.trim();
    const rv = reviewValue();
    if (rv) task.review = rv;
    if (pre.tags?.length) task.tags = pre.tags;
    const ids = attach.ids();
    if (ids.length) task.attachmentIds = ids;
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.task.create', task, ...(start ? { start: true } : {}) }), button);
    if (!ok) return;
    modal.close();
    if (ok.startError) toast(`Created #${ok.taskId ?? ''}, but it couldn’t start: ${ok.startError}`, 'warn');
    else toast(start ? `Created and started #${ok.taskId ?? ''}` : `Created #${ok.taskId ?? ''}`);
    if (ok.taskId) o.created?.(ok.taskId);
  };
  createBtn.addEventListener('click', () => void submit(false, createBtn));
  startBtn.addEventListener('click', () => void submit(true, startBtn));
  body.addEventListener('keydown', (e) => {
    if (isSendKey(e) && !(e.target as HTMLElement | null)?.closest?.('button, select, input[type=checkbox]')) {
      e.preventDefault();
      if (!e.repeat) void submit(false, createBtn);
    }
  });
}
