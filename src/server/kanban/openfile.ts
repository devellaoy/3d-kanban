// Opens a file named in a task's conversation (kanban.task.openFile) in VS Code on the office's machine.
// The browser sends the path as the agent wrote it; the office opens it only when it is a file inside
// one of the task's folders (taskFolders: its worktrees, else its repositories' checkouts), after
// following links on both sides, so a path can't reach anything else on the machine.

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { KanbanPlugin, KanbanContext } from './registry.js';
import { openInVsCode, taskFolders, type VsCodeDeps, type VsFolder } from './vscode.js';

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

const inside = (file: string, dir: string) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Paths as agents write them: `a/`/`b/` diff prefixes and `./` dropped, `~` left alone (it is never a
 * task's). Off Windows a \ in it is a folder separator written the Windows way (src\app.ts).
 */
function candidates(written: string): string[] {
  const p = (process.platform === 'win32' ? written : written.replace(/\\/g, '/')).replace(/^\.[\\/]/, '');
  const out = [p];
  if (/^[ab][\\/]/.test(p)) out.push(p.slice(2));
  return out;
}

/**
 * The real path of `written` if it is a file inside one of `folders`, else why not. A relative path is
 * tried against each folder, primary first; an absolute one must already be inside one.
 */
export function resolveTaskFile(folders: VsFolder[], written: string): { file: string } | { error: string } {
  const roots = folders.map((f) => real(f.dir)).filter((d): d is string => !!d);
  if (!roots.length) return { error: 'The task has no folder on this machine any more' };
  for (const c of candidates(written)) {
    const tries = path.isAbsolute(c) ? [c] : roots.map((r) => path.join(r, c));
    for (const t of tries) {
      const file = real(t);
      if (!file || !roots.some((r) => inside(file, r))) continue;
      try {
        if (statSync(file).isFile()) return { file };
      } catch {
        // gone between the two looks
      }
    }
  }
  return { error: path.isAbsolute(written) ? `${written} isn't a file in the task's folders (its worktree may have been removed)` : `There's no ${written} in the task's folders` };
}

/** The plugin that answers kanban.task.openFile (admins only, as 🧩 VSCode). */
export function createOpenFilePlugin(ctx: KanbanContext, deps?: VsCodeDeps): KanbanPlugin {
  return {
    name: 'openfile',
    ws: {
      'kanban.task.openFile': async (c, m) => {
        const fail = (message: string) => c.send({ t: 'kanban.error', ...(m.rid ? { rid: m.rid } : {}), message });
        if (!c.admin) return fail('Only an admin can open files on the office’s computer');
        const task = ctx.repo.getTask(m.id);
        if (!task) return fail(`There's no task #${m.id}`);
        try {
          const found = resolveTaskFile(await taskFolders(ctx, task), m.path);
          if ('error' in found) return fail(found.error);
          console.log(`agent-office: opening ${found.file} of task #${task.id} in VS Code`);
          await openInVsCode(found.file, deps, m.line);
          c.send({ t: 'kanban.ok', ...(m.rid ? { rid: m.rid } : {}) });
        } catch (err) {
          fail((err as Error).message);
        }
      },
    },
  };
}
