// Attachments on a text box: 📎 to pick files, or paste / drop them onto it. Each is uploaded straight
// away (see attach.ts). With `insertLinks` (the kanban's own text boxes) a file goes into the text where
// the cursor is: a placeholder at once, its link when the upload is done, and the ids sent are the links
// still in the text. Without it (the 3D hire dialog) the files are listed with their size and a ✕.
// Its styles load with it: the 3D page has no kanban.css.
import './attachbox.css';
import { h, toast } from '../ui/dom';
import type { KanbanAttachment } from '../../shared/kanban/types.js';
import { attachmentMarkdown, attachmentUrl, formatSize, insertAt, linkedIds, pastedName, swapMark, uploadAttachment, uploadingMark } from './attach';

export interface AttachBox {
  el: HTMLElement;
  /** With `insertLinks`, the files the text still links to. */
  ids(): string[];
  /** Uploads still under way. */
  busy(): boolean;
  clear(): void;
  /** Adds a file that is already uploaded (no link goes into the text). */
  adopt(a: KanbanAttachment): void;
}

export function attachBox(opts: { target: HTMLTextAreaElement; dropZone?: HTMLElement; taskId?: () => number | undefined; insertLinks: boolean; max?: number; onChange?: () => void }): AttachBox {
  const done: KanbanAttachment[] = [];
  let uploading = 0;
  const list = h('ul.kb-attachments', { 'aria-live': 'polite' });
  const input = h('input', { type: 'file', multiple: true, class: 'hidden', tabindex: -1, 'aria-hidden': 'true' }) as HTMLInputElement;
  const pick = h('button.btn.small', { type: 'button', title: 'Attach files (or paste / drop them)' }, '📎 Attach');
  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    add([...(input.files ?? [])]);
    input.value = '';
  });

  const paint = () => {
    if (opts.insertLinks) {
      list.replaceChildren(...(uploading ? [h('li.kb-attachment.busy', {}, `⏳ Uploading ${uploading}…`)] : []));
      return;
    }
    list.replaceChildren(
      ...done.map((a) =>
        h(
          'li.kb-attachment',
          {},
          h('a', { href: attachmentUrl(a.id), target: '_blank', rel: 'noopener noreferrer' }, `📄 ${a.name}`),
          h('small', {}, formatSize(a.size)),
          h(
            'button.kb-x',
            {
              type: 'button',
              'aria-label': `Remove ${a.name}`,
              onclick: () => {
                done.splice(done.indexOf(a), 1);
                paint();
                opts.onChange?.();
              },
            },
            '✕',
          ),
        ),
      ),
      ...(uploading ? [h('li.kb-attachment.busy', {}, `⏳ Uploading ${uploading}…`)] : []),
    );
  };

  const ta = opts.target;
  const ids = () => (opts.insertLinks ? linkedIds(ta.value) : done.map((a) => a.id));
  /** Puts new text in the box, the selection kept (focused or not), and lets the draft and the view know. */
  const setText = (text: string, sel: [number, number]) => {
    ta.value = text;
    ta.setSelectionRange(sel[0], sel[1]);
    ta.dispatchEvent(new Event('input'));
  };
  const at = (): [number, number] => [ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length];

  const upload = async (f: File, name: string, mark: string) => {
    try {
      const a = await uploadAttachment(f, name, opts.taskId?.());
      done.push(a);
      if (!opts.insertLinks) return;
      const link = attachmentMarkdown(a);
      const swapped = swapMark(ta.value, mark, link, at());
      if (swapped) return setText(swapped.text, swapped.sel);
      // The placeholder was edited away: the file goes where the cursor is now.
      const r = insertAt(ta.value, at()[1], link);
      setText(r.text, [r.cursor, r.cursor]);
    } catch (err) {
      const swapped = mark ? swapMark(ta.value, mark, '', at()) : null;
      if (swapped) setText(swapped.text, swapped.sel);
      toast((err as Error).message, 'error');
    } finally {
      uploading--;
      paint();
      opts.onChange?.();
    }
  };

  // Every file's placeholder goes in at once, so their order and place hold however long the uploads take;
  // the uploads themselves go one at a time.
  let queue = Promise.resolve();
  const add = (files: File[]) => {
    const max = opts.max ?? 20;
    for (const f of files) {
      if (ids().length + uploading >= max) {
        toast(`At most ${max} files`, 'warn');
        break;
      }
      const name = f.name || pastedName(f.type);
      let mark = '';
      if (opts.insertLinks) {
        mark = uploadingMark(name);
        const r = insertAt(ta.value, at()[1], mark);
        setText(r.text, [r.cursor, r.cursor]);
      }
      uploading++;
      queue = queue.then(() => upload(f, name, mark));
    }
    paint();
  };

  opts.target.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });
  const zone = opts.dropZone ?? opts.target;
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    zone.classList.add('kb-dropping');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove('kb-dropping');
  });
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('kb-dropping');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    // Not on to a window's own drop zone too (the worker window's terminal would type their paths in).
    e.stopPropagation();
    add(files);
  });

  return {
    el: h('div.kb-attach', {}, pick, input, list),
    ids,
    busy: () => uploading > 0,
    adopt: (a) => {
      done.push(a);
      paint();
      opts.onChange?.();
    },
    clear: () => {
      done.length = 0;
      paint();
    },
  };
}
