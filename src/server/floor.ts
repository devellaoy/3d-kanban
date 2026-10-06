import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ChangesState, FloorInfo, GhIssue, GhPull, GhState, PeerInfo, ProjectInfo, ServerMsg, WorkerInfo } from '../shared/protocol.js';
import { isBusy, waitingOnSomeone } from '../shared/status.js';
import { DESK_BY_ID, MEETING_ROOMS, builtMeetingRooms, type MeetingRoomDef } from '../shared/layout.js';
import type { FloorDef } from './building.js';
import { excludeFromGit } from './config.js';
import { agentProviders, configuredProvider } from './agents.js';
import { WorkerManager, workedMs, type HookEnv, type RunAs } from './workers.js';
import { GitHub, MergeWatch } from './github.js';
import type { GhAs } from './signins.js';
import { TaskQueue } from './queue.js';
import { WorkerCloses } from './worker-closes.js';
import { queueEvents } from './queue-events.js';
import { Changes } from './changes.js';
import { Decor } from './decor.js';
import { FloorPlanStore } from './floorplan.js';
import { Docs } from './docs.js';
import { Dog } from './dog.js';
import { Court } from './court.js';
import { Jail } from './jail.js';
import { Garage } from './garage.js';
import { Jukebox } from './jukebox.js';
import { Whiteboard } from './whiteboard.js';
import { MeetingRooms } from './meeting-rooms.js';
import { Worktrees, worktreeDir, type WorktreeCleanup } from './worktrees.js';
import { landedWork, landedWorkers, type Landed } from './leave-on-merge.js';
import type { Ledger } from './usage.js';
import type { Capacity } from './machine.js';
import type { PromptSource } from './prompts.js';
// The PR board covers every repository of the project (see pullsState).
import { parseRepoFloorId, projectRepos, uniqueRepos } from './kanban/projects.js';
import { checkoutRemote, checkoutRepo } from './ghrepo.js';
import { ghIssueKey } from './kanban/integrations/issues/github-repo.js';
// The kanban hears when the PR board has fresh lists (its tasks' linked PRs' states).
import { floorPulled } from './kanban/integrations/pulls/board.js';
// The issues board shows the project's issue sources when it has any (see issuesState).
import { claimGhKey, onWallIssues, progressIssue, wallIssues, wallKnows, watchWall } from './kanban/integrations/issues/wall.js';
import { isPrimaryIssue, parseGhKey } from '../shared/kanban/issuecard.js';
// What a worker is sent home with (see sendHome).
import type { DepartureIntent } from '../shared/kanban/types.js';
import { sameRepo } from '../shared/floors.js';
import { NOT_GIT, SAFE_GIT, isGitFloor } from './floor-git.js';

type ToastLevel = 'info' | 'warn' | 'error';

/** What a floor needs from the building around it. */
export interface FloorContext {
  agentCmd: string;
  agentArgs: string[];
  /** The DSH profile DeepSeek Harness workers boot (see server/dsh.ts). */
  dshProfile: string;
  hook: HookEnv;
  /** Spend, across every floor. */
  ledger: Ledger;
  /** The office's worker limit, across every floor. */
  capacity: Capacity;
  /** The office's prompts and the worker everyone starts on, as set in ⚙️ Settings, with a project's own language (see server/language.ts). */
  prompts(projectId: string): PromptSource;
  /** Workers hired by an account run on its own sign-ins (see signins.ts). */
  runAs?: RunAs;
  /** How to run gh as an account: its own sign-in, the office's (undefined), or why it can't. */
  ghAs(owner: string | undefined): GhAs | undefined | string;
  /** To everyone on this floor. */
  emit(floor: Floor, msg: ServerMsg, droppable?: boolean): void;
  toast(floor: Floor, text: string, level?: ToastLevel): void;
  /** A worker's terminal output, for whoever has that terminal open. */
  termData(workerId: string, data: string, viewers: string[]): void;
  /** What a worker changed, for whoever has its Changes window open. */
  changes(state: ChangesState, clients: string[]): void;
  /** A worker on this floor changed, or left (then just its id). */
  workerChanged(floor: Floor, w: WorkerInfo | string): void;
  /** How many people are on this floor right now. */
  people(floor: Floor): number;
  /** Who's on this floor, and where they stand. */
  peers(floor: Floor): PeerInfo[];
  /** ⚙️ Settings: a worker whose pull request merged goes home by itself. */
  leaveOnMerge(): boolean;
  /** Another floor of the building: a worker across repositories works in its project too (see WorkerInfo.repos). */
  floor(id: string): Floor | undefined;
  /** This floor's pull requests came back: a worker on another floor with a repository here may have landed. */
  pullsChanged(floor: Floor): void;
  /** Whether a worker on another floor works in this floor's project too. */
  lent(floor: Floor): boolean;
  /** Whether the building's map locks up workers sent home (see MapPlan.sendHome), instead of letting them go. */
  locksUp(): boolean;
  /** The building's map's meeting rooms. */
  meetingRooms(): MeetingRoomDef[];
  officeMap?(): boolean; // whether the building is on the office's own map, the only one with loose furniture (see shared/arrange.ts); unsaid: it is
  /** Whether this floor is the checkout the office was started in. */
  isLocal(id: string): boolean;
}

/** The open pull request on a floor's board whose head is `branch`. */
function openPull(floor: Floor, branch: string): { number: number; url: string } | undefined {
  return openPullIn(floor.github.pulls.items, branch);
}

/** The open pull request in a list whose head is `branch` (a project's other repository's list too). */
function openPullIn(pulls: GhPull[], branch: string): { number: number; url: string } | undefined {
  const pr = pulls.find((p) => p.state === 'OPEN' && p.headRefName === branch);
  return pr ? { number: pr.number, url: pr.url } : undefined;
}

/** How long after a PR list or a worker's change the office looks for workers whose PR merged. */
const LANDED_DELAY_MS = 1500;
/** Boards on a floor nobody is on, with nothing running, are asked GitHub about this seldom. */
const IDLE_REFRESH_MS = 10 * 60_000;
const REFRESH_MS = 90_000;

/** What `git` says about a checkout: its name, branch and origin for the top bar. A folder that isn't a git floor has neither. */
export function projectInfo(dir: string, name: string, agentCmd: string, agentArgs: string[], isGit = true): ProjectInfo {
  const git = (args: string[]) => {
    if (!isGit) return undefined;
    try {
      return execFileSync('git', [...SAFE_GIT, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    name,
    dir,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: git(['remote', 'get-url', 'origin']),
    agentCmd: [agentCmd, ...agentArgs].join(' '),
    defaultProvider: configuredProvider(agentCmd),
    agentProviders: agentProviders(configuredProvider(agentCmd)),
  };
}

/**
 * One floor of the building: a project's checkout with its own desks and workers, issues and PR
 * boards, task queue, pictures and jukebox, all kept in that checkout's .agent-office folder.
 */
export class Floor {
  readonly id: string;
  readonly dir: string;
  readonly project: ProjectInfo;
  /** See isGitFloor: a plain folder runs no git and asks GitHub nothing. */
  readonly git: boolean;
  readonly workers: WorkerManager;
  readonly github: GitHub;
  readonly queue: TaskQueue;
  private readonly closes: WorkerCloses;
  readonly changes: Changes;
  readonly decor: Decor;
  /** The signs over its desks, and how far its back office is built out. */
  readonly plan: FloorPlanStore;
  readonly jukebox: Jukebox;
  /** The whiteboard everyone on the floor draws on together. */
  readonly whiteboard: Whiteboard;
  /** The meeting rooms, where workers work through a question together (see meeting-rooms.ts). */
  readonly meetings: MeetingRooms;
  /** The bookshelf: the project's Markdown files (see docs.ts). */
  readonly docs: Docs;
  /** Settles once the workers whose terminals outlived the last office are picked back up, and the rest woken. */
  readonly ready: Promise<void>;
  readonly dog: Dog;
  /** The basketball by the hoop: who has it, or how it was last thrown. */
  readonly court = new Court();
  /** The cars in the garage: who's in which, and where their drivers have left them. */
  readonly garage = new Garage();
  /** Workers sent home on a map that locks them up (see MapPlan.sendHome). */
  readonly jail: Jail;
  private timer: NodeJS.Timeout;
  /** Stops hearing about the project's issue-source cards (see issuesState). */
  private offWall: () => void;
  /** Pull requests merging, to ring the gong for. */
  private merges = new MergeWatch();
  /** A look for workers whose pull request merged, due shortly (see sendLandedHome). */
  private landedTimer?: NodeJS.Timeout;
  /** Workers across repositories whose worktrees are being checked before they go home. */
  private landing = new Set<string>();
  /**
   * The PR lists of the project's other git repositories (FloorDef.repos with a GitHub
   * remote), by ProjectRepo id, each fetched in that repository's checkout. `github` stays the floor's
   * own repository, exactly as upstream has it; the board shows them all (see pullsState).
   */
  private boards = new Map<string, { board: GitHub; dir: string; remote: string }>();

  constructor(
    readonly def: FloorDef,
    private ctx: FloorContext,
  ) {
    this.id = def.id;
    this.dir = def.dir;
    const dataDir = path.join(def.dir, '.agent-office');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Also for a folder inside some repository: its .agent-office stays out of that repository's commits.
    excludeFromGit(def.dir);
    this.git = isGitFloor(def.dir, ctx.isLocal(def.id));
    this.project = projectInfo(def.dir, def.name, ctx.agentCmd, ctx.agentArgs, this.git);
    this.docs = new Docs(def.dir, this.git);
    // Before the workers and the dog: the back office's desks are only there once it's built.
    this.plan = new FloorPlanStore(dataDir, () => ctx.officeMap?.() !== false);
    this.jail = new Jail(dataDir);
    const prompts = ctx.prompts(def.id);

    // Before the workers, so it hears about the ones who wake up needing input.
    this.dog = new Dog(def.id, dataDir, {
      workers: () => this.workers?.list() ?? [],
      people: () => ctx.peers(this),
      send: (dog) => ctx.emit(this, { t: 'dog', dog }),
      wing: () => this.plan.wing,
      rooms: () => this.plan.rooms, layout: () => this.plan.layout(),
    });

    this.workers = new WorkerManager(
      def.dir,
      dataDir,
      ctx.agentCmd,
      ctx.agentArgs,
      ctx.hook,
      {
        update: (worker) => {
          ctx.emit(this, { t: 'worker.update', worker });
          // Still being built: the first updates come from waking the workers already at their desks.
          this.queue?.onWorker(worker);
          this.closes?.onWorker(worker);
          this.meetings?.onWorker(worker);
          this.dog.onWorker(worker);
          ctx.workerChanged(this, worker);
          // Its turn ended, or whoever had its terminal open closed it: it may be free to go now.
          this.sendLandedHome();
        },
        remove: (workerId, info) => {
          this.changes?.forget(workerId);
          // Sent home on a map that locks workers up: into the dungeon with it, for good (a meeting's
          // workers aren't sent home when it's over, just let go).
          const jail = info && !info.meeting && ctx.locksUp() ? this.jail.add({ ...info, workedMs: workedMs(info) }) : undefined;
          ctx.emit(this, { t: 'worker.remove', workerId, ...(jail ? { jail } : {}) });
          this.queue?.onWorkerGone(workerId);
          this.meetings?.onWorkerGone(workerId);
          this.dog.onWorkerGone(workerId);
          ctx.workerChanged(this, workerId);
        },
        data: (workerId, data, viewers) => ctx.termData(workerId, data, viewers),
        screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame }, true),
        toast: (text, level) => ctx.toast(this, text, level),
      },
      ctx.ledger,
      ctx.capacity,
      prompts,
      ctx.runAs,
      ctx.dshProfile,
    );
    this.workers.wing = () => this.plan.wing; this.workers.removed = () => this.plan.seatsOut();

    this.github = new GitHub(
      def.dir,
      (state) => void (wallIssues(this.id) ? undefined : ctx.emit(this, { t: 'gh.issues', state })), // not while the board shows the project's issue sources
      (state) => {
        // The board shows every repository of the project (the same list as upstream's for one).
        ctx.emit(this, { t: 'gh.pulls', state: this.pullsState() });
        this.queue?.onPulls(state.items);
        this.closes?.onPulls(state.items);
        if (state.loading || state.error) return;
        this.boardPulled();
      },
      { off: this.git ? undefined : NOT_GIT },
    );
    // The 📋 task queue seats workers by itself: it watches the workers and links PRs from GitHub.
    this.closes = new WorkerCloses(this, ctx);
    this.queue = new TaskQueue(dataDir, this.workers, !!this.project.branch, queueEvents(this, ctx));

    // Meetings seat their own workers round the meeting room's table and run them round by round.
    const workers = this.workers;
    this.meetings = new MeetingRooms(
      def.dir,
      dataDir,
      {
        defaultProvider: this.workers.defaultProvider,
        get officeDefault() {
          return workers.officeDefault;
        },
        list: () => this.workers.list(),
        seat: (deskId, by, prompt, provider, model, effort, meeting, owner) => this.workers.spawn(deskId, by, prompt, false, 'agent', provider, model, effort, meeting, owner),
        prompt: (id, text, by) => this.workers.prompt(id, text, by),
        write: (id, data, by) => this.workers.write(id, data, by),
        // With why it goes (see WorkerManager.kill).
        kill: (id, intent) => this.workers.kill(id, undefined, undefined, undefined, intent),
      },
      this.project.branch ? new Worktrees(def.dir) : undefined,
      {
        update: (state) => ctx.emit(this, { t: 'meeting', state }),
        toast: (text, level) => ctx.toast(this, text, level),
        hiringPaused: () => ctx.ledger.hiringPaused,
        postReview: (pr, file, owner) => {
          const as = this.github.hosted ? undefined : ctx.ghAs(owner); // a repository elsewhere posts with its host's credentials (GitHub.review)
          return typeof as === 'string' ? Promise.reject(new Error(as)) : this.github.review(pr, file, as, owner);
        },
        prompt: (id) => prompts.text(id),
      },
      // The office's wing rooms are only there once the floor's built out that far; another map's are all there.
      () => {
        const all = ctx.meetingRooms();
        return all === MEETING_ROOMS ? builtMeetingRooms(all, this.plan.rooms) : all;
      },
    );

    // What each worker changed, for the Changes window at its desk (see changes.ts).
    this.changes = new Changes(
      def.dir,
      this.project.branch,
      (workerId, repo) => {
        const w = this.workers.get(workerId);
        if (!w) return undefined;
        if (!repo) return { name: w.name, cwd: w.worktree ? worktreeDir(def.dir, w.worktree.path) : def.dir, rel: w.worktree?.path ?? '', worktreeBase: w.worktree?.base, ...(this.git ? {} : { noGit: true }) };
        // One of the other floors' repositories it works in: diffed against, and PRs opened against, that floor's branch.
        const r = w.repos?.find((x) => x.floor === repo);
        if (!r) return undefined;
        const other = ctx.floor(r.floor);
        // One of this project's own other repositories (a synthetic `<floor>~<repo>` id).
        const board = this.boardOf(r.floor);
        return {
          name: w.name,
          cwd: worktreeDir(def.dir, r.path),
          rel: r.path,
          worktreeBase: r.base,
          baseBranch: r.from ?? null,
          openPull: (branch) => (other ? openPull(other, branch) : board ? openPullIn(board.pulls.items, branch) : undefined),
          refreshGitHub: () => void (other ? other.github.refresh() : board?.refresh()),
        };
      },
      (branch) => openPull(this, branch),
      {
        state: (state, ids) => ctx.changes(state, ids),
        toast: (text, level) => ctx.toast(this, text, level),
        refreshGitHub: () => void this.github.refresh(),
      },
    );

    this.decor = new Decor(dataDir);
    this.jukebox = new Jukebox(dataDir);
    this.whiteboard = new Whiteboard(dataDir);
    this.ready = this.workers.start();

    void this.github.refresh();
    this.refreshBoards();
    // The issues board hears when the project's issue-source cards change.
    this.offWall = onWallIssues(this.id, () => ctx.emit(this, { t: 'gh.issues', state: this.issuesState() }));
    // A floor with people on it, or work under way, keeps its boards fresh; the others check in now and then.
    this.timer = setInterval(() => {
      if (this.active() || Date.now() - this.github.issues.fetchedAt > IDLE_REFRESH_MS) {
        void this.github.refresh();
        this.refreshBoards();
      }
      if (this.active()) watchWall(this.id);
    }, REFRESH_MS);
  }

  /** Pull request `n` merged (`by` someone, from the PR window): the gong rings, once per PR. `repo` when it's in another of the project's repositories. */
  merged(n: number, by?: string, repo?: string) {
    if (this.merges.ring(n, this.otherRepo(repo))) this.ctx.emit(this, { t: 'gong', why: 'merged', pr: n, by });
  }

  // --- the issues board from the project's issue sources --------------------------------

  /**
   * The issues board's list: the cards of the project's issue sources (Settings → Issue sources) when
   * it has any, else upstream's, the floor's own repository's.
   */
  issuesState(): GhState<GhIssue> {
    return wallIssues(this.id) ?? this.github.issues;
  }

  /** A card's issue as a key: its own, else the floor's repository's issue `n` (`gh:owner/repo#n`). */
  cardRef(issue: number | undefined, key: string | undefined): string | undefined {
    const repo = this.def.repo ?? (this.git ? checkoutRepo(this.dir) : undefined);
    return key ?? (issue && repo ? ghIssueKey(repo, issue) : undefined);
  }

  /**
   * Assigns a card's issue on GitHub to `as` (else the office's gh): one of the floor's own issues as
   * upstream does, another repository's by its key, and moves it to In progress on the project's boards.
   * A card that isn't a GitHub issue (Jira, a draft) is left be. Resolves to why not, or nothing.
   */
  async claimCard(issue: number | undefined, key: string | undefined, as?: GhAs): Promise<string | undefined> {
    // A project's draft has no assignee, only a Status.
    if (key?.startsWith('ghp:')) {
      void progressIssue(this.id, key, as?.env).then((w) => w && this.ctx.toast(this, `📋 ${w}`, 'warn'));
      return undefined;
    }
    // The issue is the one the key names, whatever number came with it; without a key, the floor's own repository's.
    const ref = this.cardRef(issue, key);
    const gh = parseGhKey(ref);
    if (!ref || !gh) return undefined;
    const err = isPrimaryIssue({ number: gh.number, key: ref }, this.def.repo) ? await this.github.claim(gh.number, as) : await claimGhKey(ref, this.dir, as?.env);
    // The board's Status moves even when the assignment failed (it may need other rights): both are said.
    void progressIssue(this.id, ref, as?.env).then((w) => w && this.ctx.toast(this, `📋 ${w}`, 'warn'));
    return err;
  }

  /**
   * A card's key as a client sent it, when it's one of the cards on this floor's board from the
   * project's issue sources, or an issue the project knows within their scope (browsed or acted on,
   * though the filters keep it off the board); anything else is dropped, so nobody can have an issue
   * claimed (or queued) that the project doesn't know.
   */
  cardKey(v: unknown): string | undefined {
    if (typeof v !== 'string' || !v) return undefined;
    return wallIssues(this.id)?.items.some((i) => i.key === v) || wallKnows(this.id, v) ? v : undefined;
  }

  // --- the project's other repositories' pull requests --------------------------------

  /**
   * The PR board's list: the floor's own repository's pull requests and, on a project with several,
   * each other one's, all marked with their repository (GhPull.repo); one repository gets upstream's
   * list. `repos` names every repository (the floor's own first), so one without PRs gets a tab too.
   */
  pullsState(): GhState<GhPull> {
    const own = this.github.pulls;
    if (!this.boards.size) return own;
    const states = [...this.boards.values()].map((b) => b.board);
    const errors = [own.error, ...states.map((b) => b.pulls.error && `${b.nameWithOwner}: ${b.pulls.error}`)].filter(Boolean);
    return {
      items: [...own.items.map((p) => (this.def.repo && !p.repo ? { ...p, repo: this.def.repo } : p)), ...states.flatMap((b) => b.pulls.items)],
      fetchedAt: Math.max(own.fetchedAt, ...states.map((b) => b.pulls.fetchedAt)),
      loading: own.loading || states.some((b) => b.pulls.loading),
      ...(own.viewer ? { viewer: own.viewer } : {}),
      // The floor's own board lists the repository GitHub.target names (FloorDef.repo, else the origin); the others are projectRepos'.
      repos: uniqueRepos([this.def.repo ?? (this.git ? checkoutRemote(this.dir) : undefined), ...projectRepos(this.def).filter((r) => !r.primary).map((r) => r.remote)]),
      ...(errors.length ? { error: errors.join(' · ') } : {}),
    };
  }

  /** The GitHub of one of the project's repositories, by owner/name: the floor's own for none (or its own name). */
  githubFor(repo?: string): GitHub | undefined {
    if (!repo || sameRepo(repo, this.def.repo) || sameRepo(repo, this.github.hosted?.id)) return this.github;
    for (const b of this.boards.values()) if (sameRepo(b.remote, repo)) return b.board;
    return undefined;
  }

  /**
   * The pull requests of a floor a worker works in, by the RepoSource.floor it has for it: another
   * floor's own list, or one of a project's other repositories (`<floor>~<repo>`, see kanban/projects.ts).
   */
  pullsOf(id: string): GhPull[] | undefined {
    const synthetic = parseRepoFloorId(id);
    if (!synthetic) return this.ctx.floor(id)?.github.pulls.items;
    const floor = synthetic.floor === this.id ? this : this.ctx.floor(synthetic.floor);
    return floor?.boards.get(synthetic.repo)?.board.pulls.items;
  }

  private boardOf(id: string): GitHub | undefined {
    const synthetic = parseRepoFloorId(id);
    return synthetic?.floor === this.id ? this.boards.get(synthetic.repo)?.board : undefined;
  }

  /** undefined for the floor's own repository, which MergeWatch keys without one. */
  private otherRepo(repo: string | undefined): string | undefined {
    return repo && !sameRepo(repo, this.def.repo) ? repo : undefined;
  }

  /** Follows the project's repositories (they can change while the floor is open), then asks GitHub about each. */
  private refreshBoards() {
    const want = new Map(projectRepos(this.def).filter((r) => !r.primary && r.kind === 'git' && r.remote).map((r) => [r.id, r]));
    for (const [id, b] of this.boards) {
      const r = want.get(id);
      if (r && r.dir === b.dir && r.remote === b.remote) continue;
      b.board.stop();
      this.boards.delete(id);
    }
    for (const [id, r] of want) {
      if (this.boards.has(id)) continue;
      const board = new GitHub(r.dir, () => {}, (state) => {
        this.ctx.emit(this, { t: 'gh.pulls', state: this.pullsState() });
        if (!state.loading && !state.error) this.boardPulled();
      }, { nameWithOwner: r.remote, pullsOnly: true });
      this.boards.set(id, { board, dir: r.dir, remote: r.remote! });
    }
    for (const b of this.boards.values()) void b.board.refresh();
  }

  /** A fresh list of one of the project's repositories came back: branches, gongs and workers whose PRs merged. */
  private boardPulled() {
    // A worker may have opened one from a branch it made itself, mid-turn or from a shell.
    void this.workers.syncBranches();
    // The floor's own PRs without a repository, the others with theirs: one watch, keyed by both.
    const watched = [...this.github.pulls.items, ...[...this.boards.values()].flatMap((b) => b.board.pulls.items)];
    for (const p of this.merges.look(watched)) {
      this.ctx.toast(this, `🎉 PR ${p.repo ? `${p.repo}#` : '#'}${p.number} merged: ${p.title}`);
      this.merged(p.number, undefined, p.repo);
    }
    this.sendLandedHome();
    this.ctx.pullsChanged(this);
    // The tasks' linked pull requests take the states on the board.
    floorPulled(this);
  }

  /**
   * With ⚙️ Settings' *go home once merged* on, sends home every worker whose pull request merged,
   * once it's at rest and nobody has its terminal open, deleting its worktree and branch unless they
   * hold work that isn't on GitHub. Called whenever that might have changed; it looks a moment later,
   * once for a burst of calls, and not from inside the event that prompted it.
   */
  sendLandedHome() {
    if (this.landedTimer || !this.ctx.leaveOnMerge()) return;
    this.landedTimer = setTimeout(() => {
      this.landedTimer = undefined;
      if (!this.ctx.leaveOnMerge()) return;
      const pullsOf = (id: string) => this.pullsOf(id);
      for (const landed of landedWorkers(this.workers.list(), this.github.pulls.items, this.queue.state().tasks, pullsOf)) {
        const { worker, head, heads } = landed;
        if (!worker.repos?.length) {
          this.goHome(worker, `PR #${landed.pr} merged`, head);
          continue;
        }
        // Across repositories, one PR can merge before another repository's work even has one:
        // it goes once nothing is left that its merged PRs didn't deliver.
        if (this.landing.has(worker.id)) continue;
        this.landing.add(worker.id);
        void this.workers.holdsWork(worker.id, head, heads).catch(() => true).then((held) => {
          this.landing.delete(worker.id);
          if (!held && this.workers.get(worker.id) === worker) this.goHome(worker, `its pull requests merged (${landed.prs?.join(', ')})`, head, heads);
        });
      }
    }, LANDED_DELAY_MS);
  }

  /**
   * Whether a worker's work landed: a pull request of its merged and none is open, on this floor
   * and, for a worker across repositories, on the others too (see landedWork).
   */
  landed(worker: WorkerInfo): Landed | undefined {
    return landedWork(worker, this.github.pulls.items, this.queue.state().tasks, (id) => this.pullsOf(id));
  }

  /**
   * Sends a worker home as someone asked (not by itself, see sendLandedHome): with no `cleanup`, its
   * worktree and branch go unless they hold work, where what its merged pull requests delivered
   * doesn't count. Resolves with the line about its worktree.
   */
  sendHome(workerId: string, cleanup?: WorktreeCleanup, intent?: DepartureIntent): Promise<{ note?: string; error?: string }> {
    const info = this.workers.get(workerId);
    const landed = info && this.landed(info);
    // `intent` says who sent it and why (see WorkerManager.kill).
    return this.workers.kill(workerId, cleanup, landed?.head, landed?.heads, intent);
  }

  private goHome(worker: WorkerInfo, why: string, head?: string, heads?: Record<string, string | undefined>) {
    // leave-on-merge's departure (see WorkerManager.kill).
    const done = this.workers.kill(worker.id, undefined, head, heads, { by: 'Leave-on-merge', reason: 'merged' });
    this.ctx.toast(this, `🏠 ${worker.name} went home: ${why}`);
    void done.then(({ note, error }) => {
      if (note) this.ctx.toast(this, note);
      if (error) this.ctx.toast(this, error, 'warn');
    });
  }

  /** Someone just walked in: boards that haven't been looked at in a while get fetched again. */
  arrived() {
    if (Date.now() - Math.max(this.github.issues.fetchedAt, this.github.pulls.fetchedAt) > REFRESH_MS) {
      void this.github.refresh();
      this.refreshBoards();
    }
  }

  private active(): boolean {
    return this.ctx.people(this) > 0 || this.ctx.lent(this) || this.workers.list().some((w) => isBusy(w.status)) || this.queue.state().tasks.some((t) => t.status !== 'done') || this.meetings.running();
  }

  info(): FloorInfo {
    const ws = this.workers.list();
    return {
      id: this.id,
      name: this.def.name,
      repo: this.def.repo,
      dir: this.dir,
      branch: this.project.branch,
      palette: this.def.palette,
      addedBy: this.def.addedBy,
      addedAt: this.def.addedAt,
      workers: ws.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length,
      busy: ws.filter((w) => w.status === 'working').length,
      waiting: ws.filter((w) => w.kind === 'agent' && waitingOnSomeone(w)).length,
      people: this.ctx.people(this),
      wing: this.plan.wing,
      rooms: this.plan.rooms,
    };
  }

  /** With `keep` (a restart), the workers' terminals keep running for the next office to pick up. */
  shutdown(keep = false) {
    clearInterval(this.timer);
    this.offWall();
    clearTimeout(this.landedTimer);
    this.dog.stop();
    this.github.stop();
    for (const b of this.boards.values()) b.board.stop();
    this.queue.shutdown();
    this.meetings.shutdown();
    this.changes.stop();
    this.whiteboard.flush();
    this.workers.shutdown(keep);
  }
}
