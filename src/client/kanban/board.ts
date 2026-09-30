// The board: the five columns (and the archive drawer), cards dragged between them. While a card is
// dragged, the columns that take it light up and the others say why not (the rules are
// shared/kanban/moves.ts, which the server enforces as well). Without a mouse, every card's ⋯ (or M
// on a focused card) opens the same moves as a menu.

import { h, toast } from '../ui/dom';
import { BOARD_COLUMNS, type KanbanTaskCard, type TaskStatus } from '../../shared/kanban/types.js';
import { columnsOf, dropZones, filterActive, type BoardFilter } from './model';
import { taskCard } from './card';
import { columnName, moveReason, t } from './i18n';
import { kstore } from './store';
import { dialog, showDialog } from './ui';

const COLUMN_ICON: Record<TaskStatus, string> = { todo: '📥', in_progress: '🚧', waiting: '🙋', review: '👀', done: '✅', archived: '🗄️' };

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
        if (!cards.length) ul.append(h('p.kb-empty', {}, !kstore.loaded ? t('loading') : filterActive(f) && all[status].length ? t('noneMatch') : t(`empty.${status}`)));
        const hidden = all[status].length - cards.length;
        const section = h(
          'section.kb-col',
          { class: status, 'data-status': status, 'aria-label': columnName(status) },
          h(
            'h3.kb-col-head',
            {},
            h('span', {}, `${COLUMN_ICON[status]} ${columnName(status)}`),
            h('span.kb-count', { title: hidden ? t('hiddenByFilter', { n: hidden }) : '' }, hidden ? `${cards.length}/${all[status].length}` : String(cards.length)),
            status === 'archived' ? h('button.btn.small', { type: 'button', onclick: () => this.o.toggleArchive(), 'aria-label': t('hideArchive') }, '✕') : null,
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
    const strip = h('section.kb-col.kb-archive-drop', { 'data-status': 'archived', 'aria-hidden': 'true' }, h('div.kb-archive-label', {}, `🗄️ ${columnName('archived')}`), h('div.kb-drop-why'));
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
      if (why) why.textContent = z?.ok ? (z.action === 'start' ? `▶️ ${t('moveStarts')}` : t('dropHere')) : z?.reason ? moveReason(z.reason) : '';
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
        if (z?.reason) toast(moveReason(z.reason), 'warn');
        return;
      }
      void this.o.move(card.id, status);
    });
  }

  /** The keyboard's way to move a card: every column, the ones it can't go to greyed out with why. */
  moveMenu(id: number) {
    const card = kstore.tasks.get(id);
    if (!card) return;
    const zones = dropZones(card);
    const body = h('div.body.kb-move-menu', { role: 'menu' });
    const d = dialog('kb-move-dialog', t('moveTaskN', { id }), body);
    const modal = showDialog(d);
    for (const z of zones) {
      const b = h(
        'button.btn.kb-move-to',
        { type: 'button', role: 'menuitem', disabled: !z.ok, title: z.ok ? '' : moveReason(z.reason ?? '') },
        h('span', {}, `${COLUMN_ICON[z.to]} ${columnName(z.to)}`),
        z.ok ? (z.action === 'start' ? h('small.kb-starts', {}, `▶️ ${t('moveStarts')}`) : z.action === 'reset' ? h('small', {}, t('moveResets')) : null) : h('small', {}, moveReason(z.reason ?? '')),
      ) as HTMLButtonElement;
      b.addEventListener('click', () => {
        modal.close();
        void this.o.move(id, z.to);
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
