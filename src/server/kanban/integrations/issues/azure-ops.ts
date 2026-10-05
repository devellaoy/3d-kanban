// Actions on one Azure Boards work item, as the person who asks (their own Azure DevOps token, else
// the office's, in which case a comment is signed with who wrote it): its states (the work item
// type's own, whatever its process calls them), its comments, and its assignee (from the project's
// default team). Every function throws an Error with a text a person can act on.

import type { WorkItemRef } from '../../../../shared/hosting/workitems.js';
import type { IssueAssignTo, IssueCommentItem, IssuePerson, IssueTransition } from '../../../../shared/kanban/issueops.js';
import { hostCredentials } from '../../../hosting/index.js';
import { hostCall } from '../../../hosting/http.js';
import type { HostAs } from '../../../hosting/provider.js';
import { checkOrgProject, htmlToText, NO_AZURE_TOKEN } from './azure-boards.js';
import { attribution, type IssueSourceIo } from './source.js';

const API = 'api-version=7.1';
const COMMENTS_API = 'api-version=7.1-preview.4';
const JSON_PATCH = 'application/json-patch+json';
/** How many comments one read brings (the newest). */
const COMMENTS = 50;
const PEOPLE = 20;
/** A transition id: `abs:` and the state's name in hex (TRANSITION_ID_RE takes no spaces). */
const STATE_ID = /^abs:((?:[0-9a-f]{2}){1,200})$/;

const enc = encodeURIComponent;
type Io = Pick<IssueSourceIo, 'fetch'>;

/**
 * The credentials the person acts with: their own, else the office's. A read with neither falls back
 * to whoever's the issue source reads with; a write says why it can't.
 */
export function azureActAs(accountId: string | undefined, write: boolean): HostAs {
  const creds = hostCredentials();
  if (!creds) throw new Error(NO_AZURE_TOKEN);
  const as = creds.as(accountId, 'azure');
  if (typeof as !== 'string') return as;
  if (write) throw new Error(as);
  const any = creds.anyAs('azure');
  if (!any) throw new Error(NO_AZURE_TOKEN);
  return any;
}

function check(ref: WorkItemRef) {
  checkOrgProject(ref.org, ref.project);
  if (!Number.isInteger(ref.id) || ref.id <= 0) throw new Error(`#${ref.id} isn't an Azure Boards work item number`);
}

const projectApi = (ref: WorkItemRef, rest: string) => `https://dev.azure.com/${enc(ref.org)}/${enc(ref.project)}/_apis${rest}`;
const itemApi = (ref: WorkItemRef) => projectApi(ref, `/wit/workitems/${ref.id}?${API}`);

const stateId = (name: string) => `abs:${Buffer.from(name, 'utf8').toString('hex')}`;
function stateOf(id: string): string | undefined {
  const m = STATE_ID.exec(id);
  return m ? Buffer.from(m[1], 'hex').toString('utf8') : undefined;
}

/** The work item's type and state, and the states of its type. */
async function states(io: Io, as: HostAs, ref: WorkItemRef): Promise<{ type: string; now: string; all: { name: string; category: string }[] }> {
  check(ref);
  const item = await hostCall(io.fetch, as, 'GET', itemApi(ref));
  const type = String(item?.fields?.['System.WorkItemType'] ?? '');
  const now = String(item?.fields?.['System.State'] ?? '');
  if (!type) throw new Error(`Azure DevOps didn't say what kind of work item #${ref.id} is`);
  const got = await hostCall(io.fetch, as, 'GET', projectApi(ref, `/wit/workitemtypes/${enc(type)}/states?${API}`));
  const all = ((got?.value ?? []) as any[]).filter((s) => typeof s?.name === 'string' && s.name).map((s) => ({ name: String(s.name), category: String(s.category ?? '') }));
  return { type, now, all };
}

/** Where the work item can go: every other state of its type, grouped by the state's category. */
export async function azureTransitions(io: Io, as: HostAs, ref: WorkItemRef): Promise<{ current: string; transitions: IssueTransition[] }> {
  const { now, all } = await states(io, as, ref);
  const transitions = all.filter((s) => s.name !== now).map((s): IssueTransition => ({ id: stateId(s.name), name: s.name, to: s.name, ...(s.category ? { group: s.category } : {}) }));
  return { current: now, transitions };
}

/** Moves the work item to the state a transition id names; resolves to that state. */
export async function azureTransition(io: Io, as: HostAs, ref: WorkItemRef, transitionId: string): Promise<string> {
  const to = stateOf(transitionId);
  if (!to) throw new Error(`#${ref.id} can’t be moved that way: reload its states`);
  // Asked again so a state the type doesn't have (any more) is refused here.
  const { type, all } = await states(io, as, ref);
  if (!all.some((s) => s.name === to)) throw new Error(`A ${type} has no state ${to} (any more): reload its states`);
  await hostCall(io.fetch, as, 'PATCH', itemApi(ref), [{ op: 'add', path: '/fields/System.State', value: to }], JSON_PATCH);
  return to;
}

/** The newest comments, oldest first. */
export async function azureComments(io: Io, as: HostAs, ref: WorkItemRef): Promise<IssueCommentItem[]> {
  check(ref);
  const body = await hostCall(io.fetch, as, 'GET', projectApi(ref, `/wit/workItems/${ref.id}/comments?$top=${COMMENTS}&order=desc&${COMMENTS_API}`));
  return ((body?.comments ?? []) as any[])
    .filter((c) => c && !c.isDeleted)
    .map(
      (c): IssueCommentItem => ({
        id: String(c.id ?? c.commentId ?? ''),
        author: String(c.createdBy?.displayName ?? 'Someone'),
        body: htmlToText(c.text),
        createdAt: String(c.createdDate ?? ''),
        url: `https://dev.azure.com/${enc(ref.org)}/${enc(ref.project)}/_workitems/edit/${ref.id}`,
      }),
    )
    .reverse();
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain text as a comment's HTML: escaped, a paragraph per blank-line block, a line break per newline. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

/** Adds a comment; `signedBy` (the asker, when it goes out under the office's token) signs it. */
export async function azureComment(io: Io, as: HostAs, ref: WorkItemRef, text: string, signedBy?: string): Promise<void> {
  check(ref);
  const all = signedBy ? `${text.trim()}\n\n${attribution(signedBy)}` : text;
  await hostCall(io.fetch, as, 'POST', projectApi(ref, `/wit/workItems/${ref.id}/comments?${COMMENTS_API}`), { text: textToHtml(all) });
}

interface Member {
  id: string;
  name: string;
  unique: string;
  avatar?: string;
}

/** The members of the project's default team. */
async function teamMembers(io: Io, as: HostAs, ref: WorkItemRef): Promise<Member[]> {
  check(ref);
  const project = await hostCall(io.fetch, as, 'GET', `https://dev.azure.com/${enc(ref.org)}/_apis/projects/${enc(ref.project)}?${API}`);
  const team = String(project?.defaultTeam?.id ?? '');
  if (!team) throw new Error(`Azure DevOps didn't say which team ${ref.project} has`);
  const body = await hostCall(io.fetch, as, 'GET', `https://dev.azure.com/${enc(ref.org)}/_apis/projects/${enc(ref.project)}/teams/${enc(team)}/members?$top=500&${API}`);
  return ((body?.value ?? []) as any[])
    .map((m) => m?.identity)
    .filter((i) => i && typeof i.id === 'string' && /^[0-9a-f-]{1,64}$/i.test(i.id) && !i.isContainer)
    .map((i): Member => ({ id: String(i.id), name: String(i.displayName ?? i.uniqueName ?? i.id), unique: String(i.uniqueName ?? ''), ...(i.imageUrl ? { avatar: String(i.imageUrl) } : {}) }));
}

/** Who the work item can be assigned to (the project's default team), matching `query`. */
export async function azurePeople(io: Io, as: HostAs, ref: WorkItemRef, query = ''): Promise<IssuePerson[]> {
  const q = query.trim().toLowerCase();
  return (await teamMembers(io, as, ref))
    .filter((m) => !q || m.name.toLowerCase().includes(q) || m.unique.toLowerCase().includes(q))
    .slice(0, PEOPLE)
    .map((m): IssuePerson => ({ id: m.id, name: m.name, ...(m.unique ? { login: m.unique } : {}), ...(m.avatar ? { avatar: m.avatar } : {}) }));
}

/**
 * Assigns the work item to a member of the project's team (by the id azurePeople gave), to the
 * person whose own token acts (`me`), or to nobody. Resolves to the new assignee's name.
 */
export async function azureAssign(io: Io, as: HostAs, ref: WorkItemRef, to: IssueAssignTo): Promise<string | undefined> {
  check(ref);
  let value = '';
  let name: string | undefined;
  if (to && 'me' in to) {
    // The office's token is nobody's in particular: it can't say who "me" is.
    if (as.key === 'office') throw new Error('The office acts on Azure Boards with its own token, so it doesn’t know which user you are: pick yourself in the list, or set your own token in ☰ → 🔐 Your sign-ins');
    const me = await hostCall(io.fetch, as, 'GET', `https://app.vssps.visualstudio.com/_apis/profile/profiles/me?${API}`);
    value = String(me?.emailAddress ?? '');
    name = String(me?.displayName || value);
    if (!value) throw new Error("Azure DevOps didn't say whose the token is");
  } else if (to) {
    const m = (await teamMembers(io, as, ref)).find((x) => x.id === to.id);
    if (!m || !m.unique) throw new Error(`${to.name ?? to.id} isn't on ${ref.project}'s team (any more): search again`);
    value = `${m.name} <${m.unique}>`;
    name = m.name;
  }
  await hostCall(io.fetch, as, 'PATCH', itemApi(ref), [{ op: 'add', path: '/fields/System.AssignedTo', value }], JSON_PATCH);
  return name;
}
