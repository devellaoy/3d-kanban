// The store's slice for the phone: the workers of one other floor, followed with phone.watch (phone/watch.ts
// decides which). Last in SLICES (state/slices/index.ts).
import type { ProjectInfo, WorkerInfo } from '../../shared/protocol';
import { shownWorker } from '../kanban/status';
import type { Slice } from '../state/store';

/** The floor being followed: everyone on it, and its project (for the providers' names). */
export interface PhoneFloor {
  floor: string;
  workers: Map<string, WorkerInfo>;
  project: ProjectInfo | null;
}

declare module '../state/store' {
  interface Store {
    /** The workers on the floor the phone follows, null when none is (or it is your own floor, which `workers` already has). */
    phoneFloor: PhoneFloor | null;
  }
  interface Topics {
    phoneWorkers: true;
  }
}

export const phone: Slice = {
  init(s) {
    s.phoneFloor = null;
  },
  on: {
    'phone.floor'(s, m) {
      const old = s.phoneFloor?.floor === m.floor ? s.phoneFloor.workers : undefined;
      s.phoneFloor = { floor: m.floor, project: m.project, workers: new Map(m.workers.map((w) => [w.id, shownWorker(w, old?.get(w.id))])) };
      return ['phoneWorkers'];
    },
    'phone.worker'(s, m) {
      if (s.phoneFloor?.floor !== m.floor) return;
      s.phoneFloor.workers.set(m.worker.id, shownWorker(m.worker, s.phoneFloor.workers.get(m.worker.id)));
      return ['phoneWorkers'];
    },
    'phone.workerRemove'(s, m) {
      if (s.phoneFloor?.floor !== m.floor || !s.phoneFloor.workers.delete(m.workerId)) return;
      return ['phoneWorkers'];
    },
  },
};
