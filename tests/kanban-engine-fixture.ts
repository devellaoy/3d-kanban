// Test fixture for the kanban engine (not a test itself): a git project, fake `claude` and `codex`
// CLIs that answer prompts by rules, write transcripts in the real CLIs' shapes and post their hooks
// to a local hook server, a real WorkerManager, and a KanbanContext around them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FloorDef } from '../src/server/building.js';
import type { Floor } from '../src/server/floor.js';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { createEngine, type EngineOptions, type KanbanEngine } from '../src/server/kanban/engine/index.js';
import { projectRepos } from '../src/server/kanban/projects.js';
import type { KanbanContext } from '../src/server/kanban/registry.js';
import { KanbanSecrets, KanbanSettingsStore } from '../src/server/kanban/settings.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type RunAs } from '../src/server/workers.js';
import type { Capacity } from '../src/server/machine.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { DepartureIntent, KanbanTask } from '../src/shared/kanban/types.js';

/** How a fake agent answers a prompt: the first rule whose `when` (a regex) matches it. */
export interface Rule {
  when: string;
  reply: string;
  /** Claude only: end the turn in ExitPlanMode with this plan (PermissionRequest, no Stop). */
  exitPlan?: string;
  /** Make an empty commit with this message first (the work). */
  commit?: string;
  /** Wait this long before answering (to type a comment meanwhile). */
  delayMs?: number;
  /** Run git with these arguments in the agent's folder first (checking out a branch, say). */
  git?: string[];
  /** Exit mid-turn instead of answering. */
  exit?: boolean;
  /** Say this in a message of its own first (with a tool call after it, as a real turn goes), before the final `reply`. */
  earlier?: string;
  /**
   * Claude only: launch a background agent and end the turn on this interim text (Stop), as Claude
   * Code does when it "waits for it to finish"; `backgroundMs` later (300 by default) the agent's
   * task-notification and the final `reply` are logged and a second Stop follows, with no hook of a
   * new turn in between.
   */
  background?: string;
  backgroundMs?: number;
  /** With `background`: the resumed turn runs a tool this long (PreToolUse, no result yet) before it replies. */
  resumeToolMs?: number;
  /** With `background`: the first Stop comes with the log ending at the Agent call; its result and the interim text are logged this long after. */
  launchLateMs?: number;
  /**
   * Claude only: spawn a teammate (agent teams) and end the turn on this interim text (Stop), as the
   * lead does when it "waits for the report"; the teammate's own transcript ends mid-tool and its own
   * hook (with an `agent_id`) comes. `teammatesMs` later (300 by default) its report and its idle
   * notification reach the lead's log, its transcript ends in text, and the final `reply` is logged
   * with a second Stop and no hook of a new turn in between.
   */
  teammates?: string;
  teammatesMs?: number;
  /** With `teammates`: after the final Stop a teammate still hooks the lead's worker (it works again), and this long after, the lead's turn on its message stops. */
  lateTeamMs?: number;
  /**
   * With `teammates`: 400 ms after the final Stop the teammate wakes on its own (its transcript ends mid-tool, no hook of the
   * lead's, the worker stays `done`), and this long later rests again and writes `team-rested` (ms) beside the invocations log.
   */
  teamAgainMs?: number;
  /**
   * Claude only: post Stop (with the reply as its last_assistant_message) before the final reply is
   * in the log, and log it this long after (-1: never), as Claude Code sometimes does (#310). The
   * turn ends there: it doesn't combine with `ask` or `exitPlan`. With `background` it is the resumed
   * turn's reply that is logged late (its Stop first).
   */
  lateLogMs?: number;
  /**
   * Claude only: a forged Stop, as anything in the agent's shell could post, carrying this as its
   * last_assistant_message while the tool call after `earlier` still runs (its result never logged).
   */
  forgedStop?: string;
  /**
   * Claude only: end the turn asking in the terminal after the reply, no Stop: true a permission
   * prompt (PermissionRequest); 'question' an AskUserQuestion (PreToolUse), whose answers typed in
   * (`questions` of them, 1 by default) end it with a PostToolUse, `answerDelayMs` after the last,
   * and the turn goes on by the rule matching the last answer.
   */
  ask?: boolean | 'question';
  questions?: number;
  answerDelayMs?: number;
}

export interface Invocation {
  kind: string;
  args: string[];
  cwd: string;
  prompt?: string;
  interrupted?: boolean;
  /** When it was recorded (ms). */
  at?: number;
}

const FAKE_AGENT = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (extra) => fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ kind, args, cwd: process.cwd(), at: Date.now(), ...extra }) + '\n');
if (args.includes('--output-format')) {
  process.stdout.write(JSON.stringify({ structured_output: { name: 'Fake task', summary: 'A fake task' } }));
  process.exit(0);
}
record({});
const at = kind === 'claude' ? args.indexOf('--resume') : args.indexOf('resume');
const session = at >= 0 ? args[at + 1] : kind + '-' + process.pid + '-' + Date.now();
const transcript = path.join(process.env.FAKE_TRANSCRIPTS, session + '.jsonl');
const append = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const post = (event, payload) => new Promise((resolve) => {
  const url = new URL(process.env.AGENT_OFFICE_HOOK_URL + '/hooks/' + (kind === 'codex' ? 'codex' : 'claude'));
  url.searchParams.set('worker', process.env.AGENT_OFFICE_WORKER_ID);
  url.searchParams.set('event', event);
  const req = http.request(url, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.AGENT_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', resolve);
  req.end(JSON.stringify({ session_id: session, transcript_path: transcript, ...payload }));
});
const rules = () => JSON.parse(fs.readFileSync(process.env.FAKE_KANBAN_RULES, 'utf8'));
// A sleep an Esc cuts short: resolves true then.
let wake = null;
const nap = (ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { wake = null; resolve(false); }, ms);
  wake = () => { clearTimeout(timer); wake = null; resolve(true); };
});
let questions = 0;
let answerDelay = 0;
async function turn(prompt, answered) {
  record({ prompt });
  if (!answered) await post('UserPromptSubmit', { prompt });
  const rule = rules().find((r) => new RegExp(r.when).test(prompt)) || { reply: 'OK' };
  if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
  if (rule.exit) process.exit(3);
  if (rule.git) cp.execFileSync('git', rule.git, { cwd: process.cwd(), stdio: 'ignore' });
  if (rule.commit) cp.execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '--allow-empty', '-q', '-m', rule.commit], { cwd: process.cwd() });
  if (kind === 'claude') {
    // One API message's blocks are logged as lines sharing its id, as Claude Code does.
    const msgId = 'msg-' + process.pid + '-' + Date.now();
    append({ type: 'user', message: { role: 'user', content: prompt } });
    if (rule.earlier) {
      append({ type: 'assistant', message: { id: msgId + '-a', role: 'assistant', content: [{ type: 'text', text: rule.earlier }] } });
      append({ type: 'assistant', message: { id: msgId + '-a', role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'README.md' } }] } });
      if (rule.forgedStop !== undefined) {
        await post('Stop', { last_assistant_message: rule.forgedStop });
        return;
      }
      append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: '# test' }] } });
    }
    if (rule.background !== undefined) {
      const agent = 'agent-' + msgId;
      append({ type: 'assistant', message: { id: msgId + '-bg', role: 'assistant', content: [{ type: 'tool_use', id: 'bg-1', name: 'Agent', input: { run_in_background: true } }] } });
      const launched = () => {
        append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg-1', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + agent + ' (internal ID)' }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent } });
        append({ type: 'assistant', message: { id: msgId + '-wait', role: 'assistant', content: [{ type: 'text', text: rule.background }] } });
      };
      if (rule.launchLateMs) {
        await post('Stop', { last_assistant_message: rule.background });
        await new Promise((r) => setTimeout(r, rule.launchLateMs));
        launched();
      } else {
        launched();
        await post('Stop', { last_assistant_message: rule.background });
      }
      await new Promise((r) => setTimeout(r, rule.backgroundMs ?? 300));
      append({ type: 'user', origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: '<task-notification>\n<task-id>' + agent + '</task-id>\n<status>completed</status>\n</task-notification>' } });
      if (rule.resumeToolMs) {
        append({ type: 'assistant', message: { id: msgId + '-tool', role: 'assistant', content: [{ type: 'tool_use', id: 'bg-2', name: 'Bash', input: { command: 'sleep' } }] } });
        await post('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep' } });
        // Esc cuts the wait short, as it does a real tool: the turn ends there.
        if (await nap(rule.resumeToolMs)) return post('Stop', {});
        append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg-2', content: 'ok' }] } });
      }
      const reply = { type: 'assistant', message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: rule.reply }] } };
      if (rule.lateLogMs !== undefined) {
        await post('Stop', { last_assistant_message: rule.reply });
        await new Promise((r) => setTimeout(r, rule.lateLogMs));
        append(reply);
        return;
      }
      append(reply);
      await post('Stop', { last_assistant_message: rule.reply });
      return;
    }
    if (rule.teammates !== undefined) {
      const stamp = () => new Date().toISOString();
      const lead = (o) => append({ timestamp: stamp(), ...o });
      const team = path.join(process.env.FAKE_TRANSCRIPTS, session, 'subagents');
      fs.mkdirSync(team, { recursive: true });
      const own = (o) => fs.appendFileSync(path.join(team, 'agent-ahelper-1.jsonl'), JSON.stringify({ timestamp: stamp(), isSidechain: true, ...o }) + '\n');
      fs.writeFileSync(path.join(team, 'agent-ahelper-1.meta.json'), JSON.stringify({ agentType: 'helper', name: 'helper', taskKind: 'in_process_teammate', teamName: 'session-1' }));
      lead({ type: 'assistant', message: { id: msgId + '-tm', role: 'assistant', content: [{ type: 'tool_use', id: 'tm-1', name: 'Agent', input: { name: 'helper' } }] } });
      lead({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tm-1', content: [{ type: 'text', text: 'Spawned successfully.\nagent_id: helper@session-1\nname: helper' }] }] }, toolUseResult: { status: 'teammate_spawned', name: 'helper', teammate_id: 'helper@session-1', team_name: 'session-1' } });
      own({ type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="team-lead" summary="Go">\nDo it.\n</teammate-message>' } });
      own({ type: 'assistant', message: { id: 'tm-own-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tm-own-t', name: 'Bash', input: { command: 'work' } }] } });
      lead({ type: 'assistant', message: { id: msgId + '-wait', role: 'assistant', content: [{ type: 'text', text: rule.teammates }] } });
      await post('Stop', { last_assistant_message: rule.teammates });
      // The teammate works: its hooks reach the lead's worker with an agent_id, and are none of the lead's turn.
      await post('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'work' }, agent_id: 'helper@session-1' });
      await new Promise((r) => setTimeout(r, rule.teammatesMs ?? 300));
      own({ type: 'assistant', message: { id: 'tm-own-2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
      const idle = JSON.stringify({ type: 'idle_notification', from: 'helper', timestamp: stamp(), idleReason: 'available', summary: '[to main] Done', result: 'Done {with braces}' });
      lead({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="helper" color="blue" summary="Done">\nAll done.\n</teammate-message>\n<teammate-message teammate_id="helper" color="blue">\n' + idle + '\n</teammate-message>' } });
      lead({ type: 'assistant', message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: rule.reply }] } });
      await post('Stop', { last_assistant_message: rule.reply });
      if (rule.teamAgainMs) {
        setTimeout(() => {
          own({ type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="team-lead" summary="Again">\nOne more.\n</teammate-message>' } });
          own({ type: 'assistant', message: { id: 'tm-own-3', role: 'assistant', content: [{ type: 'tool_use', id: 'tm-own-u', name: 'Bash', input: { command: 'more' } }] } });
          setTimeout(() => {
            own({ type: 'assistant', message: { id: 'tm-own-4', role: 'assistant', content: [{ type: 'text', text: 'Done again.' }] } });
            fs.writeFileSync(path.join(path.dirname(process.env.FAKE_AGENT_LOG), 'team-rested'), String(Date.now()));
          }, rule.teamAgainMs);
        }, 400);
      }
      if (rule.lateTeamMs) {
        await post('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'again' }, agent_id: 'helper@session-1' });
        await new Promise((r) => setTimeout(r, rule.lateTeamMs));
        await post('Stop', {});
      }
      return;
    }
    const final = { type: 'assistant', message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: rule.reply }] } };
    if (rule.lateLogMs !== undefined) {
      await post('Stop', { last_assistant_message: rule.reply });
      if (rule.lateLogMs >= 0) {
        await new Promise((r) => setTimeout(r, rule.lateLogMs));
        append(final);
      }
      return;
    }
    append(final);
    if (rule.ask === 'question') {
      await post('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: rule.reply }] } });
      questions = rule.questions || 1;
      answerDelay = rule.answerDelayMs || 0;
      return;
    }
    if (rule.ask) {
      await post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
      return;
    }
    if (rule.exitPlan) {
      append({ type: 'assistant', message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id: 'plan-' + Date.now(), name: 'ExitPlanMode', input: { plan: rule.exitPlan } }] } });
      await post('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: rule.exitPlan } });
      await post('PermissionRequest', { tool_name: 'ExitPlanMode' });
      return;
    }
  } else {
    append({ type: 'event_msg', payload: { type: 'user_message', message: prompt } });
    if (rule.earlier) append({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: rule.earlier }] } });
    append({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: rule.reply }] } });
    append({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: rule.reply } });
  }
  await post('Stop', kind === 'claude' ? { last_assistant_message: rule.reply } : {});
}
let chain = post('SessionStart', { source: at >= 0 ? 'resume' : 'startup' });
const dash = args.indexOf('--');
if (dash >= 0) chain = chain.then(() => turn(args[dash + 1]));
let buf = '';
// Raw, as the real TUI is: a lone Esc reaches it without a newline.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const start = buf.indexOf('\x1b[200~');
    const end = buf.indexOf('\x1b[201~');
    if (start < 0 || end < start) break;
    const prompt = buf.slice(start + 6, end);
    buf = buf.slice(end + 6);
    if (questions > 1) {
      questions--;
      chain = chain.then(() => record({ prompt, answer: true }));
    } else if (questions === 1) {
      questions = 0;
      chain = chain.then(async () => {
        if (answerDelay) await new Promise((r) => setTimeout(r, answerDelay));
        await post('PostToolUse', { tool_name: 'AskUserQuestion' });
        await turn(prompt, true);
      });
    } else chain = chain.then(() => turn(prompt));
  }
  if (buf.includes('\x1b') && !buf.includes('\x1b[')) {
    buf = '';
    record({ interrupted: true });
    if (wake) wake();
    chain = chain.then(() => post('Stop', {}));
  }
});
process.stdin.resume();
`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();

export function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

/** A task as one `repo.updateTask` left it, with the run going at that moment and when it was. */
export interface TaskSnapshot {
  task: KanbanTask;
  runId?: number;
  at: number;
}

export interface EngineFixture {
  root: string;
  dir: string;
  def: FloorDef;
  workers: WorkerManager;
  repo: KanbanRepository;
  settings: KanbanSettingsStore;
  ctx: KanbanContext;
  engine: KanbanEngine;
  broadcasts: KanbanServerMsg[];
  setRules(rules: Rule[]): void;
  invocations(): Invocation[];
  task(id: number): KanbanTask;
  newTask(patch?: Partial<Parameters<KanbanRepository['createTask']>[0]>): KanbanTask;
  waitTask(id: number, pred: (t: KanbanTask) => boolean, what: string, timeout?: number): Promise<KanbanTask>;
  /** Every state the task was updated to, oldest first. */
  history(id: number): TaskSnapshot[];
  /**
   * Waits until the task was, at any update from `history(id)[since]` on, in a state `pred` accepts, and
   * returns that update. For a state the engine may already have left by the time a poll looks (in
   * progress between an answer typed in and the turn's end, when the fake agent is quick), where
   * `waitTask` would miss it on a slow machine.
   */
  sawTask(id: number, pred: (t: KanbanTask) => boolean, what: string, timeout?: number, since?: number): Promise<TaskSnapshot>;
  close(): Promise<void>;
}

/** Keep the fake CLIs away from the user's own configs and sign-ins (as tests/workers.test.ts does). */
function isolate(root: string, bin: string): () => void {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'FAKE_AGENT_LOG', 'FAKE_TRANSCRIPTS', 'FAKE_KANBAN_RULES'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PATH = `${bin}${path.delimiter}${before.PATH ?? ''}`;
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
  process.env.XDG_STATE_HOME = path.join(root, 'xdg-state');
  process.env.XDG_CACHE_HOME = path.join(root, 'xdg-cache');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config', 'claude');
  process.env.CODEX_HOME = path.join(root, 'config', 'codex');
  const removed: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) {
      removed[key] = process.env[key]!;
      delete process.env[key];
    }
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.assign(process.env, removed);
  };
}

export async function engineFixture(opts: { engine?: EngineOptions; repos?: FloorDef['repos']; capacity?: Capacity; runAs?: RunAs; notify?: (title: string, detail?: string) => void } = {}): Promise<EngineFixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-engine-'));
  const dir = path.join(root, 'proj');
  makeRepo(dir);
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex']) {
    writeFileSync(path.join(bin, name), FAKE_AGENT, { mode: 0o755 });
    if (process.platform === 'win32') {
      writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\n"' + process.execPath + '" "%~dp0' + name + '" %*\r\n');
    }
  }
  const transcripts = path.join(root, 'transcripts');
  mkdirSync(transcripts, { recursive: true });
  const log = path.join(root, 'invocations.jsonl');
  writeFileSync(log, '');
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, '[]');
  const restore = isolate(root, bin);
  process.env.FAKE_AGENT_LOG = log;
  process.env.FAKE_TRANSCRIPTS = transcripts;
  process.env.FAKE_KANBAN_RULES = rulesFile;

  let workers!: WorkerManager;
  const hooks = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const worker = url.searchParams.get('worker') ?? '';
      const event = url.searchParams.get('event') ?? '';
      let payload: unknown = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        // counts as the event anyway
      }
      const ok = url.pathname === '/hooks/codex' ? workers.handleCodexHook(worker, token, event, payload) : workers.handleHook(worker, token, event, payload);
      res.writeHead(ok ? 200 : 401).end('{}');
    });
  });
  await new Promise<void>((resolve) => hooks.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}`;

  const data = path.join(root, 'data');
  mkdirSync(data, { recursive: true });
  const toasts: string[] = [];
  workers = new WorkerManager(dir, data, path.join(bin, 'claude'), [], { url: hookUrl, token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast: (t) => void toasts.push(t) }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}), opts.capacity, undefined, opts.runAs);
  const def: FloorDef = { id: 'proj', name: 'Proj', dir, repo: 'acme/proj', palette: 0, addedBy: 'test', addedAt: 0, ...(opts.repos ? { repos: opts.repos } : {}) };
  const floor = { id: 'proj', dir, workers, project: { name: 'Proj', dir, branch: 'main' }, sendHome: (id: string, cleanup?: 'keep' | 'worktree' | 'all', intent?: DepartureIntent) => workers.kill(id, cleanup, undefined, undefined, intent) } as unknown as Floor;
  const repo = new KanbanRepository(openKanbanDb(':memory:'));
  // Every update is kept, so a test can check a state the task only passed through (sawTask).
  const history = new Map<number, TaskSnapshot[]>();
  const updateTask = repo.updateTask.bind(repo);
  repo.updateTask = (id, patch) => {
    const t = updateTask(id, patch);
    if (t) {
      let list = history.get(id);
      if (!list) history.set(id, (list = []));
      list.push({ task: t, runId: repo.activeRun(id)?.id, at: Date.now() });
    }
    return t;
  };
  const kanbanData = path.join(root, 'kanban-data');
  mkdirSync(kanbanData, { recursive: true });
  const settings = new KanbanSettingsStore(kanbanData);
  const broadcasts: KanbanServerMsg[] = [];
  const ctx: KanbanContext = {
    dataDir: kanbanData,
    filesDir: path.join(kanbanData, 'kanban'),
    repo,
    settings,
    secrets: new KanbanSecrets(kanbanData),
    projects: () => [def],
    project: (id) => (id === def.id ? def : undefined),
    floor: (id) => (id === def.id ? floor : undefined),
    repos: () => projectRepos(def),
    setRepos: () => 'not in tests',
    setName: () => 'not in tests',
    officePrompts: () => ({}),
    hookUrl,
    broadcast: (msg) => void broadcasts.push(msg),
    toast: (_f, text) => void toasts.push(text),
    ...(opts.capacity ? { capacity: () => opts.capacity!.full() } : {}),
    ...(opts.runAs ? { runAs: opts.runAs } : {}),
    ...(opts.notify ? { notify: opts.notify } : {}),
    engine: undefined as unknown as KanbanContext['engine'],
    pulls: { bundle: async () => 'no', review: async () => 'no' },
    refs: { referencedTasksFile: () => undefined },
    workerExtras: () => ({ args: [], env: { FAKE_EXTRA: '1' } }),
  };
  const engine = createEngine(ctx, { readPauseMs: 50, stopGraceMs: 1500, ...opts.engine });
  ctx.engine = engine;
  engine.begin();

  const fx: EngineFixture = {
    root,
    dir,
    def,
    workers,
    repo,
    settings,
    ctx,
    engine,
    broadcasts,
    setRules: (rules) => writeFileSync(rulesFile, JSON.stringify(rules)),
    invocations: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Invocation) : []),
    task: (id) => repo.getTask(id)!,
    newTask: (patch = {}) => repo.createTask({ project: 'proj', title: 'Fix the login redirect', description: 'After login, go back to the page you came from.', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada', ...patch }),
    async waitTask(id, pred, what, timeout = 15_000) {
      const end = Date.now() + timeout;
      let t = repo.getTask(id)!;
      while (!pred(t) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 30));
        t = repo.getTask(id)!;
      }
      assert.ok(pred(t), `timed out waiting for ${what}: status ${t.status}, phase ${t.phase}, runState ${t.runState}, waiting ${t.waitingReason ?? '-'} ${t.waitingText ?? ''}`);
      return t;
    },
    history: (id) => [...(history.get(id) ?? [])],
    async sawTask(id, pred, what, timeout = 15_000, since = 0) {
      const end = Date.now() + timeout;
      const find = () => (history.get(id) ?? []).slice(since).find((s) => pred(s.task));
      let hit = find();
      while (!hit && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 30));
        hit = find();
      }
      const seen = (history.get(id) ?? []).slice(since).map((s) => `${s.task.status}/${s.task.phase ?? '-'}/${s.task.runState}`);
      assert.ok(hit, `timed out waiting for ${what}; the task went through: ${seen.join(' → ') || 'no updates'}`);
      return hit;
    },
    async close() {
      engine.dispose();
      for (const w of workers.list()) await workers.kill(w.id, 'all');
      workers.shutdown();
      await new Promise<void>((resolve) => hooks.close(() => resolve()));
      restore();
      // Windows may retain the PTY working directory until the host finishes stopping.
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
  return fx;
}

export const ADA = { name: 'Ada', admin: true };
