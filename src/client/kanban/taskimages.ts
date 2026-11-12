// A task's Images tab: the before/after pictures an implementer saved of the UI it changed, a pair per
// subject side by side (under its repository's name when the task keeps them in a folder per repository), read from GET /api/kanban/tasks/<id>/images (the images plugin). A picture is
// a link to its file in a new browser tab; Remove (asked in place, in the picture's own row) deletes one
// before it reaches a pull request. A visitor of a shared office only reads.
//
// The tab keeps its host across the task view's redraws and draws again only when the list is another
// one: the files are never cached, so every redraw would fetch each picture again.

import './taskimages.css';
import { h, timeAgo, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { btn } from '../ui/kit';
import type { ProjectRepo } from '../../shared/kanban/types.js';
import { pairImages, type KanbanTaskImage, type KanbanTaskImageList, type UiImageKind, type UiImagePair } from '../../shared/kanban/uitesting.js';
import { visiting } from '../multiplayer/visit';
import { getJson } from './api';
import { formatSize } from './attach';
import { fmtTime } from './labels';
import { groupImagePairs, imagesKey, imagesUrl, imageUrl, KIND_NAMES, missingText, pairLabel, type ImageGroup } from './taskimagesmodel';

export interface TaskImages {
  host: HTMLElement;
  /** How many images the task has (0 until the list came). */
  readonly count: number;
  /** Reads the list again; the pictures on the page stay unless it changed. */
  refresh(): void;
  destroy(): void;
}

/** `onCount` hears when the number of images changes (the tab's count); `repos` is the task's project's repositories, as known now. */
export function mountTaskImages(taskId: number, onCount: () => void, repos: () => readonly ProjectRepo[] = () => []): TaskImages {
  const host = h('div.kb-tv-images');
  let list: KanbanTaskImage[] | null = null;
  let error = '';
  let key = '';
  /** The image whose Remove is being asked about. */
  let asking = '';
  let seq = 0;
  let busy = false;
  let dead = false;
  const canRemove = !visiting();

  const take = (images: KanbanTaskImage[]) => {
    const before = list?.length ?? 0;
    // The headings are part of what is drawn: a repository renamed, or the projects arriving late, draws again.
    const next = `${imagesKey(images)}#${groupImagePairs(pairImages(images), repos()).map((g) => g.title).join('|')}`;
    const same = list !== null && next === key && !error;
    list = images;
    key = next;
    error = '';
    if (!images.some((i) => i.name === asking)) asking = '';
    if (!same) draw();
    if (images.length !== before) onCount();
  };

  const refresh = async (button?: HTMLButtonElement) => {
    if (dead) return;
    const mine = ++seq;
    busy = true;
    if (button) button.disabled = true;
    try {
      const r = await getJson<KanbanTaskImageList>(imagesUrl(taskId));
      if (dead || mine !== seq) return;
      busy = false;
      take(r.images);
    } catch (err) {
      if (dead || mine !== seq) return;
      busy = false;
      error = (err as Error).message || 'The images could not be read';
      draw();
    }
    // The same list again leaves the page as it was: the button is the old one, to enable again.
    if (button?.isConnected) button.disabled = false;
  };

  const remove = async (img: KanbanTaskImage, button: HTMLButtonElement) => {
    button.disabled = true;
    const mine = ++seq;
    try {
      const res = await fetch(imageUrl(taskId, img, false), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as Partial<KanbanTaskImageList> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (dead) return;
      toast(`Removed ${img.name}`);
      asking = '';
      if (mine === seq && Array.isArray(body.images)) take(body.images);
      else void refresh();
    } catch (err) {
      if (dead) return;
      toast(`${img.name} was not removed: ${(err as Error).message}`, 'error');
      asking = '';
      draw();
      void refresh();
    }
  };

  const focus = (name: string) => void setTimeout(() => host.querySelector<HTMLElement>(`[data-focus="${CSS.escape(name)}"]`)?.focus({ preventScroll: true }), 0);

  /** One side of a pair: its name, size and age, the picture as a link to its file, and Remove. */
  const side = (pair: UiImagePair, kind: UiImageKind, name: string): HTMLElement => {
    const img = pair[kind];
    const label = h('span.kb-img-kind', {}, KIND_NAMES[kind]);
    if (!img) return h('figure.kb-img-side.missing', {}, h('figcaption', {}, label), h('div.kb-img-none', {}, icon('image', { size: 18 }), h('span', {}, missingText(kind))));
    const picture = h('img', { src: imageUrl(taskId, img), alt: `${name}, ${kind}`, loading: 'lazy' }) as HTMLImageElement;
    const link = h('a.kb-img-link', { href: imageUrl(taskId, img), target: '_blank', rel: 'noopener noreferrer', title: `Open ${img.name} full size in a new tab` }, picture);
    picture.addEventListener('error', () => link.replaceWith(h('div.kb-img-none.bad', { role: 'alert' }, icon('triangle-alert', { size: 18 }), h('span', {}, `${img.name} could not be shown`))));
    const meta = h('small.kb-muted', { title: `${img.name} · ${fmtTime(img.mtime)}` }, `${formatSize(img.size)} · ${timeAgo(img.mtime)}`);
    const caption = h('figcaption', {}, label, meta);
    if (canRemove && asking === img.name) {
      // Asked here in the picture's row: a window over the task's would be one more to shut.
      const no = btn('Cancel', { kind: 'quiet', size: 'xs', attrs: { 'data-focus': `img-no-${img.name}` } });
      const yes = btn('Remove', { kind: 'danger', size: 'xs', attrs: { 'data-focus': `img-yes-${img.name}` } });
      no.addEventListener('click', () => {
        asking = '';
        draw();
        focus(`img-rm-${img.name}`);
      });
      yes.addEventListener('click', () => void remove(img, yes));
      caption.append(h('span.kb-img-ask', { role: 'group', 'aria-label': `Remove ${img.name}?` }, h('span', {}, 'Remove this image?'), no, yes));
    } else if (canRemove) {
      const rm = btn('Remove', { kind: 'quiet-danger', size: 'xs', icon: 'trash-2', attrs: { 'data-focus': `img-rm-${img.name}`, title: `Remove ${img.name} from the task: it then stays out of the pull request too` } });
      rm.addEventListener('click', () => {
        asking = img.name;
        draw();
        focus(`img-no-${img.name}`);
      });
      caption.append(rm);
    }
    return h('figure.kb-img-side', {}, caption, link);
  };

  function draw() {
    if (dead) return;
    const again = btn('Refresh', { kind: 'quiet', size: 'sm', icon: 'refresh-cw', attrs: { 'data-focus': 'img-refresh', title: 'Read the task’s images again' } });
    again.disabled = busy;
    again.addEventListener('click', () => void refresh(again));
    const pairs = pairImages(list ?? []);
    const n = list?.length ?? 0;
    const said = list === null ? (error ? '' : 'Loading…') : n ? `${n} ${n === 1 ? 'image' : 'images'} of ${pairs.length} ${pairs.length === 1 ? 'view' : 'views'}, before and after the change` : '';
    const kids: (Node | null)[] = [h('div.kb-img-bar', {}, h('span.kb-muted.grow', {}, said), again)];
    if (error) kids.push(h('div.kb-error.kb-row', { role: 'alert' }, icon('triangle-alert'), h('span.grow', {}, `The images could not be read: ${error}`)));
    if (list && !n && !error) {
      kids.push(
        h(
          'div.kb-img-empty',
          {},
          icon('image', { size: 28 }),
          h('strong', {}, 'No images yet'),
          h('span', {}, 'When the task changes the UI, the implementer saves a screenshot from before the change and one from after it here. The reviewer reads them, and they go into the pull request’s description.'),
        ),
      );
    }
    const drawPair = (pair: UiImagePair, g: ImageGroup): HTMLElement => {
      const name = pairLabel(pair, g);
      return h('section.kb-img-pair', { 'aria-label': name }, h('h4', {}, pair.subject), h('div.kb-img-sides', {}, side(pair, 'before', name), side(pair, 'after', name)));
    };
    for (const g of groupImagePairs(pairs, repos())) {
      // No folders: the pairs alone, as a task in one repository always had them.
      if (!g.title) kids.push(...g.pairs.map((p) => drawPair(p, g)));
      else kids.push(h('section.kb-img-group', { 'aria-label': g.title }, h('div.kb-img-group-head', {}, icon(g.repo ? 'git-branch' : 'git-pull-request', { size: 14 }), h('h3', {}, g.title), h('span.kb-muted', {}, g.hint)), ...g.pairs.map((p) => drawPair(p, g))));
    }
    host.replaceChildren(...kids.filter((k): k is Node => !!k));
  }

  draw();
  return {
    host,
    get count() {
      return list?.length ?? 0;
    },
    refresh: () => void refresh(host.querySelector<HTMLButtonElement>('[data-focus="img-refresh"]') ?? undefined),
    destroy: () => {
      dead = true;
      host.remove();
    },
  };
}
