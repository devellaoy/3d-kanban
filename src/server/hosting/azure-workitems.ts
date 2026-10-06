// Azure Boards' work items: linking one to a pull request, completing it, and reading it, over
// Azure DevOps' REST API 7.1.

import type { RepoRef } from '../../shared/hosting/remote.js';
import { azureRepoApi } from './azure.js';
import { hostCall } from './http.js';
import type { Fetch, HostAs } from './provider.js';

const API = 'api-version=7.1';
const JSON_PATCH = 'application/json-patch+json';

const enc = encodeURIComponent;

function itemApi(org: string, project: string | undefined, id: number, query = ''): string {
  return `https://dev.azure.com/${enc(org)}${project ? `/${enc(project)}` : ''}/_apis/wit/workitems/${id}?${query ? `${query}&` : ''}${API}`;
}

function checkId(id: number) {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`#${id} isn't an Azure Boards work item number`);
}

/** Links a work item to a pull request (its Development section); true when it linked, false when it already was. */
export async function linkWorkItemToPr(repo: RepoRef, prNumber: number, workItemId: number, as: HostAs, fetch: Fetch): Promise<boolean> {
  checkId(workItemId);
  const pr = await hostCall(fetch, as, 'GET', azureRepoApi(repo, `/pullrequests/${prNumber}`));
  const repoId = pr?.repository?.id;
  const projectId = pr?.repository?.project?.id;
  if (!repoId || !projectId) throw new Error(`Azure DevOps didn't say which repository pull request ${prNumber} is in`);
  const url = `vstfs:///Git/PullRequestId/${projectId}%2F${repoId}%2F${prNumber}`;
  const item = await hostCall(fetch, as, 'GET', itemApi(repo.owner, undefined, workItemId, '$expand=relations'));
  if ((item?.relations ?? []).some((r: any) => String(r?.url ?? '').toLowerCase() === url.toLowerCase())) return false;
  await hostCall(fetch, as, 'PATCH', itemApi(repo.owner, undefined, workItemId), [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url, attributes: { name: 'Pull Request' } } }], JSON_PATCH);
  return true;
}

/**
 * Moves a work item to its type's first Completed state ("Done", "Closed", …) and resolves to that
 * state, or to 'already' when it is completed (or removed) already.
 */
export async function completeWorkItem(org: string, project: string, id: number, as: HostAs, fetch: Fetch): Promise<string> {
  checkId(id);
  const item = await hostCall(fetch, as, 'GET', itemApi(org, project, id));
  const type = String(item?.fields?.['System.WorkItemType'] ?? '');
  const now = String(item?.fields?.['System.State'] ?? '');
  if (!type) throw new Error(`Azure DevOps didn't say what kind of work item #${id} is`);
  const states: any[] = (await hostCall(fetch, as, 'GET', `https://dev.azure.com/${enc(org)}/${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/states?${API}`))?.value ?? [];
  const category = states.find((s) => s?.name === now)?.category;
  if (category === 'Completed' || category === 'Removed') return 'already';
  const done = states.find((s) => s?.category === 'Completed')?.name;
  if (!done) throw new Error(`Azure Boards' ${type} has no completed state to move #${id} to`);
  await hostCall(fetch, as, 'PATCH', itemApi(org, project, id), [{ op: 'add', path: '/fields/System.State', value: done }], JSON_PATCH);
  return String(done);
}

export interface AzureWorkItem {
  id: number;
  title: string;
  state: string;
  type: string;
  /** Its page on Azure Boards. */
  url: string;
}

/** A work item's title, state and kind. */
export async function workItemOf(org: string, project: string, id: number, as: HostAs, fetch: Fetch): Promise<AzureWorkItem> {
  checkId(id);
  const item = await hostCall(fetch, as, 'GET', itemApi(org, project, id));
  const f = item?.fields ?? {};
  return {
    id,
    title: String(f['System.Title'] ?? ''),
    state: String(f['System.State'] ?? ''),
    type: String(f['System.WorkItemType'] ?? ''),
    url: `https://dev.azure.com/${enc(org)}/${enc(project)}/_workitems/edit/${id}`,
  };
}
