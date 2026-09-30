// Skills management: the registry (kanban.skills.list), syncing the bundled Codex skills
// (kanban.skills.sync, admins), and a task worker's picked skills (ProjectSettings.skills, a task's
// overrides.skills) by phase and tool: delivered with workerArgs (claude: --plugin-dir; codex:
// copied to its home), and named in the prompts through skillHint ({{skills}}).

import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import type { KanbanTool, RunPhase, SkillInfo, SkillPhase, SkillSelection } from '../../../../shared/kanban/types.js';
import { projectRepos } from '../../projects.js';
import { fail } from '../util.js';
import { pluginDir, syncCodexSkills, type SyncResult } from './delivery.js';
import { defaultRoots, discoverSkills, findSkill, type SkillRoots } from './registry.js';

/** The office's own skill every Claude task worker gets (reading other tasks). */
export const ALWAYS_BUNDLED = ['office-task-refs'];

/** The phase a run's skills are picked for. */
export function skillPhase(phase: string): SkillPhase {
  const p = phase as RunPhase;
  if (p === 'plan' || p === 'review') return p;
  if (p === 'pr' || p === 'pr-fix') return 'pr';
  return 'implement';
}

/** The skills picked for a phase and tool: the task's own pick for the phase, else the project's. */
export function pickedSkills(project: SkillSelection, task: SkillSelection | undefined, phase: SkillPhase, tool: KanbanTool): string[] {
  const own = task?.[phase]?.[tool];
  return [...(own ?? project[phase]?.[tool] ?? [])];
}

/** What's wrong with a selection against the registry: names no skill has, for that tool. */
export function checkSelection(selection: SkillSelection, skills: SkillInfo[]): string[] {
  const out: string[] = [];
  for (const [phase, tools] of Object.entries(selection)) {
    for (const tool of ['claude', 'codex'] as const) {
      for (const name of tools?.[tool] ?? []) if (!skills.some((s) => s.tool === tool && s.name === name)) out.push(`${name} (${tool}, ${phase}) isn't installed anywhere the office looks`);
    }
  }
  return out;
}

export interface SkillsOptions {
  roots?: (ctx: KanbanContext) => SkillRoots;
}

export function createSkills(ctx: KanbanContext, opts: SkillsOptions = {}) {
  const repoDirs = (project?: string) =>
    (project ? [project] : ctx.projects().map((d) => d.id)).flatMap((id) => {
      const def = ctx.project(id);
      return def ? projectRepos(def).map((r) => r.dir) : [];
    });
  const roots = (project?: string) => (opts.roots ? opts.roots(ctx) : defaultRoots(ctx.dataDir, repoDirs(project)));
  let cached: { at: number; skills: SkillInfo[] } | undefined;
  /** The registry; asked again after a few seconds, since skills are folders anyone can change. */
  const registry = (): SkillInfo[] => {
    if (!cached || Date.now() - cached.at > 5000) cached = { at: Date.now(), skills: discoverSkills(roots()) };
    return cached.skills;
  };
  const warned = new Set<string>();

  /** The names picked for a task's phase and tool, and the skills they are (for the tool; missing ones warned about once). */
  const forTask = (taskId: number, tool: KanbanTool, phase: string) => {
    const t = ctx.repo.getTask(taskId);
    if (!t) return undefined;
    const names = pickedSkills(ctx.settings.project(t.project).skills, t.overrides.skills, skillPhase(phase), tool);
    const skills = registry();
    const dirs = repoDirs(t.project);
    const found: SkillInfo[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const s = findSkill(skills, tool, n, dirs);
      if (s) found.push(s);
      else missing.push(n);
    }
    for (const n of missing) {
      const key = `${t.project}:${tool}:${n}`;
      if (warned.has(key)) continue;
      warned.add(key);
      ctx.toast(t.project, `The skill ${n} picked for ${tool} (${skillPhase(phase)}) isn't installed for the office's agents`, 'warn');
    }
    return { task: t, names, found, missing };
  };

  /** A line for the prompt's {{skills}}: the skills to use in this phase; '' when none are picked. */
  const skillHint = (taskId: number, tool: KanbanTool, phase: string): string => {
    const got = forTask(taskId, tool, phase);
    if (!got || !got.found.length) return '';
    const names = got.found.map((s) => s.name).join(', ');
    return tool === 'claude' ? `Use these skills in this phase (the Skill tool): ${names}.` : `Use these skills in this phase: ${names}.`;
  };

  const workerArgs = (taskId: number, tool: KanbanTool, phase: string): string[] => {
    const got = forTask(taskId, tool, phase);
    if (!got) return [];
    const skills = registry();
    if (tool === 'claude') {
      // Bundled and repository skills go in the plugin; the user's own already load from their home.
      const deliver = [...ALWAYS_BUNDLED.map((n) => skills.find((s) => s.tool === 'claude' && s.origin === 'bundled' && s.name === n)), ...got.found.filter((s) => s.origin === 'bundled' || s.origin === 'repo')].filter(
        (s): s is SkillInfo => !!s,
      );
      if (!deliver.length) return [];
      return ['--plugin-dir', pluginDir(ctx.filesDir, deliver)];
    }
    const bundled = [...ALWAYS_BUNDLED.map((n) => skills.find((s) => s.tool === 'codex' && s.origin === 'bundled' && s.name === n)), ...got.found.filter((s) => s.origin === 'bundled')].filter((s): s is SkillInfo => !!s);
    for (const r of syncCodexSkills(roots(got.task.project).codexHome, bundled)) {
      if (r.status === 'update-available' || r.status === 'failed') ctx.toast(got.task.project, `Codex skill ${r.name}: ${r.status === 'failed' ? `couldn't be installed (${r.detail})` : 'a newer version is available, but the installed copy was changed by hand, so it was left as it is'}`, 'warn');
    }
    return [];
  };

  const sync = (): SyncResult[] => {
    const skills = registry().filter((s) => s.tool === 'codex' && s.origin === 'bundled');
    const out = syncCodexSkills(roots().codexHome, skills);
    cached = undefined;
    return out;
  };

  const plugin: KanbanPlugin = {
    name: 'skills',
    ws: {
      'kanban.skills.list': (c, m) => {
        const skills = registry();
        c.send({ t: 'kanban.skills', ...(m.rid ? { rid: m.rid } : {}), skills });
      },
      'kanban.skills.sync': (c, m) => {
        if (!c.admin) return fail(c, m.rid, 'Only an admin can install skills');
        const results = sync();
        const bad = results.filter((r) => r.status === 'failed' || r.status === 'update-available' || r.status === 'user-owned');
        c.send({ t: 'kanban.skills', ...(m.rid ? { rid: m.rid } : {}), skills: registry(), ...(bad.length ? { error: bad.map((r) => `${r.name}: ${r.detail ?? r.status}`).join(' · ') } : {}) });
      },
    },
    workerArgs,
  };
  return { plugin, registry, skillHint, workerArgs, sync, forTask };
}

/** One skills part per context, so its registry cache and its warned-once memory last across calls. */
const perContext = new WeakMap<KanbanContext, ReturnType<typeof createSkills>>();

/** skillHint for code that has the context but not the plugin (the engine). */
export function skillHint(ctx: KanbanContext, taskId: number, tool: KanbanTool, phase: string): string {
  let skills = perContext.get(ctx);
  if (!skills) perContext.set(ctx, (skills = createSkills(ctx)));
  return skills.skillHint(taskId, tool, phase);
}

