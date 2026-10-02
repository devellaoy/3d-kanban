// Finding a worker on any floor the page knows: yours (`store.workers`) or the one the phone follows.
import type { ProjectInfo, WorkerInfo } from '../../shared/protocol';
import { store } from './index';

export function findWorker(id: string): WorkerInfo | undefined {
  return store.workers.get(id) ?? store.phoneFloor?.workers.get(id);
}

/** The project of the floor a worker is on, for its provider's name: yours when it's on your floor. */
export function projectOf(id: string): ProjectInfo | null {
  return store.workers.has(id) || !store.phoneFloor?.workers.has(id) ? store.project : store.phoneFloor.project;
}

/** The id of the floor a worker sits on: yours, or the one the phone follows. */
export function floorOfWorker(id: string): string | null {
  return store.workers.has(id) || !store.phoneFloor?.workers.has(id) ? store.floor : store.phoneFloor.floor;
}
