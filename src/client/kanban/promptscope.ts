// The prompt editor's project scope for the kanban's prompts (upstream ui/prompts.ts): a kanban prompt
// can be worded for one project (kanban.project.prompt.set) over the office's text, and its fixed
// contract block — what the engine appends and reads back — is shown under it, read-only.

import { h } from '../ui/dom';
import type { Net } from '../net';
import { store } from '../state';
import type { PromptId } from '../../shared/prompts';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanSettings } from '../../shared/kanban/types.js';
import { KANBAN_CONTRACTS, PROMPT_CONTRACT, isKanbanPromptId, kanbanPromptSource } from '../../shared/kanban/prompts.js';
import { kanbanApi } from './api';
import { officeCss } from './officecss';
import { run } from './ui';

export interface PromptScope {
  /** The bar (scope picker, what applies now, a reset) and the contract block, for under the prompt's description. */
  el: HTMLElement;
  /** The saved text of `id` in the picked project, or undefined when the office's applies (the editor's own). */
  saved(id: PromptId): string | undefined;
  /** Redraws for `id`; `busy`: unsaved drafts, so the scope can't change under them. */
  paint(id: PromptId, busy: boolean): void;
  /** Saves `text` for the picked project; false when the office scope is picked (the editor saves as ever). */
  save(id: PromptId, text: string): boolean;
  close(): void;
}

export function promptScope(net: Net, changed: () => void): PromptScope {
  officeCss();
  const api = kanbanApi(net);
  let settings: KanbanSettings | null = null;
  let project = '';
  let current: PromptId | null = null;
  const sel = h('select', { 'aria-label': 'Where this wording applies' }) as HTMLSelectElement;
  const state = h('span');
  const reset = h('button.btn.small', { type: 'button', title: 'Drop this project’s text and use the office’s again' }, '↺ Back to the office’s') as HTMLButtonElement;
  const contract = h('details.kb-scope-contract');
  const bar = h('div.kb-scope-bar', {}, h('span', {}, '🗂️ For'), sel, state, reset);
  const el = h('div.kb-scope', {}, bar, contract);

  const projectText = (id: PromptId) => (project && isKanbanPromptId(id) ? settings?.projects[project]?.prompts[id] : undefined);

  const paintOptions = () => {
    const floors = store.floors.filter((f) => !f.cloning);
    sel.replaceChildren(h('option', { value: '' }, '🏢 The whole office'), ...floors.map((f) => h('option', { value: f.id }, f.name)));
    if (!floors.some((f) => f.id === project)) project = '';
    sel.value = project;
  };

  const scope: PromptScope = {
    el,
    saved: (id) => projectText(id),
    paint(id, busy) {
      current = id;
      const kanban = isKanbanPromptId(id);
      el.classList.toggle('hidden', !kanban);
      if (!kanban) return;
      if (sel.options.length !== store.floors.filter((f) => !f.cloning).length + 1) paintOptions();
      sel.disabled = busy || !settings;
      sel.title = busy ? 'Save or undo your changes first' : '';
      const src = kanbanPromptSource(id, { office: store.prompts.custom as Partial<Record<string, { text: string }>>, project: project ? (settings?.projects[project]?.prompts ?? {}) : {} });
      state.textContent = project ? (src.scope === 'project' ? 'This project’s own text' : 'This project uses the office’s text: saving gives it its own') : 'Every project without its own text uses this';
      reset.classList.toggle('hidden', !project || src.scope !== 'project' || !store.me.admin);
      const c = PROMPT_CONTRACT[id];
      contract.classList.toggle('hidden', !c);
      contract.replaceChildren(...(c ? [h('summary', {}, '🔒 Added by the office after it (can’t be changed)'), h('pre', { 'aria-readonly': 'true' }, KANBAN_CONTRACTS[c])] : []));
    },
    save(id, text) {
      if (!project || !isKanbanPromptId(id)) return false;
      const office = kanbanPromptSource(id, { office: store.prompts.custom as Partial<Record<string, { text: string }>> }).text.trim();
      // The office's own words saved for a project would only hide later office-wide changes.
      void run(() => api.request({ t: 'kanban.project.prompt.set', project, id, text: text.trim() === office ? null : text }), undefined, 'Saved');
      return true;
    },
    close: () => off(),
  };

  sel.addEventListener('change', () => {
    project = sel.value;
    changed();
  });
  reset.addEventListener('click', () => {
    if (!project || !current) return;
    void run(() => api.request({ t: 'kanban.project.prompt.set', project, id: current!, text: null }), reset, 'Saved');
  });
  const off = api.on((msg: KanbanServerMsg) => {
    if (msg.t !== 'kanban.settings' && msg.t !== 'kanban.snapshot') return;
    settings = msg.settings;
    changed();
  });
  paintOptions();
  // The office tells a page the kanban's settings only when it asks.
  api.request({ t: 'kanban.settings.get' }).catch(() => {
    // no kanban on this office: the scope stays the office's
  });
  return scope;
}
