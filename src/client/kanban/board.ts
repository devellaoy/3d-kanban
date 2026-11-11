// The board: the five columns (and the archive drawer), cards dragged between them. While a card is
// dragged, the columns that take it light up and the others say why not (the rules are
// shared/kanban/moves.ts, which the server enforces as well). Without a mouse, every card's move button
// (or M on a focused card) opens the same moves as a dialog.

import { h, toast } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import { STATUS_ICON } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import { BOARD_COLUMNS, type KanbanTaskCard, type TaskStatus } from '../../shared/kanban/types.js';
import { columnsOf, dropZones, filterActive, type BoardFilter } from './model';
import { taskCard } from './card';
import { columnName } from './labels';
import { kstore } from './store';

const EMPTY_TEXT: Record<TaskStatus, string> = {
  todo: 'Nothing to do. New task adds one.',
  in_progress: 'Nothing running',
  waiting: 'Nobody is waiting on you',
  review: 'Nothing to review',
  on_hold: 'Nothing on hold',
  done: 'Nothing done yet',
  archived: 'The archive is empty',
};

export interface BoardOptions {
  root: HTMLElement;
  filter(): BoardFilter;
  open(id: number): void;
  move(id: number, to: TaskStatus): Promise<void>;
  /** The archive drawer is open. */
  archiveOpen(): boolean;
  toggleArchive(): void;
  /** The task the detail panel shows, to mark its card. */
  selected(): number | null;
  /** The To do column's + (absent: no button). */
  newTask?(): void;
}

export class Board {
  private dragging: KanbanTaskCard | null = null;
  private sections = new Map<TaskStatus, HTMLElement>();
  /** A change came in mid-drag: redrawing then would drop the card being dragged, so it waits. */
  private stale = false;

  constructor(private o: BoardOptions) {}

  render() {
    if (this.dragging) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const { root } = this.o;
    // Redrawn from scratch on every change, so keep the scroll of each column and the focused card.
    const scroll = new Map([...this.sections].map(([k, s]) => [k, s.querySelector('.kb-cards')?.scrollTop ?? 0]));
    const { scrollLeft } = root;
    const focusedId = (document.activeElement as HTMLElement | null)?.closest?.('.kb-card')?.getAttribute('data-id');
    const f = this.o.filter();
    const cols = columnsOf(kstore.tasks.values(), f, kstore.projects, kstore.project);
    const all = columnsOf(kstore.tasks.values(), { q: '', repos: [], state: 'all', tools: [], ticket: 'any' }, kstore.projects, kstore.project);
    const showProject = !kstore.project && kstore.projects.length > 1;
    const now = Date.now();
    this.sections.clear();
    const list: TaskStatus[] = [...BOARD_COLUMNS, ...(this.o.archiveOpen() ? (['archived'] as const) : [])];
    root.replaceChildren(
      ...list.map((status) => {
        const cards = cols[status];
        const ul = h('div.kb-cards', { role: 'list' });
        for (const c of cards) {
          const el = taskCard(c, kstore.projectOf(c.project), showProject, this.handlers(), now);
          el.setAttribute('role', 'listitem');
          if (this.o.selected() === c.id) el.classList.add('selected');
          ul.append(el);
        }
        if (!cards.length) ul.append(h('p.kb-empty', {}, !kstore.loaded ? 'Loading…' : filterActive(f) && all[status].length ? 'Nothing matches the filters' : EMPTY_TEXT[status]));
        const hidden = all[status].length - cards.length;
        const section = h(
          'section.kb-col',
          { class: status, 'data-status': status, 'aria-label': columnName(status) },
          h(
            'h3.kb-col-head',
            {},
            icon(STATUS_ICON[status]),
            h('span.kb-col-name', {}, columnName(status)),
            h('span.kb-count', { title: hidden ? `${hidden} hidden by the filters` : '' }, hidden ? `${cards.length}/${all[status].length}` : String(cards.length)),
            status === 'todo' && this.o.newTask ? iconButton('plus', 'New task', { class: 'xs', onclick: () => this.o.newTask?.() }) : null,
            status === 'archived' ? iconButton('x', 'Hide the archive', { class: 'xs', onclick: () => this.o.toggleArchive() }) : null,
          ),
          h('div.kb-drop-why', { 'aria-hidden': 'true' }),
          ul,
        );
        this.wireDrop(section, status);
        this.sections.set(status, section);
        return section;
      }),
      // While dragging with the drawer shut, the archive is still a place to drop on.
      ...(this.o.archiveOpen() ? [] : [this.archiveDropStrip()]),
    );
    for (const [k, s] of this.sections) {
      const ul = s.querySelector('.kb-cards');
      if (ul) ul.scrollTop = scroll.get(k) ?? 0;
    }
    root.scrollLeft = scrollLeft;
    if (focusedId) root.querySelector<HTMLElement>(`.kb-card[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }

  private archiveDropStrip(): HTMLElement {
    const strip = h('section.kb-col.kb-archive-drop', { 'data-status': 'archived', 'aria-hidden': 'true' }, h('div.kb-archive-label', {}, icon(STATUS_ICON.archived), columnName('archived')), h('div.kb-drop-why'));
    this.wireDrop(strip, 'archived');
    this.sections.set('archived', strip);
    return strip;
  }

  private handlers() {
    return {
      open: (id: number) => this.o.open(id),
      moveMenu: (id: number) => this.moveMenu(id),
      dragStart: (card: KanbanTaskCard, e: DragEvent) => this.dragStart(card, e),
      dragEnd: () => this.dragEnd(),
    };
  }

  private dragStart(card: KanbanTaskCard, e: DragEvent) {
    this.dragging = card;
    e.dataTransfer?.setData('text/plain', `#${card.id}`);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    const zones = new Map(dropZones(card).map((z) => [z.to, z]));
    this.o.root.classList.add('dragging');
    for (const [status, s] of this.sections) {
      const z = zones.get(status);
      s.classList.toggle('drop-ok', !!z?.ok);
      s.classList.toggle('drop-no', !z?.ok && status !== card.status);
      s.classList.toggle('drop-home', status === card.status);
      const why = s.querySelector('.kb-drop-why');
      if (why) why.textContent = z?.ok ? (z.action === 'start' ? 'Starts the task' : 'Drop here') : z?.reason ?? '';
    }
  }

  private dragEnd() {
    this.dragging = null;
    this.o.root.classList.remove('dragging');
    for (const s of this.sections.values()) s.classList.remove('drop-ok', 'drop-no', 'drop-home', 'over');
    if (this.stale) this.render();
  }

  private wireDrop(section: HTMLElement, status: TaskStatus) {
    section.addEventListener('dragover', (e) => {
      if (!this.dragging || !section.classList.contains('drop-ok')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      section.classList.add('over');
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget as Node | null)) section.classList.remove('over');
    });
    section.addEventListener('drop', (e) => {
      const card = this.dragging;
      e.preventDefault();
      this.dragEnd();
      if (!card) return;
      const z = dropZones(card).find((x) => x.to === status);
      if (!z?.ok) {
        if (z?.reason) toast(z.reason, 'warn');
        return;
      }
      void this.o.move(card.id, status);
    });
  }

  /** The keyboard's way to move a card: every column as a row, the task's own marked, the ones it can't go to greyed out with why. */
  moveMenu(id: number) {
    const card = kstore.tasks.get(id);
    if (!card) return;
    const zones = new Map(dropZones(card).map((z) => [z.to, z]));
    const rows: HTMLElement[] = [];
    const shell = modalShell({ cls: 'kb-move-dialog w400', icon: 'arrow-right-left', title: 'Move', id: `#${id}`, label: `Move task ${id}`, body: rows });
    const body = shell.main;
    body.setAttribute('role', 'menu');
    const modal = openShell(shell);
    for (const to of [...BOARD_COLUMNS, 'archived' as const]) {
      const z = zones.get(to);
      if (!z) {
        body.append(h('div.kb-move-here', { class: to, 'aria-current': 'true' }, icon(STATUS_ICON[to]), h('span', {}, columnName(to)), h('small', {}, 'Current')));
        continue;
      }
      const why = z.ok ? (z.action === 'start' ? h('small.kb-starts', {}, 'Starts the task') : z.action === 'reset' ? h('small', {}, 'Starts over: the automation’s state is cleared') : null) : z.reason ? h('small', {}, z.reason) : null;
      const b = h('button.kb-move-to', { type: 'button', role: 'menuitem', class: to, disabled: !z.ok, title: z.ok ? '' : z.reason ?? '' }, icon(STATUS_ICON[to]), h('span', {}, columnName(to), why)) as HTMLButtonElement;
      b.addEventListener('click', () => {
        modal.close();
        void this.o.move(id, to);
      });
      body.append(b);
    }
    body.addEventListener('keydown', (e) => {
      const items = [...body.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    });
    setTimeout(() => body.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus(), 40);
  }
}
