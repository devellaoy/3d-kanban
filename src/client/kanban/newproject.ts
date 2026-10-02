// ＋ New project, in ⚙️ Settings → 📁 Projects (admins): a folder on the office's machine made a
// project as it is, or a GitHub repository the office clones. Either way it's a new floor of the
// building, the same as the elevator's "add a project" (ui/flooradd.ts), on both pages.

import { normalizeRepo } from '../../shared/floors';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast } from '../ui/dom';
import { folderNote, folderPath, folderProblem, requestFloor } from '../ui/flooradd';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { kanbanApi, type KanbanApi } from './api';
import { kstore } from './store';

type Kind = 'dir' | 'repo';

/** How long to wait for a new floor to show up in the project list before giving up on picking it. */
const PICK_WAIT_MS = 30_000;

/**
 * The "＋ New project" button, shown to admins only. Off the kanban page, who you are comes in with the
 * settings after the window opens, so it follows kstore's `me` (and stops once it's out of the page).
 * `onCreated` gets the new project once the list has it.
 */
export function newProjectButton(net: Net, onCreated: (id: string) => void): HTMLElement {
  const btn = h('button.btn.small.kb-new-project', { type: 'button', onclick: () => openNewProject(net, onCreated) }, '＋ New project');
  const show = () => btn.classList.toggle('hidden', !kstore.me.admin);
  const off = kstore.on('me', () => (btn.isConnected ? show() : off()));
  show();
  return btn;
}

/**
 * Calls `fn` with the new project once kstore lists it. The list follows the floors a moment later,
 * but only to a connection that follows some project: Settings in a building that had no floors
 * follows none, so this also asks for the kanban's meta itself (a page that applies it already has,
 * by the time the answer gets here; the kanban page doesn't, so it's applied here then).
 */
export function whenListed(api: Pick<KanbanApi, 'request'>, id: string, fn: (id: string) => void) {
  if (kstore.projectOf(id)) return fn(id);
  const done = () => (off(), clearTimeout(timer));
  const off = kstore.on('projects', () => {
    if (!kstore.projectOf(id)) return;
    done();
    fn(id);
  });
  const timer = setTimeout(done, PICK_WAIT_MS);
  api.request<Extract<KanbanServerMsg, { t: 'kanban.meta' }>>({ t: 'kanban.meta.get' }).then(
    (meta) => {
      if (!kstore.projectOf(id) && meta.projects.some((p) => p.id === id)) kstore.applyMeta(meta);
    },
    // No answer: the list may still catch up on its own until the wait runs out.
    () => {},
  );
}

function openNewProject(net: Net, onCreated: (id: string) => void) {
  let kind: Kind = 'dir';
  let busy = false;
  let open = true;

  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const kinds: Record<Kind, HTMLButtonElement> = {
    dir: h('button.kb-np-kind', { type: 'button', 'aria-pressed': 'true' }, '📁 Local folder'),
    repo: h('button.kb-np-kind', { type: 'button', 'aria-pressed': 'false' }, 'GitHub repository'),
  };
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const noteEl = h('p.kb-np-note');
  const errEl = h('p.kb-np-err.hidden', { role: 'alert' });
  const create = h('button.btn.primary', { type: 'button' }, 'Create') as HTMLButtonElement;

  const repoNote = (repo: string | undefined) => {
    const dir = store.projectsDir.dir;
    if (!dir) return 'The office clones it with its gh login, and it becomes a new floor.';
    return `Cloned into ${dir}/${repo ?? '<owner>/<repo>'} with the office's gh login.`;
  };

  // A folder that can't be added from here says so as it's typed (a relative path, say).
  const typedProblem = () => {
    const dir = kind === 'dir' ? folderPath(input.value) : undefined;
    return (dir && folderProblem(dir, kstore.me.admin)) || '';
  };

  const paint = () => {
    for (const k of Object.keys(kinds) as Kind[]) {
      kinds[k].setAttribute('aria-pressed', String(k === kind));
      kinds[k].disabled = busy;
    }
    input.disabled = busy;
    input.placeholder = kind === 'dir' ? '/Users/me/work/notes or ~/work/notes' : 'owner/name';
    input.setAttribute('aria-label', kind === 'dir' ? 'Folder path' : 'Repository');
    const value = input.value.trim();
    const problem = typedProblem();
    if (kind === 'dir') {
      // When it can't be added from here, the error line under it says why instead.
      noteEl.textContent = busy ? `⏳ Adding ${value}…` : problem ? '' : folderNote(value || '<folder>');
      create.textContent = busy ? '⏳ Adding…' : 'Create';
    } else {
      const repo = normalizeRepo(value);
      noteEl.textContent = busy ? `⏳ Cloning ${repo}… a big repository can take a minute.` : repoNote(repo);
      create.textContent = busy ? '⏳ Cloning…' : 'Create';
    }
    noteEl.classList.toggle('busy', busy);
    noteEl.classList.toggle('hidden', !noteEl.textContent);
    create.disabled = busy || !value || !!problem;
  };

  const fail = (text: string) => {
    errEl.textContent = text;
    errEl.classList.toggle('hidden', !text);
  };

  /** What to ask the office for, or why what's typed won't do. */
  const what = (): { dir: string } | { repo: string } | string => {
    const value = input.value.trim();
    if (kind === 'repo') {
      const repo = normalizeRepo(value);
      return repo ? { repo } : 'Type the repository as owner/name, like octocat/hello-world';
    }
    const dir = folderPath(value);
    if (!dir) return 'Type the folder’s full path, like /Users/me/work/notes or ~/work/notes';
    return folderProblem(dir, kstore.me.admin) ?? { dir };
  };

  const submit = () => {
    if (busy) return;
    const req = what();
    if (typeof req === 'string') return fail(req);
    fail('');
    busy = true;
    paint();
    // Closing the window doesn't stop it: the office carries on, and its answer still lands.
    void requestFloor(net, req).then((res) => {
      busy = false;
      if ('error' in res) {
        if (!open) return void toast(res.error, 'error');
        fail(res.error);
        paint();
        return;
      }
      modal.close();
      whenListed(kanbanApi(net), res.floor, onCreated);
    });
  };

  for (const k of Object.keys(kinds) as Kind[])
    kinds[k].addEventListener('click', () => {
      if (busy || kind === k) return;
      kind = k;
      fail(typedProblem());
      paint();
      input.focus();
    });
  input.addEventListener('input', () => (fail(typedProblem()), paint()));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    submit();
  });
  create.addEventListener('click', submit);

  const el = h(
    'div.modal.kb-new-project-modal',
    { role: 'dialog', 'aria-label': 'New project' },
    h('header', {}, h('h2', {}, '＋ New project'), close),
    h('div.body', {}, h('div.kb-np-kinds', { role: 'group', 'aria-label': 'Where the project comes from' }, kinds.dir, kinds.repo), input, noteEl, errEl),
    h('footer', {}, h('span.grow'), create),
  );
  // ✕ and Esc close this window only (Settings under it stays); a stray click on the backdrop doesn't.
  const modal = openModal(el, { backdropCloses: false, onClose: () => (open = false) });
  close.addEventListener('click', () => modal.close());
  paint();
  setTimeout(() => input.focus(), 30);
}
