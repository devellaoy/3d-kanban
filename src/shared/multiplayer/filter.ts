// The owner's office → a visitor's browser, deny by default: every frame the office would send a
// visitor passes through `filterForVisitor`, which returns it (possibly rewritten to hold only what
// the visitor's scope covers) or undefined to drop it. See allow.ts for the other direction and for
// VisitorScope.
//
// Frames the office sends with toFloor / toNeighbors reach a visitor only while they are on a floor
// in their scope (they cannot stand anywhere else), so floor-scoped updates pass as they are.
// Broadcasts to everyone (welcome, floors, peer.*, kanban.*) are the ones to rewrite or drop here.

import type { KanbanProjectInfo, KanbanSettings, KanbanTaskCard } from '../kanban/types.js';
import type { FloorInfo, FloorView, PeerInfo, ProjectInfo, ServerMsg, WorkerInfo } from '../protocol.js';
import { repoFloorId } from '../kanban/repofloor.js';
import { ROOF } from '../rooftop.js';
import type { VisitorScope } from './allow.js';
import { repoOk, taskOk } from './repos.js';

/** What the owner's office can look up while filtering. */
export interface FilterCtx {
  /** The floor a peer (by id) is on; used to drop movement of people on floors outside the scope. */
  floorOfPeer?(peerId: string): string | undefined;
  /** The project a kanban task belongs to (kanban.comments names only the task). */
  projectOfTask?(taskId: number): string | undefined;
  /** The repositories a worker works in (its own floor, then its WorkerInfo.repos' ids); terminal and diff frames go to viewers directly, so each is checked against all of them. */
  workerFloors?(workerId: string): string[] | undefined;
  /** The repositories a task names (see taskRepoIds); a frame about a task that touches one outside the scope is dropped. */
  taskRepos?(taskId: number): string[] | undefined;
}

/**
 * - pass: sent as it is (floor-scoped, or nothing about the owner's other floors in it).
 * - rewrite: inspected and rebuilt (or dropped when it is outside the scope) by filterForVisitor.
 * - drop: a visitor never gets it.
 */
export type ServerMsgOut = 'pass' | 'drop' | 'rewrite';

export const SERVER_MSG_OUT = {
  // --- People ---
  welcome: 'rewrite',
  'peer.join': 'rewrite',
  'peer.update': 'rewrite',
  'peer.move': 'rewrite',
  'peer.leave': 'pass',
  'peer.act': 'rewrite',
  'peer.emote': 'pass',
  rtc: 'pass',
  chat: 'pass',
  // Toasts say who did what to which floor or repo ("X took <floor> off the building"); the visitor
  // gets none of them. (Their own refusals are the browser's job.)
  toast: 'drop',
  'sit.refused': 'pass',
  pong: 'pass',
  golf: 'pass',
  toss: 'pass',
  gong: 'pass',
  horn: 'pass',

  // --- The floor they are on ---
  'floor.enter': 'rewrite',
  floors: 'rewrite',
  plan: 'pass',
  'worker.update': 'rewrite',
  'worker.remove': 'pass',
  screen: 'rewrite',
  'term.snapshot': 'rewrite',
  'term.data': 'rewrite',
  'term.typing': 'rewrite',
  changes: 'rewrite',
  'changes.diff': 'rewrite',
  'gh.issues': 'pass',
  'gh.pulls': 'pass',
  queue: 'pass',
  meeting: 'pass',
  decor: 'pass',
  dog: 'pass',
  ball: 'pass',
  cars: 'pass',
  'car.move': 'pass',
  'car.honk': 'pass',
  jukebox: 'pass',
  cabinet: 'pass',
  'cabinet.frame': 'pass',
  'wb.update': 'pass',
  'wb.people': 'pass',
  'wb.pointer': 'pass',
  'tv.youtube': 'pass',
  // The phone: another floor's workers, only for floors in scope.
  'phone.floor': 'rewrite',
  'phone.worker': 'rewrite',
  'phone.workerRemove': 'rewrite',
  'phone.music': 'drop',
  // The building: the same for everyone.
  sky: 'pass',
  theme: 'pass',
  map: 'pass',

  // --- Answers to things only the owner's people ask, and the owner's own state ---
  'worker.worktree': 'drop',
  'gh.merged': 'drop',
  'gh.commented': 'drop',
  'gh.closed': 'drop',
  'gh.labeled': 'drop',
  'floor.repos': 'drop',
  'floor.added': 'drop',
  projectsDir: 'drop',
  team: 'drop',
  'team.invited': 'drop',
  accounts: 'drop',
  'accounts.invited': 'drop',
  me: 'drop',
  signins: 'drop',
  'signins.needed': 'drop',
  hosting: 'drop',
  'hosting.saved': 'drop',
  upgrade: 'drop',
  // Ports, commands and folders of what the owner's workers run.
  services: 'drop',
  notify: 'drop',
  machine: 'drop',
  prompts: 'drop',
  leaveOnMerge: 'drop',
  carryOn: 'drop',
  usage: 'drop',
  limits: 'drop',
  'codex-limits': 'drop',
  'mp.state': 'drop',
  'mp.probe.res': 'drop',
  'mp.ended': 'drop',

  // --- The kanban: only the projects in scope ---
  'kanban.snapshot': 'rewrite',
  'kanban.task': 'rewrite',
  'kanban.task.removed': 'rewrite',
  'kanban.task.detail': 'rewrite',
  'kanban.comments': 'rewrite',
  'kanban.comment': 'rewrite',
  'kanban.run': 'rewrite',
  'kanban.plan': 'rewrite',
  'kanban.meta': 'rewrite',
  'kanban.projects': 'rewrite',
  'kanban.pr.bundle': 'rewrite',
  'kanban.error': 'pass',
  'kanban.settings': 'drop',
  'kanban.skills': 'drop',
  'kanban.pr.owner': 'drop',
  'kanban.ok': 'drop',
  // Issues of the owner's Jira / GitHub sources: read with the owner's credentials, so not the visitor's to see.
  'kanban.issues': 'drop',
  'kanban.issueTransitions': 'drop',
  'kanban.issueComments': 'drop',
  'kanban.issuePeople': 'drop',
  'kanban.browseScopes': 'drop',
  'kanban.browseOptions': 'drop',
  'kanban.browseGroups': 'drop',
  'kanban.browseCount': 'drop',
  'kanban.browsePage': 'drop',
  'kanban.browseIssue': 'drop',
  // The tasks on hold as figures in the lounge (floor-scoped), less those the visitor can't see.
  'kanban.lounge': 'rewrite',
} as const satisfies Record<ServerMsg['t'], ServerMsgOut>;

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

// --- Pieces ---------------------------------------------------------------------------------------

/** A person on a floor outside the scope is still a name on the list, but where they are and what they do is not shown. */
function peerFor(p: PeerInfo, scope: VisitorScope): PeerInfo {
  if (!p.floor || p.floor === ROOF || scope.floors.has(p.floor)) return p;
  // Someone on a floor the visitor can't see: nothing of where they stand or what they're up to.
  return {
    ...p, floor: undefined, doing: undefined, carrying: undefined, seat: undefined, reading: undefined,
    x: 0, y: 0, z: 0, smoking: undefined, golfing: undefined, throwing: undefined, drink: undefined,
  };
}

const floorFor = (f: FloorInfo): FloorInfo => ({ ...f, dir: '' });

const projectFor = (p: ProjectInfo | null): ProjectInfo | null => (p ? { ...p, dir: '', agentCmd: '' } : null);

/**
 * Whether a worker may be shown: every repository it works in (WorkerInfo.repos) is one in scope, i.e.
 * on a floor they have and still one of that project's repositories they were verified against (a
 * repository taken out of the project later stays in the workspace of an old worker).
 */
function workerOk(w: WorkerInfo, scope: VisitorScope): boolean {
  return (w.repos ?? []).every((r) => repoOk(scope, r.floor));
}

/** Whether a task card is one to show: in a project in scope and touching only repositories in scope. */
const cardOk = (t: KanbanTaskCard, scope: VisitorScope) => scope.projects.has(t.project) && taskOk(scope, t);

/** A worker without the owner's folders. */
const workerFor = (w: WorkerInfo): WorkerInfo => (w.repos ? { ...w, repos: w.repos.map((r) => ({ ...r, dir: '' })) } : w);

/** The arrival floor's view with the owner's folders, commands and ports taken out, and only the workers and lounge figures (by task) the visitor may see. */
function viewFor<V extends FloorView>(v: V, scope: VisitorScope, taskIn: (taskId: number) => boolean): V {
  return {
    ...v,
    project: projectFor(v.project),
    services: { items: [], port: 0 },
    workers: v.workers.filter((w) => workerOk(w, scope)).map(workerFor),
    ...(v.kanbanLounge ? { kanbanLounge: v.kanbanLounge.filter((f) => taskIn(f.taskId)) } : {}),
  };
}

function kanbanProjectFor(p: KanbanProjectInfo): KanbanProjectInfo {
  return { ...p, dir: '', repos: p.repos.map((r) => ({ ...r, dir: '', instructions: undefined })) };
}

/** The settings the board needs to draw itself, less the prompts and issue sources the owner wrote for their projects. */
function kanbanSettingsFor(s: KanbanSettings, scope: VisitorScope): KanbanSettings {
  const projects: KanbanSettings['projects'] = {};
  for (const id of scope.projects) {
    const ps = s.projects[id];
    if (ps) projects[id] = { ...ps, issueSources: [], prompts: {} };
  }
  return { ...s, projects };
}

const NO_SECRETS = { jira: { configured: false }, apiKey: { configured: false } } as const;

const zeroUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };

// --- The filter -----------------------------------------------------------------------------------

/**
 * The frame a visitor gets for `msg`: as it is, rewritten to the scope, or undefined (drop it).
 * Anything not in SERVER_MSG_OUT (a type from outside the typed unions) is dropped.
 */
export function filterForVisitor(msg: ServerMsg, scope: VisitorScope, ctx: FilterCtx = {}): ServerMsg | undefined {
  const how = Object.hasOwn(SERVER_MSG_OUT, msg.t) ? (SERVER_MSG_OUT as Record<string, ServerMsgOut>)[msg.t] : 'drop';
  if (how === 'drop') return undefined;
  if (how === 'pass') return msg;
  const floorOk = (id: string | null | undefined) => !!id && scope.floors.has(id);
  // Where a visitor can stand: their floors, and the roof (it has nothing of the owner's projects).
  const placeOk = (id: string | null | undefined) => id === ROOF || floorOk(id);
  const projectOk = (id: string | null | undefined) => !!id && scope.projects.has(id);
  const workerIn = (id: string) => {
    const floors = ctx.workerFloors?.(id);
    return !!floors?.length && floors.every((r) => repoOk(scope, r));
  };
  // A frame about a task by id (comments, runs, plans): its project, and the repositories it names.
  const taskIn = (taskId: number) => projectOk(ctx.projectOfTask?.(taskId)) && (ctx.taskRepos?.(taskId) ?? []).every((r) => repoOk(scope, r));
  switch (msg.t) {
    // Kept: what the visitor needs to stand in the arrival floor. Replaced by neutral values: the
    // owner's settings, usage, folders and invites, which the client still expects to find.
    case 'welcome': {
      if (!floorOk(msg.floor)) return undefined; // the host must send the visitor to a floor in scope first
      const view = viewFor(msg, scope, taskIn);
      const out: Msg<'welcome'> = {
        ...view,
        peers: msg.peers.map((p) => peerFor(p, scope)),
        floors: msg.floors.filter((f) => floorOk(f.id)).map(floorFor),
        projectsDir: { dir: '', custom: false },
        invites: false,
        upgrade: { available: false, phase: 'idle' },
        usage: { total: zeroUsage, today: zeroUsage, day: '', pauseHiring: false },
        limits: { windows: [], at: 0 },
        me: { admin: false, visitor: true },
        notify: {},
        machine: { cpu: 0, cores: 0, memUsed: 0, memTotal: 0, history: [], workers: 0 },
        prompts: { custom: {} },
        leaveOnMerge: { on: false },
        carryOn: { on: true },
      };
      return out;
    }
    case 'floor.enter':
      return placeOk(msg.floor) ? { ...viewFor(msg, scope, taskIn), peers: msg.peers.map((p) => peerFor(p, scope)) } : undefined;
    // Worker-scoped frames reach their viewers directly, so a viewer who attached while the floor was in
    // scope must stop getting them once it is not; an unknown worker or no lookup is a drop.
    case 'term.snapshot':
    case 'term.data':
    case 'term.typing':
    case 'screen':
    case 'changes.diff':
      return workerIn(msg.workerId) ? msg : undefined;
    case 'changes':
      return workerIn(msg.state.workerId) && (!msg.state.repo || repoOk(scope, msg.state.repo)) ? msg : undefined;
    case 'worker.update':
      return workerOk(msg.worker, scope) ? { ...msg, worker: workerFor(msg.worker) } : undefined;
    case 'phone.floor':
      return floorOk(msg.floor) ? { ...msg, workers: msg.workers.filter((w) => workerOk(w, scope)).map(workerFor), project: projectFor(msg.project) } : undefined;
    case 'phone.worker':
      return floorOk(msg.floor) && workerOk(msg.worker, scope) ? { ...msg, worker: workerFor(msg.worker) } : undefined;
    case 'phone.workerRemove':
      // Intentionally no workerOk: it carries only an id, as worker.remove passes.
      return floorOk(msg.floor) ? msg : undefined;
    case 'floors':
      return { t: 'floors', floors: msg.floors.filter((f) => floorOk(f.id)).map(floorFor) };
    case 'peer.act': {
      // Broadcast to the whole building, so only when the one acting is on a floor in scope.
      const floor = ctx.floorOfPeer?.(msg.id);
      return floor && placeOk(floor) ? msg : undefined;
    }
    case 'peer.join':
    case 'peer.update':
      return { ...msg, peer: peerFor(msg.peer, scope) };
    case 'peer.move': {
      // The office sends moves to a floor's neighbours only; with a lookup this also checks it.
      const floor = ctx.floorOfPeer?.(msg.id);
      return ctx.floorOfPeer && !placeOk(floor) ? undefined : msg;
    }

    // --- The kanban ---
    case 'kanban.snapshot':
      return projectOk(msg.project)
        ? { ...msg, tasks: msg.tasks.filter((t) => cardOk(t, scope)), projects: msg.projects.filter((p) => projectOk(p.id)).map(kanbanProjectFor), settings: kanbanSettingsFor(msg.settings, scope), secrets: NO_SECRETS, me: { admin: false, name: scope.login } }
        : undefined;
    case 'kanban.meta':
      return { ...msg, projects: msg.projects.filter((p) => projectOk(p.id)).map(kanbanProjectFor), settings: kanbanSettingsFor(msg.settings, scope), secrets: NO_SECRETS, me: { admin: false, name: scope.login } };
    case 'kanban.projects':
      return { t: 'kanban.projects', projects: msg.projects.filter((p) => projectOk(p.id)).map(kanbanProjectFor) };
    // A task that touches a repository outside the scope is never sent whole (its stored workspace and
    // repository ids would show it). One that gains such a repository was on their board a moment ago,
    // so the board is told it is gone (just its id) rather than left showing the old card.
    case 'kanban.task':
      if (cardOk(msg.task, scope)) return msg;
      return projectOk(msg.task.project) ? { t: 'kanban.task.removed', id: msg.task.id, project: msg.task.project } : undefined;
    case 'kanban.task.detail':
      return projectOk(msg.task.project) && taskOk(scope, msg.task) ? msg : undefined;
    case 'kanban.task.removed':
      return projectOk(msg.project) ? msg : undefined;
    case 'kanban.comment':
      return projectOk(msg.project) && taskIn(msg.comment.taskId) ? msg : undefined;
    case 'kanban.run':
      return projectOk(msg.project) && taskIn(msg.run.taskId) ? msg : undefined;
    case 'kanban.plan':
      return projectOk(msg.project) && taskIn(msg.plan.taskId) ? msg : undefined;
    case 'kanban.pr.bundle':
      // Pull requests of a repository outside the scope are left out of the bundle.
      return projectOk(msg.project)
        ? { ...msg, prs: msg.prs.filter((p) => !p.repoId || repoOk(scope, p.repoId === msg.project ? p.repoId : repoFloorId(msg.project, p.repoId))) }
        : undefined;
    case 'kanban.comments':
      return taskIn(msg.taskId) ? msg : undefined;
    case 'kanban.lounge':
      return floorOk(msg.floor) ? { ...msg, figures: msg.figures.filter((f) => taskIn(f.taskId)) } : undefined;
    default:
      return undefined; // a 'rewrite' type without a case above: never let it through unchecked
  }
}
