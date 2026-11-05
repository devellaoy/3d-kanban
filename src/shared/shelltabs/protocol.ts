// Shell tabs: extra terminals beside a worker's own, each a plain login shell in the worker's
// folder (its worktree, workspace or the project). They run on the office's machine, are shared by
// everyone who opens that worker's window, and end with their × , `exit`, the worker going home or
// the office restarting. Visitors (multiplayer) get none of these messages.

/** One shell tab of a worker. */
export interface ShellTab {
  id: string;
  workerId: string;
  /** "🐚 Shell 1" and so on. */
  title: string;
  /** Who opened it. */
  by: string;
  at: number;
}

export type ShellTabClientMsg =
  /** A worker's window opened: send its tabs, and every change to them until `shelltab.unlist`. */
  | { t: 'shelltab.list'; workerId: string }
  | { t: 'shelltab.unlist'; workerId: string }
  /** New tab: a shell in the worker's folder. */
  | { t: 'shelltab.open'; workerId: string }
  /** Its ×: the shell and whatever runs in it end. */
  | { t: 'shelltab.close'; tabId: string }
  /** Watch a tab's terminal (answered with `shelltab.snapshot`, then `shelltab.data`). */
  | { t: 'shelltab.attach'; tabId: string }
  | { t: 'shelltab.detach'; tabId: string }
  | { t: 'shelltab.input'; tabId: string; data: string }
  | { t: 'shelltab.resize'; tabId: string; cols: number; rows: number };

export type ShellTabServerMsg =
  /** A worker's tabs, to everyone who listed them; `opened` only to whoever just opened that one, so their window shows it. */
  | { t: 'shelltab.tabs'; workerId: string; tabs: ShellTab[]; opened?: string }
  | { t: 'shelltab.snapshot'; tabId: string; data: string; cols: number; rows: number }
  | { t: 'shelltab.data'; tabId: string; data: string }
  /** The tab's size changed, or someone started or stopped watching it: sent to every viewer. Only a lone viewer sizes the shell by resizing their window; with more, they follow `cols` x `rows` (typing claims it). */
  | { t: 'shelltab.size'; tabId: string; cols: number; rows: number; viewers: number };
