// Attachments on a text box: 📎 to pick files, or paste / drop them onto it. Each is uploaded straight
// away (see attach.ts) and listed with its size and a ✕; the ids go with the task or comment.

import { h, toast } from '../ui/dom';
import type { KanbanAttachment } from '../../shared/kanban/types.js';
import { attachmentMarkdown, attachmentUrl, formatSize, insertAt, pastedName, uploadAttachment } from './attach';

export interface AttachBox {
  el: HTMLElement;
  ids(): string[];
  /** Uploads still under way. */
  busy(): boolean;
  clear(): void;
}

export function attachBox(opts: { target: HTMLTextAreaElement; dropZone?: HTMLElement; taskId?: () => number | undefined; insertLinks: boolean; max?: number; onChange?: () => void }): AttachBox {
  const done: KanbanAttachment[] = [];
  let uploading = 0;
  const list = h('ul.kb-attachments', { 'aria-live': 'polite' });
  const input = h('input', { type: 'file', multiple: true, class: 'hidden', tabindex: -1, 'aria-hidden': 'true' }) as HTMLInputElement;
  const pick = h('button.btn.small', { type: 'button', title: 'Attach files (or paste / drop them)' }, '📎 Attach');
  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    void add([...(input.files ?? [])]);
    input.value = '';
  });

  const paint = () => {
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

  const add = async (files: File[]) => {
    const max = opts.max ?? 20;
    for (const f of files) {
      if (done.length + uploading >= max) {
        toast(`At most ${max} files`, 'warn');
        break;
      }
      uploading++;
      paint();
      try {
        const name = f.name || pastedName(f.type);
        const a = await uploadAttachment(f, name, opts.taskId?.());
        done.push(a);
        if (opts.insertLinks) {
          const ta = opts.target;
          const r = insertAt(ta.value, ta.selectionStart ?? ta.value.length, attachmentMarkdown(a));
          ta.value = r.text;
          ta.setSelectionRange(r.cursor, r.cursor);
          ta.dispatchEvent(new Event('input'));
        }
      } catch (err) {
        toast((err as Error).message, 'error');
      } finally {
        uploading--;
        paint();
        opts.onChange?.();
      }
    }
  };

  opts.target.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void add(files);
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
    void add(files);
  });

  return {
    el: h('div.kb-attach', {}, pick, input, list),
    ids: () => done.map((a) => a.id),
    busy: () => uploading > 0,
    clear: () => {
      done.length = 0;
      paint();
    },
  };
}
