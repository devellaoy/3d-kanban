// 3d-kanban (#328): one send key for every multi-line prompt box. Enter adds a line; Shift/⌘/Ctrl + Enter sends.

/** True for a keydown that sends: Enter with Shift, ⌘ or Ctrl held (never Alt, never mid-IME-composition). */
export function isSendKey(e: Pick<KeyboardEvent, 'key' | 'isComposing' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return e.key === 'Enter' && !e.isComposing && !e.altKey && (e.shiftKey || e.metaKey || e.ctrlKey);
}

/** Whether this browser runs on an Apple platform (shows ⌘ and ⇧ in hints). */
export function isMac(): boolean {
  const nav = (globalThis as { navigator?: Navigator & { userAgentData?: { platform?: string } } }).navigator;
  if (!nav) return false;
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '');
}

/** The footer/placeholder hint that names the send key. */
export function sendHint(): string {
  return isMac() ? '⇧/⌘+Enter sends · Enter for a new line' : 'Shift/Ctrl+Enter sends · Enter for a new line';
}

/** Makes `go` run on the send key in `el` (and keeps the key from typing a newline). */
export function onSendKey(el: HTMLElement, go: () => void): void {
  el.addEventListener('keydown', (e) => {
    if (isSendKey(e)) {
      e.preventDefault();
      go();
    }
  });
}
