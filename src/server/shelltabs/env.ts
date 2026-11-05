// The environment of a shell tab: what manager.launch() gives a worker's terminal, minus what lets
// something pose as the worker (no AGENT_OFFICE_WORKER_ID or hook token) and minus any agent setup.
import path from 'node:path';
import { workerHostEnv } from '../hosting/index.js';
import { kanbanWorkerEnv } from '../kanban/workers.js';
import { childEnv } from '../workers/env.js';
import type { WorkerManager } from '../workers/manager.js';
import type { RunAs } from '../workers/types.js';

export type ShellSpec = NonNullable<ReturnType<WorkerManager['shellSpec']>>;

/** `account` is whoever opens the tab: the shell runs as them (their sign-ins), not as the worker's owner. */
export function shellEnv(spec: ShellSpec, account: string | undefined, runAs?: Pick<RunAs, 'apply'>): Record<string, string> {
  const { info, cwd } = spec;
  const env: Record<string, string> = { ...childEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  Object.assign(env, kanbanWorkerEnv(), workerHostEnv(env, account), info.kanban && { AIKANBAN_API_BASE: spec.hookUrl, AIKANBAN_TASK_ID: String(info.kanban.taskId) });
  if (spec.officeBin) {
    // Windows spells it Path.
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [spec.officeBin, env[key]].filter(Boolean).join(path.delimiter);
  }
  // A workspace isn't a repository: git run in it must not find the checkout beside it.
  if (info.repos?.length) env.GIT_CEILING_DIRECTORIES = [path.dirname(cwd), env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
  // The opener's own GitHub, git and cloud sign-ins, as for a shell worker they hire (no Claude sign-in needed here).
  if (account && runAs) runAs.apply(account, env, [spec.dir, cwd]);
  return env;
}
