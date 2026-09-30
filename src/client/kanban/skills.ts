// Settings → Skills: every skill the office found (bundled with it, the user's, an account's, a
// repository's), which config homes it's installed in and which projects use it; a sync that installs
// the office's own again; and, per project, which skills each phase gets for each tool.

import { h } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { KANBAN_TOOLS, SKILL_PHASES, type KanbanSettings, type KanbanTool, type SkillPhase, type SkillSelection } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { skillUsage } from './model';
import { kstore } from './store';
import { t, toolName } from './i18n';
import { run } from './ui';

type SkillsMsg = Extract<KanbanServerMsg, { t: 'kanban.skills' }>;

let cache: SkillsMsg | null = null;

export function skillsPane(api: KanbanApi, projectId: string, s: KanbanSettings): HTMLElement {
  const list = h('div.kb-skill-list', { 'aria-live': 'polite' });
  const grid = h('div.kb-skill-grid');
  const sync = h('button.btn.kb-admin', { type: 'button', title: t('syncHint') }, `🔄 ${t('syncSkills')}`) as HTMLButtonElement;
  const save = h('button.btn.primary.kb-admin', { type: 'button' }, t('save')) as HTMLButtonElement;
  const selection: SkillSelection = structuredClone(s.projects[projectId]?.skills ?? {});
  const projectName = (id: string) => kstore.projectOf(id)?.name ?? id;

  const paintList = () => {
    if (!cache) return list.replaceChildren(h('p.kb-muted', {}, t('loading')));
    if (cache.error) list.replaceChildren(h('p.kb-error', {}, `⚠️ ${cache.error}`));
    else list.replaceChildren();
    if (!cache.skills.length) return list.append(h('p.kb-muted', {}, t('noSkills')));
    list.append(
      h(
        'table.kb-table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, t('skill')), h('th', {}, t('tool')), h('th', {}, t('origin')), h('th', {}, t('installedIn')), h('th', {}, t('usedBy')))),
        h(
          'tbody',
          {},
          ...cache.skills.map((k) =>
            h(
              'tr',
              {},
              h('td', {}, h('b', {}, k.name), h('div.kb-muted', {}, k.description)),
              h('td', {}, toolName(k.tool)),
              h('td', {}, h('span.kb-chip', { title: k.location }, t(`origin.${k.origin}`))),
              h('td', {}, ...(k.installedIn.length ? k.installedIn.map((p) => h('code.kb-path', {}, p)) : [h('span.kb-muted', {}, '—')])),
              h('td', {}, skillUsage(kstore.settings ?? s, k.name, k.tool).map(projectName).join(', ') || '—'),
            ),
          ),
        ),
      ),
    );
  };

  const paintGrid = () => {
    const skills = cache?.skills ?? [];
    const cell = (phase: SkillPhase, tool: KanbanTool) => {
      const names = [...new Set(skills.filter((k) => k.tool === tool).map((k) => k.name))].sort();
      const picked = selection[phase]?.[tool] ?? [];
      // A picked skill the office can't find any more still shows, to be taken off.
      for (const n of picked) if (!names.includes(n)) names.push(n);
      const summary = h('summary', {}, picked.length ? picked.join(', ') : t('none'));
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
              summary.textContent = now.size ? [...now].join(', ') : t('none');
            });
            const missing = !skills.some((k) => k.name === n && k.tool === tool);
            return h('label.kb-check', { class: missing ? 'missing' : '', title: missing ? t('skillMissing') : '' }, box, h('span', {}, `${n}${missing ? ' ⚠️' : ''}`));
          }),
          names.length ? null : h('small.kb-muted', {}, t('noSkillsFor', { tool: toolName(tool) })),
        ),
      );
    };
    grid.replaceChildren(
      h(
        'table.kb-table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, t('phase')), ...KANBAN_TOOLS.map((x) => h('th', {}, toolName(x))))),
        h('tbody', {}, ...SKILL_PHASES.map((ph) => h('tr', {}, h('th', {}, t(`skillPhase.${ph}`)), ...KANBAN_TOOLS.map((x) => cell(ph, x))))),
      ),
    );
  };

  const load = (msg: SkillsMsg) => {
    cache = msg;
    paintList();
    paintGrid();
  };
  sync.addEventListener('click', () => void run(() => api.request<SkillsMsg>({ t: 'kanban.skills.sync' }), sync, 'synced').then((m) => m && m.t === 'kanban.skills' && load(m)));
  save.addEventListener('click', () => void run(() => api.request({ t: 'kanban.project.settings.set', project: projectId, settings: { skills: selection } }), save, 'saved'));
  paintList();
  paintGrid();
  api.request<SkillsMsg>({ t: 'kanban.skills.list' }).then(load, (err: Error) => {
    cache = { t: 'kanban.skills', skills: cache?.skills ?? [], error: err.message };
    paintList();
  });
  return h(
    'div.kb-pane',
    {},
    h('fieldset', {}, h('legend', {}, t('skillsFound')), h('div.kb-row', {}, h('p.kb-hint', {}, t('skillsHint')), h('span.grow'), sync), list),
    h('fieldset', {}, h('legend', {}, t('skillsForProject', { name: projectName(projectId) })), h('p.kb-hint', {}, t('skillsPickHint')), grid, h('div.kb-row.kb-save', {}, h('span.grow'), save)),
  );
}

