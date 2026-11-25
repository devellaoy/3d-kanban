// Antigravity (`agy`): its hooks and MCP server come from a plugin the office writes into the
// workspace at each launch (see ../antigravity.ts) and report on /hooks/antigravity. It reports no usage.
import { antigravityTrustArgs, normalizeAntigravityHook, writeAntigravityHook, writeAntigravityPlugin, type AntigravityHookEvent } from '../antigravity.js';
import { answered, reduceLifecycle, type LifecycleReport, type ToolTracker } from '../workers/lifecycle.js';
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
  /** Subagents' open question calls (their ids), by conversation: they need the person too. */
  asking: Map<string, Set<string>>;
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
      s.asking.clear();
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
    waiting: () => !!(s.pending.size || s.permissionUnknown || s.asking.size),
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

/** While a Stop is held, any hook event shows the tree is alive (see HELD_STOP_MS); the silence never ends the turn while a subagent's question is open. */
function arm(h: WorkerHandle<AntigravityState>) {
  const s = h.state;
  if (!s.held) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = undefined;
    if (!s.held || !h.running) return;
    // A subagent's open question is the person's silence, not the tree's: the wait starts over, and the turn can't end under the dialog.
    if (s.asking.size) arm(h);
    else release(h);
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
  h.observeHook(e.event, e.tool, { ...(payload as object), agent_id: e.sessionId });
  if (e.event === 'Stop') {
    s.subagents.delete(e.sessionId);
    s.asking.delete(e.sessionId);
    if (s.held && s.subagents.size === 0) release(h);
    else settle(h);
  } else {
    if (s.subagents.size < 64) s.subagents.add(e.sessionId);
    if ((e.event === 'PreToolUse' || e.event === 'PostToolUse') && WAITS.test(e.tool ?? '')) {
      const calls = s.asking.get(e.sessionId) ?? new Set<string>();
      const key = e.toolUseId ?? `anon:${e.tool}`;
      if (e.event === 'PreToolUse') calls.add(key);
      else calls.delete(key);
      if (calls.size) s.asking.set(e.sessionId, calls);
      else s.asking.delete(e.sessionId);
      settle(h);
    }
  }
  arm(h);
  return false;
}

/** A subagent's question opened or closed: the worker needs input while any is open, and carries on once none is (a finished turn stays finished). */
function settle(h: WorkerHandle<AntigravityState>) {
  const s = h.state;
  if (tracker(s).waiting()) {
    if (h.info.status === 'working') {
      h.info.activity = 'A subagent is asking';
      h.setStatus('needs_input');
    }
  } else if (h.info.status === 'needs_input' && !h.bootBlocked) answered(h);
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

/** Its own prompts, as the CLI prints them at the start of a line (its banner "not signed in … Signing in..." shows at every start and is no prompt). */
const TRUST = /^[^\w\n]*Do you trust the contents of this project\?/m;
const SIGN_IN = /^[^\w\n]*(?:Select login method:|Select Google Cloud sign-in method:|Open this URL in your local browser to sign in:|Enter the authorization code:|Sign-in timed out\. Try again\.|No authentication methods available\.)/m;
const FIRST_RUN = /^[^\w\n]*Choose your color scheme:/m;

/**
 * Antigravity can sit at its prompt without being usable: on its trust, sign-in or first-run
 * screen. It never reports itself 'starting' (it has no boot hint), so `early` is no help here; the
 * text is only this run's visible screen, which a dialog that was answered has left.
 */
export function antigravityBlocked(text: string): string | undefined {
  if (TRUST.test(text)) return 'Antigravity is asking whether to trust this folder — open the terminal and answer it';
  if (SIGN_IN.test(text)) return 'Open the terminal: sign in to Antigravity';
  if (FIRST_RUN.test(text)) return "Open the terminal: finish Antigravity's first-run setup";
  return undefined;
}

export const antigravity: ProviderAdapter<AntigravityState, AntigravitySetup> = {
  id: 'antigravity',
  scrubEnv: ['ANTIGRAVITY_CONVERSATION_ID', 'AGY'],
  createState: () => ({ subagents: new Set(), asking: new Map(), tools: new Map(), pending: new Set() }),
  // Only the helper goes in the data dir here; the plugin is written into the folder it runs in, at launch.
  prepare: ({ dataDir, mcpScript }) => ({ hook: writeAntigravityHook(dataDir), mcpScript }),
  launch({ h, args, cwd, prompt, resumeSessionId, setup, extraArgs }) {
    reset(h.state);
    args.push(...antigravityTrustArgs(cwd));
    if (extraArgs) args.push(...extraArgs); // the phase's own flags, ahead of the resume and the prompt
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (prompt) args.push('-i', prompt);
    // Written just before it starts, and not at all when the folder's plugin isn't the office's: that fails the start with its message.
    return { args, rotateToken: true, finishEnv: () => void writeAntigravityPlugin(cwd, setup.hook, setup.mcpScript) };
  },
  // No bootHint: a resumed conversation fires no SessionStart, so it's idle as soon as it runs.
  hook: { strictJson: true, handle: antigravityHook },
  screen: { blocked: antigravityBlocked },
  usage: {
    persisted: true,
    save: (s) => ({ antigravityTranscript: s.transcript, antigravityRoot: s.root }),
    restore(s, saved) {
      if (typeof saved.antigravityTranscript === 'string') s.transcript = saved.antigravityTranscript;
      if (typeof saved.antigravityRoot === 'string') s.root = saved.antigravityRoot;
    },
  },
};
