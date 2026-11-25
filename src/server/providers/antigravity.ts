// Antigravity (`agy`): its hooks and MCP server come from a plugin the office writes into the
// workspace at each launch (see ../antigravity.ts) and report on /hooks/antigravity. It reports no usage.
import { antigravityTrustArgs, normalizeAntigravityHook, writeAntigravityHook, writeAntigravityPlugin, type AntigravityHookEvent } from '../antigravity.js';
import { reduceLifecycle, type LifecycleReport, type ToolTracker } from '../workers/lifecycle.js';
import type { WorkerHandle } from '../workers/types.js';
import type { ProviderAdapter } from './types.js';

/**
 * Fallback for a lost subagent Stop hook: a held Stop with no hook event of the whole tree for this
 * long ends the turn. A live tree is told by its subagents' Stops, never by silence alone.
 */
export const HELD_STOP_MS = 10 * 60_000;

export interface AntigravityState {
  /** The conversation this launch's first event named: the worker's own. Its subagents are other conversations. */
  root?: string;
  /** The root's transcript, as its hooks name it. */
  transcript?: string;
  /** What the person last said to the root: a wake by a subagent repeats it, a new prompt differs. */
  lastPrompt?: string;
  /** Launched by this office process (a state restored after a restart is not). */
  launched?: boolean;
  /** Subagent conversations that started and haven't stopped. */
  subagents: Set<string>;
  /** The root's Stop while subagents were still running: its payload, until a Stop of an idle tree (or the timer) ends the turn. */
  held?: { payload: unknown };
  timer?: NodeJS.Timeout;
  /** Its tool calls in flight, and which of them wait on the person (see tracker). */
  tools: Map<string, string>;
  pending: Set<string>;
  permissionUnknown?: boolean;
}

interface AntigravitySetup {
  hook: string;
  mcpScript?: string;
}

/** Tools that wait on the person. */
const WAITS = /^(?:ask_question|ask_permission|ask_custom_permission)$/;

/** Its hooks say when a question is asked (PreToolUse) and answered (PostToolUse), so its tool calls are followed one by one. */
function tracker(s: AntigravityState): ToolTracker {
  return {
    clear() {
      s.tools.clear();
      s.pending.clear();
      s.permissionUnknown = false;
    },
    started(tool, toolUseId) {
      if (toolUseId && s.tools.size < 256) s.tools.set(toolUseId, tool ?? '');
      if (WAITS.test(tool ?? '')) {
        if (toolUseId) s.pending.add(toolUseId);
        else s.permissionUnknown = true;
      }
    },
    permission() {},
    finished(toolUseId) {
      if (toolUseId) {
        s.tools.delete(toolUseId);
        s.pending.delete(toolUseId);
      } else s.permissionUnknown = false;
    },
    waiting: () => !!(s.pending.size || s.permissionUnknown),
  };
}

/** Nothing held, no timer. */
function drop(s: AntigravityState) {
  s.held = undefined;
  if (s.timer) clearTimeout(s.timer);
  s.timer = undefined;
}

/** A new launch: nothing of the last run is known. */
function reset(s: AntigravityState) {
  drop(s);
  s.root = undefined;
  s.lastPrompt = undefined;
  s.launched = true;
  s.subagents.clear();
  tracker(s).clear();
}

/** One report of the root's, with the raw hook for the observers when there is one. */
function report(h: WorkerHandle<AntigravityState>, r: LifecycleReport, raw?: unknown, transcript?: string): boolean {
  const s = h.state;
  return reduceLifecycle(h, r, {
    onSessionSwitch() {
      h.info.usage = undefined;
      s.transcript = undefined;
      drop(s);
    },
    onReport() {
      if (transcript) s.transcript = transcript;
      if (raw !== undefined) h.observeHook(r.event, r.tool, raw); // heard before the status change it causes
    },
    tools: tracker(s),
  });
}

/** The root's held Stop ends its turn. */
function release(h: WorkerHandle<AntigravityState>, fallback?: unknown): boolean {
  const s = h.state;
  const payload = s.held?.payload ?? fallback;
  drop(s);
  if (!s.root) return false;
  return report(h, { sessionId: s.root, event: 'Stop' }, payload ?? {});
}

/** While a Stop is held, any hook event shows the tree is alive (see HELD_STOP_MS). */
function arm(h: WorkerHandle<AntigravityState>) {
  const s = h.state;
  if (!s.held) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = undefined;
    if (s.held && h.running) release(h);
  }, HELD_STOP_MS);
  s.timer.unref();
}

/** A conversation of the person's own began: the worker's session is theirs now, and nothing of the last one carries over. */
function newRoot(s: AntigravityState, id: string) {
  drop(s);
  s.root = id;
  s.lastPrompt = undefined;
  s.subagents.clear();
  tracker(s).clear();
}

/**
 * A subagent's events are none of the worker's lifecycle: they only say which subagents are live (a
 * Stop of the last one ends a held root Stop) and, as `agent_id` hooks, that the tree is alive.
 */
function subagentEvent(h: WorkerHandle<AntigravityState>, e: AntigravityHookEvent, payload: unknown): boolean {
  const s = h.state;
  if (e.event === 'Stop') {
    s.subagents.delete(e.sessionId);
    h.observeHook(e.event, e.tool, { ...(payload as object), agent_id: e.sessionId });
    if (s.held && s.subagents.size === 0) release(h);
  } else {
    if (s.subagents.size < 64) s.subagents.add(e.sessionId);
    h.observeHook(e.event, e.tool, { ...(payload as object), agent_id: e.sessionId });
  }
  arm(h);
  return false;
}

function antigravityHook(h: WorkerHandle<AntigravityState>, event: string, payload: unknown): boolean {
  const e = normalizeAntigravityHook(event, payload);
  if (!e) return false;
  const s = h.state;
  if (!s.root) {
    // A restored state without its root can't tell a subagent's start from the root's: it waits for a root-looking event.
    if (!s.launched && e.event === 'SessionStart' && !e.prompt) return false;
    s.root = e.sessionId; // the first event of a launch names the root: a resumed conversation fires no SessionStart
    // The reducer takes a session when it starts, so the first event of a resumed one starts it first.
    if (e.event !== 'SessionStart') report(h, { sessionId: e.sessionId, event: 'SessionStart' }, undefined, e.transcriptPath);
  } else if (e.sessionId !== s.root) {
    // A subagent starts with an empty prompt; one with a prompt is a conversation the person started.
    if (e.event !== 'SessionStart' || !e.prompt || s.subagents.has(e.sessionId)) return subagentEvent(h, e, payload);
    newRoot(s, e.sessionId);
  }
  const r: LifecycleReport = { sessionId: e.sessionId, event: e.event, tool: e.tool, toolUseId: e.toolUseId, prompt: e.prompt };
  switch (e.event) {
    case 'SessionStart':
      drop(s);
      if (e.prompt) s.lastPrompt = e.prompt;
      return report(h, r, payload, e.transcriptPath);
    case 'PreInvocation': {
      if (e.invocationNum !== 0) return false;
      const woken = !e.prompt || e.prompt === s.lastPrompt; // the same prompt again: a subagent woke the root
      if (e.prompt) s.lastPrompt = e.prompt;
      if (s.held) {
        drop(s);
        // The root is working again and its next Stop decides.
        if (woken) return true;
      }
      return report(h, { ...r, event: 'UserPromptSubmit' }, payload, e.transcriptPath);
    }
    case 'PostInvocation':
      arm(h);
      return false;
    case 'Stop':
      if (e.transcriptPath) s.transcript = e.transcriptPath;
      if (s.subagents.size) {
        s.held = { payload }; // subagents still run: the turn goes on until the last of them stops
        arm(h);
        return true;
      }
      drop(s);
      return report(h, r, payload, e.transcriptPath);
    default:
      arm(h);
      return report(h, r, payload, e.transcriptPath);
  }
}

export const antigravity: ProviderAdapter<AntigravityState, AntigravitySetup> = {
  id: 'antigravity',
  scrubEnv: ['ANTIGRAVITY_CONVERSATION_ID', 'AGY'],
  createState: () => ({ subagents: new Set(), tools: new Map(), pending: new Set() }),
  // Only the helper goes in the data dir here; the plugin is written into the folder it runs in, at launch.
  prepare: ({ dataDir, mcpScript }) => ({ hook: writeAntigravityHook(dataDir), mcpScript }),
  launch({ h, args, cwd, prompt, resumeSessionId, setup, extraArgs }) {
    writeAntigravityPlugin(cwd, setup.hook, setup.mcpScript);
    reset(h.state);
    args.push(...antigravityTrustArgs(cwd));
    if (extraArgs) args.push(...extraArgs); // the phase's own flags, ahead of the resume and the prompt
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (prompt) args.push('-i', prompt);
    return { args, rotateToken: true };
  },
  // No bootHint: a resumed conversation fires no SessionStart, so it's idle as soon as it runs.
  hook: { strictJson: true, handle: antigravityHook },
  screen: {
    blocked: (text) => (/Do you trust the contents of this project\?/.test(text) ? "Antigravity is asking whether to trust this folder — open the terminal and answer it" : undefined),
  },
  usage: {
    persisted: true,
    save: (s) => ({ antigravityTranscript: s.transcript, antigravityRoot: s.root }),
    restore(s, saved) {
      if (typeof saved.antigravityTranscript === 'string') s.transcript = saved.antigravityTranscript;
      if (typeof saved.antigravityRoot === 'string') s.root = saved.antigravityRoot;
    },
  },
};
