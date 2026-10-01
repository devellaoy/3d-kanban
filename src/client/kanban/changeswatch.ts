// Who the task's Changes views (changesview.ts) follow live, counted: the office keeps one watch per
// connection, worker and repository, so the kanban page's embedded view and a Changes window on the
// same worker share it, and only the last one to let go unwatches. After a reconnect the office has
// forgotten them all: the welcome watches each again (upstream re-watches its own window the same way).

import type { Net } from '../net';
import { store } from '../state';
import { onChangesMessage } from '../ui/changes';

const held = new Map<string, { net: Net; workerId: string; repo?: string; n: number }>();
let listening = false;

const keyOf = (workerId: string, repo?: string) => `${workerId}\n${repo ?? ''}`;

/** Follows a worker's checkout (`repo`: upstream's floor id, none for its own floor's) until the returned function is called. */
export function holdChangesWatch(net: Net, workerId: string, repo?: string): () => void {
  if (!listening) {
    listening = true;
    onChangesMessage((msg) => {
      if (msg.t !== 'welcome') return;
      for (const w of held.values()) if (store.workers.has(w.workerId)) w.net.send({ t: 'changes.watch', workerId: w.workerId, repo: w.repo });
    });
  }
  const key = keyOf(workerId, repo);
  const w = held.get(key);
  if (w) w.n++;
  else held.set(key, { net, workerId, repo, n: 1 });
  // Asked again even when shared, so the newcomer gets the state now rather than at the next change.
  net.send({ t: 'changes.watch', workerId, repo });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const h = held.get(key);
    if (!h || --h.n > 0) return;
    held.delete(key);
    net.send({ t: 'changes.unwatch', workerId, repo });
  };
}
