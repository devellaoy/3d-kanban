// The answer to a change of the secrets (the API key, the Jira connections), shared by ws.ts and the issues plugin's
// connection handlers: only whether they're set goes out, never what they are: to the asker, then to everyone.

import type { SecretStatus } from '../../shared/kanban/types.js';
import type { KanbanClient, KanbanContext } from './registry.js';

/** Runs the change; a string result (or a failed save) is the asker's error. Resolves to whether it went through. */
export function answerSecrets(ctx: KanbanContext, c: KanbanClient, rid: string | undefined, run: () => SecretStatus | string): boolean {
  const fail = (message: string) => c.send({ t: 'kanban.error', ...(rid ? { rid } : {}), message });
  let secrets: SecretStatus | string;
  try {
    secrets = run();
  } catch (err) {
    console.error(`agent-office: couldn't save the kanban secrets: ${(err as Error).message}`);
    return fail("The office couldn't save them"), false;
  }
  if (typeof secrets === 'string') return fail(secrets), false;
  const settings = ctx.settings.get();
  c.send({ t: 'kanban.settings', ...(rid ? { rid } : {}), settings, secrets });
  ctx.broadcast({ t: 'kanban.settings', settings, secrets }, null);
  return true;
}
