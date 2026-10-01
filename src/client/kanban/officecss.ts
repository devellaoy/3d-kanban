// The few styles the kanban's pieces need inside upstream's pages (the 3D office and /lite load
// style.css, not kanban.css): the repository chip, filter and tabs on the boards, the PR review picker and
// the task worker's message dialog, the queue board's kanban toggle.
// Put in once, the first time one of them is drawn.

const CSS = `
.repo-chip { display: inline-flex; align-items: center; padding: 0 6px; font-size: var(--fs-2xs); font-weight: var(--fw-heavy); border: var(--bw-sm) solid var(--ink); border-radius: var(--radius-pill); background: var(--tint-blue); white-space: nowrap; }
.board-repo { height: 36px; padding: 0 8px; font: var(--fw-bold) var(--fs-sm) var(--font); color: var(--text); background: var(--field); border: var(--bw) solid var(--ink); border-radius: var(--radius-sm); }
.board-repo-tabs { flex: none; display: flex; gap: 6px; padding: 8px 12px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; background: var(--paper-2); border-bottom: var(--bw) solid var(--ink); }
.board-repo-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 12px; font: var(--fw-bold) var(--fs-sm) var(--font); color: var(--text); white-space: nowrap; background: var(--field); border: var(--bw) solid var(--ink); border-radius: var(--radius-sm); cursor: pointer; }
.board-repo-tab:hover { background: var(--paper); }
.board-repo-tab small { min-width: 22px; padding: 0 6px; font-size: var(--fs-2xs); font-weight: var(--fw-heavy); text-align: center; border-radius: var(--radius-pill); background: var(--paper-2); border: var(--bw-sm) solid var(--ink); }
.board-repo-tab[aria-selected="true"] { color: var(--text-on-strong); background: var(--strong); }
.board-repo-tab[aria-selected="true"] small { color: var(--text); background: var(--field); border-color: var(--field); }
.board-repo-tab:focus-visible { outline: var(--focus-ring); outline-offset: 1px; }
.modal.kb-pr-picker { width: min(640px, 100%); }
.kb-pr-picker .body { display: flex; flex-direction: column; gap: 8px; }
.kb-pr-picker h5 { margin: 8px 0 2px; font-size: var(--fs-xs); font-weight: var(--fw-heavy); text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.kb-pr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.kb-pr-list li label { display: flex; align-items: center; gap: 8px; margin: 0; padding: 6px 8px; border: var(--bw-sm) solid var(--ink); border-radius: 10px; background: var(--field); font-size: var(--fs-sm); cursor: pointer; }
.kb-pr-list li.this label { background: var(--warn-wash); }
.kb-pr-list input { width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
.kb-pr-list .kb-pr-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-pr-picker .kb-note { margin: 0; font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--muted); }
.kb-pr-picker .kb-err { margin: 0; padding: 6px 8px; border: 2px solid var(--bad); border-radius: 10px; background: var(--bad-wash); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
.kb-scope-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); }
.kb-scope-bar select { height: 32px; padding: 0 8px; font: var(--fw-bold) var(--fs-sm) var(--font); border: var(--bw-sm) solid var(--ink); border-radius: 10px; background: var(--field); }
.kb-scope-contract { margin: 8px 0 0; }
.kb-scope-contract summary { cursor: pointer; font-size: var(--fs-xs); font-weight: var(--fw-heavy); }
.kb-scope-contract pre { margin: 6px 0 0; padding: 8px; white-space: pre-wrap; font-size: var(--fs-xs); background: var(--field-off); border: var(--bw-sm) dashed var(--ink); border-radius: 10px; color: var(--muted); }
/* The 📋 queue board's kanban toggle (ui/queue.ts) takes a row of its own under the text. */
.queue-add > .kanban-queue-toggle { flex: 1 1 100%; min-width: 0; }
/* A task worker's P (ui/prompt.ts): three buttons don't fit beside the hint, so the window is wider and the hint gets a row of its own. */
.modal:has(> footer > .kb-raw) { width: min(620px, 100%); }
.modal footer:has(> .kb-raw) { flex-wrap: wrap; row-gap: 8px; }
.modal footer:has(> .kb-raw) > .grow { flex-basis: 100%; }
/* Its title ("💬 Message task #14 (continues the kanban process)") wraps rather than being cut off on a phone. */
.modal:has(> footer > .kb-raw) > header h2 { white-space: normal; overflow-wrap: anywhere; line-height: 1.25; }
`;

export function officeCss() {
  if (document.getElementById('kb-office-css')) return;
  const el = document.createElement('style');
  el.id = 'kb-office-css';
  el.textContent = CSS;
  document.head.append(el);
}
