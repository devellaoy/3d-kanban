import './windows.css';
import type { GhIssue, GhLabel, GhPull } from '../../../shared/protocol';
import type { Net } from '../../net';
import { h } from '../dom';
import { iconButton } from '../icons';
import { btn, outLink } from '../kit';
import { modalShell, openShell } from '../shell';
import { repoUrlOf } from '../markdown';
import { ghKey, ghLabel, ghRepoField, ghUrl } from './ghrepo';
import { getJson, labelWaiters } from './api';
import { errorBox, spinnerRow } from './pieces';

// ---- Labels -----------------------------------------------------------------------------------

/** A GitHub label in its own color, with text that stays readable on dark ones. */
export function labelChip(l: GhLabel) {
  const n = parseInt(l.color.slice(1), 16);
  const lum = Number.isNaN(n) ? 1 : (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return h('span.label', { style: `background:${l.color};color:${lum < 0.55 ? '#fff' : '#1f2328'}` }, l.name);
}

/**
 * Picks an issue's or PR's labels from the repo's own, like GitHub's sidebar: tick them on and off,
 * then save, and the office's gh account adds and takes off the difference.
 */
export function openLabels(kind: 'issue' | 'pull', it: GhIssue | GhPull, net: Net, onSaved?: (labels: GhLabel[]) => void) {
  // By the repository it's in too.
  const key = ghKey(kind, it.number, it.repo);
  const label = ghLabel(it.number, it.repo);
  const had = new Set(it.labels.map((l) => l.name));
  const on = new Set(had);
  const noun = kind === 'pull' ? 'PR' : 'issue';
  const manage = `${repoUrlOf(it.url)}/labels`;
  let repo: GhLabel[] | null = null;
  let error = '';
  let busy = false;
  let timer = 0;
  /** Each row and the text the filter looks in. */
  const rows = new Map<HTMLElement, string>();

  const filter = h('input.inp', { type: 'text', placeholder: 'Filter labels…', 'aria-label': 'Filter labels', autofocus: true }) as HTMLInputElement;
  const list = h('ul.gh-labels');
  const none = h('p.gh-quiet.hidden');
  const result = h('div.gh-merge-result.hidden');
  const summary = h('span.gh-labels-sum');
  const cancel = btn('Cancel', { kind: 'quiet' });
  const save = btn('Save labels', { kind: 'primary' });
  const shell = modalShell({
    cls: 'gh-merge gh-labeler',
    icon: 'tag',
    title: 'Labels',
    id: label,
    label: `Labels on ${noun} ${label}`,
    body: h('div.gh-merge-body', {}, h('p.gh-merge-title', {}, it.title), filter, list, none, result),
    footerLeft: [summary],
    footerRight: [cancel, save],
  });
  const el = shell.el;

  const changes = () => ({ add: [...on].filter((n) => !had.has(n)), remove: [...had].filter((n) => !on.has(n)) });
  const sync = () => {
    const { add, remove } = changes();
    save.disabled = busy || (!add.length && !remove.length);
    save.textContent = busy ? 'Saving…' : 'Save labels';
    summary.textContent = add.length || remove.length ? [...add.map((l) => `+${l}`), ...remove.map((l) => `−${l}`)].join('  ') : `${on.size} label${on.size === 1 ? '' : 's'} on it`;
    for (const box of list.querySelectorAll('input')) box.disabled = busy;
  };
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const [row, text] of rows) {
      const hit = !q || text.includes(q);
      row.classList.toggle('hidden', !hit);
      if (hit) shown++;
    }
    const empty = !!repo && !shown;
    none.classList.toggle('hidden', !empty);
    if (empty)
      none.replaceChildren(q ? `No labels match “${filter.value.trim()}”. ` : 'This repository has no labels yet. ', outLink('Make one on GitHub', manage));
  };
  const row = (l: GhLabel) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = on.has(l.name);
    box.addEventListener('change', () => {
      if (box.checked) on.add(l.name);
      else on.delete(l.name);
      sync();
    });
    const li = h('li', {}, h('label.gh-check', {}, box, labelChip(l), l.description ? h('small', {}, l.description) : null));
    rows.set(li, `${l.name}\n${l.description ?? ''}`.toLowerCase());
    return li;
  };
  const render = () => {
    rows.clear();
    // The ones it has first, then the rest, each A to Z. Worked out once, so a row never jumps away from the pointer.
    const byName = (a: GhLabel, b: GhLabel) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const known = new Map((repo ?? []).map((l) => [l.name, l]));
    const mine = it.labels.map((l) => known.get(l.name) ?? l).sort(byName);
    const rest = (repo ?? []).filter((l) => !had.has(l.name)).sort(byName);
    list.replaceChildren(...[...mine, ...rest].map(row));
    if (error) list.append(h('li', {}, errorBox(error, load)));
    else if (!repo) list.append(h('li', {}, spinnerRow("Loading the repo's labels…")));
    applyFilter();
    sync();
  };
  const load = () => {
    error = '';
    repo = null;
    render();
    getJson<GhLabel[]>(ghUrl('/api/gh/labels', it.repo)) // that repository's labels
      .then((l) => (repo = l))
      .catch((err) => (error = (err as Error).message))
      .finally(render);
  };
  const settle = () => {
    labelWaiters.delete(key);
    clearTimeout(timer);
    busy = false;
  };
  const fail = (text: string) => {
    result.className = 'gh-merge-result error';
    result.replaceChildren(text);
    sync();
  };
  const submit = () => {
    const { add, remove } = changes();
    if (busy || (!add.length && !remove.length)) return;
    busy = true;
    result.className = 'gh-merge-result';
    result.replaceChildren(h('span.spinner'), 'Saving the labels on GitHub…');
    sync();
    labelWaiters.set(key, (msg) => {
      settle();
      if (!msg.labels) return fail(msg.error ?? 'GitHub did not take the labels');
      modal.close();
      onSaved?.(msg.labels);
    });
    // The office drops messages while it's disconnected, and then no answer comes.
    timer = window.setTimeout(() => {
      settle();
      fail('No answer from the office. Look at the board to see whether the labels changed before saving again.');
    }, 45_000);
    net.send({ t: 'gh.labels', kind, number: it.number, add, remove, ...ghRepoField(it.repo) });
  };

  filter.addEventListener('input', applyFilter);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) submit();
    // Enter in the filter ticks (or unticks) the first label it shows.
    else if (e.target === filter) [...rows.keys()].find((r) => !r.classList.contains('hidden'))?.querySelector('input')?.click();
    else return;
    e.preventDefault();
  });
  const modal = openShell(shell, { onClose: settle });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', submit);
  load();
}

/** The button that opens the label picker, after an issue's or PR's labels. */
export function labelButton(kind: 'issue' | 'pull', it: () => GhIssue | GhPull, net: Net, onSaved: (labels: GhLabel[]) => void) {
  const open = () => openLabels(kind, it(), net, onSaved);
  if (it().labels.length > 0) return iconButton('pencil', 'Edit labels', { class: 'xs', onclick: open }, 14);
  return h('button.link-btn', { type: 'button', onclick: open }, 'Add labels');
}
