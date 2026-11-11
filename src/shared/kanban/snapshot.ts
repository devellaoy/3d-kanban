// The board as it is now (kanban.snapshot): the answer to kanban.subscribe and to a one-off
// kanban.snapshot, one of KanbanServerMsg (protocol.ts).

import type { KanbanProjectInfo, KanbanSettings, KanbanTaskCard, SecretStatus } from './types.js';

export interface KanbanSnapshotMsg {
  t: 'kanban.snapshot';
  rid?: string;
  project: string | null;
  /**
   * The archived tasks are in `tasks` too, as the request asked. A board takes only the snapshots that
   * match its own archive setting: the bus hands it the one-off ones other views ask for as well.
   */
  includeArchived?: boolean;
  tasks: KanbanTaskCard[];
  projects: KanbanProjectInfo[];
  settings: KanbanSettings;
  secrets: SecretStatus;
  me: { admin: boolean; name: string };
}
