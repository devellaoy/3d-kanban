// The kanban bar's 🔀 Pull requests: the same board the 3D office and the 2D view have. The office
// keeps a floor's pull requests for the floor a page is on, so with a project picked the page goes to
// that project's floor first (as picking the project does anyway), and "All projects" shows the board
// of whichever floor the page is on.

import type { Net } from '../net';
import { store } from '../state';
import { toast } from '../ui/dom';
import { openBoard } from '../ui/boards';
import type { BoardActions } from '../ui/github/prompts';
import { goToFloor } from '../ui/github/floor-trip';
import { pullsTarget } from './model';

let going = false;

/** Opens the pull requests board of the picked project's floor (see above). */
export function openPulls(net: Net, project: string | null, actions: () => BoardActions) {
  const target = pullsTarget(project, store.floor, store.floors);
  if (target === 'none') return toast(project ? 'That project has no floor open: open it in the 3D office first.' : 'No projects yet: add one in Settings → Projects, or at the elevator in the 3D office.', 'warn');
  if (target === 'here') {
    // Under "All projects" nothing else says whose board this is.
    if (!project) toast(`${store.floors.find((f) => f.id === store.floor)?.name ?? store.floor}’s pull requests`);
    return openBoard('pulls', net, actions());
  }
  // A second click while the page is on its way opens nothing more.
  if (going) return;
  going = true;
  void goToFloor(project!, (floor) => net.send({ t: 'floor.go', floor })).then((ok) => {
    going = false;
    if (ok) openBoard('pulls', net, actions());
    else toast('Couldn’t get to that floor', 'error');
  });
}
