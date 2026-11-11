// The few styles the kanban's pieces need inside upstream's pages (the 3D office and /lite load
// style.css, not kanban.css): the repository chip, filter and tabs on the boards, the PR review picker and
// the task worker's message dialog, the queue board's kanban toggle.
// Put in once, the first time one of them is drawn.

const CSS = `
.repo-chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; font-size: var(--fs-2xs); font-weight: var(--fw-heavy); border: var(--bw-sm) solid var(--ink); border-radius: var(--radius-pill); background: var(--tint-blue); white-space: nowrap; }
.board-repo { height: 36px; padding: 0 8px; font: var(--fw-bold) var(--fs-sm) var(--font); color: var(--text); background: var(--field); border: var(--bw) solid var(--ink); border-radius: var(--radius-sm); }
/* The repository tabs are the shared strip (styles/kit-modal.css): this is only where they sit and how they scroll. */
.board-repo-tabs { padding: 0 12px; overscroll-behavior-x: contain; scrollbar-width: thin; background: var(--paper-2); }
.board-pr-bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 0 12px 0 0; background: var(--paper-2); border-bottom: var(--bw) solid var(--ink); }
.board-pr-bar > .board-repo-tabs { flex: 1 1 auto; min-width: 0; align-self: flex-end; box-shadow: none; background: none; }
.board-who { flex: none; display: inline-flex; margin: 8px 0 8px auto; border: var(--bw) solid var(--ink); border-radius: var(--radius-sm); overflow: hidden; background: var(--field); }
.board-who-opt { padding: 4px 10px; font: var(--fw-bold) var(--fs-sm) var(--font); color: var(--text); white-space: nowrap; background: none; border: 0; cursor: pointer; }
.board-who-opt + .board-who-opt { border-left: var(--bw-sm) solid var(--ink); }
.board-who-opt:hover:not(:disabled):not([aria-checked="true"]) { background: var(--paper); }
.board-who-opt[aria-checked="true"] { color: var(--text-on-strong); background: var(--strong); }
.board-who-opt:disabled { color: var(--muted); cursor: not-allowed; }
.board-who-opt:focus-visible { outline: var(--focus-ring); outline-offset: -3px; }
.board-pr-empty { flex: none; padding: 8px 12px; font-size: var(--fs-sm); font-weight: var(--fw-bold); background: var(--paper); border-bottom: var(--bw) solid var(--ink); }
@media (max-width: 560px) { .board-pr-bar { padding-left: 12px; } .board-pr-bar > .board-repo-tabs { flex-basis: 100%; padding-left: 0; padding-right: 0; } .board-who { margin: 0 0 8px; } }
.kb-scope-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); }
.kb-scope-bar select { height: 32px; padding: 0 8px; font: var(--fw-bold) var(--fs-sm) var(--font); border: var(--bw-sm) solid var(--ink); border-radius: var(--radius-md); background: var(--field); }
.kb-scope-contract { margin: 8px 0 0; }
.kb-scope-contract summary { cursor: pointer; font-size: var(--fs-xs); font-weight: var(--fw-heavy); }
.kb-scope-contract pre { margin: 6px 0 0; padding: 8px; white-space: pre-wrap; font-size: var(--fs-xs); background: var(--field-off); border: var(--bw-sm) dashed var(--ink); border-radius: var(--radius-md); color: var(--muted); }
/* The queue board's kanban toggle (ui/queue.ts) takes a row of its own under the text. */
.queue-add > .kanban-queue-toggle { flex: 1 1 100%; min-width: 0; }
.queue-kanban-head { display: flex; align-items: center; gap: 6px; }
.queue-kanban-head > svg { flex: none; }
.queue-kanban-link { margin-left: auto; font-size: var(--fs-md); }
`;

export function officeCss() {
  if (document.getElementById('kb-office-css')) return;
  const el = document.createElement('style');
  el.id = 'kb-office-css';
  el.textContent = CSS;
  document.head.append(el);
}
