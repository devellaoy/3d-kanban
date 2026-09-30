// The kanban's skills in ⚙️ Settings: under 🗂️ Kanban every skill the office found (bundled with it,
// the user's, an account's, a repository's), which config homes it's installed in and which projects
// use it, and a sync that installs the office's own again; under 📁 Projects → Skills, per project,
// which skills each phase gets for each tool.

import { h } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { KANBAN_TOOLS, SKILL_PHASES, type KanbanSettings, type KanbanTool, type SkillInfo, type SkillPhase, type SkillSelection } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { skillUsage } from './model';
import { kstore } from './store';
import { toolName } from './labels';
import { run } from './ui';

type SkillsMsg = Extract<KanbanServerMsg, { t: 'kanban.skills' }>;

const ORIGIN_NAMES: Record<SkillInfo['origin'], string> = { bundled: 'the office', user: 'you', account: 'an account', repo: 'a repository' };
const PHASE_NAMES: Record<SkillPhase, string> = { plan: 'Plan', implement: 'Implement', review: 'Review', pr: 'Pull requests' };

let cache: SkillsMsg | null = null;
/** The panes drawn now, redrawn when the list comes in or is synced. */
const painters = new Set<() => void>();

function load(msg: SkillsMsg) {
  cache = msg;
  for (const paint of painters) paint();
}

/** Asks for the list once for as long as something shows it; `paint` runs when it's in. Returns how to stop. */
function follow(api: KanbanApi, paint: () => void, el: HTMLElement): () => void {
  const stop = () => painters.delete(paint);
  const guarded = () => {
    // A pane taken out of the page stops listening.
    if (!el.isConnected && cache) return stop();
    paint();
  };
  painters.add(guarded);
  api.request<SkillsMsg>({ t: 'kanban.skills.list' }).then(load, (err: Error) => load({ t: 'kanban.skills', skills: cache?.skills ?? [], error: err.message }));
  return stop;
}

/** Every skill the office found, which projects use it, and 🔄 Sync (office-wide). */
export function skillsOverview(api: KanbanApi, s: KanbanSettings): HTMLElement {
  const list = h('div.kb-skill-list', { 'aria-live': 'polite' });
  const sync = h('button.btn.kb-admin', { type: 'button', title: 'Look for skills again and install the office’s own' }, '🔄 Sync') as HTMLButtonElement;
  const projectName = (id: string) => kstore.projectOf(id)?.name ?? id;

  const paintList = () => {
    if (!cache) return list.replaceChildren(h('p.kb-muted', {}, 'Loading…'));
    if (cache.error) list.replaceChildren(h('p.kb-error', {}, `⚠️ ${cache.error}`));
    else list.replaceChildren();
    if (!cache.skills.length) return list.append(h('p.kb-muted', {}, 'No skills found.'));
    list.append(
      h(
        'table.kb-table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Skill'), h('th', {}, 'Agent'), h('th', {}, 'From'), h('th', {}, 'Installed in'), h('th', {}, 'Used by'))),
        h(
          'tbody',
          {},
          ...cache.skills.map((k) =>
            h(
              'tr',
              {},
              h('td', {}, h('b', {}, k.name), h('div.kb-muted', {}, k.description)),
              h('td', {}, toolName(k.tool)),
              h('td', {}, h('span.kb-chip', { title: k.location }, ORIGIN_NAMES[k.origin])),
              h('td', {}, ...(k.installedIn.length ? k.installedIn.map((p) => h('code.kb-path', {}, p)) : [h('span.kb-muted', {}, '—')])),
              h('td', {}, skillUsage(kstore.settings ?? s, k.name, k.tool).map(projectName).join(', ') || '—'),
            ),
          ),
        ),
      ),
    );
  };

  sync.addEventListener('click', () => void run(() => api.request<SkillsMsg>({ t: 'kanban.skills.sync' }), sync, 'Skills synced').then((m) => m && m.t === 'kanban.skills' && load(m)));
  const el = h('fieldset', {}, h('legend', {}, 'Skills'), h('div.kb-row', {}, h('p.kb-hint', {}, 'Skills the office found on this machine.'), h('span.grow'), sync), list);
  paintList();
  follow(api, paintList, el);
  return el;
}

/** Which skills each phase of `projectId`'s tasks is told to use, per agent. */
export function skillsPane(api: KanbanApi, projectId: string, s: KanbanSettings): HTMLElement {
  const grid = h('div.kb-skill-grid');
  const save = h('button.btn.primary.kb-admin', { type: 'button' }, 'Save') as HTMLButtonElement;
  const selection: SkillSelection = structuredClone(s.projects[projectId]?.skills ?? {});
  const projectName = (id: string) => kstore.projectOf(id)?.name ?? id;

  const paintGrid = () => {
    const skills = cache?.skills ?? [];
    const cell = (phase: SkillPhase, tool: KanbanTool) => {
      const names = [...new Set(skills.filter((k) => k.tool === tool).map((k) => k.name))].sort();
      const picked = selection[phase]?.[tool] ?? [];
      // A picked skill the office can't find any more still shows, to be taken off.
      for (const n of picked) if (!names.includes(n)) names.push(n);
      const summary = h('summary', {}, picked.length ? picked.join(', ') : 'none');
      return h(
        'td',
        {},
        h(
          'details.kb-skill-pick',
          {},
          summary,
          ...names.map((n) => {
            const box = h('input', { type: 'checkbox', checked: picked.includes(n), disabled: !kstore.me.admin }) as HTMLInputElement;
            box.addEventListener('change', () => {
              const now = new Set(selection[phase]?.[tool] ?? []);
              if (box.checked) now.add(n);
              else now.delete(n);
              selection[phase] = { ...selection[phase], [tool]: [...now] };
              // Not redrawn: that would shut the list being picked from.
              summary.textContent = now.size ? [...now].join(', ') : 'none';
            });
            const missing = !skills.some((k) => k.name === n && k.tool === tool);
            return h('label.kb-check', { class: missing ? 'missing' : '', title: missing ? 'Picked, but the office can’t find it' : '' }, box, h('span', {}, `${n}${missing ? ' ⚠️' : ''}`));
          }),
          names.length ? null : h('small.kb-muted', {}, `No skills for ${toolName(tool)}`),
        ),
      );
    };
    grid.replaceChildren(
      h(
        'table.kb-table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Phase'), ...KANBAN_TOOLS.map((x) => h('th', {}, toolName(x))))),
        h('tbody', {}, ...SKILL_PHASES.map((ph) => h('tr', {}, h('th', {}, PHASE_NAMES[ph]), ...KANBAN_TOOLS.map((x) => cell(ph, x))))),
      ),
    );
  };

  save.addEventListener('click', () => void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: { skills: selection } }), save, 'Saved'));
  const el = h('div.kb-pane', {}, h('fieldset', {}, h('legend', {}, `Skills for ${projectName(projectId)}`), h('p.kb-hint', {}, 'Which skills each phase is told to use, per agent.'), grid, h('div.kb-row.kb-save', {}, h('span.grow'), save)));
  paintGrid();
  follow(api, paintGrid, el);
  return el;
}
