// The kanban's settings, as two categories of the office's ⚙️ Settings (ui/settings.ts), for admins
// (everyone else reads them): the office's defaults for new tasks and their reviews, the skills and
// the secrets, which the browser only ever writes (it's told whether they're set, never what they
// are); per project its repositories, instructions and overrides, its issue sources, its own wording
// of the kanban prompts and which skills each phase gets.

import './settings.css';
import { h, toast } from '../ui/dom';
import type { Net } from '../net';
import { store } from '../state';
import { openPromptEditor } from '../ui/prompts';
import type { KanbanServerMsg, KanbanSettingsPatch, ProjectRepoInput } from '../../shared/kanban/protocol.js';
import { GH_REPO_RE, KANBAN_LIMITS } from '../../shared/kanban/protocol.js';
import {
  KANBAN_EFFORTS,
  KANBAN_TOOLS,
  type ImplementPermission,
  type IssueSourceConfig,
  type IssueSourceKind,
  type KanbanEffort,
  type KanbanSettings,
  type KanbanTool,
  type PlanApproval,
  type ProjectRepo,
  type ProjectSettings,
  type ReviewSettings,
} from '../../shared/kanban/types.js';
import { KANBAN_CONTRACTS, KANBAN_PROMPT_DEFS, KANBAN_PROMPT_IDS, PROMPT_CONTRACT, kanbanPromptSource, type KanbanPromptId, type KanbanPromptScope } from '../../shared/kanban/prompts.js';
import { kanbanApi, type KanbanApi, type KanbanError } from './api';
import { KANBAN_DEFAULTS, projectDefaults, REVIEW_DEFAULTS } from './defaults';
import { repoIdFrom } from './model';
import { kstore } from './store';
import { loadSkills, skillsOverview, skillsPane } from './skills';
import type { KanbanSettingsPane } from './settingsslot';
import { Cleanups, settingsRedraw } from './settingsflow';
import { APPROVAL_NAMES, effortName, SOURCE_KIND_NAMES, toolName } from './labels';
import { checkbox, field, numberInput, numberValue, run, select, tabStrip, textArea, textInput } from './ui';

/** The tabs of 📁 Projects. */
export type ProjectTab = 'project' | 'sources' | 'skills' | 'prompts';
const PROJECT_TABS: readonly ProjectTab[] = ['project', 'sources', 'skills', 'prompts'];
const TAB_NAMES: Record<ProjectTab, string> = { project: '⚙️ Project', sources: '📌 Issue sources', skills: '🧩 Skills', prompts: '📝 Prompts' };
const PERMISSION_NAMES: Record<ImplementPermission, string> = { bypass: 'without permission prompts', 'workspace-write': 'in Codex’s workspace sandbox' };
/** A prompt's scope: the short tag in the list, and the line over the editor. */
const SCOPE_TAGS: Record<KanbanPromptScope, string> = { default: 'default', office: 'office', project: 'project' };
const SCOPE_NOW: Record<KanbanPromptScope, string> = { default: 'The default text', office: 'The office’s text', project: 'This project’s own text' };

/** A save button that says whether you may. */
function saveButton(label = 'Save'): HTMLButtonElement {
  const b = h('button.btn.primary', { type: 'button' }, label) as HTMLButtonElement;
  if (!kstore.me.admin) {
    b.disabled = true;
    b.title = 'Only admins can change this';
  }
  return b;
}

/** Turns every input in `root` read-only for someone who isn't an admin. */
function lockForNonAdmins(root: HTMLElement) {
  if (kstore.me.admin) return;
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button.kb-admin')) el.disabled = true;
}

const optionalModel = (v: string) => v.trim() || null;

function reviewFields(r: Partial<ReviewSettings>, base: ReviewSettings | null) {
  const tool = select<KanbanTool | ''>([...(base ? [] : ([['', 'Default']] as const)), ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], r.tool ?? (base ? base.tool : ''));
  const model = textInput(r.model ?? '', { maxlength: KANBAN_LIMITS.model, placeholder: 'Default' });
  const effort = select<KanbanEffort | ''>([['', 'Default'], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], r.effort ?? '');
  const rounds = numberInput(r.rounds ?? base?.rounds ?? REVIEW_DEFAULTS.rounds, 1, 10);
  const reRev = checkbox('Review the last fix too', r.reReviewLastFix ?? base?.reReviewLastFix ?? REVIEW_DEFAULTS.reReviewLastFix);
  const sandbox = checkbox('Keep the reviewer off the web', r.sandbox ?? base?.sandbox ?? REVIEW_DEFAULTS.sandbox);
  const el = h('div.kb-subfields', {}, field('Reviewer', tool), field('Model', model), field('Effort', effort), field('Rounds', rounds, '1–10 review rounds, each followed by a fix when changes are asked for'), reRev.el, sandbox.el);
  const value = (): { tool?: KanbanTool; model: string | null; effort: KanbanEffort | null; rounds: number; reReviewLastFix: boolean; sandbox: boolean } => ({
    ...(tool.value ? { tool: tool.value as KanbanTool } : {}),
    model: optionalModel(model.value),
    effort: (effort.value as KanbanEffort) || null,
    rounds: numberValue(rounds, 1, 10, REVIEW_DEFAULTS.rounds),
    reReviewLastFix: reRev.box.checked,
    sandbox: sandbox.box.checked,
  });
  return { el, value };
}

/**
 * The kanban's two categories of ⚙️ Settings, drawn into upstream's window on any page (settingsslot.ts
 * loads this the first time one is shown): 🗂️ Kanban (the office's defaults, secrets and skills) and
 * 📁 Projects (one project's settings, picked at the top). On the kanban page the board's own
 * subscription keeps kstore current; anywhere else (the 3D office) this asks for the kanban's settings
 * itself (kanban.meta.get: no cards) and follows them with a watch while the window is open.
 */
export function kanbanSettingsPanes(net: Net): { panes: Record<KanbanSettingsPane, HTMLElement>; close(): void } {
  const api = kanbanApi(net);
  const own = !api.pageSubscribed;
  let tab: ProjectTab = 'project';
  let project = '';
  const pickProject = () => {
    if (kstore.projectOf(project)) return;
    project = [kstore.project, store.floor].find((id) => id && kstore.projectOf(id)) ?? kstore.projects[0]?.id ?? '';
  };

  // 🗂️ Kanban: the defaults, then the secrets and the skills (the long list last). The secrets redraw on their own when
  // they change, the rest only when the settings first come in (what you typed stays).
  const officeEl = h('div.kb-set');
  const secretsSlot = h('div.kb-set-secrets');
  const paintSecrets = () => {
    const pane = secretsPane(api);
    lockForNonAdmins(pane);
    secretsSlot.replaceChildren(pane);
  };
  // What the drawn panes listen to, taken down when they're drawn again or the window shuts.
  const officeCleanups = new Cleanups();
  const projectCleanups = new Cleanups();
  // Drawn only from settings fresh from the office: on a page without a board, what kstore kept from
  // the last time is stale (saving it would write old values back), so it waits for the snapshot.
  let ready = !own;
  const paintOffice = () => {
    officeCleanups.run();
    const s = kstore.settings;
    if (!s || !ready) return officeEl.replaceChildren(h('p.kb-muted', {}, 'Loading…'));
    const note = h('p.kb-settings-note', {}, kstore.me.admin ? 'For the whole office. Changes apply to tasks from their next phase.' : 'Only admins can change these. This is how they’re set now.');
    const general = generalPane(api, s, own);
    const skills = h('div.kb-pane', {}, skillsOverview(api, s, officeCleanups));
    lockForNonAdmins(general);
    lockForNonAdmins(skills);
    paintSecrets();
    officeEl.replaceChildren(note, general, secretsSlot, skills);
  };

  // 📁 Projects: the project, its tabs, the picked tab's pane.
  const projectsEl = h('div.kb-set');
  const projectPick = h('label.kb-settings-project', {}, h('span', {}, 'Project'));
  const note = h('p.kb-settings-note');
  const body = h('div.kb-settings-body');
  const strip = tabStrip(PROJECT_TABS.map((x) => ({ id: x, label: TAB_NAMES[x] })), tab, (x) => {
    tab = x;
    paintProject();
  }, 'Project settings');
  projectsEl.append(projectPick, strip.el, note, body);
  /** The project picker alone: a project added or renamed shows without redrawing what you're typing. */
  const paintPicker = () => {
    const sel = select(kstore.projects.map((p) => [p.id, p.name] as const), project, { 'aria-label': 'Project' });
    sel.addEventListener('change', () => {
      project = sel.value;
      paintProject();
    });
    projectPick.replaceChildren(h('span', {}, 'Project'), sel);
    projectPick.classList.toggle('hidden', !kstore.projects.length);
    strip.el.classList.toggle('hidden', !kstore.projects.length);
  };
  const paintProject = () => {
    projectCleanups.run();
    pickProject();
    paintPicker();
    note.textContent = kstore.me.admin ? 'For the project picked here only. Changes apply to its tasks from their next phase.' : 'Only admins can change these. This is how they’re set now.';
    const s = kstore.settings;
    if (!s || !ready) return body.replaceChildren(h('p.kb-muted', {}, 'Loading…'));
    if (!kstore.projectOf(project)) return body.replaceChildren(h('p.kb-muted', {}, 'No projects yet: add a floor in the 3D office first.'));
    const panes: Record<ProjectTab, () => HTMLElement> = {
      project: () => projectPane(api, project, s, projectCleanups),
      sources: () => sourcesPane(api, project, s),
      skills: () => skillsPane(api, project, s, projectCleanups),
      prompts: () => promptsPane(api, project, s, (id) => openPromptEditor(net, id), projectCleanups),
    };
    const pane = panes[tab]();
    lockForNonAdmins(pane);
    body.replaceChildren(pane);
  };

  const paint = () => {
    paintOffice();
    paintProject();
  };
  const redraw = settingsRedraw(own, !!kstore.settings);
  let admin = kstore.me.admin;
  const offs: (() => void)[] = [
    // Someone else saved meanwhile: the pane shows what's saved now (what you typed and didn't save goes).
    kstore.on('projects', () => {
      if (!kstore.projectOf(project)) paintProject();
      else paintPicker();
    }),
    kstore.on('settings', () => {
      if (redraw() === 'all') {
        ready = true;
        return paint();
      }
      // What's configured changes only by saving (here or elsewhere): the secrets say so at once.
      paintSecrets();
    }),
    // Every snapshot says who you are again: only a change of rights redraws.
    kstore.on('me', () => {
      if (kstore.me.admin === admin) return;
      admin = kstore.me.admin;
      paint();
    }),
  ];

  if (own) {
    // No board here keeps kstore current: this asks, and hears the settings while the window is open.
    offs.push(
      api.on((msg: KanbanServerMsg) => {
        if (msg.t === 'kanban.meta' || msg.t === 'kanban.snapshot') kstore.applyMeta(msg);
        else if (msg.t === 'kanban.settings' || msg.t === 'kanban.projects') kstore.apply(msg);
      }),
    );
    // The office tells settings changes to whoever follows a project, any one: the watch starts before
    // asking, so nothing falls between the answer and it. A floor is a project; with none there's
    // nothing to follow, and only your own saves show while the window is open.
    const watched = store.floor ?? store.floors.find((f) => !f.cloning)?.id;
    if (watched) offs.push(api.watch(watched));
    const load = () => {
      loadSkills(api);
      return api.request({ t: 'kanban.meta.get' }).catch((err: KanbanError) => {
        // A connection that went or started over asks again once the office welcomes it.
        if (ready || err.lost) return;
        const why = h('p.kb-muted', {}, `The kanban’s settings didn’t load (${err.message}): open this again.`);
        officeEl.replaceChildren(why);
        body.replaceChildren(why.cloneNode(true));
      });
    };
    offs.push(api.onWelcome(() => void load()));
    if (api.up) void load();
  } else loadSkills(api);
  paint();
  return {
    panes: { kanban: officeEl, projects: projectsEl },
    close: () => {
      for (const off of offs.splice(0)) off();
      officeCleanups.run();
      projectCleanups.run();
    },
  };
}

// --- General ---------------------------------------------------------------------------------------

function generalPane(api: KanbanApi, s: KanbanSettings, refetch: boolean): HTMLElement {
  const dft = s.defaults;
  const tool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, toolName(x)] as const), dft.tool);
  const model = textInput(dft.model ?? '', { maxlength: KANBAN_LIMITS.model, placeholder: 'Default' });
  const effort = select<KanbanEffort | ''>([['', 'Default'], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], dft.effort ?? '');
  const usePlan = checkbox('Plan first', dft.usePlan);
  const approval = select<PlanApproval>([['auto', APPROVAL_NAMES.auto], ['manual', APPROVAL_NAMES.manual]], dft.planApproval);
  const useReview = checkbox('Review rounds', dft.useReview);
  const perm = select<ImplementPermission>([['bypass', PERMISSION_NAMES.bypass], ['workspace-write', PERMISSION_NAMES['workspace-write']]], dft.implementPermission);
  const review = reviewFields(s.review, s.review);
  const auto = checkbox('Resume after a usage limit or a network break', s.autoResume.enabled);
  const attempts = numberInput(s.autoResume.maxAttempts, 0, 50);
  const waitHours = numberInput(s.autoResume.maxWaitHours, 1, 168);
  const archive = numberInput(s.archiveAfterDays, 0, 3650);
  const save = saveButton();
  save.addEventListener('click', () => {
    const settings = {
      defaults: { tool: tool.value as KanbanTool, model: optionalModel(model.value), effort: (effort.value as KanbanEffort) || null, usePlan: usePlan.box.checked, planApproval: approval.value as PlanApproval, useReview: useReview.box.checked, implementPermission: perm.value as ImplementPermission },
      review: review.value(),
      autoResume: { enabled: auto.box.checked, maxAttempts: numberValue(attempts, 0, 50, KANBAN_DEFAULTS.autoResume.maxAttempts), maxWaitHours: numberValue(waitHours, 1, 168, KANBAN_DEFAULTS.autoResume.maxWaitHours) },
      archiveAfterDays: numberValue(archive, 0, 3650, KANBAN_DEFAULTS.archiveAfterDays),
    };
    // null clears a model or an effort (the server takes it as "back to the default").
    void run(() => api.request({ t: 'kanban.settings.set', settings: settings as unknown as KanbanSettingsPatch }), save, 'Saved').then((ok) => {
      // The saved settings come to subscribers only: without a board, ask for them.
      if (ok && refetch) api.request({ t: 'kanban.settings.get' }).catch(() => {});
    });
  });
  return h(
    'div.kb-pane',
    {},
    h('fieldset', {}, h('legend', {}, 'New tasks'), h('div.kb-three', {}, field('Agent', tool), field('Model', model), field('Effort', effort)), h('div.kb-two', {}, usePlan.el, field('Plan approval', approval)), useReview.el, field('Implementation runs', perm, 'How implement, fix and PR phases run. Plans and reviews are always read-only.')),
    h('fieldset', {}, h('legend', {}, 'Reviews'), review.el),
    h('fieldset', {}, h('legend', {}, 'Resume after a usage limit or a network break'), auto.el, h('div.kb-two', {}, field('Tries at most', attempts), field('Waits at most (hours)', waitHours)), h('small.kb-hint', {}, 'A task that stopped on a usage limit is tried again when the limit resets.')),
    h('fieldset', {}, h('legend', {}, 'Archive'), field('Archive done tasks after (days)', archive, '0 keeps them on the board')),
    h('div.kb-row.kb-save', {}, h('span.grow'), save),
  );
}

// --- Projects --------------------------------------------------------------------------------------

/** ⚙️ Project: its name, its repositories, its instructions and overrides. */
export function projectPane(api: Pick<KanbanApi, 'request'>, projectId: string, s: KanbanSettings, cleanups: Cleanups): HTMLElement {
  const info = kstore.projectOf(projectId)!;
  const ps: ProjectSettings = s.projects[projectId] ?? projectDefaults();

  // The name: what people read in the elevator, on the board and in the prompts. Compared with the
  // name the office holds now (the pane isn't drawn again when the projects change, the picker is).
  const projectName = textInput(info.name, { maxlength: 100, 'aria-label': 'Project name' });
  const rename = saveButton('Rename');
  const unchanged = () => {
    const v = projectName.value.trim();
    return !v || v === kstore.projectOf(projectId)?.name;
  };
  const paintRename = () => {
    if (kstore.me.admin) rename.disabled = unchanged();
  };
  // A rename can rename the primary repository too (the office decides): an untouched box takes the
  // name the office now has for it, so saving the repositories afterwards keeps that, not the old one.
  const primaryOf = () => kstore.projectOf(projectId)?.repos.find((r) => r.primary)?.name;
  let shownPrimary = primaryOf();
  const renamed = () => {
    const now = primaryOf();
    if (now && now !== shownPrimary) {
      const primary = rows.find((r) => r.repo.primary);
      if (primary && primary.nameBox.value.trim() === shownPrimary) primary.nameBox.value = now;
      shownPrimary = now;
    }
    paintRename();
  };
  projectName.addEventListener('input', paintRename);
  cleanups.add(kstore.on('projects', renamed));
  paintRename();
  rename.addEventListener('click', () => {
    if (unchanged()) return paintRename();
    void run(() => api.request({ t: 'kanban.project.rename', project: projectId, name: projectName.value.trim() }), rename, 'Renamed').then(paintRename);
  });

  // Repositories
  type Row = { repo: ProjectRepoInput; el: HTMLElement; nameBox: HTMLInputElement; read(): ProjectRepoInput };
  const rows: Row[] = [];
  const list = h('div.kb-repos');
  const makeRow = (r: ProjectRepo | ProjectRepoInput): Row => {
    const name = textInput(r.name, { maxlength: 100, 'aria-label': 'Name' });
    const dir = textInput(r.dir, { maxlength: 4096, placeholder: '/Users/me/code/api', 'aria-label': 'Folder', disabled: r.primary });
    const kind = select<'git' | 'folder'>([['git', 'git'], ['folder', 'folder']], r.kind ?? 'git', { 'aria-label': 'Kind', disabled: r.primary });
    // The floor's own GitHub repository, when it knows one, is the primary's: it isn't edited here.
    const fixedRemote = r.primary ? info.repo : undefined;
    const remote = textInput(fixedRemote ?? r.remote ?? '', { maxlength: 200, placeholder: 'owner/name', 'aria-label': 'GitHub (owner/name)', disabled: !!fixedRemote });
    const base = textInput(r.baseBranch ?? '', { maxlength: KANBAN_LIMITS.branch, placeholder: 'main', 'aria-label': 'Base branch' });
    const ins = textArea(r.instructions ?? '', { rows: 2, maxlength: KANBAN_LIMITS.promptText, placeholder: 'Instructions for work in this repository', 'aria-label': 'Instructions for work in this repository' });
    const remove = h('button.btn.small.kb-admin', { type: 'button', 'aria-label': `Remove ${r.name}`, disabled: r.primary, title: r.primary ? 'The floor’s own repository stays' : '' }, '✕');
    const el = h(
      'div.kb-repo',
      { class: r.primary ? 'primary' : '' },
      h('div.kb-repo-head', {}, h('b', {}, r.primary ? '⭐ Primary (the floor)' : `📦 ${r.id}`), h('span.grow'), remove),
      h('div.kb-three', {}, field('Name', name), field('Kind', kind), field('Base branch', base)),
      h('div.kb-two', {}, field('Folder', dir, r.primary ? 'The floor’s checkout: change it from the elevator in the 3D office' : undefined), field('GitHub (owner/name)', remote, fixedRemote ? `The floor’s own repository is ${fixedRemote}; add another repository instead, or re-add the floor` : undefined)),
      ins,
    );
    const row: Row = {
      repo: r as ProjectRepoInput,
      el,
      nameBox: name,
      read: () => ({
        id: r.id,
        name: name.value.trim() || r.name,
        dir: dir.value.trim(),
        primary: r.primary,
        kind: kind.value as 'git' | 'folder',
        ...(remote.value.trim() ? { remote: remote.value.trim() } : {}),
        ...(base.value.trim() ? { baseBranch: base.value.trim() } : {}),
        ...(ins.value.trim() ? { instructions: ins.value } : {}),
      }),
    };
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      el.remove();
    });
    return row;
  };
  for (const r of info.repos) rows.push(makeRow(r));
  list.append(...rows.map((r) => r.el));
  const addDir = textInput('', { placeholder: '/absolute/path/to/checkout', 'aria-label': 'Add a local repository' });
  const addBtn = h('button.btn.kb-admin', { type: 'button' }, '＋ Add a local repository');
  addBtn.addEventListener('click', () => {
    const dir = addDir.value.trim();
    if (!dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(dir)) return toast('Give the folder as an absolute path', 'warn');
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo';
    const id = repoIdFrom(name, new Set(rows.map((r) => r.read().id)));
    const row = makeRow({ id, name, dir, primary: false, kind: 'git' });
    rows.push(row);
    list.append(row.el);
    addDir.value = '';
  });
  const saveRepos = saveButton('Save repositories');
  saveRepos.addEventListener('click', () => {
    const repos = rows.map((r) => r.read());
    const bad = repos.find((r) => r.remote && !GH_REPO_RE.test(r.remote));
    if (bad) return toast(`${bad.name}: GitHub is owner/name`, 'warn');
    void run(() => api.request({ t: 'kanban.project.repos.set', project: projectId, repos }), saveRepos, 'Saved');
  });

  // Instructions and overrides
  const branch = textArea(ps.branchInstructions, { rows: 3, maxlength: KANBAN_LIMITS.promptText, placeholder: 'e.g. gh-{issue}/short-slug' });
  const general = textArea(ps.generalInstructions, { rows: 4, maxlength: KANBAN_LIMITS.promptText });
  const testing = textArea(ps.testingInstructions, { rows: 4, maxlength: KANBAN_LIMITS.promptText });
  const maxConc = numberInput(ps.maxConcurrent, 1, 20);
  const approval = select<PlanApproval | ''>([['', `Default (${APPROVAL_NAMES[s.defaults.planApproval]})`], ['auto', APPROVAL_NAMES.auto], ['manual', APPROVAL_NAMES.manual]], ps.planApproval ?? '');
  const perm = select<ImplementPermission | ''>([['', `Default (${PERMISSION_NAMES[s.defaults.implementPermission]})`], ['bypass', PERMISSION_NAMES.bypass], ['workspace-write', PERMISSION_NAMES['workspace-write']]], ps.implementPermission ?? '');
  const overrideReview = checkbox('Its own review settings', !!ps.review);
  const review = reviewFields(ps.review ?? {}, { ...s.review, ...ps.review });
  const paintReview = () => review.el.classList.toggle('hidden', !overrideReview.box.checked);
  overrideReview.box.addEventListener('change', paintReview);
  paintReview();
  const save = saveButton();
  save.addEventListener('click', () => {
    const rv = review.value();
    const settings: Record<string, unknown> = {
      branchInstructions: branch.value,
      generalInstructions: general.value,
      testingInstructions: testing.value,
      maxConcurrent: numberValue(maxConc, 1, 20, projectDefaults().maxConcurrent),
      // null: back to the office's.
      planApproval: approval.value || null,
      implementPermission: perm.value || null,
      review: overrideReview.box.checked ? { ...rv, model: rv.model ?? undefined, effort: rv.effort ?? undefined } : null,
    };
    void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: settings as Partial<ProjectSettings> }), save, 'Saved');
  });

  return h(
    'div.kb-pane',
    {},
    h(
      'fieldset',
      {},
      h('legend', {}, 'Project'),
      h('div.kb-row.kb-rename', {}, field('Project name', projectName), rename),
      h('small.kb-hint', {}, `Shown in the elevator, on the board and in the agents’ prompts. Its id (${projectId}), folder and repository stay.`),
    ),
    h('fieldset', {}, h('legend', {}, 'Repositories'), h('p.kb-hint', {}, 'A project works across these. Tasks get a worktree of each on the same branch.'), list, h('div.kb-row', {}, addDir, addBtn), h('div.kb-row.kb-save', {}, h('span.grow'), saveRepos)),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Instructions'),
      field('Branch naming', branch, 'Empty: the default (see Prompts → Branch naming)'),
      field('General instructions', general),
      field('Debugging and testing', testing),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, 'This project'),
      h('div.kb-three', {}, field('Tasks at once', maxConc), field('Plan approval', approval), field('Implementation runs', perm)),
      overrideReview.el,
      review.el,
    ),
    h('div.kb-row.kb-save', {}, h('span.grow'), save),
  );
}

// --- Issue sources ---------------------------------------------------------------------------------

const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

function sourcesPane(api: KanbanApi, projectId: string, s: KanbanSettings): HTMLElement {
  const info = kstore.projectOf(projectId)!;
  const remotes = info.repos.filter((r) => r.kind === 'git' && r.remote).map((r) => r.remote!);
  const sources: { read(): IssueSourceConfig | string; el: HTMLElement }[] = [];
  const list = h('div.kb-sources');

  const makeSource = (src: IssueSourceConfig) => {
    const remove = h('button.btn.small.kb-admin', { type: 'button', 'aria-label': 'Remove this source' }, '✕');
    const head = h('div.kb-repo-head', {}, h('b', {}, SOURCE_KIND_NAMES[src.kind]), h('span.grow'), remove);
    let read: () => IssueSourceConfig | string;
    let fields: HTMLElement;
    if (src.kind === 'github-repo') {
      const picks = remotes.map((r) => ({ r, c: checkbox(r, src.repos.includes(r)) }));
      const assignee = textInput(src.filters.assignee ?? '', { placeholder: '@me' });
      const labels = textInput((src.filters.labels ?? []).join(', '), { placeholder: 'bug, ai' });
      const state = select<'open' | 'closed' | 'all'>([['open', 'open'], ['closed', 'closed'], ['all', 'all']], src.filters.state ?? 'open');
      fields = h(
        'div',
        {},
        field('Repositories', h('div.kb-repo-checks', {}, ...picks.map((p) => p.c.el), ...(remotes.length ? [] : [h('small.kb-muted', {}, 'No repository of the project has a GitHub remote')])), 'None picked: every repository of the project on GitHub'),
        h('div.kb-three', {}, field('Assignee', assignee), field('Labels', labels), field('State', state)),
      );
      read = () => ({
        id: src.id,
        kind: 'github-repo',
        repos: picks.filter((p) => p.c.box.checked).map((p) => p.r),
        filters: { ...(assignee.value.trim() ? { assignee: assignee.value.trim() } : {}), ...(csv(labels.value).length ? { labels: csv(labels.value) } : {}), state: state.value as 'open' | 'closed' | 'all' },
      });
    } else if (src.kind === 'github-project') {
      const owner = textInput(src.owner, { placeholder: 'my-org' });
      const number = numberInput(src.number || 1, 1, 100000);
      const assignee = textInput(src.filters.assignee ?? '', { placeholder: '@me' });
      const status = textInput(src.filters.status ?? '', { placeholder: 'Todo' });
      const iteration = textInput(src.filters.iteration ?? '', { placeholder: '@current' });
      fields = h(
        'div',
        {},
        h('div.kb-two', {}, field('Owner (user or organisation)', owner), field('Project number', number)),
        h('div.kb-three', {}, field('Assignee', assignee), field('Status', status), field('Iteration', iteration)),
        h('small.kb-hint', {}, 'Reading Projects needs a scope of its own: run gh auth refresh -s read:project on the office’s machine.'),
      );
      read = () => {
        if (!/^[A-Za-z0-9_.-]+$/.test(owner.value.trim())) return 'A GitHub project needs its owner';
        return {
          id: src.id,
          kind: 'github-project',
          owner: owner.value.trim(),
          number: numberValue(number, 1, 100000, 1),
          filters: { ...(assignee.value.trim() ? { assignee: assignee.value.trim() } : {}), ...(status.value.trim() ? { status: status.value.trim() } : {}), ...(iteration.value.trim() ? { iteration: iteration.value.trim() } : {}) },
        };
      };
    } else {
      const site = textInput(src.site, { placeholder: 'yourteam.atlassian.net' });
      const keys = textInput(src.projectKeys.join(', '), { placeholder: 'UYT, OPS' });
      const assignee = textInput(src.filters.assignee ?? '', { placeholder: 'currentUser()' });
      const epic = textInput(src.filters.epic ?? '', { placeholder: 'UYT-100' });
      const labels = textInput((src.filters.labels ?? []).join(', '), { placeholder: 'ai' });
      const notStatus = textInput((src.filters.statusCategoryNot ?? []).join(', '), { placeholder: 'Done' });
      const jql = textArea(src.filters.jql ?? '', { rows: 2, placeholder: 'priority = High' });
      fields = h(
        'div',
        {},
        h('div.kb-two', {}, field('Jira site', site), field('Project keys', keys)),
        h('div.kb-three', {}, field('Assignee', assignee), field('Epic', epic), field('Labels', labels)),
        h('div.kb-two', {}, field('Leave out status categories', notStatus), field('Extra JQL', jql)),
        h('small.kb-hint', {}, s && kstore.secrets.jira.configured ? `The Jira token is set in 🗂️ Kanban (${kstore.secrets.jira.site ?? ''}).` : 'The Jira e-mail and API token go in 🗂️ Kanban → Jira.'),
      );
      read = () => {
        const host = site.value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return 'A Jira source needs its site, like yourteam.atlassian.net';
        return {
          id: src.id,
          kind: 'jira',
          site: host,
          projectKeys: csv(keys.value).map((k) => k.toUpperCase()),
          filters: {
            ...(assignee.value.trim() ? { assignee: assignee.value.trim() } : {}),
            ...(epic.value.trim() ? { epic: epic.value.trim() } : {}),
            ...(csv(labels.value).length ? { labels: csv(labels.value) } : {}),
            ...(csv(notStatus.value).length ? { statusCategoryNot: csv(notStatus.value) } : {}),
            ...(jql.value.trim() ? { jql: jql.value.trim() } : {}),
          },
        };
      };
    }
    const el = h('div.kb-source', {}, head, fields);
    const item = { read: () => read(), el };
    remove.addEventListener('click', () => {
      sources.splice(sources.indexOf(item), 1);
      el.remove();
    });
    sources.push(item);
    list.append(el);
  };
  for (const src of s.projects[projectId]?.issueSources ?? []) makeSource(src);

  const newId = () => `src-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const blank: Record<IssueSourceKind, () => IssueSourceConfig> = {
    'github-repo': () => ({ id: newId(), kind: 'github-repo', repos: [], filters: { state: 'open' } }),
    'github-project': () => ({ id: newId(), kind: 'github-project', owner: '', number: 1, filters: {} }),
    jira: () => ({ id: newId(), kind: 'jira', site: kstore.secrets.jira.site ?? '', projectKeys: [], filters: {} }),
  };
  const adders = (Object.keys(blank) as IssueSourceKind[]).map((k) => h('button.btn.small.kb-admin', { type: 'button', onclick: () => makeSource(blank[k]()) }, `＋ ${SOURCE_KIND_NAMES[k]}`));
  const save = saveButton();
  save.addEventListener('click', () => {
    const out: IssueSourceConfig[] = [];
    for (const src of sources) {
      const v = src.read();
      if (typeof v === 'string') return toast(v, 'warn');
      out.push(v);
    }
    void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: { issueSources: out } }), save, 'Saved');
  });
  return h('div.kb-pane', {}, h('p.kb-hint', {}, 'Where the project’s issues come from. Filters narrow what’s fetched.'), list, h('div.kb-row', {}, ...adders), h('div.kb-row.kb-save', {}, h('span.grow'), save));
}

// --- Prompts ---------------------------------------------------------------------------------------

function promptsPane(api: KanbanApi, projectId: string, s: KanbanSettings, openEditor: (id: KanbanPromptId) => void, cleanups: Cleanups): HTMLElement {
  let current: KanbanPromptId = KANBAN_PROMPT_IDS[0];
  const layers = () => ({ office: store.prompts.custom as Partial<Record<string, { text: string }>>, project: kstore.settings?.projects[projectId]?.prompts ?? s.projects[projectId]?.prompts ?? {} });
  const nav = h('nav.kb-prompt-list', { 'aria-label': 'Prompts' });
  const head = h('h4');
  const used = h('p.kb-hint');
  const scope = h('span.kb-scope');
  const ta = textArea('', { rows: 14, spellcheck: 'false', maxlength: KANBAN_LIMITS.promptText, 'aria-label': 'Prompt' });
  const vars = h('div.kb-vars');
  const contract = h('div.kb-contract');
  const save = saveButton('Save for this project');
  const reset = h('button.btn.kb-admin', { type: 'button', title: 'Drop this project’s text and use the office’s again' }, '↺ Back to the office’s') as HTMLButtonElement;
  const office = h('button.btn', { type: 'button' }, '📝 Edit the office-wide text');

  const paintNav = () => {
    const l = layers();
    nav.replaceChildren(
      ...KANBAN_PROMPT_IDS.map((id) => {
        const src = kanbanPromptSource(id, l);
        return h('button.kb-prompt-item', { type: 'button', class: id === current ? 'on' : '', 'aria-current': String(id === current), onclick: () => pick(id) }, h('span', {}, KANBAN_PROMPT_DEFS[id].label), h('small', { class: src.scope }, SCOPE_TAGS[src.scope]));
      }),
    );
  };
  const pick = (id: KanbanPromptId) => {
    current = id;
    const def = KANBAN_PROMPT_DEFS[id];
    const src = kanbanPromptSource(id, layers());
    head.textContent = def.label;
    used.textContent = def.used;
    scope.textContent = SCOPE_NOW[src.scope];
    scope.className = `kb-scope ${src.scope}`;
    ta.value = src.text;
    reset.disabled = src.scope !== 'project' || !kstore.me.admin;
    vars.replaceChildren(...Object.entries(def.vars as Record<string, string>).map(([k, v]) => h('span.kb-var', { title: v }, h('code', {}, `{{${k}}}`))));
    const c = PROMPT_CONTRACT[id];
    contract.replaceChildren(...(c ? [h('h5', {}, '🔒 Added by the office after it (can’t be changed)'), h('pre', { 'aria-readonly': 'true' }, KANBAN_CONTRACTS[c])] : []));
    paintNav();
  };
  save.addEventListener('click', () => {
    const text = ta.value.replace(/\r\n?/g, '\n').trim();
    const officeText = kanbanPromptSource(current, { office: layers().office }).text.trim();
    // The office's own words saved for a project would only hide later office-wide changes.
    void run(() => api.request({ t: 'kanban.project.prompt.set', project: projectId, id: current, text: text === officeText ? null : text }), save, 'Saved');
  });
  reset.addEventListener('click', () => void run(() => api.request({ t: 'kanban.project.prompt.set', project: projectId, id: current, text: null }), reset, 'Saved'));
  office.addEventListener('click', () => openEditor(current));
  cleanups.add(kstore.on('settings', () => pick(current)));
  pick(current);
  return h(
    'div.kb-pane.kb-prompts',
    {},
    nav,
    h('section', {}, h('div.kb-row', {}, head, scope), used, ta, vars, contract, h('div.kb-row.kb-save', {}, office, h('span.grow'), reset, save)),
  );
}

// --- Secrets ---------------------------------------------------------------------------------------

function secretsPane(api: KanbanApi): HTMLElement {
  const sec = kstore.secrets;
  const status = (on: boolean, extra = '') => h('span.kb-secret', { class: on ? 'on' : '' }, on ? `✅ configured${extra}` : '— not set');
  const site = textInput(sec.jira.site ?? '', { placeholder: 'yourteam.atlassian.net', autocomplete: 'off' });
  const email = textInput('', { placeholder: 'me@example.com', autocomplete: 'off', type: 'email' });
  const token = h('input', { type: 'password', autocomplete: 'new-password', placeholder: sec.jira.configured ? '••••••••' : '', 'aria-label': 'API token' }) as HTMLInputElement;
  const saveJira = saveButton('Save Jira');
  const clearJira = h('button.btn.kb-admin', { type: 'button', disabled: !sec.jira.configured }, 'Clear') as HTMLButtonElement;
  saveJira.addEventListener('click', () => {
    if (!site.value.trim() || !email.value.trim() || !token.value.trim()) return toast('Jira needs the site, the e-mail and the token', 'warn');
    void run(() => api.request({ t: 'kanban.secrets.set', jira: { site: site.value.trim(), email: email.value.trim(), token: token.value.trim() } }), saveJira, 'Saved').then((ok) => {
      if (ok) token.value = '';
    });
  });
  clearJira.addEventListener('click', () => void run(() => api.request({ t: 'kanban.secrets.set', jira: null }), clearJira, 'Saved'));

  const key = h('input', { type: 'password', autocomplete: 'new-password', placeholder: sec.apiKey.configured ? '••••••••' : '', 'aria-label': 'API key', minlength: 16 }) as HTMLInputElement;
  const gen = h('button.btn.kb-admin', { type: 'button', title: 'Make a random key (copy it before saving: it isn’t shown again)' }, '🎲 Generate');
  gen.addEventListener('click', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    key.value = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    key.type = 'text';
    key.select();
  });
  const saveKey = saveButton('Save the key');
  const clearKey = h('button.btn.kb-admin', { type: 'button', disabled: !sec.apiKey.configured }, 'Clear') as HTMLButtonElement;
  saveKey.addEventListener('click', () => {
    if (key.value.trim().length < 16) return toast('The key needs at least 16 characters', 'warn');
    void run(() => api.request({ t: 'kanban.secrets.set', apiKey: key.value.trim() }), saveKey, 'Saved').then((ok) => {
      if (ok) {
        key.value = '';
        key.type = 'password';
      }
    });
  });
  clearKey.addEventListener('click', () => void run(() => api.request({ t: 'kanban.secrets.set', apiKey: null }), clearKey, 'Saved'));

  return h(
    'div.kb-pane',
    {},
    h('p.kb-hint', {}, 'Written here, kept on the office’s machine only: this page is only told whether they’re set.'),
    h('fieldset', {}, h('legend', {}, 'Jira'), h('p', {}, status(sec.jira.configured, sec.jira.site ? ` · ${sec.jira.site}` : '')), h('div.kb-three', {}, field('Jira site', site), field('E-mail', email), field('API token', token, 'id.atlassian.com → Security → API tokens')), h('div.kb-row.kb-save', {}, h('span.grow'), clearJira, saveJira)),
    h('fieldset', {}, h('legend', {}, 'API key'), h('p', {}, status(sec.apiKey.configured)), h('p.kb-hint', {}, 'For the loopback /api/v1 (jira-loop, jira-kanban-feeder). At least 16 characters.'), h('div.kb-row', {}, key, gen), h('div.kb-row.kb-save', {}, h('span.grow'), clearKey, saveKey)),
  );
}
