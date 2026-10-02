// Which other floor the phone follows (phone.watch): the floor whose workers the phone lists, or the one of
// the worker whose terminal is open (so the window keeps updating after the phone closes). Never your own
// floor: store.workers has it. One message per change; resent after a reconnect, as the server forgets it.
import type { Net } from '../net';
import { store } from '../state';
import { onModalChange } from '../ui/dom';
import { openTerminalFor } from '../ui/terminal';
import { wantedFloor } from './wanted';

export interface PhoneWatch {
  /** The phone shows `floor`'s workers (null: it doesn't any more). */
  list(floor: string | null): void;
}

export function phoneWatch(net: Net): PhoneWatch {
  let listed: string | null = null;
  /** What the server was last told to follow. */
  let sent: string | null = null;

  /** The floor that must be followed, if any. */
  const wanted = () => wantedFloor(listed, openTerminalFor(), store);

  const sync = () => {
    const floor = wanted();
    if (floor !== sent) {
      sent = floor;
      net.send({ t: 'phone.watch', floor });
    }
    // What's held is of the floor followed, never another (a late snapshot of the last one, or one we stopped following).
    if (store.phoneFloor && store.phoneFloor.floor !== floor) {
      store.phoneFloor = null;
      store.emit('phoneWorkers');
    }
  };

  net.onMessage((m) => {
    if (m.t !== 'welcome') return;
    sent = null; // a new connection follows nothing yet
    sync();
  });
  store.on('floor', sync);
  store.on('floors', sync);
  store.on('phoneWorkers', sync);
  // The window sets itself up after it opens, so what it's on is only known a moment later.
  onModalChange(() => queueMicrotask(sync));

  return {
    list(floor) {
      listed = floor;
      sync();
    },
  };
}
