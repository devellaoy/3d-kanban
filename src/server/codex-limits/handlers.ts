// The Codex limits panel's messages: a browser says it has the numbers in view, or wants them read again.
import type { CodexLimitsClientMsg } from '../../shared/codex-limits/protocol.js';
import type { FeatureHooks, HandlerMap } from '../ws/handlers/types.js';
import { codexLimitsOf, unwatchCodexLimits } from './index.js';

export const codexLimitsHandlers = {
  'codex-limits.watch'(ctx, c, msg) {
    if (msg.on === true) codexLimitsOf(ctx).watch(c);
    else unwatchCodexLimits(ctx, c.id);
  },
  'codex-limits.refresh'(ctx, c) {
    codexLimitsOf(ctx).refresh(c);
  },
} satisfies HandlerMap<CodexLimitsClientMsg>;

export const codexLimitsHooks: FeatureHooks = {
  closed: (ctx, c) => unwatchCodexLimits(ctx, c.id),
};
