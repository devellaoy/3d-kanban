// The few styles the kanban's pieces need inside upstream's pages (the 3D office and /lite load
// style.css, not kanban.css): the repository chip and filter on the boards, and the PR review picker.
// Put in once, the first time one of them is drawn.

const CSS = `
.repo-chip { display: inline-flex; align-items: center; padding: 0 6px; font-size: 11px; font-weight: 900; border: 2px solid var(--ink); border-radius: 999px; background: #e7f0ff; white-space: nowrap; }
.board-repo { height: 36px; padding: 0 8px; font: 800 13px var(--font); color: var(--ink); background: #fff; border: 3px solid var(--ink); border-radius: 12px; }
.modal.kb-pr-picker { width: min(640px, 100%); }
.kb-pr-picker .body { display: flex; flex-direction: column; gap: 8px; }
.kb-pr-picker h5 { margin: 8px 0 2px; font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.kb-pr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.kb-pr-list li label { display: flex; align-items: center; gap: 8px; margin: 0; padding: 6px 8px; border: 2px solid var(--ink); border-radius: 10px; background: #fff; font-size: 13px; cursor: pointer; }
.kb-pr-list li.this label { background: #fffbe6; }
.kb-pr-list input { width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
.kb-pr-list .kb-pr-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-pr-picker .kb-note { margin: 0; font-size: 12px; font-weight: 700; color: var(--muted); }
.kb-pr-picker .kb-err { margin: 0; padding: 6px 8px; border: 2px solid var(--bad); border-radius: 10px; background: #fff0f3; font-size: 13px; font-weight: 800; }
.kb-scope-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; font-weight: 800; }
.kb-scope-bar select { height: 32px; padding: 0 8px; font: 800 13px var(--font); border: 2px solid var(--ink); border-radius: 10px; background: #fff; }
.kb-scope-contract { margin: 8px 0 0; }
.kb-scope-contract summary { cursor: pointer; font-size: 12px; font-weight: 900; }
.kb-scope-contract pre { margin: 6px 0 0; padding: 8px; white-space: pre-wrap; font-size: 12px; background: #f3f1ee; border: 2px dashed var(--ink); border-radius: 10px; color: var(--muted); }
`;

export function officeCss() {
  if (document.getElementById('kb-office-css')) return;
  const el = document.createElement('style');
  el.id = 'kb-office-css';
  el.textContent = CSS;
  document.head.append(el);
}
