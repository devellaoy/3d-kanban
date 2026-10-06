// The WS handlers for the Jira connections (admins only): add or change one, remove one, ask Jira who one
// signs in as. Only whether they're set goes back out (id, name, site), never the e-mail or the token.

import type { KanbanClient, KanbanContext, KanbanPlugin } from '../../registry.js';
import type { SecretStatus } from '../../../../shared/kanban/types.js';
import { fail } from '../util.js';
import { jiraCall } from './jira-ops.js';
import { wallSourcesChanged } from './wall.js';

type Handlers = NonNullable<KanbanPlugin['ws']>;

export function jiraConnectionHandlers(ctx: KanbanContext, doFetch: typeof fetch, onChange: () => void): Handlers {
  const adminOnly = (c: KanbanClient, rid: string | undefined): boolean => {
    if (c.admin) return true;
    fail(c, rid, 'Only an admin can change that');
    return false;
  };

  /** A connection was added, changed or removed: the answer to the asker, the new status to everyone, and the projects with a Jira source fetch again. */
  const changed = (c: KanbanClient, rid: string | undefined, secrets: SecretStatus) => {
    const settings = ctx.settings.get();
    c.send({ t: 'kanban.settings', ...(rid ? { rid } : {}), settings, secrets });
    ctx.broadcast({ t: 'kanban.settings', settings, secrets }, null);
    onChange();
    for (const def of ctx.projects()) if (ctx.settings.project(def.id).issueSources.some((s) => s.kind === 'jira')) wallSourcesChanged(def.id);
  };

  const save = (c: KanbanClient, rid: string | undefined, run: () => SecretStatus | string) => {
    if (!adminOnly(c, rid)) return;
    let result: SecretStatus | string;
    try {
      result = run();
    } catch (err) {
      console.error(`agent-office: couldn't save the kanban secrets: ${(err as Error).message}`);
      return fail(c, rid, "The office couldn't save them");
    }
    if (typeof result === 'string') return fail(c, rid, result);
    changed(c, rid, result);
  };

  return {
    'kanban.secrets.jira.set': (c, m) => save(c, m.rid, () => ctx.secrets.setJiraConnection({ id: m.id, name: m.name, site: m.site, email: m.email, token: m.token })),
    'kanban.secrets.jira.remove': (c, m) => save(c, m.rid, () => ctx.secrets.removeJiraConnection(m.id)),
    'kanban.secrets.jira.test': async (c, m) => {
      if (!adminOnly(c, m.rid)) return;
      const conn = ctx.secrets.jiraConnections().find((x) => x.id === m.id);
      if (!conn) return fail(c, m.rid, 'No such Jira connection');
      try {
        const me = await jiraCall({ gh: async () => '', fetch: doFetch, cwd: ctx.dataDir, jira: [conn], projectRepos: [], who: c.name, shared: false }, { site: conn.site, connection: conn.id }, 'GET', '/rest/api/3/myself');
        c.send({ t: 'kanban.secrets.jiraTested', ...(m.rid ? { rid: m.rid } : {}), id: conn.id, name: String(me?.displayName ?? conn.email), ...(me?.accountId ? { accountId: String(me.accountId) } : {}) });
      } catch (err) {
        fail(c, m.rid, (err as Error).message);
      }
    },
  };
}
