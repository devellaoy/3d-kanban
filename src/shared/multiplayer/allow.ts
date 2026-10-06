// What a visitor in someone else's office may do (browser → office) and see (office → browser).
// Both sides are deny by default, and both tables are `satisfies Record<…['t'], …>`, so a message
// type added to ClientMsg / ServerMsg anywhere in the codebase is a compile error until someone
// decides what a visitor gets of it. Pure functions, no Node imports: the owner's office runs the
// gates (the browser's own copy of the rules is only a hint), tests run them on fixtures.
//
// A visitor is read-only: they walk around, chat, talk, play the toys, draw on the whiteboard and
// watch terminals, diffs and boards, but only on the floors (and kanban projects) the owner shared
// and the visitor has GitHub access to (their `VisitorScope`).

import type { ClientMsg } from '../protocol.js';
import { ROOF } from '../rooftop.js';
import { repoOk } from './repos.js';

export { filterForVisitor, SERVER_MSG_OUT, type FilterCtx } from './filter.js';

/** What one visitor may see: opened by the owner's office when the visit starts. */
export interface VisitorScope {
  /** The visitor's GitHub login. */
  login: string;
  /** Floor ids the visitor may enter. */
  floors: ReadonlySet<string>;
  /** Kanban project ids the visitor may read (a project's id is its floor's id). */
  projects: ReadonlySet<string>;
  /**
   * Floor id → the repositories of its project the visitor was verified against (the floor id for the
   * project's own checkout, `<floor>~<repo>` for the others; see repos.ts). Set by the host; a scope
   * without it is checked by floor only.
   */
  repos?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * - allow: harmless in any scope (their own presence, the toys, chat, voice).
 * - scoped: allowed only when the thing it names is in the visitor's scope (see visitorMayScoped).
 * - deny: never.
 */
export type ClientMsgClass = 'allow' | 'deny' | 'scoped';

export const CLIENT_MSG_CLASS = {
  // --- Presence: their own character, chat and voice ---
  move: 'allow',
  act: 'allow',
  sit: 'allow',
  emote: 'allow',
  profile: 'allow',
  doing: 'allow',
  voice: 'allow',
  rtc: 'allow',
  chat: 'allow',
  ping: 'allow',
  /** Picks an issue card off the board for everyone to see in their hands; touches the floor's issues. */
  carry: 'deny',

  // --- The balcony and the roof ---
  golf: 'allow',
  toss: 'allow',
  gong: 'allow',
  horn: 'allow',

  // --- The toys. The cabinet is play (its score lands on the owner's table under the visitor's name) ---
  'ball.take': 'allow',
  'ball.throw': 'allow',
  'cabinet.play': 'allow',
  'cabinet.leave': 'allow',
  'cabinet.frame': 'allow',
  // Driving is play like the ball: it only moves the floor's cars, nothing persists.
  'car.enter': 'allow',
  'car.leave': 'allow',
  'car.drive': 'allow',
  'car.honk': 'allow',
  'dog.pet': 'allow',
  /** Renames the owner's dog for good. */
  'dog.name': 'deny',
  'wb.open': 'allow',
  'wb.close': 'allow',
  'wb.pointer': 'allow',
  'wb.update': 'allow',
  'decor.add': 'deny',
  'decor.update': 'deny',
  'decor.remove': 'deny',
  'jukebox.play': 'deny',
  'jukebox.skip': 'deny',
  'jukebox.stop': 'deny',

  // --- The building ---
  'floor.go': 'scoped',
  'floor.repos': 'deny',
  'floor.add': 'deny',
  'floor.remove': 'deny',
  'floor.move': 'deny',
  'floor.projectsDir': 'deny',
  'desk.label': 'deny',
  'floor.expand': 'deny',
  'floor.shrink': 'deny',
  'furniture.move': 'deny',
  'furniture.remove': 'deny',
  'furniture.reset': 'deny',

  // --- Workers. Watching a terminal grants no input (term.input is separate), but the worker id is
  // not tied to the visitor's floor, so attach and the changes views check the worker's floor. ---
  'worker.attach': 'scoped',
  'worker.detach': 'scoped',
  'changes.watch': 'scoped',
  'changes.unwatch': 'scoped',
  'changes.diff': 'scoped',
  'worker.spawn': 'deny',
  'worker.resume': 'deny',
  'worker.kill': 'deny',
  'worker.worktree': 'deny',
  'worker.rebuild': 'deny',
  'worker.prompt': 'deny',
  'station.prompt': 'deny',
  'worker.pr': 'deny',
  'term.input': 'deny',
  'term.typing': 'deny',
  'term.resize': 'deny',
  'changes.commit': 'deny',
  'changes.discard': 'deny',
  'changes.pr': 'deny',

  // --- GitHub, the queue, meetings: all act as the owner ---
  'gh.refresh': 'deny',
  'gh.merge': 'deny',
  'gh.comment': 'deny',
  'gh.close': 'deny',
  'gh.labels': 'deny',
  'queue.add': 'deny',
  'queue.remove': 'deny',
  'queue.move': 'deny',
  'queue.retry': 'deny',
  'queue.clear': 'deny',
  'queue.limit': 'deny',
  'meeting.start': 'deny',
  'meeting.stop': 'deny',
  'meeting.clear': 'deny',
  'meeting.handed': 'deny',

  // --- The owner's settings, accounts and sign-ins ---
  'team.get': 'deny',
  'team.invite': 'deny',
  'team.remove': 'deny',
  'accounts.get': 'deny',
  'accounts.invite': 'deny',
  'accounts.cancel': 'deny',
  'accounts.revoke': 'deny',
  'accounts.role': 'deny',
  'accounts.shared': 'deny',
  'signins.get': 'deny',
  'signins.start': 'deny',
  'signins.code': 'deny',
  'signins.cancel': 'deny',
  'signins.token': 'deny',
  'signins.office': 'deny',
  'signins.signout': 'deny',
  'hosting.get': 'deny',
  'hosting.set': 'deny',
  'hosting.clear': 'deny',
  'hosting.servers': 'deny',
  'notify.webhook': 'deny',
  'notify.test': 'deny',
  'machine.limit': 'deny',
  'upgrade.check': 'deny',
  'upgrade.start': 'deny',
  'theme.set': 'deny',
  'sky.clock': 'deny',
  'map.set': 'deny',
  'leaveOnMerge.set': 'deny',
  'prompts.set': 'deny',
  'prompts.agent': 'deny',
  'prompts.language': 'deny',
  'limits.refresh': 'deny',
  'codex-limits.watch': 'deny',
  'codex-limits.refresh': 'deny',
  'tv.youtube.play': 'deny',
  'tv.youtube.stop': 'deny',
  'tv.youtube.ended': 'deny',
  'tv.youtube.pause': 'deny',
  'tv.youtube.seek': 'deny',
  'tv.youtube.rate': 'deny',
  'tv.youtube.skip': 'deny',
  'tv.youtube.queue.move': 'deny',
  'tv.youtube.queue.remove': 'deny',
  'tv.youtube.queue.jump': 'deny',
  'tv.youtube.queue.clear': 'deny',
  'tv.youtube.unpack': 'deny',
  'tv.youtube.info': 'deny',
  'tv.youtube.settings': 'deny',
  'mp.connect': 'deny',
  'mp.online': 'deny',
  'mp.identity.start': 'deny',
  'mp.identity.cancel': 'deny',
  'mp.identity.forget': 'deny',
  'mp.share': 'deny',
  'mp.watch': 'deny',
  'mp.unwatch': 'deny',
  'mp.probe': 'deny',

  // --- The phone: following the workers of a floor in scope (stopping is always fine) ---
  'phone.watch': 'scoped',
  // Music is between the people of one office: a visitor neither plays nor controls it.
  'phone.music.play': 'deny',
  'phone.music.control': 'deny',
  'phone.music.leave': 'deny',

  // --- The kanban: reading the board of a shared project is scoped; everything else is the owner's ---
  'kanban.subscribe': 'scoped',
  'kanban.unsubscribe': 'scoped',
  'kanban.snapshot': 'scoped',
  'kanban.task.get': 'scoped',
  'kanban.comments.page': 'scoped',
  'kanban.meta.get': 'scoped',
  'kanban.pr.bundle': 'scoped',
  'kanban.task.create': 'deny',
  'kanban.task.update': 'deny',
  'kanban.task.move': 'deny',
  'kanban.task.start': 'deny',
  'kanban.task.stop': 'deny',
  'kanban.task.continue': 'deny',
  'kanban.task.retry': 'deny',
  'kanban.task.review': 'deny',
  'kanban.plan.approve': 'deny',
  'kanban.plan.requestChanges': 'deny',
  'kanban.task.pr': 'deny',
  'kanban.task.delete': 'deny',
  'kanban.task.vscode': 'deny',
  'kanban.worker.vscode': 'deny',
  'kanban.comment.add': 'deny',
  'kanban.settings.get': 'deny',
  'kanban.settings.set': 'deny',
  'kanban.project.settings.set': 'deny',
  'kanban.project.rename': 'deny',
  'kanban.project.repos.set': 'deny',
  'kanban.project.repo.clone': 'deny',
  'kanban.project.prompt.set': 'deny',
  'kanban.skills.list': 'deny',
  'kanban.skills.sync': 'deny',
  'kanban.secrets.set': 'deny',
  'kanban.pr.review': 'deny',
  // Reads, but through the owner's Jira / GitHub credentials, so not covered by the visitor's repo access.
  'kanban.pr.owner': 'deny',
  'kanban.issues.list': 'deny',
  'kanban.issues.refresh': 'deny',
  'kanban.issues.createTask': 'deny',
  'kanban.issue.transitions': 'deny',
  'kanban.issue.transition': 'deny',
  'kanban.issue.comments': 'deny',
  'kanban.issue.comment': 'deny',
  'kanban.issue.people': 'deny',
  'kanban.issue.assign': 'deny',
  'kanban.browse.scopes': 'deny',
  'kanban.browse.options': 'deny',
  'kanban.browse.groups': 'deny',
  'kanban.browse.count': 'deny',
  'kanban.browse.page': 'deny',
  'kanban.browse.children': 'deny',
  'kanban.browse.issue': 'deny',
  'kanban.browse.people': 'deny',
} as const satisfies Record<ClientMsg['t'], ClientMsgClass>;

/** The class of a message type from the wire; anything not in the table (an unknown type) is denied. */
export function classOf(type: unknown): ClientMsgClass {
  return typeof type === 'string' && Object.hasOwn(CLIENT_MSG_CLASS, type) ? (CLIENT_MSG_CLASS as Record<string, ClientMsgClass>)[type] : 'deny';
}

/** What the owner's office can look up for the checks that need more than the message. */
export interface ScopeLookup {
  /** Every repository a worker touches: its own floor, then the repository ids it also works in (WorkerInfo.repos[].floor, a floor id or `<floor>~<repo>`); undefined if there is no such worker. */
  workerFloors?(workerId: string): string[] | undefined;
  /** The repositories a task names (see taskRepoIds); undefined if there is no such task. */
  taskRepos?(taskId: number): string[] | undefined;
  /** The project a kanban task belongs to; undefined if there is no such task. */
  projectOfTask?(taskId: number): string | undefined;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;


/**
 * Whether a visitor may send this message, whatever its class: 'allow' passes, 'deny' (and anything
 * unknown) fails, 'scoped' is checked against the scope. `msg` is untrusted: every field the check
 * relies on is type-checked here. A scoped check that needs a lookup the caller did not give fails.
 */
export function visitorMay(msg: { t?: unknown }, scope: VisitorScope, lookup: ScopeLookup = {}): boolean {
  const cls = classOf(msg.t);
  if (cls === 'allow') return true;
  if (cls === 'deny') return false;
  return visitorMayScoped(msg as Extract<ClientMsg, { t: string }>, scope, lookup);
}

/** The scoped half of {@link visitorMay}. A message that is not a scoped type is refused. */
export function visitorMayScoped(msg: ClientMsg, scope: VisitorScope, lookup: ScopeLookup = {}): boolean {
  const m = msg as Record<string, unknown>;
  const floorOk = (id: unknown) => isStr(id) && scope.floors.has(id);
  const projectOk = (id: unknown) => isStr(id) && scope.projects.has(id);
  switch (msg.t) {
    // Only to a floor in scope, or up to the roof (the games are there and it carries nothing of the
    // owner's projects); the lobby and every other floor are refused.
    case 'floor.go':
      return floorOk(m.floor) || m.floor === ROOF;
    // null stops watching; a floor must be one in scope (workerOk in the filter then drops what spans other floors).
    case 'phone.watch':
      return m.floor === null || floorOk(m.floor);
    case 'worker.attach':
    case 'worker.detach':
    case 'changes.watch':
    case 'changes.unwatch':
    case 'changes.diff': {
      // A worker across repositories shows other floors' code too, so every floor it works in must be in scope.
      const repos = isStr(m.workerId) ? lookup.workerFloors?.(m.workerId) : undefined;
      if (!repos?.length || !repos.every((id) => repoOk(scope, id))) return false;
      return m.repo === undefined || repoOk(scope, m.repo);
    }
    // null (all projects) and a missing project are refused: the owner's other projects are not theirs to see.
    case 'kanban.subscribe':
    case 'kanban.snapshot':
    case 'kanban.pr.bundle':
      return projectOk(m.project);
    case 'kanban.task.get':
    case 'kanban.comments.page':
      return typeof m.id === 'number' && projectOk(lookup.projectOfTask?.(m.id)) && (lookup.taskRepos?.(m.id) ?? []).every((id) => repoOk(scope, id));
    // No project to name: the answer is filtered to the scope on the way out.
    case 'kanban.unsubscribe':
    case 'kanban.meta.get':
      return true;
    default:
      return false;
  }
}
