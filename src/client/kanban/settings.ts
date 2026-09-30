// The kanban's settings, for admins (everyone else reads them): the office's defaults for new tasks
// and their reviews; per project its repositories, instructions and overrides, its issue sources,
// its own wording of the kanban prompts and which skills each phase gets; and the secrets, which
// the browser only ever writes (it's told whether they're set, never what they are).

import { h, toast } from '../ui/dom';
import { store } from '../state';
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
import { KANBAN_CONTRACTS, KANBAN_PROMPT_DEFS, KANBAN_PROMPT_IDS, PROMPT_CONTRACT, kanbanPromptSource, type KanbanPromptId } from '../../shared/kanban/prompts.js';
import type { KanbanApi } from './api';
import { KANBAN_DEFAULTS, projectDefaults, REVIEW_DEFAULTS } from './defaults';
import { repoIdFrom } from './model';
import { kstore } from './store';
import { skillsPane } from './skills';
import { effortName, t, toolName } from './i18n';
import { checkbox, dialog, field, numberInput, numberValue, run, select, showDialog, tabStrip, textArea, textInput } from './ui';

export type SettingsTab = 'general' | 'projects' | 'sources' | 'prompts' | 'skills' | 'secrets';
const TABS: readonly SettingsTab[] = ['general', 'projects', 'sources', 'prompts', 'skills', 'secrets'];

export interface SettingsOptions {
  first?: SettingsTab;
  project?: string;
  /** Upstream's prompt editor, for a prompt's office-wide text. */
  openPromptEditor(id: KanbanPromptId): void;
}

/** A save button that says whether you may. */
function saveButton(label = t('save')): HTMLButtonElement {
  const b = h('button.btn.primary', { type: 'button' }, label) as HTMLButtonElement;
  if (!kstore.me.admin) {
    b.disabled = true;
    b.title = t('adminsOnly');
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
  const tool = select<KanbanTool | ''>([...(base ? [] : ([['', t('default')]] as const)), ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], r.tool ?? (base ? base.tool : ''));
  const model = textInput(r.model ?? '', { maxlength: KANBAN_LIMITS.model, placeholder: t('default') });
  const effort = select<KanbanEffort | ''>([['', t('default')], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], r.effort ?? '');
  const rounds = numberInput(r.rounds ?? base?.rounds ?? REVIEW_DEFAULTS.rounds, 1, 10);
  const reRev = checkbox(t('reReviewLastFix'), r.reReviewLastFix ?? base?.reReviewLastFix ?? REVIEW_DEFAULTS.reReviewLastFix);
  const sandbox = checkbox(t('reviewSandbox'), r.sandbox ?? base?.sandbox ?? REVIEW_DEFAULTS.sandbox);
  const el = h('div.kb-subfields', {}, field(t('reviewer'), tool), field(t('model'), model), field(t('effort'), effort), field(t('rounds'), rounds, t('roundsHint')), reRev.el, sandbox.el);
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

export function openKanbanSettings(api: KanbanApi, o: SettingsOptions) {
  let tab: SettingsTab = o.first ?? 'general';
  let project = o.project ?? kstore.project ?? kstore.projects[0]?.id ?? '';
  const body = h('div.kb-settings-body');
  const projectPick = h('label.kb-settings-project', {}, h('span', {}, t('project')));
  const note = h('p.kb-settings-note', {}, kstore.me.admin ? t('settingsAdmin') : t('settingsReadOnly'));
  const strip = tabStrip(TABS.map((x) => ({ id: x, label: t(`stab.${x}`) })), tab, (x) => {
    tab = x;
    paint();
  }, t('settings'));
  const d = dialog('kb-settings', `⚙️ ${t('kanbanSettings')}`, h('div.body', {}, strip.el, projectPick, note, body));
  const modal = showDialog(d, { backdropCloses: false, onClose: () => off() });

  const paintProjectPick = () => {
    const perProject = tab !== 'general' && tab !== 'secrets';
    projectPick.classList.toggle('hidden', !perProject || !kstore.projects.length);
    const sel = select(kstore.projects.map((p) => [p.id, p.name] as const), project, { 'aria-label': t('project') });
    sel.addEventListener('change', () => {
      project = sel.value;
      paint();
    });
    projectPick.replaceChildren(h('span', {}, t('project')), sel);
    note.textContent = !kstore.me.admin ? t('settingsReadOnly') : perProject ? t('settingsProject') : t('settingsAdmin');
  };

  const paint = () => {
    paintProjectPick();
    const s = kstore.settings;
    if (!s) return body.replaceChildren(h('p.kb-muted', {}, t('loading')));
    if (tab !== 'general' && tab !== 'secrets' && !kstore.projectOf(project)) return body.replaceChildren(h('p.kb-muted', {}, t('noProjects')));
    const panes: Record<SettingsTab, () => HTMLElement> = {
      general: () => generalPane(api, s),
      projects: () => projectPane(api, project, s),
      sources: () => sourcesPane(api, project, s),
      prompts: () => promptsPane(api, project, s, o.openPromptEditor),
      skills: () => skillsPane(api, project, s),
      secrets: () => secretsPane(api),
    };
    const pane = panes[tab]();
    lockForNonAdmins(pane);
    body.replaceChildren(pane);
  };

  // Someone else saved meanwhile: the pane shows what's saved now (what you typed and didn't save goes).
  const offApi = api.on((msg: KanbanServerMsg) => {
    if (msg.t === 'kanban.projects' && !kstore.projectOf(project)) paint();
  });
  // What's configured changes only by saving here (or elsewhere): the secrets pane says so at once.
  const offSettings = kstore.on('settings', () => {
    if (tab === 'secrets') paint();
  });
  const off = () => {
    offApi();
    offSettings();
  };
  paint();
  return modal;
}

// --- General ---------------------------------------------------------------------------------------

function generalPane(api: KanbanApi, s: KanbanSettings): HTMLElement {
  const dft = s.defaults;
  const tool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, toolName(x)] as const), dft.tool);
  const model = textInput(dft.model ?? '', { maxlength: KANBAN_LIMITS.model, placeholder: t('default') });
  const effort = select<KanbanEffort | ''>([['', t('default')], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], dft.effort ?? '');
  const usePlan = checkbox(t('usePlan'), dft.usePlan);
  const approval = select<PlanApproval>([['auto', t('approval.auto')], ['manual', t('approval.manual')]], dft.planApproval);
  const useReview = checkbox(t('useReview'), dft.useReview);
  const perm = select<ImplementPermission>([['bypass', t('perm.bypass')], ['workspace-write', t('perm.workspace-write')]], dft.implementPermission);
  const review = reviewFields(s.review, s.review);
  const auto = checkbox(t('autoResume'), s.autoResume.enabled);
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
    void run(() => api.request({ t: 'kanban.settings.set', settings: settings as unknown as KanbanSettingsPatch }), save, 'saved');
  });
  return h(
    'div.kb-pane',
    {},
    h('fieldset', {}, h('legend', {}, t('newTaskDefaults')), h('div.kb-three', {}, field(t('tool'), tool), field(t('model'), model), field(t('effort'), effort)), h('div.kb-two', {}, usePlan.el, field(t('planApproval'), approval)), useReview.el, field(t('implementPermission'), perm, t('permHint'))),
    h('fieldset', {}, h('legend', {}, t('reviewDefaults')), review.el),
    h('fieldset', {}, h('legend', {}, t('autoResume')), auto.el, h('div.kb-two', {}, field(t('maxAttempts'), attempts), field(t('maxWaitHours'), waitHours)), h('small.kb-hint', {}, t('autoResumeHint'))),
    h('fieldset', {}, h('legend', {}, t('archive')), field(t('archiveDays'), archive, t('archiveHint'))),
    h('div.kb-row.kb-save', {}, h('span.grow'), save),
  );
}

// --- Projects --------------------------------------------------------------------------------------

function projectPane(api: KanbanApi, projectId: string, s: KanbanSettings): HTMLElement {
  const info = kstore.projectOf(projectId)!;
  const ps: ProjectSettings = s.projects[projectId] ?? projectDefaults();

  // Repositories
  type Row = { repo: ProjectRepoInput; el: HTMLElement; read(): ProjectRepoInput };
  const rows: Row[] = [];
  const list = h('div.kb-repos');
  const makeRow = (r: ProjectRepo | ProjectRepoInput): Row => {
    const name = textInput(r.name, { maxlength: 100, 'aria-label': t('repoName') });
    const dir = textInput(r.dir, { maxlength: 4096, placeholder: '/Users/me/code/api', 'aria-label': t('repoDir'), disabled: r.primary });
    const kind = select<'git' | 'folder'>([['git', 'git'], ['folder', t('folder')]], r.kind ?? 'git', { 'aria-label': t('repoKind'), disabled: r.primary });
    const remote = textInput(r.remote ?? '', { maxlength: 200, placeholder: 'owner/name', 'aria-label': t('repoRemote') });
    const base = textInput(r.baseBranch ?? '', { maxlength: KANBAN_LIMITS.branch, placeholder: 'main', 'aria-label': t('baseBranch') });
    const ins = textArea(r.instructions ?? '', { rows: 2, maxlength: KANBAN_LIMITS.promptText, placeholder: t('repoInstructions'), 'aria-label': t('repoInstructions') });
    const remove = h('button.btn.small.kb-admin', { type: 'button', 'aria-label': t('removeRepo', { name: r.name }), disabled: r.primary, title: r.primary ? t('primaryFixed') : '' }, '✕');
    const el = h(
      'div.kb-repo',
      { class: r.primary ? 'primary' : '' },
      h('div.kb-repo-head', {}, h('b', {}, r.primary ? `⭐ ${t('primary')}` : `📦 ${r.id}`), h('span.grow'), remove),
      h('div.kb-three', {}, field(t('repoName'), name), field(t('repoKind'), kind), field(t('baseBranch'), base)),
      h('div.kb-two', {}, field(t('repoDir'), dir, r.primary ? t('primaryHint') : undefined), field(t('repoRemote'), remote)),
      ins,
    );
    const row: Row = {
      repo: r as ProjectRepoInput,
      el,
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
  const addDir = textInput('', { placeholder: t('addRepoPlaceholder'), 'aria-label': t('addRepo') });
  const addBtn = h('button.btn.kb-admin', { type: 'button' }, `＋ ${t('addRepo')}`);
  addBtn.addEventListener('click', () => {
    const dir = addDir.value.trim();
    if (!dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(dir)) return toast(t('absolutePath'), 'warn');
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo';
    const id = repoIdFrom(name, new Set(rows.map((r) => r.read().id)));
    const row = makeRow({ id, name, dir, primary: false, kind: 'git' });
    rows.push(row);
    list.append(row.el);
    addDir.value = '';
  });
  const saveRepos = saveButton(t('saveRepos'));
  saveRepos.addEventListener('click', () => {
    const repos = rows.map((r) => r.read());
    const bad = repos.find((r) => r.remote && !GH_REPO_RE.test(r.remote));
    if (bad) return toast(t('badRemote', { name: bad.name }), 'warn');
    void run(() => api.request({ t: 'kanban.project.repos.set', project: projectId, repos }), saveRepos, 'saved');
  });

  // Instructions and overrides
  const branch = textArea(ps.branchInstructions, { rows: 3, maxlength: KANBAN_LIMITS.promptText, placeholder: t('branchInsPlaceholder') });
  const general = textArea(ps.generalInstructions, { rows: 4, maxlength: KANBAN_LIMITS.promptText });
  const testing = textArea(ps.testingInstructions, { rows: 4, maxlength: KANBAN_LIMITS.promptText });
  const maxConc = numberInput(ps.maxConcurrent, 1, 20);
  const approval = select<PlanApproval | ''>([['', t('defaultIs', { v: t(`approval.${s.defaults.planApproval}`) })], ['auto', t('approval.auto')], ['manual', t('approval.manual')]], ps.planApproval ?? '');
  const perm = select<ImplementPermission | ''>([['', t('defaultIs', { v: t(`perm.${s.defaults.implementPermission}`) })], ['bypass', t('perm.bypass')], ['workspace-write', t('perm.workspace-write')]], ps.implementPermission ?? '');
  const overrideReview = checkbox(t('reviewOverrideProject'), !!ps.review);
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
    void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: settings as Partial<ProjectSettings> }), save, 'saved');
  });

  return h(
    'div.kb-pane',
    {},
    h('fieldset', {}, h('legend', {}, t('repositories')), h('p.kb-hint', {}, t('reposEditorHint')), list, h('div.kb-row', {}, addDir, addBtn), h('div.kb-row.kb-save', {}, h('span.grow'), saveRepos)),
    h(
      'fieldset',
      {},
      h('legend', {}, t('instructions')),
      field(t('branchIns'), branch, t('branchInsHint')),
      field(t('generalIns'), general),
      field(t('testingIns'), testing),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, t('projectOverrides')),
      h('div.kb-three', {}, field(t('maxConcurrent'), maxConc), field(t('planApproval'), approval), field(t('implementPermission'), perm)),
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
    const remove = h('button.btn.small.kb-admin', { type: 'button', 'aria-label': t('removeSource') }, '✕');
    const head = h('div.kb-repo-head', {}, h('b', {}, t(`src.${src.kind}`)), h('span.grow'), remove);
    let read: () => IssueSourceConfig | string;
    let fields: HTMLElement;
    if (src.kind === 'github-repo') {
      const picks = remotes.map((r) => ({ r, c: checkbox(r, src.repos.includes(r)) }));
      const assignee = textInput(src.filters.assignee ?? '', { placeholder: '@me' });
      const labels = textInput((src.filters.labels ?? []).join(', '), { placeholder: 'bug, ai' });
      const state = select<'open' | 'closed' | 'all'>([['open', t('issueState.open')], ['closed', t('issueState.closed')], ['all', t('all')]], src.filters.state ?? 'open');
      fields = h(
        'div',
        {},
        field(t('sourceRepos'), h('div.kb-repo-checks', {}, ...picks.map((p) => p.c.el), ...(remotes.length ? [] : [h('small.kb-muted', {}, t('noRemotes'))])), t('sourceReposHint')),
        h('div.kb-three', {}, field(t('assignee'), assignee), field(t('labels'), labels), field(t('state'), state)),
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
        h('div.kb-two', {}, field(t('ghOwner'), owner), field(t('ghNumber'), number)),
        h('div.kb-three', {}, field(t('assignee'), assignee), field(t('status'), status), field(t('iteration'), iteration)),
        h('small.kb-hint', {}, t('ghProjectHint')),
      );
      read = () => {
        if (!/^[A-Za-z0-9_.-]+$/.test(owner.value.trim())) return t('ghOwnerNeeded');
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
        h('div.kb-two', {}, field(t('jiraSite'), site), field(t('jiraKeys'), keys)),
        h('div.kb-three', {}, field(t('assignee'), assignee), field(t('epic'), epic), field(t('labels'), labels)),
        h('div.kb-two', {}, field(t('statusNot'), notStatus), field(t('extraJql'), jql)),
        h('small.kb-hint', {}, s && kstore.secrets.jira.configured ? t('jiraTokenSet', { site: kstore.secrets.jira.site ?? '' }) : t('jiraTokenHint')),
      );
      read = () => {
        const host = site.value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return t('jiraSiteNeeded');
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
  const adders = (Object.keys(blank) as IssueSourceKind[]).map((k) => h('button.btn.small.kb-admin', { type: 'button', onclick: () => makeSource(blank[k]()) }, `＋ ${t(`src.${k}`)}`));
  const save = saveButton();
  save.addEventListener('click', () => {
    const out: IssueSourceConfig[] = [];
    for (const src of sources) {
      const v = src.read();
      if (typeof v === 'string') return toast(v, 'warn');
      out.push(v);
    }
    void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: { issueSources: out } }), save, 'saved');
  });
  return h('div.kb-pane', {}, h('p.kb-hint', {}, t('sourcesHint')), list, h('div.kb-row', {}, ...adders), h('div.kb-row.kb-save', {}, h('span.grow'), save));
}

// --- Prompts ---------------------------------------------------------------------------------------

function promptsPane(api: KanbanApi, projectId: string, s: KanbanSettings, openEditor: (id: KanbanPromptId) => void): HTMLElement {
  let current: KanbanPromptId = KANBAN_PROMPT_IDS[0];
  const layers = () => ({ office: store.prompts.custom as Partial<Record<string, { text: string }>>, project: kstore.settings?.projects[projectId]?.prompts ?? s.projects[projectId]?.prompts ?? {} });
  const nav = h('nav.kb-prompt-list', { 'aria-label': t('prompts') });
  const head = h('h4');
  const used = h('p.kb-hint');
  const scope = h('span.kb-scope');
  const ta = textArea('', { rows: 14, spellcheck: 'false', maxlength: KANBAN_LIMITS.promptText, 'aria-label': t('prompt') });
  const vars = h('div.kb-vars');
  const contract = h('div.kb-contract');
  const save = saveButton(t('saveForProject'));
  const reset = h('button.btn.kb-admin', { type: 'button', title: t('resetHint') }, `↺ ${t('resetToOffice')}`) as HTMLButtonElement;
  const office = h('button.btn', { type: 'button' }, `📝 ${t('officeText')}`);

  const paintNav = () => {
    const l = layers();
    nav.replaceChildren(
      ...KANBAN_PROMPT_IDS.map((id) => {
        const src = kanbanPromptSource(id, l);
        return h('button.kb-prompt-item', { type: 'button', class: id === current ? 'on' : '', 'aria-current': String(id === current), onclick: () => pick(id) }, h('span', {}, KANBAN_PROMPT_DEFS[id].label), h('small', { class: src.scope }, t(`scope.${src.scope}`)));
      }),
    );
  };
  const pick = (id: KanbanPromptId) => {
    current = id;
    const def = KANBAN_PROMPT_DEFS[id];
    const src = kanbanPromptSource(id, layers());
    head.textContent = def.label;
    used.textContent = def.used;
    scope.textContent = t(`scopeNow.${src.scope}`);
    scope.className = `kb-scope ${src.scope}`;
    ta.value = src.text;
    reset.disabled = src.scope !== 'project' || !kstore.me.admin;
    vars.replaceChildren(...Object.entries(def.vars as Record<string, string>).map(([k, v]) => h('span.kb-var', { title: v }, h('code', {}, `{{${k}}}`))));
    const c = PROMPT_CONTRACT[id];
    contract.replaceChildren(...(c ? [h('h5', {}, `🔒 ${t('contractBlock')}`), h('pre', { 'aria-readonly': 'true' }, KANBAN_CONTRACTS[c])] : []));
    paintNav();
  };
  save.addEventListener('click', () => {
    const text = ta.value.replace(/\r\n?/g, '\n').trim();
    const officeText = kanbanPromptSource(current, { office: layers().office }).text.trim();
    // The office's own words saved for a project would only hide later office-wide changes.
    void run(() => api.request({ t: 'kanban.project.prompt.set', project: projectId, id: current, text: text === officeText ? null : text }), save, 'saved');
  });
  reset.addEventListener('click', () => void run(() => api.request({ t: 'kanban.project.prompt.set', project: projectId, id: current, text: null }), reset, 'saved'));
  office.addEventListener('click', () => openEditor(current));
  const off = kstore.on('settings', () => {
    if (!nav.isConnected) return off();
    pick(current);
  });
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
  const status = (on: boolean, extra = '') => h('span.kb-secret', { class: on ? 'on' : '' }, on ? `✅ ${t('configured')}${extra}` : `— ${t('notConfigured')}`);
  const site = textInput(sec.jira.site ?? '', { placeholder: 'yourteam.atlassian.net', autocomplete: 'off' });
  const email = textInput('', { placeholder: 'me@example.com', autocomplete: 'off', type: 'email' });
  const token = h('input', { type: 'password', autocomplete: 'new-password', placeholder: sec.jira.configured ? '••••••••' : '', 'aria-label': t('jiraToken') }) as HTMLInputElement;
  const saveJira = saveButton(t('saveJira'));
  const clearJira = h('button.btn.kb-admin', { type: 'button', disabled: !sec.jira.configured }, t('clear')) as HTMLButtonElement;
  saveJira.addEventListener('click', () => {
    if (!site.value.trim() || !email.value.trim() || !token.value.trim()) return toast(t('jiraAllNeeded'), 'warn');
    void run(() => api.request({ t: 'kanban.secrets.set', jira: { site: site.value.trim(), email: email.value.trim(), token: token.value.trim() } }), saveJira, 'saved').then((ok) => {
      if (ok) token.value = '';
    });
  });
  clearJira.addEventListener('click', () => void run(() => api.request({ t: 'kanban.secrets.set', jira: null }), clearJira, 'saved'));

  const key = h('input', { type: 'password', autocomplete: 'new-password', placeholder: sec.apiKey.configured ? '••••••••' : '', 'aria-label': t('apiKey'), minlength: 16 }) as HTMLInputElement;
  const gen = h('button.btn.kb-admin', { type: 'button', title: t('generateHint') }, `🎲 ${t('generate')}`);
  gen.addEventListener('click', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    key.value = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    key.type = 'text';
    key.select();
  });
  const saveKey = saveButton(t('saveKey'));
  const clearKey = h('button.btn.kb-admin', { type: 'button', disabled: !sec.apiKey.configured }, t('clear')) as HTMLButtonElement;
  saveKey.addEventListener('click', () => {
    if (key.value.trim().length < 16) return toast(t('keyTooShort'), 'warn');
    void run(() => api.request({ t: 'kanban.secrets.set', apiKey: key.value.trim() }), saveKey, 'saved').then((ok) => {
      if (ok) {
        key.value = '';
        key.type = 'password';
      }
    });
  });
  clearKey.addEventListener('click', () => void run(() => api.request({ t: 'kanban.secrets.set', apiKey: null }), clearKey, 'saved'));

  return h(
    'div.kb-pane',
    {},
    h('p.kb-hint', {}, t('secretsHint')),
    h('fieldset', {}, h('legend', {}, 'Jira'), h('p', {}, status(sec.jira.configured, sec.jira.site ? ` · ${sec.jira.site}` : '')), h('div.kb-three', {}, field(t('jiraSite'), site), field(t('jiraEmail'), email), field(t('jiraToken'), token, t('jiraTokenWhere'))), h('div.kb-row.kb-save', {}, h('span.grow'), clearJira, saveJira)),
    h('fieldset', {}, h('legend', {}, t('apiKey')), h('p', {}, status(sec.apiKey.configured)), h('p.kb-hint', {}, t('apiKeyHint')), h('div.kb-row', {}, key, gen), h('div.kb-row.kb-save', {}, h('span.grow'), clearKey, saveKey)),
  );
}
