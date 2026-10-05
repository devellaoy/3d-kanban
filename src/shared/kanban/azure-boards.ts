// What an Azure Boards issue source (IssueSourceConfig 'azure-boards') may be: the names and the
// admin's extra WIQL condition, checked alike by the settings form, the saved settings and the
// source itself (server/kanban/integrations/issues/azure-boards.ts). Pure.

/** An Azure DevOps organisation's name. */
export const AZURE_ORG_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/;
/** An Azure DevOps project's name (what shared/hosting/workitems.ts accepts in a key). */
export const AZURE_PROJECT_RE = /^[^/\\#?:*"<>|;+=&%\p{C}]{1,64}$/u;
/** How long the extra WIQL condition may be. */
export const WIQL_EXTRA_MAX = 2000;

/** Why the extra WIQL condition can't be used, or undefined when it can. */
export function wiqlExtraProblem(extra: string): string | undefined {
  if (extra.length > WIQL_EXTRA_MAX) return `The extra WIQL is longer than ${WIQL_EXTRA_MAX} characters`;
  if (extra.includes(';')) return 'The extra WIQL can’t have a ;';
  if (/\border\s+by\b/i.test(extra)) return 'The extra WIQL can’t have ORDER BY: the office sorts by the last change';
  return undefined;
}
