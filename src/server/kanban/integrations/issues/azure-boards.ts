// Azure Boards work items (IssueSourceConfig 'azure-boards'), over Azure DevOps' REST API 7.1: a
// WIQL query for the ids, then the work items themselves in batches. It reads with the office's
// Azure DevOps token, else the token of whoever set one of their own most recently (☰ → 🔐 Your
// sign-ins; see server/hosting/credentials.ts). The WIQL is built here from the source's fields,
// every value quoted, so a filter can't change what the query means; the admin's own extra WIQL
// condition is AND-ed in parentheses.

import { abKey, workItemUrl } from '../../../../shared/hosting/workitems.js';
import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import { AZURE_ORG_RE, AZURE_PROJECT_RE, wiqlExtraProblem } from '../../../../shared/kanban/azure-boards.js';
import { hostCredentials } from '../../../hosting/index.js';
import { hostCall } from '../../../hosting/http.js';
import type { HostAs } from '../../../hosting/provider.js';
import { ISSUE_BODY_MAX, SOURCE_MAX, type IssueSource, type IssueSourceIo } from './source.js';

export type AzureBoardsConfig = Extract<IssueSourceConfig, { kind: 'azure-boards' }>;

/** How many work items one read asks for. */
const BATCH = 200;
const API = 'api-version=7.1';
const FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.Tags', 'System.Description', 'System.ChangedDate', 'System.CreatedDate'];
/** The states of Azure Boards' own processes (Agile, Scrum, Basic, CMMI) that are done with: left out unless `closed`. */
export const CLOSED_STATES = ['Done', 'Closed', 'Removed', 'Completed', 'Cut'];

export const NO_AZURE_TOKEN = 'Set an Azure DevOps token in ☰ → 🔐 Your sign-ins (yours or the office’s) to read Azure Boards';

const enc = encodeURIComponent;

/** A WIQL string literal: in single quotes, a quote doubled; line breaks become spaces. */
export function wiqlQuote(value: string): string {
  return `'${value.replace(/[\r\n\t]+/g, ' ').replace(/'/g, "''")}'`;
}

/** Throws unless the organisation and project are names Azure DevOps could have. */
export function checkOrgProject(org: string, project: string) {
  if (!AZURE_ORG_RE.test(org)) throw new Error(`${org || 'An empty name'} isn't an Azure DevOps organisation`);
  if (!AZURE_PROJECT_RE.test(project)) throw new Error(`${project || 'An empty name'} isn't an Azure DevOps project`);
}

/** The source's WIQL query. */
export function buildWiql(c: Pick<AzureBoardsConfig, 'project' | 'filters'>): string {
  const f = c.filters;
  const parts = [`[System.TeamProject] = ${wiqlQuote(c.project)}`];
  const types = (f.types ?? []).map((t) => t.trim()).filter(Boolean);
  if (types.length) parts.push(`[System.WorkItemType] IN (${types.map(wiqlQuote).join(', ')})`);
  const who = f.assignee?.trim();
  if (who) parts.push(/^@?me$/i.test(who) ? '[System.AssignedTo] = @Me' : `[System.AssignedTo] = ${wiqlQuote(who)}`);
  const area = f.areaPath?.trim();
  if (area) parts.push(`[System.AreaPath] UNDER ${wiqlQuote(area)}`);
  if (!f.closed) parts.push(`[System.State] NOT IN (${CLOSED_STATES.map(wiqlQuote).join(', ')})`);
  const extra = f.wiql?.trim();
  if (extra) {
    const why = wiqlExtraProblem(extra);
    if (why) throw new Error(why);
    parts.push(`(${extra})`);
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${parts.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A work item's HTML (its description, a comment) as plain text: block ends as line breaks, list items as "- ", tags gone, entities decoded. */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\s*\/?\s*(p|div|h[1-6]|tr|ul|ol|pre|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (all, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One work item of the read's answer. */
export function azureWorkItem(raw: any, org: string, project: string, sourceId?: string): NormalizedIssue | undefined {
  const id = Number(raw?.id ?? raw?.fields?.['System.Id']);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const f = raw.fields ?? {};
  const assigned = f['System.AssignedTo'];
  const assignee = typeof assigned === 'string' ? assigned : assigned?.displayName;
  const tags = String(f['System.Tags'] ?? '').split(';').map((t) => t.trim()).filter(Boolean);
  return {
    source: 'azure-boards',
    ...(sourceId ? { sourceId } : {}),
    key: abKey(org, project, id),
    title: String(f['System.Title'] ?? `#${id}`),
    url: workItemUrl({ org, project, id }),
    body: htmlToText(f['System.Description']).slice(0, ISSUE_BODY_MAX),
    ...(assignee ? { assignee: String(assignee) } : {}),
    labels: tags,
    ...(f['System.State'] ? { status: String(f['System.State']) } : {}),
    project,
    updatedAt: String(f['System.ChangedDate'] ?? f['System.CreatedDate'] ?? ''),
  };
}

/** The credentials an issue source reads with, or the error to show. */
export function readerAs(): HostAs {
  const as = hostCredentials()?.anyAs('azure');
  if (!as) throw new Error(NO_AZURE_TOKEN);
  return as;
}

/** The work items with these ids, in batches of BATCH, in the order asked (one that can't be read is left out). */
export async function readWorkItems(io: Pick<IssueSourceIo, 'fetch'>, as: HostAs, org: string, project: string, ids: number[], sourceId?: string): Promise<NormalizedIssue[]> {
  const out: NormalizedIssue[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const url = `https://dev.azure.com/${enc(org)}/_apis/wit/workitems?ids=${batch.join(',')}&fields=${FIELDS.join(',')}&errorPolicy=omit&${API}`;
    const body = await hostCall(io.fetch, as, 'GET', url);
    for (const raw of body?.value ?? []) {
      const item = raw ? azureWorkItem(raw, org, project, sourceId) : undefined;
      if (item) out.push(item);
    }
  }
  return out;
}

export const azureBoardsSource: IssueSource = {
  async list(config, io) {
    const c = config as AzureBoardsConfig;
    checkOrgProject(c.org, c.project);
    const wiql = buildWiql(c);
    const as = readerAs();
    const found = await hostCall(io.fetch, as, 'POST', `https://dev.azure.com/${enc(c.org)}/${enc(c.project)}/_apis/wit/wiql?$top=${SOURCE_MAX}&${API}`, { query: wiql });
    const ids = [...new Set<number>((found?.workItems ?? []).map((w: any) => Number(w?.id)).filter((n: number) => Number.isInteger(n) && n > 0))].slice(0, SOURCE_MAX);
    return readWorkItems(io, as, c.org, c.project, ids, c.id);
  },
};
