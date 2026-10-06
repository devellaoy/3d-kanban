// The forms of the issue sources that aren't GitHub's, in 📁 Projects → Issue sources (settings.ts
// sourcesPane): Jira and Azure Boards. Each gives its fields and a read() that turns them back into
// the source, or says what is missing.

import { h } from '../ui/dom';
import type { IssueSourceConfig } from '../../shared/kanban/types.js';
import { AZURE_ORG_RE, AZURE_PROJECT_RE, wiqlExtraProblem } from '../../shared/kanban/azure-boards.js';
import { cleanJiraSite, sameJiraSite } from '../../shared/kanban/jira-connections.js';
import { connectionLabel } from './jira-connections';
import { kstore } from './store';
import { checkbox, field, select, textArea, textInput } from './ui';

/** A source's form: its fields, and the source they say (or why they don't say one). */
export interface SourceForm {
  fields: HTMLElement;
  read(): IssueSourceConfig | string;
}

/** A comma-separated list, trimmed, without the empty ones. */
export const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export function jiraForm(src: Extract<IssueSourceConfig, { kind: 'jira' }>): SourceForm {
  const conns = kstore.secrets.jira;
  const site = textInput(src.site, { placeholder: 'yourteam.atlassian.net' });
  // A connection that was removed since stays picked, so saving doesn't quietly change what the source reads as.
  const gone = src.connection && !conns.some((c) => c.id === src.connection) ? [[src.connection, '⚠️ A removed connection'] as const] : [];
  const connection = select([['', 'Automatic (by site)'], ...conns.map((c) => [c.id, connectionLabel(c)] as const), ...gone], src.connection ?? '');
  const connectionHint = h('small.kb-hint');
  const keys = textInput(src.projectKeys.join(', '), { placeholder: 'UYT, OPS' });
  const assignee = textInput(src.filters.assignee ?? '', { placeholder: 'currentUser()' });
  const epic = textInput(src.filters.epic ?? '', { placeholder: 'UYT-100' });
  const labels = textInput((src.filters.labels ?? []).join(', '), { placeholder: 'ai' });
  const notStatus = textInput((src.filters.statusCategoryNot ?? []).join(', '), { placeholder: 'Done' });
  const jql = textArea(src.filters.jql ?? '', { rows: 2, placeholder: 'priority = High' });
  const chosen = () => conns.find((c) => c.id === connection.value);
  /** Which connection the source reads as, said under the picker as the site or the pick changes. */
  const paintHint = () => {
    const host = cleanJiraSite(site.value);
    const c = chosen();
    if (connection.value && !c) return void (connectionHint.textContent = 'That connection was removed: pick another, or Automatic.');
    if (c) return void (connectionHint.textContent = host && !sameJiraSite(host, c.site) ? `${c.name} is for ${c.site}, not ${host}` : `Reads as ${c.name}; assignee currentUser() is that account.`);
    if (!host) return void (connectionHint.textContent = 'Type the Jira site, or pick a connection.');
    const mine = conns.filter((x) => sameJiraSite(x.site, host));
    connectionHint.textContent = !mine.length
      ? `No Jira connection for ${host}: add one in ⚙️ Settings → 🗂️ Kanban`
      : mine.length > 1
        ? `Uses ${mine[0].name} (the first for this site); assignee currentUser() is that account`
        : `Uses ${mine[0].name}.`;
  };
  connection.addEventListener('change', () => {
    const c = chosen();
    if (c) site.value = c.site;
    paintHint();
  });
  site.addEventListener('input', paintHint);
  paintHint();
  const connectionField = field('Connection', connection);
  connectionField.append(connectionHint);
  const fields = h(
    'div',
    {},
    h('div.kb-two', {}, connectionField, field('Jira site', site)),
    h('div.kb-three', {}, field('Project keys', keys), field('Assignee', assignee), field('Epic', epic)),
    h('div.kb-three', {}, field('Labels', labels), field('Leave out status categories', notStatus), field('Extra JQL', jql)),
  );
  const read = (): IssueSourceConfig | string => {
    const host = cleanJiraSite(site.value);
    if (!host) return 'A Jira source needs its site, like yourteam.atlassian.net';
    const c = chosen();
    if (connection.value && !c) return 'A Jira source’s connection was removed: pick another, or Automatic';
    if (c && !sameJiraSite(c.site, host)) return `The Jira connection ${c.name} is for ${c.site}, not ${host}`;
    return {
      id: src.id,
      kind: 'jira',
      site: host,
      ...(c ? { connection: c.id } : {}),
      projectKeys: csv(keys.value).map((k) => k.toUpperCase()),
      filters: {
        ...(assignee.value.trim() ? { assignee: assignee.value.trim() } : {}),
        ...(epic.value.trim() ? { epic: epic.value.trim() } : {}),
        ...(csv(labels.value).length ? { labels: csv(labels.value) } : {}),
        ...(csv(notStatus.value).length ? { statusCategoryNot: csv(notStatus.value) } : {}),
        ...(jql.value.trim() ? { jql: jql.value.trim() } : {}),
      },
    };
  };
  return { fields, read };
}

export function azureBoardsForm(src: Extract<IssueSourceConfig, { kind: 'azure-boards' }>): SourceForm {
  const org = textInput(src.org, { placeholder: 'my-org' });
  const project = textInput(src.project, { placeholder: 'My Project' });
  const assignee = textInput(src.filters.assignee ?? '', { placeholder: '@Me' });
  const types = textInput((src.filters.types ?? []).join(', '), { placeholder: 'User Story, Bug' });
  const area = textInput(src.filters.areaPath ?? '', { placeholder: 'My Project\\Team' });
  const closed = checkbox('Also the closed ones (Done, Closed, Removed…)', !!src.filters.closed);
  const wiql = textArea(src.filters.wiql ?? '', { rows: 2, placeholder: "[Microsoft.VSTS.Common.Priority] <= 2" });
  const fields = h(
    'div',
    {},
    h('div.kb-two', {}, field('Organisation (dev.azure.com/…)', org), field('Project', project)),
    h('div.kb-three', {}, field('Assignee', assignee, '@Me: whose token reads'), field('Work item types', types), field('Area path', area)),
    h('div.kb-two', {}, field('Extra WIQL condition', wiql), h('div', {}, closed.el)),
    h('small.kb-hint', {}, 'It reads with the office’s Azure DevOps token, else the newest of yours set in ☰ → 🔐 Your sign-ins (Work Items: read & write).'),
  );
  const read = (): IssueSourceConfig | string => {
    const o = org.value.trim().replace(/^https?:\/\/dev\.azure\.com\//i, '').replace(/\/+$/, '');
    const p = project.value.trim();
    if (!AZURE_ORG_RE.test(o)) return 'An Azure Boards source needs its organisation, as in dev.azure.com/<organisation>';
    if (!AZURE_PROJECT_RE.test(p)) return 'An Azure Boards source needs its project';
    const extra = wiql.value.trim();
    const why = extra ? wiqlExtraProblem(extra) : undefined;
    if (why) return why;
    return {
      id: src.id,
      kind: 'azure-boards',
      org: o,
      project: p,
      filters: {
        ...(assignee.value.trim() ? { assignee: assignee.value.trim() } : {}),
        ...(csv(types.value).length ? { types: csv(types.value) } : {}),
        ...(area.value.trim() ? { areaPath: area.value.trim() } : {}),
        ...(closed.box.checked ? { closed: true } : {}),
        ...(extra ? { wiql: extra } : {}),
      },
    };
  };
  return { fields, read };
}
