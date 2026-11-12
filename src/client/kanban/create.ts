// A new task, or changes to one that hasn't started: what it's about, where (the project and which of
// its repositories), how (implement or investigate, a plan first or not, how many review rounds and by
// whom, acceptance criteria) and by which agent. Unset fields take the project's and the office's defaults.
// A new task has no title box: its title is the description's first line, or, with an issue picked by
// Select issue, the issue's (createmsg.ts works out which message that makes).
//
// The window is the shared shell (ui/shell.ts): the sections What / Where / How / Who, each a heading
// with its hint beside its fields, and a footer of Cancel, Create and the one primary Create and start.

import './create.css';
import { h, toast } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import { CLAUDE_MODELS } from '../../shared/protocol';
import { KANBAN_EFFORTS, KANBAN_TOOLS, type KanbanEffort, type KanbanTask, type KanbanTool, type NormalizedIssue, type PlanApproval, type ReviewSettings, type TaskType } from '../../shared/kanban/types.js';
import { KANBAN_LIMITS, type KanbanTaskInput, type KanbanTaskPatch } from '../../shared/kanban/protocol.js';
import type { KanbanApi, KanbanOk } from './api';
import { attachBox } from './attachbox';
import { codexLimitsChip, recheckCodexChips } from './codexlimits';
import { newOnceKey } from './office';
import { newTaskMsg, reviewOverride as reviewOf, reviewStart, type NewTaskFields } from './createmsg';
import { KANBAN_DEFAULTS, REVIEW_DEFAULTS } from './defaults';
import { draftApplies, draftFailure, requestIssueDraft } from './issuedraft';
import { openIssuePicker } from './issues';
import { sameRepoPick } from './model';
import { projectUiTesting, taskUiTesting, uiTestingPatch } from './taskimagesmodel';
import { kstore } from './store';
import { APPROVAL_NAMES, effortName, toolName } from './labels';
import { isSendKey } from './sendkey';
import { numberInput, numberValue, run, select, textArea, textInput } from './ui';
import { btn, checkLine, formField, segmented, sendKeyHint } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';

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
  // Only a task being edited has a title box: a new one is titled by its first line (or its issue).
  const title = textInput(editing?.title ?? '', { class: 'inp', maxlength: KANBAN_LIMITS.title, required: true, autofocus: !!editing, placeholder: 'What needs doing, in a line' });
  // A preset title (a task made from something else) leads the text, where the title comes from.
  const preText = [pre.title, pre.description].filter(Boolean).join('\n\n');
  const desc = textArea(editing?.description ?? preText, {
    rows: 5,
    maxlength: KANBAN_LIMITS.description,
    autofocus: !editing,
    'aria-label': 'Description',
    placeholder: editing ? 'The details, in Markdown. Paste or drop screenshots and files here.' : 'What needs doing? Details in Markdown; paste or drop screenshots and files here.',
    spellcheck: 'true',
  });
  const descBox = h('div.composite.kb-nt-desc', {}, desc);
  const attach = attachBox({ target: desc, dropZone: descBox, insertLinks: true });
  const ticket = textInput(editing?.ticket ?? pre.ticket ?? '', { class: 'inp', maxlength: KANBAN_LIMITS.ticket, placeholder: 'UYT-1415 or gh:owner/repo#12' });
  const ticketUrl = textInput(editing?.ticketUrl ?? pre.ticketUrl ?? '', { class: 'inp', maxlength: KANBAN_LIMITS.url, placeholder: 'https://', type: 'url' });
  const projectSel = select(projects.map((p) => [p.id, p.name] as const), editing?.project ?? pre.project ?? o.project ?? kstore.project ?? projects[0].id, { class: 'inp', disabled: !!editing });
  const repoBox = h('div.kb-nt-repos', { role: 'group', 'aria-label': 'Repositories' });
  let repoChecks: { id: string; box: HTMLInputElement; el: HTMLElement }[] = [];
  const paintRepos = (initial?: string[] | null) => {
    const p = kstore.projectOf(projectSel.value);
    const repos = p?.repos ?? [];
    repoChecks = repos.map((r) => {
      // The primary repository (the floor's own checkout) is always in: the engine works there whatever is picked.
      const box = h('input', { type: 'checkbox', value: r.id, disabled: r.primary }) as HTMLInputElement;
      box.checked = r.primary || (initial ? initial.includes(r.id) : true);
      const el = h('label.check-chip', {}, box, `${r.name}${r.kind === 'folder' ? ' (folder)' : ''}`, r.primary ? h('span.check-chip-tag', {}, 'Primary') : null);
      if (r.primary) el.title = 'Always included: the task works in the floor’s own checkout whatever else is picked';
      return { id: r.id, box, el };
    });
    repoBox.replaceChildren(...repoChecks.map((c) => c.el), ...(repos.length ? [] : [h('span.field-hint', {}, 'The project has no repositories listed')]));
  };
  paintRepos(editing ? editing.repoIds : pre.repoIds);

  // --- The issue it is made from (a new task only: an edit wouldn't bring the issue's text or check for its task)
  let picked: NormalizedIssue | null = null;
  const pickBtn = btn('Select issue', { kind: 'quiet', size: 'sm', icon: 'link', attrs: { title: 'Make the task from one of the project’s issues: its key, link and text go on the task, and the issue’s title is the task’s' } });
  const pickedChip = h('div.kb-nt-picked.hidden');
  // A picked issue with the description still empty: the default agent drafts a prompt into it (issuedraft.ts).
  // The box stays the person's meanwhile, and whatever they write, pick or close first drops the answer.
  let draftSeq = 0;
  let open = true;
  const drafting = h('span.kb-nt-drafting', { role: 'status' });
  /** Voids the draft being written, if any, and takes its status line away. */
  const dropDraft = () => {
    draftSeq++;
    descBox.classList.remove('drafting');
    drafting.replaceChildren();
  };
  const draftFor = (issue: NormalizedIssue) => {
    if (desc.value.trim()) return;
    const asked = { seq: ++draftSeq, issueKey: issue.key };
    const applies = () => draftApplies(asked, { seq: draftSeq, open, pickedKey: picked?.key, description: desc.value });
    drafting.replaceChildren(icon('loader', { size: 14 }), h('span', {}, 'Drafting a prompt from the issue…'));
    descBox.classList.add('drafting');
    /** The answer, or why there is none: dropped when the form has moved on (issuedraft.ts says when). */
    const done = (text: string, failed?: string | null) => {
      if (!applies()) return;
      dropDraft();
      if (failed) return toast(failed, 'warn');
      if (!text) return;
      desc.value = text;
      desc.dispatchEvent(new Event('input', { bubbles: true }));
    };
    requestIssueDraft(api, projectSel.value, issue).then(done, (err) => done('', draftFailure(err)));
  };
  desc.addEventListener('input', () => desc.value.trim() && descBox.classList.contains('drafting') && dropDraft());
  const setPicked = (issue: NormalizedIssue | null, keepFields = false) => {
    dropDraft();
    if (!keepFields && (issue || picked)) {
      ticket.value = issue?.key ?? '';
      ticketUrl.value = issue?.url ?? '';
    }
    picked = issue;
    // The link of a picked issue is the issue's own: the office takes it from there, so it isn't to edit.
    ticketUrl.readOnly = !!issue;
    pickedChip.classList.toggle('hidden', !issue);
    if (!issue) return;
    const clear = iconButton('x', `Unlink ${issue.key}`, { class: 'xs', onclick: () => setPicked(null) }, 14);
    pickedChip.replaceChildren(icon('link', { size: 14 }), h('span', { title: `${issue.key} · ${issue.title}` }, h('b', {}, issue.key), ` ${issue.title}`), clear);
  };
  pickBtn.addEventListener('click', () => openIssuePicker(api, projectSel.value, (issue) => (setPicked(issue), draftFor(issue)), () => desc.focus()));
  // A ticket typed over the picked one is a plain ticket again: the chip would say otherwise.
  ticket.addEventListener('input', () => picked && ticket.value.trim() !== picked.key && setPicked(null, true));
  descBox.append(h('div.composite-bar', {}, attach.el, editing ? null : pickBtn, editing ? null : drafting, h('span.composite-note', { title: 'Files pasted, dropped or attached go in where the cursor is.' }, 'Markdown supported')));

  // --- How
  const type = segmented<TaskType>([['implement', 'Implement'], ['investigate', 'Investigate']], editing?.type ?? pre.type ?? 'implement', () => paintDefaults(), 'Type');
  const usePlan = checkLine('Plan first');
  usePlan.box.checked = editing?.usePlan ?? pre.usePlan ?? defaults?.usePlan ?? KANBAN_DEFAULTS.defaults.usePlan;
  const projSettings = () => s?.projects[projectSel.value];
  const approvalDefault = () => projSettings()?.planApproval ?? defaults?.planApproval ?? KANBAN_DEFAULTS.defaults.planApproval;
  const approval = select<PlanApproval | ''>([['', ''], ['auto', APPROVAL_NAMES.auto], ['manual', APPROVAL_NAMES.manual]], editing ? editing.planApproval : (pre.planApproval ?? ''), { class: 'inp', 'aria-label': 'Plan approval' });
  const useReview = checkLine('Review rounds');
  useReview.box.checked = editing?.useReview ?? pre.useReview ?? defaults?.useReview ?? KANBAN_DEFAULTS.defaults.useReview;
  const override = editing?.overrides.review ?? pre.review;
  const baseReview = (): ReviewSettings => ({ ...(s?.review ?? REVIEW_DEFAULTS), ...projSettings()?.review }) as ReviewSettings;
  const baseRounds = () => baseReview().rounds ?? REVIEW_DEFAULTS.rounds;
  // The number of rounds stands beside its tick box; a reviewer of the task's own is picked under it.
  const reviewOverride = checkLine('Choose the reviewer');
  const stored = reviewStart(override, baseRounds());
  reviewOverride.box.checked = stored.choose;
  const rTool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, toolName(x)] as const), override?.tool ?? baseReview().tool, { class: 'inp' });
  const rModel = modelInput(override?.model ?? '', () => rTool.value as KanbanTool);
  rModel.input.classList.add('inp');
  const rEffort = effortSelect(override?.effort, 'Default');
  rEffort.classList.add('inp');
  const rRounds = numberInput(stored.rounds, 1, 10, { class: 'inp', 'aria-label': 'Number of review rounds', title: '1–10 review rounds, each followed by a fix when changes are asked for' });
  /** Whether the number is the person's own: until then it follows the picked project's default. */
  let roundsTouched = stored.ownRounds;
  rRounds.addEventListener('input', () => (roundsTouched = true));
  const rReRev = checkLine('Review the last fix too');
  rReRev.box.checked = override?.reReviewLastFix ?? baseReview().reReviewLastFix ?? REVIEW_DEFAULTS.reReviewLastFix;
  rTool.addEventListener('change', rModel.refresh);
  // The Codex sign-in's allowance, by whichever agent is Codex.
  const codexChip = (pick: () => string) => {
    const el = h('div.kb-codex-note', {}, codexLimitsChip(api.net));
    return { el, paint: () => (el.classList.toggle('hidden', pick() !== 'codex'), recheckCodexChips()) };
  };
  const reviewCodex = codexChip(() => rTool.value);
  rTool.addEventListener('change', reviewCodex.paint);
  const reviewFields = h('div.kb-nt-sub', {}, formField('Reviewer', rTool), formField('Model', rModel.el), formField('Effort', rEffort), reviewCodex.el, rReRev.el);
  // UI testing: before/after screenshots of what the task changes. The box follows the picked project's
  // default until it is touched; an edit opens on what the task does today.
  const uiTest = checkLine('UI testing');
  const uiStart = editing ? taskUiTesting(s, editing.project, editing.overrides) : (pre.uiTesting ?? projectUiTesting(s, projectSel.value));
  uiTest.box.checked = uiStart;
  let uiTouched = !!editing || pre.uiTesting !== undefined;
  uiTest.box.addEventListener('change', () => (uiTouched = true));
  const uiField = h('div.kb-nt-ui', {}, uiTest.el, h('span.field-hint', {}, 'Before and after screenshots when the task changes the UI'));
  const goal = textArea(editing?.goal ?? pre.goal ?? '', { class: 'inp', rows: 2, maxlength: KANBAN_LIMITS.goal, placeholder: 'When is it done? One criterion per line.', title: 'The agents check the work against these' });

  // --- Who
  const tool = select<KanbanTool | ''>([['', ''], ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], editing ? editing.tool : (pre.tool ?? ''), { class: 'inp' });
  const model = modelInput(editing?.model ?? pre.model ?? '', () => ((tool.value || defaults?.tool || KANBAN_DEFAULTS.defaults.tool) as KanbanTool));
  model.input.classList.add('inp');
  const effort = effortSelect(editing?.effort ?? pre.effort, 'Default');
  effort.classList.add('inp');
  tool.addEventListener('change', model.refresh);
  const toolCodex = codexChip(() => tool.value || defaults?.tool || KANBAN_DEFAULTS.defaults.tool);
  tool.addEventListener('change', toolCodex.paint);

  const paintDefaults = () => {
    (approval.options[0] as HTMLOptionElement).textContent = `Default (${APPROVAL_NAMES[approvalDefault()]})`;
    (tool.options[0] as HTMLOptionElement).textContent = `Default (${toolName(defaults?.tool ?? KANBAN_DEFAULTS.defaults.tool)})`;
    toolCodex.paint();
    reviewCodex.paint();
    model.input.placeholder = defaults?.model ? `Default (${defaults.model})` : 'Default';
    if (!roundsTouched) rRounds.value = String(baseRounds());
    const inv = type.value() === 'investigate';
    if (!uiTouched) uiTest.box.checked = projectUiTesting(s, projectSel.value);
    uiField.classList.toggle('hidden', inv);
    usePlan.box.disabled = inv;
    approval.disabled = !usePlan.box.checked || inv;
    rRounds.disabled = !useReview.box.checked;
    reviewOverride.box.disabled = !useReview.box.checked;
    reviewFields.classList.toggle('hidden', !reviewOverride.box.checked || !useReview.box.checked);
  };
  for (const el of [usePlan.box, useReview.box, reviewOverride.box]) el.addEventListener('change', paintDefaults);
  projectSel.addEventListener('change', () => {
    // The picked issue is the other project's.
    setPicked(null);
    paintRepos();
    paintDefaults();
  });

  /** A section of the form: its heading and hint in the left column, its fields in the right. */
  const section = (name: string, hint: string, ...fields: (Node | null)[]) => h('section.kb-nt-sec', { 'aria-label': name }, h('div.kb-nt-sec-head', {}, h('h3', {}, name), h('span', {}, hint)), h('div.kb-nt-sec-body', {}, ...fields));
  const body = h(
    'form.kb-nt-form',
    { novalidate: true },
    section('What', editing ? 'A task can be edited until it starts.' : 'The first line becomes the title.', editing ? formField('Title', title) : null, descBox, pickedChip, h('div.kb-nt-cols', {}, formField('Ticket', ticket), formField('Ticket link', ticketUrl))),
    section('Where', 'All repositories unless you pick some.', h('div.kb-nt-cols', {}, formField('Project', projectSel, { hint: editing ? 'A task stays in its project' : undefined }), formField('Repositories', repoBox))),
    section(
      'How',
      'Investigate is read-only and writes a report.',
      h('div.kb-nt-how', {}, formField('Type', type.el), h('div.kb-nt-pair', {}, usePlan.el, approval), h('div.kb-nt-pair', {}, useReview.el, rRounds)),
      reviewOverride.el,
      reviewFields,
      uiField,
      formField('Acceptance criteria', goal),
    ),
    section('Who', 'Empty fields use the project defaults.', h('div.kb-nt-who', {}, formField('Agent', tool), formField('Model', model.el), formField('Effort', effort)), toolCodex.el),
  );

  const cancelBtn = btn('Cancel', { kind: 'quiet' });
  const createBtn = btn(editing ? 'Save' : 'Create', { kind: editing ? 'primary' : 'secondary' });
  const startBtn = btn('Create and start', { kind: 'primary', icon: 'play' });
  const hint = sendKeyHint(editing ? 'saves' : 'creates the task');
  hint.title = editing ? 'A task can be edited until it starts; its issue also later, in its Issue tab.' : 'Unset fields take the project’s and the office’s defaults.';
  const shell = modalShell({
    cls: 'kb-newtask w840',
    title: editing ? 'Edit task' : 'New task',
    id: editing ? `#${editing.id}` : h('span.kb-nt-in', {}, `in ${kstore.projectOf(projectSel.value)?.name ?? projectSel.value}`),
    body,
    footerLeft: [hint],
    footerRight: [cancelBtn, createBtn, editing ? null : startBtn],
  });
  if (!editing) projectSel.addEventListener('change', () => (shell.head.querySelector('.kb-nt-in')!.textContent = `in ${kstore.projectOf(projectSel.value)?.name ?? projectSel.value}`));
  const modal = openShell(shell, { backdropCloses: false, onClose: () => ((open = false), dropDraft()) });
  cancelBtn.addEventListener('click', () => modal.close());
  paintDefaults();

  const reviewValue = (): Partial<ReviewSettings> | undefined =>
    reviewOf({
      useReview: useReview.box.checked,
      choose: reviewOverride.box.checked,
      rounds: numberValue(rRounds, 1, 10, REVIEW_DEFAULTS.rounds),
      baseRounds: baseRounds(),
      tool: rTool.value as KanbanTool,
      model: rModel.input.value,
      effort: rEffort.value as KanbanEffort | '',
      reReviewLastFix: rReRev.box.checked,
    });
  const repoIds = (): string[] | null => {
    const picked = repoChecks.filter((c) => c.box.checked).map((c) => c.id);
    return picked.length === repoChecks.length ? null : picked;
  };

  // One key for every attempt of this dialog: a resend after no answer can't make the task twice.
  let once = newOnceKey();
  const submit = async (start: boolean, button: HTMLButtonElement) => {
    const name = title.value.trim();
    if (editing && !name) {
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
      if (type.value() !== editing.type) patch.type = type.value();
      if (tool.value && tool.value !== editing.tool) patch.tool = tool.value as KanbanTool;
      if (model.input.value.trim() !== (editing.model ?? '')) patch.model = model.input.value.trim() || null;
      if (effort.value !== (editing.effort ?? '')) patch.effort = (effort.value as KanbanEffort) || null;
      if (usePlan.box.checked !== editing.usePlan) patch.usePlan = usePlan.box.checked;
      if (approval.value && approval.value !== editing.planApproval) patch.planApproval = approval.value as PlanApproval;
      if (useReview.box.checked !== editing.useReview) patch.useReview = useReview.box.checked;
      if (goal.value.trim() !== (editing.goal ?? '')) patch.goal = goal.value.trim() || null;
      const ui = type.value() === 'investigate' ? undefined : uiTestingPatch(uiTest.box.checked, uiStart);
      if (ui !== undefined) patch.uiTesting = ui;
      const rv = reviewValue();
      if (JSON.stringify(rv ?? null) !== JSON.stringify(editing.overrides.review && Object.keys(editing.overrides.review).length ? editing.overrides.review : null)) patch.review = rv ?? null;
      // Uploads wait unattached until saved, so a file whose link was taken out of the text is never kept.
      if (patch.description !== undefined && attach.ids().length) patch.attachmentIds = attach.ids();
      if (!Object.keys(patch).length) return modal.close();
      if (await run(() => api.request<KanbanOk>({ t: 'kanban.task.update', id: editing.id, patch }), button, 'Saved')) modal.close();
      return;
    }
    const rest: NewTaskFields['rest'] = { repoIds: repos, type: type.value(), usePlan: usePlan.box.checked, useReview: useReview.box.checked };
    if (approval.value) rest.planApproval = approval.value as PlanApproval;
    if (tool.value) rest.tool = tool.value as KanbanTool;
    if (model.input.value.trim()) rest.model = model.input.value.trim();
    if (effort.value) rest.effort = effort.value as KanbanEffort;
    if (goal.value.trim()) rest.goal = goal.value.trim();
    // Untouched, the task has no choice of its own and follows its project's.
    if (uiTouched && type.value() !== 'investigate') rest.uiTesting = uiTest.box.checked;
    const rv = reviewValue();
    if (rv) rest.review = rv;
    if (pre.tags?.length) rest.tags = pre.tags;
    const ids = attach.ids();
    if (ids.length) rest.attachmentIds = ids;
    const issue = picked;
    const made = newTaskMsg({ project: projectSel.value, description: desc.value, ticket: ticket.value, ticketUrl: ticketUrl.value, rest, start, once }, issue);
    if ('error' in made) {
      desc.focus();
      return toast(made.error, 'warn');
    }
    // What is sent is the description as it stands: a draft still on its way must not fill the box after it.
    dropDraft();
    const ok = await run(() => api.request<KanbanOk>(made.msg), button);
    if (!ok) return;
    // An earlier send of this dialog, whose answer never came, made a task of what the form held then
    // (other text or settings, another issue, or none): nothing was made now, and what is here stays for the next send, under a new key.
    if (ok.earlier) {
      once = newOnceKey();
      return toast(`Your earlier send had already made task #${ok.taskId ?? ''}, without what you changed since: nothing was made now. Create again to make another`, 'warn');
    }
    // The issue got its task meanwhile: nothing was made or started, and what was written stays here.
    if (ok.existed) {
      setPicked(null);
      // Nothing was made, and the next attempt is another message: it can't share this key's answer.
      once = newOnceKey();
      return toast(`${issue?.key ?? 'The issue'} is already task #${ok.taskId ?? ''}`, 'warn');
    }
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
