/** The whiteboard: it shows what everyone's drawn on it, and E draws on it with them. */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { clip } from '../../ui/dom';
import { closeWhiteboard, mirrorWhiteboard, openWhiteboard } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    whiteboard: true;
  }
}

export function installWhiteboard(ctx: Ctx) {
  const { office } = ctx;
  // The whiteboard shows what everyone's drawn on it.
  mirrorWhiteboard(office.whiteboard.show, office.whiteboard.fit.width, office.whiteboard.fit.height);
  // Taken out of the floor (build mode): whoever is drawing on it is let go; the drawing stays for when it's put back.
  store.on('floorPlan', () => {
    const f = store.floorPlan.furniture.whiteboard;
    if (f && 'removed' in f) closeWhiteboard();
  });
  ctx.interactions.define('whiteboard', {
    reach: 7,
    hint: () => {
      const names = store.drawing.flatMap((id) => (id === store.you ? [] : (store.peers.get(id)?.name ?? []))).join(', ');
      return { k: names, parts: [hintTitle('📝 Whiteboard'), aside(names ? `✏️ ${clip(names, 40)} drawing` : 'draw together, live'), key('E', names ? 'Join in' : 'Draw')] };
    },
    use: onE(() => openWhiteboard(ctx.net)),
  });
}
