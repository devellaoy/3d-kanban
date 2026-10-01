// The store's slice for the Codex limits panel and the kanban's readout, last in SLICES (state/slices/index.ts).
import type { CodexLimits } from '../../shared/codex-limits/protocol';
import type { Slice } from '../state/store';

declare module '../state/store' {
  interface Store {
    /** The Codex sign-in's allowance, as the office last said; `off` until a watch has been asked. */
    codexLimits: CodexLimits;
  }
  interface Topics {
    codexLimits: true;
  }
}

export const codexLimits: Slice = {
  init(s) {
    s.codexLimits = { status: 'off', windows: [], at: 0, checkedAt: 0 };
  },
  on: {
    'codex-limits'(s, m) {
      s.codexLimits = m.state;
      return ['codexLimits'];
    },
  },
};
