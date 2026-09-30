// The kanban page's picture of the board: the cards, the projects, the settings and who you are, as
// the last snapshot and the deltas since say. Views subscribe to topics, like upstream's Store.

import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanProjectInfo, KanbanSettings, KanbanTaskCard, SecretStatus } from '../../shared/kanban/types.js';

export type KanbanTopic = 'tasks' | 'projects' | 'settings' | 'me' | 'snapshot';

export class KanbanStore {
  tasks = new Map<number, KanbanTaskCard>();
  projects: KanbanProjectInfo[] = [];
  settings: KanbanSettings | null = null;
  secrets: SecretStatus = { jira: { configured: false }, apiKey: { configured: false } };
  me = { admin: false, name: '' };
  /** The project the board shows (a floor id), or null for all of them. */
  project: string | null = null;
  includeArchived = false;
  /** A snapshot has come in since the page connected. */
  loaded = false;
  private subs = new Map<KanbanTopic, Set<() => void>>();

  on(topic: KanbanTopic, fn: () => void): () => void {
    let set = this.subs.get(topic);
    if (!set) this.subs.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(topic: KanbanTopic) {
    this.subs.get(topic)?.forEach((fn) => fn());
  }

  projectOf(id: string | undefined): KanbanProjectInfo | undefined {
    return id ? this.projects.find((p) => p.id === id) : undefined;
  }

  /**
   * Takes what a snapshot says about the office (the projects, the settings, who you are) and leaves
   * the board's cards alone: for ⚙️ Settings outside the kanban page, which has no board.
   */
  applyMeta(snap: Pick<Extract<KanbanServerMsg, { t: 'kanban.snapshot' }>, 'projects' | 'settings' | 'secrets' | 'me'>) {
    this.projects = snap.projects;
    this.settings = snap.settings;
    this.secrets = snap.secrets;
    this.me = snap.me;
    for (const t of ['projects', 'settings', 'me'] as KanbanTopic[]) this.emit(t);
  }

  /** Takes in a message from the office; returns whether the board changed. */
  apply(msg: KanbanServerMsg): boolean {
    switch (msg.t) {
      case 'kanban.snapshot':
        // A one-off snapshot of another project (asked for by something else) isn't the board's.
        if (msg.project !== this.project) return false;
        this.tasks = new Map(msg.tasks.map((c) => [c.id, c]));
        this.projects = msg.projects;
        this.settings = msg.settings;
        this.secrets = msg.secrets;
        this.me = msg.me;
        this.loaded = true;
        for (const t of ['projects', 'settings', 'me', 'tasks', 'snapshot'] as KanbanTopic[]) this.emit(t);
        return true;
      case 'kanban.task':
        if (this.project && msg.task.project !== this.project) {
          // Moved to another project: off this board.
          if (!this.tasks.delete(msg.task.id)) return false;
        } else this.tasks.set(msg.task.id, msg.task);
        this.emit('tasks');
        return true;
      case 'kanban.task.removed':
        if (!this.tasks.delete(msg.id)) return false;
        this.emit('tasks');
        return true;
      case 'kanban.projects':
        this.projects = msg.projects;
        this.emit('projects');
        return true;
      case 'kanban.settings':
        this.settings = msg.settings;
        this.secrets = msg.secrets;
        this.emit('settings');
        return true;
    }
    return false;
  }
}

export const kstore = new KanbanStore();
