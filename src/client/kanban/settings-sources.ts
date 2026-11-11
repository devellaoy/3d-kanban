// A project's Issue sources in the kanban's settings (settings.ts, the 📌 tab): GitHub repositories and
// projects, Jira and Azure Boards, each a form that reads back to an IssueSourceConfig.

import { h, toast } from '../ui/dom';
import { icon, withIcon } from '../ui/icons';
import type { IssueSourceConfig, IssueSourceKind, KanbanSettings } from '../../shared/kanban/types.js';
import { jiraSourcesProblem } from '../../shared/kanban/jira-connections.js';
import type { KanbanApi } from './api';
import { SOURCE_KIND_NAMES } from './labels';
import { saveButton } from './project-fields';
import { azureBoardsForm, csv, jiraForm } from './source-forms';
import { kstore } from './store';
import { checkbox, field, numberInput, numberValue, run, select, textInput } from './ui';

export function sourcesPane(api: KanbanApi, projectId: string, s: KanbanSettings): HTMLElement {
  const info = kstore.projectOf(projectId)!;
  const remotes = info.repos.filter((r) => r.kind === 'git' && (r.remote || r.detectedRemote)).map((r) => (r.remote || r.detectedRemote)!);
  const sources: { read(): IssueSourceConfig | string; el: HTMLElement }[] = [];
  const list = h('div.kb-sources');

  const makeSource = (src: IssueSourceConfig) => {
    const remove = h('button.btn.small.kb-admin', { type: 'button', 'aria-label': 'Remove this source' }, icon('x', { size: 14 }));
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
    } else ({ fields, read } = src.kind === 'jira' ? jiraForm(src) : azureBoardsForm(src));
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
    jira: () => ({ id: newId(), kind: 'jira', site: kstore.secrets.jira[0]?.site ?? '', projectKeys: [], filters: {} }),
    'azure-boards': () => ({ id: newId(), kind: 'azure-boards', org: '', project: '', filters: {} }),
  };
  const adders = (Object.keys(blank) as IssueSourceKind[]).map((k) => h('button.btn.small.kb-admin', { type: 'button', onclick: () => makeSource(blank[k]()) }, ...withIcon('plus', SOURCE_KIND_NAMES[k])));
  const save = saveButton();
  save.addEventListener('click', () => {
    const out: IssueSourceConfig[] = [];
    for (const src of sources) {
      const v = src.read();
      if (typeof v === 'string') return toast(v, 'warn');
      out.push(v);
    }
    const clash = jiraSourcesProblem(out);
    if (clash) return toast(clash, 'warn');
    void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: { issueSources: out } }), save, 'Saved');
  });
  return h('div.kb-pane', {}, h('p.kb-hint', {}, 'Where the project’s issues come from. Filters narrow what’s fetched.'), list, h('div.kb-row', {}, ...adders), h('div.kb-row.kb-save', {}, h('span.grow'), save));
}
