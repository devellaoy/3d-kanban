// Which Jira connection a call uses. A source names one (`connection`) or takes the first one for its
// site; either way the e-mail and token only ever go to the site the connection was given for.

import { sameJiraSite, type JiraAt } from '../../../../shared/kanban/jira-connections.js';
import type { JiraConnection } from '../../secrets.js';

/** The connection for a call; throws an Error a person can act on when there is none that fits. */
export function pickJiraConnection(list: readonly JiraConnection[], at: JiraAt): JiraConnection {
  if (at.connection !== undefined) {
    const conn = list.find((c) => c.id === at.connection);
    if (!conn) throw new Error('The Jira connection this source uses was removed: pick another in 📁 Projects → Issue sources');
    if (!sameJiraSite(conn.site, at.site)) throw new Error(`The Jira connection ${conn.name} is for ${conn.site}, not ${at.site}`);
    return conn;
  }
  const conn = list.find((c) => sameJiraSite(c.site, at.site));
  if (!conn) throw new Error(`No Jira connection for ${at.site}: an admin adds one in ⚙️ Settings → 🗂️ Kanban`);
  return conn;
}

/** The Authorization header value for a connection. */
export const jiraAuthHeader = (conn: JiraConnection): string => `Basic ${Buffer.from(`${conn.email}:${conn.token}`).toString('base64')}`;
