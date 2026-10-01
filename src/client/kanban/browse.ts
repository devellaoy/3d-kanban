// 🔎 Browse issues: all of a project's Jira issues or GitHub Project items (docs/kanban-architecture.md
// §6), not just what its issue sources list. One source (scope) at a time, with a search, filters and
// a tree (browseview.ts) that loads as it is opened. The filters are remembered per project and source
// in this browser. Picking an issue hands it to `open` (the kanban page opens its issue window, the 3D
// office its card); an issue already made into a task has ↗ #id, which hands the id to `openTask`.

import './browse.css';
import { h } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { BrowseIssue, BrowseOptions, BrowseScope } from '../../shared/kanban/browse.js';
import type { KanbanApi } from './api';
import { browseTree } from './browseview';
import { DEFAULTS, SEARCH_MS, catOf, catsFor, dropUnresolvedMe, keep, meOf, meWhy, recall, recallScope, savedKey, scopeKey, toFilters, type Saved } from './browsefilters';
import { kstore } from './store';
import { dialog, showDialog, textArea, textInput } from './ui';

type Scopes = Extract<KanbanServerMsg, { t: 'kanban.browseScopes' }>;
type Options = Extract<KanbanServerMsg, { t: 'kanban.browseOptions' }>;
type People = Extract<KanbanServerMsg, { t: 'kanban.issuePeople' }>;

export interface BrowseOpts {
  open(issue: BrowseIssue, scope: BrowseScope): void;
  openTask(id: number): void;
}

/** A select of value / label pairs; `title` per option for the disabled ones' reasons. */
function pick(label: string, options: { v: string; label: string; disabled?: string }[], value: string): HTMLSelectElement {
  const el = h('select', { 'aria-label': label, title: label });
  for (const o of options) el.append(h('option', { value: o.v, disabled: !!o.disabled, title: o.disabled ?? undefined }, o.label));
  el.value = value;
  if (el.value !== value || options.find((o) => o.v === value)?.disabled) el.value = options.find((o) => !o.disabled)?.v ?? '';
  return el;
}

export function openBrowse(api: KanbanApi, projectId: string, opts: BrowseOpts): void {
  const projectName = kstore.projectOf(projectId)?.name ?? projectId;
  let scopes: BrowseScope[] = [];
  let github: string | undefined;
  let scope: BrowseScope | undefined;
  let options: BrowseOptions | undefined;
  let s: Saved = { ...DEFAULTS };
  let gen = 0;
  let closed = false;
  let tree: ReturnType<typeof browseTree> | null = null;
  const optionsCache = new Map<string, BrowseOptions>();
  /** What came in on the loaded issues: label suggestions, and the sprints by id. */
  const labelsSeen = new Set<string>();
  const sprintsSeen = new Map<string, string>();

  const scopeBox = h('span.kb-br-scope');
  const search = textInput('', {
    type: 'search',
    placeholder: 'Search: words or an issue key',
    'aria-label': 'Search the issues',
  });
  const jqlBtn = h(
    'button.btn.small.kb-br-jqlbtn',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Add your own JQL to the filters',
    },
    'JQL',
  ) as HTMLButtonElement;
  const reset = h('button.btn.small', { type: 'button', title: 'Back to the default filters' }, 'Reset') as HTMLButtonElement;
  const filters = h('div.kb-br-filters', {
    role: 'group',
    'aria-label': 'Filters',
  });
  const jqlBox = textArea('', {
    rows: 2,
    placeholder: 'e.g. priority = High AND updated >= -14d',
    'aria-label': 'JQL, added to the filters',
    spellcheck: 'false',
  });
  const jqlApply = h('button.btn.small.primary', { type: 'button' }, 'Apply') as HTMLButtonElement;
  const jqlRow = h('div.kb-br-jql', { hidden: true }, jqlBox, h('div.kb-br-jqlfoot', {}, h('small.kb-br-quiet', {}, 'Enter applies it (Shift+Enter: a new line). It is AND-ed with the filters, inside the source’s projects.'), jqlApply));
  const peopleSearch = textInput('', {
    type: 'search',
    placeholder: 'Search people',
    'aria-label': 'Search people to filter by',
  });
  const peopleList = h('ul.kb-br-people', { 'aria-live': 'polite' });
  const peopleBox = h('div.kb-br-picker', { hidden: true }, peopleSearch, peopleList);
  const labelList = h('datalist', {
    id: `kb-br-labels-${Math.random().toString(36).slice(2, 8)}`,
  });
  const notices = h('div.kb-br-notices');
  const treeBox = h('div.kb-br-treebox', { 'aria-live': 'polite' }, h('p.kb-br-quiet', {}, 'Loading the sources…'));
  const bar = h('div.kb-br-bar', {}, scopeBox, search, jqlBtn, reset);
  const body = h('div.body', {}, bar, filters, jqlRow, peopleBox, notices, treeBox, labelList);
  const d = dialog('kb-browse-window', `🔎 Browse issues · ${projectName}`, body);
  showDialog(d, {
    onClose: () => {
      closed = true;
      gen++;
      tree?.destroy();
    },
  });

  const persist = () => scope && keep(savedKey(projectId, scope.id), s);

  // ---- The tree ----
  const rebuild = () => {
    tree?.destroy();
    tree = null;
    if (!scope || !options) return;
    const g = ++gen;
    const sc = scope;
    const me = meOf(sc, github);
    const notice = dropUnresolvedMe(s, sc, me);
    if (notice) {
      persist();
      paintFilters();
    }
    notices.replaceChildren(...(notice ? [h('p.kb-br-quiet', { role: 'status' }, notice)] : []));
    tree = browseTree({
      api,
      project: projectId,
      scope: sc,
      filters: toFilters(s, sc, me),
      live: () => g === gen && !closed,
      open: (issue) => opts.open(issue, sc),
      openTask: opts.openTask,
      seen: noteSeen,
    });
    treeBox.replaceChildren(tree.el);
  };
  const changed = () => {
    persist();
    rebuild();
  };

  const noteSeen = (items: BrowseIssue[]) => {
    let newLabels = false;
    let newSprints = false;
    for (const i of items) {
      for (const l of i.labels) {
        if (labelsSeen.has(l)) continue;
        labelsSeen.add(l);
        newLabels = true;
      }
      for (const sp of i.sprints ?? []) {
        if (sprintsSeen.has(sp.id)) continue;
        sprintsSeen.set(sp.id, sp.name);
        newSprints = true;
      }
    }
    if (newLabels) labelList.replaceChildren(...[...labelsSeen].sort((a, b) => a.localeCompare(b)).map((l) => h('option', { value: l })));
    // Only the sprint select is made again: the others may have the focus (the labels being typed).
    const old = filters.querySelector('select.kb-br-sprint');
    if (newSprints && old && document.activeElement !== old) old.replaceWith(sprintSelect());
  };

  // ---- The filters ----
  const select = (label: string, list: { v: string; label: string; disabled?: string }[], key: 'cat' | 'status' | 'type' | 'version' | 'sprint' | 'iteration' | 'epic') => {
    const el = pick(label, list, s[key]);
    el.addEventListener('change', () => {
      (s[key] as string) = el.value;
      changed();
    });
    return el;
  };
  const assigneeSelect = () => {
    const me = scope ? meOf(scope, github) : undefined;
    const why = me || !scope ? undefined : meWhy(scope);
    const list = [
      { v: '', label: 'Anyone' },
      {
        v: 'me',
        label: me ? `Me (${me.name})` : 'Me: pin yourself first',
        disabled: why,
      },
      { v: 'none', label: 'Unassigned' },
      { v: 'any', label: 'Assigned' },
      ...(s.person ? [{ v: 'person', label: `👤 ${s.person.name}` }] : []),
      { v: 'someone', label: 'Someone…' },
    ];
    const el = pick('Assignee', list, s.who);
    if (why) el.title = `Assignee · Me: ${why}`;
    el.addEventListener('change', () => {
      if (el.value === 'someone') return showPeople(true);
      showPeople(false);
      s.who = el.value as Saved['who'];
      changed();
    });
    return el;
  };
  const labelsInput = () => {
    const el = textInput(s.labels, {
      type: 'search',
      placeholder: 'Labels: a, b',
      'aria-label': 'Labels (all of them)',
      list: labelList.id,
      class: 'kb-br-labels',
    });
    el.addEventListener('change', () => {
      if (el.value === s.labels) return;
      s.labels = el.value;
      changed();
    });
    return el;
  };
  /** Open sprints, and the sprints seen on the loaded issues (by id, newest first). */
  const sprintSelect = () => {
    const sprints = [...sprintsSeen].sort((a, b) => Number(b[0]) - Number(a[0]));
    if (s.sprint && /^\d+$/.test(s.sprint) && !sprintsSeen.has(s.sprint)) sprints.push([s.sprint, `Sprint ${s.sprint}`]);
    const el = select('Sprint', [{ v: '', label: 'Any sprint' }, { v: 'open', label: 'Open sprints' }, ...sprints.map(([id, name]) => ({ v: id, label: name }))], 'sprint');
    el.classList.add('kb-br-sprint');
    return el;
  };
  function paintFilters() {
    if (!scope || !options) return filters.replaceChildren();
    const jira = scope.kind === 'jira';
    const o = options;
    const any = (label: string) => ({ v: '', label });
    const statuses = jira ? o.statuses.map((x) => x.name) : (o.statusField ?? []);
    const shown = (list: unknown[], value: string) => list.length > 0 || !!value;
    filters.replaceChildren(
      ...[
        select(
          'Status category',
          catsFor(scope).map(([v, label]) => ({ v, label })),
          'cat',
        ),
        shown(statuses, s.status) ? select('Status', [any('Any status'), ...statuses.map((n) => ({ v: n, label: n }))], 'status') : null,
        assigneeSelect(),
        shown(o.issueTypes, s.type) ? select('Type', [any('Any type'), ...o.issueTypes.map((n) => ({ v: n, label: n }))], 'type') : null,
        labelsInput(),
        jira && shown(o.versions, s.version)
          ? select(
              'Fix version',
              [
                any('Any version'),
                ...o.versions.map((v) => ({
                  v: v.id,
                  label: `${v.title}${v.released ? ' (released)' : ''}`,
                })),
                { v: 'none', label: 'No version' },
              ],
              'version',
            )
          : null,
        jira ? sprintSelect() : null,
        !jira && shown(o.iterations, s.iteration) ? select('Iteration', [any('Any iteration'), ...o.iterations.map((n) => ({ v: n, label: n }))], 'iteration') : null,
        shown(o.epics, s.epic)
          ? select(
              'Epic',
              [
                any('Any epic'),
                ...o.epics.map((e) => ({
                  v: e.key,
                  label: `${e.key} ${e.title}`,
                })),
                { v: 'none', label: 'No epic' },
              ],
              'epic',
            )
          : null,
      ].filter((x) => !!x),
    );
    jqlBtn.hidden = !jira;
    jqlBtn.setAttribute('aria-pressed', String(jira && s.jqlOn));
    jqlRow.hidden = !(jira && s.jqlOn);
    jqlBox.value = s.jql;
    if (search.value !== s.q && document.activeElement !== search) search.value = s.q;
  }

  // ---- Someone… ----
  let peopleGen = 0;
  let peopleTimer: ReturnType<typeof setTimeout> | undefined;
  const findPeople = () => {
    if (!scope) return;
    const g = ++peopleGen;
    const query = peopleSearch.value.trim();
    peopleList.replaceChildren(h('li.kb-br-quiet', {}, 'Searching…'));
    api
      .request<People>({
        t: 'kanban.browse.people',
        project: projectId,
        scope: scope.id,
        ...(query ? { query } : {}),
      })
      .then((a) => {
        if (g !== peopleGen || closed) return;
        if (a.cannot) return peopleList.replaceChildren(h('li.kb-br-quiet', {}, a.cannot));
        if (!a.items.length) return peopleList.replaceChildren(h('li.kb-br-quiet', {}, query ? 'Nobody matches' : 'Type a name'));
        peopleList.replaceChildren(
          ...a.items.map((p) =>
            h(
              'li',
              {},
              h(
                'button.kb-br-person',
                {
                  type: 'button',
                  onclick: () => {
                    s.who = 'person';
                    s.person = { id: p.id, name: p.name };
                    showPeople(false);
                    paintFilters();
                    changed();
                  },
                },
                h('b', {}, p.name),
                p.login && p.login !== p.name ? h('small', {}, p.login) : null,
              ),
            ),
          ),
        );
      })
      .catch((err: Error) => g === peopleGen && peopleList.replaceChildren(h('li.kb-br-error', {}, `⚠️ ${err.message}`)));
  };
  const showPeople = (on: boolean) => {
    peopleBox.hidden = !on;
    if (!on) return;
    peopleSearch.value = '';
    peopleSearch.focus();
    findPeople();
  };
  peopleSearch.addEventListener('input', () => {
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(findPeople, SEARCH_MS);
  });

  // ---- Search, JQL, Reset ----
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (search.value.trim() === s.q.trim()) return;
      s.q = search.value;
      changed();
    }, SEARCH_MS);
  });
  const applyJql = () => {
    s.jql = jqlBox.value;
    changed();
  };
  jqlBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    applyJql();
  });
  jqlApply.addEventListener('click', applyJql);
  jqlBtn.addEventListener('click', () => {
    s.jqlOn = !s.jqlOn;
    paintFilters();
    if (s.jqlOn) return jqlBox.focus();
    // Turning it off takes the JQL out of the filters (the text is kept for next time).
    if (s.jql.trim()) changed();
    else persist();
  });
  reset.addEventListener('click', () => {
    s = { ...DEFAULTS };
    search.value = '';
    showPeople(false);
    paintFilters();
    changed();
  });

  // ---- The scope ----
  const useScope = (next: BrowseScope) => {
    scope = next;
    options = undefined;
    keep(scopeKey(projectId), next.id);
    s = {
      ...DEFAULTS,
      ...recall<Partial<Saved>>(savedKey(projectId, next.id)),
    };
    s.cat = catOf(s.cat, next);
    search.value = s.q;
    showPeople(false);
    tree?.destroy();
    gen++;
    filters.replaceChildren();
    const cached = optionsCache.get(next.id);
    if (cached) {
      options = cached;
      paintFilters();
      return rebuild();
    }
    treeBox.replaceChildren(h('p.kb-br-quiet', {}, 'Loading the filters…'));
    const g = gen;
    api
      .request<Options>({
        t: 'kanban.browse.options',
        project: projectId,
        scope: next.id,
      })
      .then((a) => {
        if (g !== gen || closed) return;
        optionsCache.set(next.id, a.options);
        options = a.options;
        paintFilters();
        rebuild();
      })
      .catch((err: Error) => {
        if (g !== gen || closed) return;
        const again = h('button.btn.small', { type: 'button', onclick: () => useScope(next) }, 'Try again');
        treeBox.replaceChildren(h('div.kb-br-error', { role: 'alert' }, h('span', {}, `⚠️ ${err.message}`), again));
      });
  };
  const paintScopes = () => {
    if (scopes.length < 2) return scopeBox.replaceChildren(scope ? h('span.kb-chip.kb-br-scopechip', { title: 'The source being browsed' }, scope.label) : '');
    const el = pick(
      'Source',
      scopes.map((x) => ({
        v: x.id,
        label: x.disabled ? `${x.label} (can’t browse)` : x.label,
        disabled: x.disabled,
      })),
      scope?.id ?? '',
    );
    el.addEventListener('change', () => {
      const next = scopes.find((x) => x.id === el.value);
      if (next && !next.disabled) useScope(next);
    });
    scopeBox.replaceChildren(el);
  };

  const loadScopes = () => {
    treeBox.replaceChildren(h('p.kb-br-quiet', {}, 'Loading the sources…'));
    api
      .request<Scopes>({ t: 'kanban.browse.scopes', project: projectId })
      .then((a) => {
        if (closed) return;
        scopes = a.scopes;
        github = a.me?.github;
        const usable = scopes.filter((x) => !x.disabled);
        const first = usable.find((x) => x.id === recallScope(projectId)) ?? usable[0];
        if (!first) {
          scope = undefined;
          paintScopes();
          bar.classList.add('off');
          const why = scopes.map((x) => `${x.label}: ${x.disabled}`).join(' · ');
          return treeBox.replaceChildren(
            h(
              'p.kb-br-empty-proj',
              {},
              scopes.length ? `None of the issue sources can be browsed (${why}).` : 'This project has no Jira or GitHub Project source to browse.',
              h('br'),
              'Add a Jira or GitHub project issue source in ⚙️ Settings → 📌 Issue sources.',
            ),
          );
        }
        bar.classList.remove('off');
        scope = first;
        paintScopes();
        useScope(first);
      })
      .catch((err: Error) => {
        if (closed) return;
        treeBox.replaceChildren(h('div.kb-br-error', { role: 'alert' }, h('span', {}, `⚠️ ${err.message}`), h('button.btn.small', { type: 'button', onclick: loadScopes }, 'Try again')));
      });
  };
  loadScopes();
}
