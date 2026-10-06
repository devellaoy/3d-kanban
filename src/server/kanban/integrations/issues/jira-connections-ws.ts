// The WS handlers for the Jira connections (admins only): add or change one, remove one, ask Jira who one
// signs in as. Only whether they're set goes back out (id, name, site), never the e-mail or the token.

import type { KanbanClient, KanbanContext, KanbanPlugin } from '../../registry.js';
import { sameJiraSite } from '../../../../shared/kanban/jira-connections.js';
import { answerSecrets } from '../../secrets-answer.js';
import { fail } from '../util.js';
import { jiraCall } from './jira-ops.js';
import { wallSourcesChanged } from './wall.js';

type Handlers = NonNullable<KanbanPlugin['ws']>;

/** `onChange(sites)`: connections of these sites changed, so what was read through them is no longer good. */
export function jiraConnectionHandlers(ctx: KanbanContext, doFetch: typeof fetch, onChange: (sites: string[]) => void): Handlers {
  const adminOnly = (c: KanbanClient, rid: string | undefined): boolean => {
    if (c.admin) return true;
    fail(c, rid, 'Only an admin can change that');
    return false;
  };

  /** Saves a change to the connections; then the projects with a Jira source on an affected site fetch their issues again. */
  const save = (c: KanbanClient, rid: string | undefined, sites: string[], run: () => ReturnType<KanbanContext['secrets']['removeJiraConnection']>) => {
    if (!adminOnly(c, rid) || !answerSecrets(ctx, c, rid, run)) return;
    onChange(sites);
    for (const def of ctx.projects()) if (ctx.settings.project(def.id).issueSources.some((s) => s.kind === 'jira' && sites.some((site) => sameJiraSite(site, s.site)))) wallSourcesChanged(def.id);
  };
  const siteOf = (id: string | undefined) => ctx.secrets.jiraConnections().find((x) => x.id === id)?.site;

  return {
    // An edit may move a connection: both its old and its new site are affected.
    'kanban.secrets.jira.set': (c, m) => save(c, m.rid, [siteOf(m.id), m.site].filter((x): x is string => !!x), () => ctx.secrets.setJiraConnection({ id: m.id, name: m.name, site: m.site, email: m.email, token: m.token })),
    'kanban.secrets.jira.remove': (c, m) => save(c, m.rid, [siteOf(m.id)].filter((x): x is string => !!x), () => ctx.secrets.removeJiraConnection(m.id)),
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
