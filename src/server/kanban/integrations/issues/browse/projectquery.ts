// The `query:` of a GitHub project's `items` (pure): the board's own filter syntax, as the filters
// and the group of the browse window say it. Values are quoted; the parser has already refused a
// double quote in them, and this refuses it again. `assignee:@me` is never used, because it would be
// the office's own gh and not the person asking: the browser sends their login.

import type { BrowseFilters } from '../../../../../shared/kanban/browse.js';

function quote(v: string): string {
  if (/["\r\n]/.test(v)) throw new Error('A search value can’t have quotes or line breaks');
  return `"${v}"`;
}

/** What a browse group is on a board: an iteration, a Status option, or the items with neither. Ids: see BrowseGroup. */
export function groupClause(group: string): string {
  if (group === 'no:iteration') return 'no:iteration';
  if (group === 'no:status') return 'no:status';
  if (group.startsWith('i:')) return `iteration:${quote(group.slice(2))}`;
  if (group.startsWith('s:')) return `status:${quote(group.slice(2))}`;
  throw new Error('That isn’t a group of the board');
}

/** The board filter for these filters and group (empty when there is none). */
export function projectQuery(filters: BrowseFilters, group?: string): string {
  const parts: string[] = [];
  const cat = filters.statusCategory ?? 'open';
  if (cat === 'done') parts.push('is:closed');
  else if (cat !== 'all') parts.push('is:open');
  if (filters.status) parts.push(`status:${quote(filters.status)}`);
  if (filters.iteration) parts.push(`iteration:${quote(filters.iteration)}`);
  if (filters.issueType) parts.push(`type:${quote(filters.issueType)}`);
  for (const l of filters.labels ?? []) parts.push(`label:${quote(l)}`);
  const a = filters.assignee;
  if (a) parts.push('id' in a ? `assignee:${a.id}` : 'none' in a ? 'no:assignee' : 'has:assignee');
  if (group) parts.push(groupClause(group));
  const q = filters.q?.trim();
  if (q) parts.push(quote(q));
  return parts.join(' ');
}
