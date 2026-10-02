/** The meeting rooms: E at a table, board or door (or 🤝 in the menu) opens the window, how the meeting's going or the form to call one. */
import { MEETING_PATTERNS, meetingAt, meetingStage } from '../../../shared/meetings';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { clip } from '../../ui/dom';
import { openMeeting, type MeetingPreset } from '../../ui/meeting';
import { keepBoardsClear } from './clear-board';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    meeting: true;
  }
}

export function installMeeting(ctx: Ctx, parts: Pick<Parts, 'waiting' | 'actions'>) {
  /** The meeting rooms' window, at `room` when it's given: how the meeting's going, or the form to call one (prefilled from an issue or a PR). */
  function showMeeting(preset?: MeetingPreset, room?: string) {
    openMeeting(
      ctx.net,
      {
        openTerminal: (id) => parts.waiting.openWorkerTerminal(id),
        openPr: (id) => {
          const w = store.workers.get(id);
          if (w) parts.actions.pullRequestFor(w);
        },
      },
      room ? { ...preset, room } : preset,
    );
  }

  keepBoardsClear(ctx);

  ctx.interactions.define('meeting', {
    reach: 7,
    hint: (it) => {
      const room = store.meeting.rooms.find((r) => r.id === it.room) ?? store.meeting.rooms[0];
      const m = room ? meetingAt(store.meeting, room.id) : null;
      const p = m && MEETING_PATTERNS[m.pattern];
      const what = !m || !p ? 'free' : m.status === 'running' ? `${p.icon} ${p.label} · ${meetingStage(m)}` : `${p.icon} ${p.label} ${m.status === 'done' ? 'done ✅' : 'stopped ⛔'}`;
      return { k: `${room?.id}:${what}`, parts: [hintTitle(room?.label ?? '🤝 Meeting room'), aside(clip(what, 50)), key('E', m?.status === 'running' ? 'See how it’s going' : m ? 'See it / call a meeting' : 'Call a meeting')] };
    },
    use: onE((it) => showMeeting(undefined, it.room)),
  });

  return { showMeeting };
}
