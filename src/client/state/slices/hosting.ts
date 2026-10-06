import type { HostingState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Your own Azure DevOps and Bitbucket tokens and the office's: whether they're set, never the tokens. */
    hosting: HostingState | null;
    /** What the office said to the last token saved or cleared: the host, and why not when it didn't take it. */
    hostingSaved: { kind: string; error?: string; at: number } | null;
  }
  interface Topics {
    hosting: true;
  }
}

export const hosting: Slice = {
  init(s) {
    s.hosting = null;
    s.hostingSaved = null;
  },
  on: {
    hosting(s, m) {
      s.hosting = m.state;
      return ['hosting'];
    },
    'hosting.saved'(s, m) {
      s.hostingSaved = { kind: m.kind, ...(m.error ? { error: m.error } : {}), at: Date.now() };
      return ['hosting'];
    },
  },
};
