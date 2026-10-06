// Azure Boards work items as tickets: the key a task keeps (`ab:org/project#123`), and the `AB#123`
// mentions Azure DevOps links a pull request to its work items by. Pure, shared by the server and the pages.

const ORG = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/;
const PROJECT = /^[^/\\#?:*"<>|;+=&%\p{C}]{1,64}$/u;
const AB_KEY = /^ab:([^/#]{1,50})\/([^#]{1,64})#(\d{1,9})$/i;

export interface WorkItemRef {
  org: string;
  project: string;
  id: number;
}

/** The ticket key of an Azure Boards work item. */
export function abKey(org: string, project: string, id: number): string {
  return `ab:${org}/${project}#${id}`;
}

/** An Azure Boards ticket key taken apart; undefined for anything else. */
export function parseAbKey(key: string | undefined): WorkItemRef | undefined {
  const m = AB_KEY.exec(key?.trim() ?? '');
  if (!m || !ORG.test(m[1]) || !PROJECT.test(m[2])) return undefined;
  const id = Number(m[3]);
  return id > 0 ? { org: m[1], project: m[2], id } : undefined;
}

/** A work item's page. */
export function workItemUrl(w: WorkItemRef): string {
  return `https://dev.azure.com/${w.org}/${encodeURIComponent(w.project)}/_workitems/edit/${w.id}`;
}

/** The work items a text mentions as `AB#123` (how Azure DevOps links them from a title or description), each once. */
export function workItemMentions(text: string | undefined): number[] {
  const ids = new Set<number>();
  for (const m of (text ?? '').matchAll(/(?<![\w#])AB#(\d{1,9})\b/g)) {
    const id = Number(m[1]);
    if (id > 0) ids.add(id);
  }
  return [...ids].slice(0, 20);
}
