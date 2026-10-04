// One meeting hand-off at a time, and only while it's still wanted: a hand-off waits on the archive (and an upload) before
// it opens the hire dialog, and by then the meeting window may have been closed, the floor changed, or the button pressed
// again. Pure, so tests/meeting-handoff-gate.test.ts can run it.

export interface HandoffRun {
  /** Whether the hand-off may still go on: not ended, and still wanted. Asked after every wait. */
  ok(): boolean;
  /** Ends it (once is enough; again does nothing), so the next one can start. */
  end(): void;
}

export interface HandoffGate {
  /** Starts a hand-off that goes on while `stillWanted()`; undefined while another one is under way. */
  begin(stillWanted: () => boolean): HandoffRun | undefined;
}

export function handoffGate(): HandoffGate {
  let busy = false;
  return {
    begin(stillWanted) {
      if (busy) return undefined;
      busy = true;
      let done = false;
      return {
        ok: () => !done && stillWanted(),
        end: () => {
          if (done) return;
          done = true;
          busy = false;
        },
      };
    },
  };
}
