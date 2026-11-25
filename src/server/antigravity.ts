import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { excludeFromGit } from './config.js';
import { MCP_NAME } from './office-workers.js';

// Antigravity (`agy`) has no hook flags: it loads hooks and MCP servers from a plugin folder in the
// workspace, which the office writes at each launch (see writeAntigravityPlugin). The helper below
// turns its camelCase hook payloads into the snake_case body the office's /hooks/antigravity takes.

export const ANTIGRAVITY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const;

export type AntigravityHookEventName = (typeof ANTIGRAVITY_HOOK_EVENTS)[number];

/** The bounded event shape the provider reduces. */
export interface AntigravityHookEvent {
  /** The conversation it came from: the root's, or one of its subagents'. */
  sessionId: string;
  event: AntigravityHookEventName;
  /** The person's latest message (PreInvocation; SessionStart, where a new conversation of the person's has one and a subagent's is empty). */
  prompt?: string;
  tool?: string;
  toolUseId?: string;
  /** Only server-side readers use this path; never sent to browsers. */
  transcriptPath?: string;
  /** Which model call of the prompt this is; 0 is the first (Pre/PostInvocation). */
  invocationNum?: number;
  /** Stop: nothing of the whole conversation tree, subagents included, is still running. */
  fullyIdle?: boolean;
}

const MAX_ID = 160;
const MAX_TEXT = 20_000;
const MAX_CALLS = 1_000_000;
const EVENT_SET = new Set<string>(ANTIGRAVITY_HOOK_EVENTS);

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

/** Validate and compact the helper's body; unknown fields and anything over its bounds are dropped. */
export function normalizeAntigravityHook(event: string, payload: unknown): AntigravityHookEvent | undefined {
  if (!EVENT_SET.has(event) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const sessionId = bounded(p.session_id, MAX_ID);
  if (!sessionId) return undefined;
  const result: AntigravityHookEvent = { sessionId, event: event as AntigravityHookEventName };
  if (event === 'SessionStart') {
    const prompt = bounded(p.prompt, MAX_TEXT);
    if (prompt) result.prompt = prompt;
  }
  const transcriptPath = bounded(p.transcript_path, 4096);
  if (transcriptPath) result.transcriptPath = transcriptPath;
  if (event === 'PreInvocation' || event === 'PostInvocation') {
    const n = p.invocation_num;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_CALLS) result.invocationNum = n;
    const prompt = event === 'PreInvocation' ? bounded(p.prompt, MAX_TEXT) : undefined;
    if (prompt) result.prompt = prompt;
  } else if (event === 'PreToolUse' || event === 'PostToolUse') {
    const tool = bounded(p.tool_name, MAX_ID);
    if (tool) result.tool = tool;
    const toolUseId = bounded(p.tool_use_id, MAX_ID);
    if (toolUseId) result.toolUseId = toolUseId;
  } else if (event === 'Stop' && typeof p.fully_idle === 'boolean') {
    result.fullyIdle = p.fully_idle;
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const MCP_HELPER = 'agent-office-antigravity-mcp.cjs';

/** Write the stable, self-contained helpers Antigravity runs (the command hooks, and the MCP launcher beside them); gives the hook's path. */
export function writeAntigravityHook(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'agent-office-antigravity-hook.cjs');
  for (const [f, source] of [[file, ANTIGRAVITY_HOOK_SOURCE], [path.join(dataDir, MCP_HELPER), ANTIGRAVITY_MCP_SOURCE]]) {
    writeFileSync(f, source, { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  return file;
}

/**
 * The plugin stays in a checkout after its worker leaves, so the person's own `agy` there would start
 * the office's MCP server: this launcher runs it only inside a worker's environment.
 */
export const ANTIGRAVITY_MCP_SOURCE = String.raw`'use strict';
if (!process.env.AGENT_OFFICE_WORKER_ID || !process.env.AGENT_OFFICE_HOOK_URL) process.exit(0);
const child = require('node:child_process').spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`;

/**
 * The helper only reads hook stdin (up to 32 MiB: every payload carries the person's whole prompt, and
 * tool calls their arguments) and the worker bridge environment; it prints nothing. Long texts are
 * cut to what the office keeps rather than dropped, so no event is ever lost to a big prompt.
 */
export const ANTIGRAVITY_HOOK_SOURCE = String.raw`'use strict';
const MAX = 32 * 1024 * 1024;
const EVENTS = new Set(${JSON.stringify(ANTIGRAVITY_HOOK_EVENTS)});
const MAX_ID = 160;
const MAX_TEXT = 20000;
const allowed = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined;
const cut = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const event = process.argv[2];
let size = 0;
let overflow = false;
const chunks = [];
process.stdin.on('data', (chunk) => {
  if (overflow) return;
  size += chunk.length;
  if (size > MAX) { overflow = true; return; }
  chunks.push(chunk);
});
process.stdin.on('error', () => {});
process.stdin.on('end', async () => {
  if (overflow || !EVENTS.has(event)) return;
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const session = allowed(input.conversationId, MAX_ID);
  if (!session) return;
  const body = { session_id: session, hook_event_name: event };
  const invocation = event === 'PreInvocation' || event === 'PostInvocation';
  const tools = event === 'PreToolUse' || event === 'PostToolUse';
  const call = tools && input.toolCall && typeof input.toolCall === 'object' ? input.toolCall : {};
  const prompt = event === 'PreInvocation' || event === 'SessionStart' ? cut(input.lastUserInput, MAX_TEXT) : undefined;
  const tool = allowed(call.name, MAX_ID);
  const toolUseId = allowed(call.id, MAX_ID);
  const transcript = allowed(input.transcriptPath, 4096);
  if (prompt) body.prompt = prompt;
  if (tool) body.tool_name = tool;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (transcript) body.transcript_path = transcript;
  if (invocation && Number.isInteger(input.invocationNum)) body.invocation_num = input.invocationNum;
  if (event === 'Stop') {
    if (typeof input.fullyIdle === 'boolean') body.fully_idle = input.fullyIdle;
    const reason = allowed(input.terminationReason, MAX_ID);
    if (reason) body.termination_reason = reason;
    const error = cut(input.error, MAX_TEXT);
    if (error) body.error = error;
  }
  const base = process.env.AGENT_OFFICE_HOOK_URL;
  const token = process.env.AGENT_OFFICE_HOOK_TOKEN;
  const worker = process.env.AGENT_OFFICE_WORKER_ID;
  if (!base || !token || !worker) return;
  try {
    const url = new URL('/hooks/antigravity', base);
    url.searchParams.set('worker', worker);
    url.searchParams.set('event', event);
    await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
});
`;

/** Where the office's plugin lives in a workspace, and the pattern that keeps it out of git. */
const PLUGIN_DIR = path.join('.agents', 'plugins', 'agent-office');
const PLUGIN_EXCLUDE = '.agents/plugins/agent-office/';

/** hooks.json: the office's command hook for each event (tool events take a matcher, the others are the handler itself). */
function pluginHooks(hookPath: string): Record<string, unknown> {
  const block: Record<string, unknown> = { enabled: true };
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const handler = { type: 'command', command: [process.execPath, hookPath, event].map(shellQuote).join(' '), timeout: 5 };
    block[event] = event === 'PreToolUse' || event === 'PostToolUse' ? [{ matcher: '.*', hooks: [handler] }] : [handler];
  }
  return { [MCP_NAME]: block };
}

/** Written first into the office's plugin folder: only a folder with it (or an empty one) is the office's to rewrite. */
const PLUGIN_MARKER = '.agent-office-plugin';

/** Why the plugin folder of `cwd` is not the office's own, when it isn't: it must never overwrite a project's files. */
function foreignPlugin(cwd: string, dir: string): string | undefined {
  try {
    const tracked = execFileSync('git', ['ls-files', '--', PLUGIN_EXCLUDE], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (tracked.trim()) return 'it is tracked by git';
  } catch {
    // not a git work tree
  }
  try {
    if (existsSync(dir) && readdirSync(dir).length && !existsSync(path.join(dir, PLUGIN_MARKER))) return 'it has no office marker';
  } catch {
    return 'it is not a folder';
  }
  return undefined;
}

function writeIfChanged(file: string, content: string) {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  } catch {
    // unreadable: write it afresh
  }
  writeFileSync(file, content);
}

/**
 * Antigravity takes hooks and MCP servers from `<workspace>/.agents/plugins/<name>/`, once the
 * workspace is trusted (see antigravityTrustArgs). The office's plugin is rewritten at every launch
 * and kept out of git through the repository's info/exclude. A folder of that name that isn't the
 * office's own (tracked by git, or without its marker) is left alone and the launch fails.
 */
export function writeAntigravityPlugin(cwd: string, hookPath: string, mcpScript?: string): string {
  const dir = path.join(cwd, PLUGIN_DIR);
  const foreign = foreignPlugin(cwd, dir);
  if (foreign) throw new Error(`Antigravity can't start here: ${PLUGIN_EXCLUDE} in this project is not the office's own (${foreign}). Move or remove it, then press R`);
  mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(dir, PLUGIN_MARKER), "This folder is written by Agent Office at each launch; the office may rewrite it.\n");
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  writeIfChanged(path.join(dir, 'plugin.json'), json({ name: MCP_NAME, version: '1.0.0', description: "Agent Office: reports this agent's turns to the office and gives it the office's tools." }));
  writeIfChanged(path.join(dir, 'hooks.json'), json(pluginHooks(hookPath)));
  const helper = path.join(path.dirname(hookPath), MCP_HELPER);
  const servers = mcpScript ? { [MCP_NAME]: { command: process.execPath, args: [helper, mcpScript, 'mcp'] } } : {};
  writeIfChanged(path.join(dir, 'mcp_config.json'), json({ mcpServers: servers }));
  excludeFromGit(cwd, PLUGIN_EXCLUDE);
  return dir;
}

/** The folder is trusted for this session only, so its trust screen never shows (nothing is saved to the user's settings). */
export function antigravityTrustArgs(cwd: string): string[] {
  return ['--settings', JSON.stringify({ trustedWorkspaces: [cwd] })];
}
