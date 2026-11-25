// The model box and the effort select an agent's choice is made of (a task's, a reviewer's).
import { h } from '../ui/dom';
import { CLAUDE_MODELS } from '../../shared/protocol';
import { ANTIGRAVITY_MODELS } from '../../shared/providers';
import { KANBAN_EFFORTS, type KanbanEffort, type KanbanTool } from '../../shared/kanban/types.js';
import { KANBAN_LIMITS } from '../../shared/kanban/protocol.js';
import { effortName } from './labels';
import { select, textInput } from './ui';

let listSeq = 0;
/** A model box with the usual names to pick from (any id can be typed). */
export function modelInput(value: string, tool: () => KanbanTool): { el: HTMLElement; input: HTMLInputElement; refresh(): void } {
  const id = `kb-models-${++listSeq}`;
  const list = h('datalist', { id });
  const input = textInput(value, { list: id, maxlength: KANBAN_LIMITS.model, placeholder: 'Default', 'aria-label': 'Model' });
  const suggestions = (t: KanbanTool): readonly string[] => (t === 'claude' ? CLAUDE_MODELS : t === 'antigravity' ? ANTIGRAVITY_MODELS : []);
  const refresh = () => list.replaceChildren(...suggestions(tool()).map((m) => h('option', { value: m })));
  refresh();
  return { el: h('span.kb-model', {}, input, list), input, refresh };
}

export function effortSelect(value: KanbanEffort | undefined, defaultLabel: string): HTMLSelectElement {
  return select<KanbanEffort | ''>([['', defaultLabel], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], value ?? '', { 'aria-label': 'Effort' });
}
