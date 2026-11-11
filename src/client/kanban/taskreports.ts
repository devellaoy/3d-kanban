// An investigation's report files on the Overview: listed, shown in place or downloaded (taskview.ts).

import { h, timeAgo, toast } from '../ui/dom';
import type { KanbanReportFile } from '../../shared/kanban/types.js';
import { getJson } from './api';
import { formatSize } from './attach';
import { fmtTime } from './labels';
import { renderMarkdown } from './md';
import type { TaskCtx } from './taskctx';
import { apiUrl } from '../multiplayer/visit';

export class Reports {
  private reports: { list: KanbanReportFile[]; shown: Map<string, HTMLElement> } | null = null;
  private key = '';

  constructor(private c: TaskCtx) {}

  /** Fetches the list again when the task moved on (a new report may be there). */
  follow(key: string) {
    if (this.key === key) return;
    this.key = key;
    void this.load();
  }

  private async load() {
    try {
      const r = await getJson<{ reports: KanbanReportFile[] }>(apiUrl(`/api/kanban/tasks/${this.c.taskId}/reports`));
      if (!this.c.alive()) return;
      this.reports = { list: r.reports, shown: this.reports?.shown ?? new Map<string, HTMLElement>() };
    } catch {
      // Nothing to list (or an office without the plugin): the section stays away.
      if (this.c.alive()) this.reports = null;
    }
    this.c.paint('overview');
  }

  /** An investigation's report files: shown in place (Markdown as the page renders it), or downloaded. */
  section(): HTMLElement | null {
    const r = this.reports;
    if (!r?.list.length) return null;
    const url = (name: string) => apiUrl(`/api/kanban/tasks/${this.c.taskId}/reports/${encodeURIComponent(name)}`);
    const items = r.list.map((f) => {
      const shownEl = r.shown.get(f.name);
      const toggle = h('button.btn.small', { type: 'button', 'aria-expanded': String(!!shownEl) }, shownEl ? 'Hide' : 'Show') as HTMLButtonElement;
      toggle.addEventListener('click', async () => {
        if (r.shown.has(f.name)) {
          r.shown.delete(f.name);
          return this.c.paint();
        }
        toggle.disabled = true;
        try {
          const res = await fetch(url(f.name), { cache: 'no-store', credentials: 'same-origin' });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
          const text = await res.text();
          r.shown.set(f.name, /\.(md|markdown)$/i.test(f.name) ? renderMarkdown(text, (id) => this.c.openTask(id), '') : h('pre', {}, text));
        } catch (err) {
          toast((err as Error).message, 'error');
        }
        this.c.paint();
      });
      return h(
        'li.kb-report',
        {},
        h('div.kb-row', {}, h('b', {}, `📄 ${f.name}`), h('small.kb-muted', { title: fmtTime(f.mtime) }, `${formatSize(f.size)} · ${timeAgo(f.mtime)}`), toggle, h('a.btn.small', { href: `${url(f.name)}?download=1`, download: f.name.split('/').pop() ?? f.name }, '⬇️ Download')),
        shownEl ?? null,
      );
    });
    return h('section', {}, h('h4', {}, '📑 Reports'), h('ul.kb-reports', {}, ...items));
  }
}
