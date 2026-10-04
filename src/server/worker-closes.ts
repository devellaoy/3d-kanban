// The closing line of a plain agent worker's pull request. A worker with an issue (a card handed to
// it, a hire for an issue; not a kanban task's or a queue task's, which have their own checks) is
// asked in its prompt to write "Closes #n"; this checks afterwards, once the worker is at rest and
// the floor's PR list has an open PR from its worktree branch, and adds the line when it's missing.
// Once per pull request and turn of the worker (a new turn may rewrite the description), a few tries
// while gh fails. Edited as the worker's owner, or with the office's gh only where that is theirs.
import type { GhPull, WorkerInfo } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import { parseGhKey } from '../shared/kanban/issuecard.js';
import type { Floor, FloorContext } from './floor.js';
import { ensureClosingRef, ghEditor } from './kanban/integrations/pulls/closes.js';
import type { GhRunner } from './kanban/integrations/issues/source.js';
import { workerIssueKey } from './kanban/engine/worker-issue.js';

/** How many times a pull request is asked about while gh fails. */
const TRIES = 3;

interface Check {
  url: string;
  done: boolean;
  tries: number;
  asking?: boolean;
}

export class WorkerCloses {
  private checks = new Map<string, Check>();
  private seen = new Map<string, string>();
  /** Workers whose handed issue went with its pull request (merged or closed): nothing more is edited for them. */
  private retired = new Set<string>();
  /** What was told about a PR, so a warning comes once and not after each turn. */
  private told = new Set<string>();

  constructor(
    private floor: Floor,
    private ctx: Pick<FloorContext, 'ghAs' | 'toast'>,
    private run?: GhRunner,
  ) {}

  /** A worker changed: a turn it starts makes its PR's description due for another check. */
  onWorker(info: WorkerInfo) {
    if (this.seen.get(info.id) === info.status) return;
    this.seen.set(info.id, info.status);
    const c = this.checks.get(info.id);
    if (c && isBusy(info.status)) (c.done = false), (c.tries = 0);
  }

  /** Fresh pull requests from GitHub (the floor's own repository's). */
  onPulls(pulls: GhPull[]) {
    const workers = this.floor.workers.list();
    for (const id of [...this.checks.keys()]) if (!workers.some((w) => w.id === id)) (this.checks.delete(id), this.seen.delete(id));
    for (const id of [...this.retired]) if (!workers.some((w) => w.id === id)) this.retired.delete(id);
    const queued = new Set(this.floor.queue.state().tasks.map((t) => t.workerId));
    for (const info of workers) {
      const branch = info.worktree?.branch;
      if (!branch || info.kanban || queued.has(info.id) || info.kind !== 'agent' || this.retired.has(info.id)) continue;
      // The issue goes with the first pull request: once the one being checked is merged or closed, a later one isn't the issue's.
      const c0 = this.checks.get(info.id);
      const gone = c0 && pulls.find((p) => p.url === c0.url && (p.state === 'MERGED' || p.state === 'CLOSED'));
      if (gone) {
        (this.retired.add(info.id), this.checks.delete(info.id));
        delete info.issueKey;
        continue;
      }
      if (isBusy(info.status)) continue;
      const pull = pulls.find((p) => p.state === 'OPEN' && p.headRefName === branch && !p.isCrossRepository);
      const ref = pull && workerIssueKey(undefined, this.floor, info);
      if (!pull || !ref || !parseGhKey(ref)) continue;
      let c = this.checks.get(info.id);
      if (!c || c.url !== pull.url) this.checks.set(info.id, (c = { url: pull.url, done: false, tries: 0 }));
      if (c.done || c.asking || c.tries >= TRIES) continue;
      c.tries++;
      c.asking = true;
      void this.check(info, c, pull, ref).finally(() => (c!.asking = false));
    }
  }

  private async check(info: WorkerInfo, c: Check, pull: GhPull, ref: string) {
    const issue = ref.replace(/^gh:/, '');
    const tell = (text: string) => {
      if (this.told.has(`${pull.url} ${text}`)) return;
      if (this.told.size > 200) this.told.clear();
      this.told.add(`${pull.url} ${text}`);
      this.ctx.toast(this.floor, `${info.name}: ${text}`, 'warn');
    };
    const editor = ghEditor(this.ctx.ghAs(this.floor.workers.ownerOf(info.id)));
    if ('warning' in editor) return (c.done = true), tell(`not checking that ${pull.url} closes ${issue}: ${editor.warning}`);
    try {
      const r = await ensureClosingRef({ prUrl: pull.url, ref, cwd: this.floor.dir, env: editor.env, run: this.run });
      if (r.retry) return c.tries >= TRIES ? tell(r.warning ?? `couldn't check that ${pull.url} closes ${issue}`) : undefined;
      c.done = true;
      if (r.warning) tell(r.warning);
    } catch (err) {
      console.error("agent-office: adding the closing line to a worker's pull request failed:", err);
    }
  }
}
