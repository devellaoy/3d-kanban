// The store's slice for the kanban's lounge figures (shared/kanban/lounge.ts): the tasks on hold on the
// floor you're on, from the floor you arrive on and from each kanban.lounge for it. Last in SLICES.
import type { LoungeFigure } from '../../shared/kanban/lounge';
import type { Slice } from '../state/store';

declare module '../state/store' {
  interface Store {
    /** The figures of the tasks on hold on your floor, shown in its lounge (kanban/lounge3d.ts). */
    kanbanLounge: LoungeFigure[];
  }
  interface Topics {
    kanbanLounge: true;
  }
}

export const kanbanLounge: Slice = {
  init(s) {
    s.kanbanLounge = [];
  },
  on: {
    'kanban.lounge'(s, m) {
      if (m.floor !== s.floor) return;
      s.kanbanLounge = m.figures;
      return ['kanbanLounge'];
    },
  },
  enter(s, v) {
    // Optional on the wire: an office that has no kanban sends none.
    s.kanbanLounge = v.kanbanLounge ?? [];
    return ['kanbanLounge'];
  },
};
