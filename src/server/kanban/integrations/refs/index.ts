// Other tasks, for the agents: the hook server's /office/tasks/reference and /office/tasks/search
// (a worker's own token, as /office/workers; what `office-tasks` and the MCP tools get_task and
// search_tasks call), ai-kanban's loopback compatibility routes (compat/v1.ts), and, for the
// read-only plan phase that can't call anything, the referenced tasks written into a file.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KanbanContext, KanbanPlugin, KanbanRefsApi } from '../../registry.js';
import type { KanbanTask } from '../../../../shared/kanban/types.js';
import { ScrollbackStore } from '../../../history.js';
import { MCP_NAME, MCP_TASK_TOOLS } from '../../../office-workers.js';
import { handleLegacyReference, handleV1 } from '../compat/v1.js';
import { sendJson } from '../util.js';
import { REF_LIMITS, candidate, referencedTasks, referencedTasksMarkdown, resolveTaskRef, searchTasks, taskBundle } from './resolve.js';

/** Where the plan phase's referenced tasks go: `<filesDir>/refs/task-<id>/referenced-tasks.md`. */
export function referencedTasksPath(filesDir: string, taskId: number): string {
  return path.join(filesDir, 'refs', `task-${taskId}`, 'referenced-tasks.md');
}

export function createRefs(ctx: KanbanContext): KanbanRefsApi {
  return {
    referencedTasksFile(taskId, text) {
      const file = referencedTasksPath(ctx.filesDir, taskId);
      const found = referencedTasks(text, ctx.repo.listTasks(null, { includeArchived: true }), taskId, 3);
      if (!found.length) {
        // An older file would say the task refers to what it no longer does.
        rmSync(file, { force: true });
        return undefined;
      }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, referencedTasksMarkdown(found.map((t) => taskBundle(ctx, t))), { mode: 0o600 });
      return file;
    },
  };
}

// --- A terminal's tail ----------------------------------------------------------------------------

/** Escape codes out: what's left of a terminal's output is its text. */
export function plainTerminal(ansi: string): string {
  return ansi
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78DEHMc]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** The last lines of a task worker's terminal, as the office last saved it (.agent-office/scrollback). */
export function terminalTail(ctx: KanbanContext, t: KanbanTask): string | undefined {
  if (!t.workerId) return undefined;
  const floor = ctx.floor(t.project);
  if (!floor) return undefined;
  const saved = new ScrollbackStore(path.join(floor.dir, '.agent-office')).load(t.workerId);
  if (!saved) return undefined;
  const lines = plainTerminal(saved).split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const tail = lines.slice(-REF_LIMITS.tailLines).join('\n');
  return tail.length > REF_LIMITS.tail ? tail.slice(-REF_LIMITS.tail) : tail;
}

// --- The plugin -----------------------------------------------------------------------------------

export function createRefsPlugin(ctx: KanbanContext): KanbanPlugin {
  const allTasks = () => ctx.repo.listTasks(null, { includeArchived: true });

  return {
    name: 'refs',
    hook: {
      '/office/tasks': (req, res, url) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' }), true;
        if (url.pathname === '/office/tasks/reference') {
          const ref = (url.searchParams.get('ref') ?? '').trim().slice(0, 300);
          if (!ref) return sendJson(res, 400, { error: 'ref is required: an id (14, #14), a ticket id or part of a title' }), true;
          const matches = resolveTaskRef(ref, allTasks());
          if (matches.length !== 1) return sendJson(res, 200, { ok: true, ref, match: null, candidates: matches.map(candidate) }), true;
          const t = matches[0];
          const tail = url.searchParams.get('tail') === '1' ? terminalTail(ctx, t) : undefined;
          return sendJson(res, 200, { ok: true, ref, match: { ...taskBundle(ctx, t), ...(tail !== undefined ? { terminalTail: tail } : {}) }, candidates: [] }), true;
        }
        if (url.pathname === '/office/tasks/search') {
          const q = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
          if (!q) return sendJson(res, 400, { error: 'q is required' }), true;
          return sendJson(res, 200, { ok: true, q, tasks: searchTasks(allTasks(), q).map(candidate) }), true;
        }
        return false;
      },
    },
    loopback: {
      '/api/tasks/reference': (req, res, url) => handleLegacyReference(ctx, req, res, url),
      '/api/v1': (req, res, url) => handleV1(ctx, req, res, url),
    },
    workerArgs(_taskId, tool) {
      // The MCP tools that read tasks only look, as list_workers: nobody should be asked about them.
      if (tool === 'claude') return ['--allowedTools', MCP_TASK_TOOLS.join(',')];
      // Codex hands its MCP servers only the variables it's told to: this one says tasks are there.
      return ['-c', `mcp_servers.${MCP_NAME}.env.AIKANBAN_API_BASE=${JSON.stringify(ctx.hookUrl)}`];
    },
  };
}
