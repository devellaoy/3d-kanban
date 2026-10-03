// The Status of an issue (or draft) on GitHub Projects v2 boards: the options each board's own
// Status field has ("Inbox / Doing / Waiting on client / Shipped"), and moving the item to one.
// Only the boards that are issue sources of the project count. Writing needs gh's `project` scope
// (reading only `read:project`).

import type { IssueTransition } from '../../../../shared/kanban/issueops.js';
import type { IssueSourceConfig } from '../../../../shared/kanban/types.js';
import { projectError } from './github-project.js';
import type { IssueActIo } from './source.js';

type ProjectConfig = Extract<IssueSourceConfig, { kind: 'github-project' }>;

/** What the office says when gh's token can read projects but not change them. */
export const PROJECT_WRITE_SCOPE_ERROR = 'Changing a GitHub project needs the project scope, which gh hasn’t been given: run `gh auth refresh -s project` on the machine whose sign-in is used, then try again.';

const TIMEOUT_MS = 30_000;

/** Fields of one item of a board: its Status now, and the board's Status options. */
const ITEM = `fragment F on ProjectV2Item {
  id
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  project {
    id number title
    owner { ... on User { login } ... on Organization { login } }
    field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
  }
}`;

/** The boards an issue or pull request is on. */
export const ISSUE_ITEMS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { projectItems(first: 20) { nodes { ...F } } }
      ... on PullRequest { projectItems(first: 20) { nodes { ...F } } }
    }
  }
}
${ITEM}`;

/** The board a draft is on, by its item id. */
export const DRAFT_ITEM_QUERY = `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ...F } } }
${ITEM}`;

export const SET_STATUS_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

/** An issue / pull request by repository and number, or a draft by its item id. */
export type ProjectTarget = { repo: string; number: number } | { itemId: string };

/** One board the item is on, with the Status field it can be moved by. */
export interface BoardItem {
  projectId: string;
  title: string;
  owner: string;
  number: number;
  itemId: string;
  /** Undefined: the board has no Status field (or not a single-select one). */
  fieldId?: string;
  options: { id: string; name: string }[];
  current?: string;
}

const SCOPE_RE = /INSUFFICIENT_SCOPES|required scopes|\bscopes?\b/i;

function graphql(io: IssueActIo, query: string, vars: [flag: '-f' | '-F', name: string, value: string][]): Promise<string> {
  return io.gh(['api', 'graphql', '-f', `query=${query}`, ...vars.flatMap(([flag, name, value]) => [flag, `${name}=${value}`])], io.cwd, TIMEOUT_MS, io.env);
}

function boardOf(n: any): BoardItem | undefined {
  const p = n?.project;
  if (!n || typeof n.id !== 'string' || !p || typeof p.id !== 'string') return undefined;
  return {
    projectId: p.id,
    title: String(p.title ?? ''),
    owner: String(p.owner?.login ?? ''),
    number: Number(p.number),
    itemId: n.id,
    ...(p.field?.id ? { fieldId: String(p.field.id) } : {}),
    options: (p.field?.options ?? []).map((o: any) => ({ id: String(o.id), name: String(o.name) })),
    ...(n.status?.name ? { current: String(n.status.name) } : {}),
  };
}

/** The boards the target is on that are issue sources of the project (`sources`: its github-project ones). */
export async function resolveBoards(io: IssueActIo, target: ProjectTarget, sources: ProjectConfig[]): Promise<BoardItem[]> {
  if (!sources.length) return [];
  let out: string;
  try {
    out =
      'itemId' in target
        ? await graphql(io, DRAFT_ITEM_QUERY, [['-f', 'id', target.itemId]])
        : await graphql(io, ISSUE_ITEMS_QUERY, [['-f', 'owner', target.repo.split('/')[0]], ['-f', 'name', target.repo.split('/')[1]], ['-F', 'number', String(target.number)]]);
  } catch (err) {
    throw projectError(err);
  }
  let raw: any;
  try {
    raw = JSON.parse(out);
  } catch {
    throw new Error('gh gave something that isn’t JSON for the project items');
  }
  if (Array.isArray(raw?.errors) && raw.errors.length) throw projectError(new Error(raw.errors.map((e: any) => `${e.type ?? ''} ${e.message ?? ''}`.trim()).join('; ')));
  const nodes: unknown[] = 'itemId' in target ? [raw?.data?.node] : (raw?.data?.repository?.issueOrPullRequest?.projectItems?.nodes ?? []);
  return nodes
    .map(boardOf)
    .filter((b): b is BoardItem => !!b && sources.some((s) => s.owner.toLowerCase() === b.owner.toLowerCase() && s.number === b.number));
}

/** `p:<projectId>:<itemId>:<fieldId>:<optionId>`: node ids hold no colon. */
export const projectTransitionId = (b: BoardItem, optionId: string) => `p:${b.projectId}:${b.itemId}:${b.fieldId}:${optionId}`;

/** The Status options of each board, grouped by the board's title; where the item is now is marked. */
export function boardTransitions(boards: BoardItem[]): IssueTransition[] {
  return boards
    .filter((b) => b.fieldId)
    .flatMap((b) => b.options.map((o): IssueTransition => ({ id: projectTransitionId(b, o.id), name: o.name, to: o.name, group: b.title, ...(b.current === o.name ? { current: true } : {}) })));
}

/** Moves the item to the option of its board's Status field; a token without the `project` scope is told how to get it. */
export async function setBoardStatus(io: IssueActIo, board: BoardItem, optionId: string): Promise<void> {
  try {
    const out = await graphql(io, SET_STATUS_MUTATION, [['-f', 'project', board.projectId], ['-f', 'item', board.itemId], ['-f', 'field', board.fieldId ?? ''], ['-f', 'option', optionId]]);
    // gh normally fails on GraphQL errors; one that answers with them is read the same.
    const errors = (/^\s*\{/.test(out) ? (JSON.parse(out) as { errors?: { message?: string }[] }) : {}).errors;
    if (errors?.length) throw new Error(errors.map((e) => e.message ?? '').join('; '));
  } catch (err) {
    if (SCOPE_RE.test((err as Error)?.message ?? '')) throw new Error(PROJECT_WRITE_SCOPE_ERROR);
    throw err;
  }
}

const IN_PROGRESS = new Set(['in progress', 'in-progress', 'doing', 'started', 'working', 'wip', 'ongoing', 'käynnissä', 'työn alla']);

/** The board's "In progress" Status option, unless the item is on it already or past it (never moved back from Review or Done). */
export function inProgressOption(b: BoardItem): { id: string; name: string } | undefined {
  if (!b.fieldId) return undefined;
  const at = b.options.findIndex((o) => IN_PROGRESS.has(o.name.trim().toLowerCase()));
  if (at < 0) return undefined;
  const now = b.options.findIndex((o) => o.name === b.current);
  return now >= at ? undefined : b.options[at];
}

/** Moves the item to the option a transition id names, after asking the boards again that it still can. Resolves to the status's name and the board it was moved on. */
export async function projectTransition(io: IssueActIo, target: ProjectTarget, sources: ProjectConfig[], transitionId: string): Promise<{ to: string; owner: string; number: number }> {
  const [tag, projectId, itemId, fieldId, optionId] = transitionId.split(':');
  const gone = () => new Error('That status isn’t one of the board’s any more: reload its statuses');
  if (tag !== 'p' || !projectId || !itemId || !fieldId || !optionId) throw gone();
  const board = (await resolveBoards(io, target, sources)).find((b) => b.projectId === projectId && b.itemId === itemId && b.fieldId === fieldId);
  const option = board?.options.find((o) => o.id === optionId);
  if (!board || !option) throw gone();
  await setBoardStatus(io, board, optionId);
  return { to: option.name, owner: board.owner, number: board.number };
}
