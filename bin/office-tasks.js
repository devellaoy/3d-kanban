#!/usr/bin/env node
// office-tasks: other kanban tasks, from inside `office-tasks get 14` prints task #14's
// description, accepted plan, runs and review verdicts, latest comments, repositories and branches,
// pull requests and report files; `office-tasks search <words>` finds tasks; `office-tasks create`
// puts new work on the board as a task (it runs through the kanban process). The office puts it on
// every worker's PATH and gives each its own address and token in AGENT_OFFICE_HOOK_URL,
// AGENT_OFFICE_WORKER_ID and AGENT_OFFICE_HOOK_TOKEN; this talks to the hook server's /office/tasks
// endpoints with them (src/server/kanban/integrations/refs; create: integrations/issues/agent-create.ts).
// The agent-office MCP server (bin/office-workers.js) offers the same as get_task, search_tasks and
// create_task. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-tasks get <ref> [--tail] [--json]    another kanban task: <ref> is its number (14, #14),
                                              its ticket id (UYT-1415) or part of its title.
                                              --tail adds the end of its worker's terminal
  office-tasks search <words> [--json]        tasks with these words in their title, ticket or
                                              description
  office-tasks create --title "…" [options] <<'EOF'   put work on the board as a new task; its
  …the description, complete on its own…              description on stdin (or --prompt "…"). It
  EOF                                                 stays in To do unless --start. Options:
                                                      --project <id|name> --repo <name|id> (repeat)
                                                      --issue <12|owner/repo#12|KEY> (a GitHub issue
                                                      or Jira key; then title and description may be
                                                      left out) --ticket <id> --ticket-url <url>
                                                      --provider claude|codex --model <m>
                                                      --effort minimal|low|medium|high|xhigh|max
                                                      --type implement|investigate --start
                                                      --desk <id> (with --start) --no-description --json
                                              prints the task's number. --start seats a worker
                                              (or queues it when the office is full) that runs
                                              without permission prompts, unattended; it is
                                              honoured only for an agent a person hired at a
                                              desk or a board agent, in its own project —
                                              otherwise the task waits in To do for a person.
                                              --no-description skips reading stdin (with --issue);
                                              stdin that sends nothing for 3 s counts as empty`;

export class UsageError extends Error {}

const ENV = ['AGENT_OFFICE_HOOK_URL', 'AGENT_OFFICE_WORKER_ID', 'AGENT_OFFICE_HOOK_TOKEN'];
const RETRY_MS = 6000;
const TIMEOUT_MS = 15_000;
/** Creating a task may fetch the issue from GitHub and start a worker. */
const CREATE_TIMEOUT_MS = 90_000;
/** A description on stdin that has not started within this long is taken as none. */
const STDIN_IDLE_MS = 3000;
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PROVIDERS = ['claude', 'codex'];
export const TASK_TYPES = ['implement', 'investigate'];

/**
 * Reads `--flag value` and `--flag=value` options (a flag in `many` may repeat), and the words that aren't options.
 * @param {string[]} args
 * @param {string[]} valued flags that take a value
 * @param {string[]} bare flags that don't
 * @param {string[]} [many] valued flags that may be given several times
 */
function options(args, valued, bare, many = []) {
  /** @type {Record<string, string | true | string[]>} */
  const opts = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg.length > 1) throw new UsageError(`Unknown option: ${arg}`);
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (bare.includes(flag)) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      opts[flag] = true;
    } else if (valued.includes(flag) || many.includes(flag)) {
      let value;
      if (eq > 0) value = arg.slice(eq + 1);
      else if (i + 1 < args.length) value = args[++i];
      else throw new UsageError(`${flag} needs a value`);
      if (many.includes(flag)) opts[flag] = [...(opts[flag] ?? []), value];
      else opts[flag] = value;
    } else throw new UsageError(`Unknown option: ${flag}`);
  }
  return { opts, words };
}

/** The create command's flags, checked here so a typo fails before the office is asked. */
function parseCreate(rest) {
  const { opts, words } = options(
    rest,
    ['--title', '--prompt', '--project', '--issue', '--ticket', '--ticket-url', '--provider', '--model', '--effort', '--type', '--desk'],
    ['--start', '--json', '--no-description'],
    ['--repo'],
  );
  if (words.length) throw new UsageError(`Unexpected argument: ${words[0]} (give the description on stdin or with --prompt)`);
  const text = (k) => String(opts[k]).trim();
  const oneOf = (k, list) => {
    if (opts[k] !== undefined && !list.includes(text(k))) throw new UsageError(`${k} is one of ${list.join(', ')}`);
  };
  oneOf('--effort', EFFORTS);
  oneOf('--provider', PROVIDERS);
  oneOf('--type', TASK_TYPES);
  /** @type {Record<string, unknown>} */
  const out = { cmd: 'create', json: opts['--json'] === true };
  if (opts['--prompt'] !== undefined) out.prompt = String(opts['--prompt']);
  const names = { '--title': 'title', '--project': 'project', '--ticket': 'ticket', '--ticket-url': 'ticketUrl', '--provider': 'provider', '--model': 'model', '--effort': 'effort', '--type': 'type', '--desk': 'desk' };
  for (const [flag, key] of Object.entries(names)) if (opts[flag] !== undefined) out[key] = text(flag);
  if (opts['--repo']) out.repos = opts['--repo'].map((r) => r.trim()).filter(Boolean);
  if (opts['--issue'] !== undefined) {
    const issue = text('--issue').replace(/^#(?=\d+$)/, '');
    if (!issue) throw new UsageError('--issue needs an issue: 12, owner/repo#12 or a Jira key');
    out.issue = /^\d+$/.test(issue) ? Number(issue) : issue;
  }
  if (opts['--start']) out.start = true;
  if (opts['--no-description']) out.noDescription = true;
  return out;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || rest.some(help)) return { cmd: 'help' };
  if (cmd === 'create' || cmd === 'new') return parseCreate(rest);
  const flags = rest.filter((a) => a.startsWith('--'));
  const words = rest.filter((a) => !a.startsWith('--'));
  const known = cmd === 'get' || cmd === 'show' ? ['--tail', '--json'] : ['--json'];
  const bad = flags.find((f) => !known.includes(f));
  if (bad) throw new UsageError(`Unknown option: ${bad}`);
  const json = flags.includes('--json');
  if (cmd === 'get' || cmd === 'show') {
    if (words.length !== 1) throw new UsageError('get takes one task: its number, ticket id or part of its title (quote words with spaces)');
    return { cmd: 'get', ref: words[0], tail: flags.includes('--tail'), json };
  }
  if (cmd === 'search' || cmd === 'find') {
    if (!words.length) throw new UsageError('search needs something to look for');
    return { cmd: 'search', query: words.join(' '), json };
  }
  throw new UsageError(`Unknown command: ${cmd}`);
}

/** Whether this worker is one the office tells about tasks (the MCP server lists get_task and search_tasks then). */
export function tasksVisible(env) {
  return !!(env.AIKANBAN_API_BASE || env.AGENT_OFFICE_TASKS);
}

/**
 * The request for one call. With the office's worker variables it goes to /office/tasks with the
 * worker's token; without them, but with AIKANBAN_API_BASE, to the loopback /api/tasks/reference
 * (search needs the worker's token).
 * create is a POST of the task as JSON and needs the worker variables.
 * @param {'get' | 'search' | 'create'} what
 * @param {{ ref?: string, tail?: boolean, query?: string, body?: Record<string, unknown> }} args
 * @param {Record<string, string | undefined>} env
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string, timeout: number, legacy: boolean }}
 */
export function buildRequest(what, args, env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    if (what === 'get' && env.AIKANBAN_API_BASE) {
      const url = new URL(`${env.AIKANBAN_API_BASE.replace(/\/+$/, '')}/api/tasks/reference`);
      url.searchParams.set('ref', String(args.ref ?? ''));
      return { method: 'GET', url: url.href, headers: {}, timeout: TIMEOUT_MS, legacy: true };
    }
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-tasks only works inside the office, from a worker's terminal.`);
  }
  const url = new URL(`${env.AGENT_OFFICE_HOOK_URL.replace(/\/+$/, '')}/office/tasks/${what === 'get' ? 'reference' : what === 'create' ? 'create' : 'search'}`);
  url.searchParams.set('worker', env.AGENT_OFFICE_WORKER_ID);
  const headers = { authorization: `Bearer ${env.AGENT_OFFICE_HOOK_TOKEN}` };
  if (what === 'create') {
    return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args.body ?? {}), timeout: CREATE_TIMEOUT_MS, legacy: false };
  }
  if (what === 'get') {
    url.searchParams.set('ref', String(args.ref ?? ''));
    if (args.tail) url.searchParams.set('tail', '1');
  } else url.searchParams.set('q', String(args.query ?? ''));
  return { method: 'GET', url: url.href, headers, timeout: TIMEOUT_MS, legacy: false };
}

async function send(req, fetchImpl) {
  const until = Date.now() + RETRY_MS;
  for (;;) {
    try {
      const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeout) });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text.slice(0, 300) };
      }
      if (res.status === 401) throw new Error(`The office didn't accept this worker's token (401)${body?.error ? `: ${body.error}` : ''}.`);
      if (res.status === 404) throw new Error("The office doesn't know office-tasks (404): it isn't a 3d-kanban office, or an older one.");
      if (res.status < 200 || res.status >= 300) throw new Error(body?.error || `The office said no (${res.status}).`);
      return body;
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      if (code === 'ECONNREFUSED' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (code) throw new Error(`Couldn't reach the office at ${new URL(req.url).origin} (${code}). Is it running?`);
      throw err;
    }
  }
}

/**
 * One call: resolves to the office's answer.
 * @param {'get' | 'search' | 'create'} what
 * @param {{ ref?: string, tail?: boolean, query?: string, body?: Record<string, unknown> }} args
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch }} io
 */
export async function call(what, args, io) {
  return send(buildRequest(what, args, io.env), io.fetch);
}

const when = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : String(ms ?? ''));

/** A candidate, in a line. */
function candidateLine(t) {
  return `#${t.id}  ${t.title}${t.ticket ?? t.ticketId ? ` [${t.ticket ?? t.ticketId}]` : ''} · ${t.status === 'on_hold' ? 'On hold' : t.status}${t.project ? ` · ${t.project}` : t.repository ? ` · ${t.repository}` : ''}`;
}

/** A task bundle (the office's /office/tasks/reference match), as text for an agent to read. */
export function formatTask(b) {
  const out = [`# Task #${b.id}: ${b.title}`, ''];
  out.push(`Project: ${b.project?.name ?? b.repository ?? '?'} · status ${b.status === 'on_hold' ? 'On hold' : b.status}${b.phase ? ` · phase ${b.phase}` : ''}`);
  if (b.hold) out.push(`On hold since ${when(b.hold.at)}${b.hold.note ? `: ${b.hold.note}` : ''}${b.hold.until ? ` · until ${new Date(b.hold.until).toISOString().slice(0, 10)}` : ''}`);
  if (b.ticket) out.push(`Ticket: ${b.ticket}${b.ticketUrl ? ` ${b.ticketUrl}` : ''}`);
  for (const r of b.repos ?? []) out.push(`Repository ${r.name}${r.remote ? ` (${r.remote})` : ''}${r.branch ? `: branch ${r.branch}` : ''}`);
  if (b.branchName) out.push(`Branch: ${b.branchName}`);
  for (const p of b.prs ?? []) out.push(`Pull request ${p.repo ? `${p.repo}#` : '#'}${p.number} (${p.state}): ${p.url}`);
  for (const f of b.reportFiles ?? []) out.push(`Report file: ${typeof f === 'string' ? f : f.path}`);
  out.push('', '## Description', '', b.description?.trim() || '(none)');
  const plan = b.acceptedPlan ?? b.plan;
  if (plan) out.push('', '## Accepted plan', '', plan.trim());
  if (b.summary) out.push('', '## Summary', '', b.summary.trim());
  if (b.runs?.length) {
    out.push('', '## Runs');
    for (const r of b.runs) out.push(`- ${r.phase}${r.round ? ` ${r.round}` : ''}: ${r.status}${r.verdict ? `, ${r.verdict}` : ''}${r.finishedAt ? ` (${when(r.finishedAt)})` : ''}${r.summary ? ` — ${r.summary.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  }
  if (b.comments?.length) {
    out.push('', '## Latest comments (oldest first)');
    for (const c of b.comments) out.push('', `**${c.authorName ?? c.author}**${c.authorKind ? ` (${c.authorKind})` : ''}, ${when(c.createdAt)}:`, String(c.text ?? c.content ?? '').trim());
  }
  if (b.terminalTail) out.push('', "## The end of its worker's terminal", '', '```', b.terminalTail, '```');
  return out.join('\n');
}

/** What get answered, as text: the task, or the candidates to pick from, or that there's none. */
export function formatAnswer(answer, ref) {
  if (answer?.match) return formatTask(answer.match);
  const c = answer?.candidates ?? [];
  if (!c.length) return `No task matches ${JSON.stringify(ref)}.`;
  return [`${c.length} tasks match ${JSON.stringify(ref)}; ask again with the number of the one you mean:`, ...c.map(candidateLine)].join('\n');
}

export function formatSearch(answer) {
  const t = answer?.tasks ?? [];
  return t.length ? t.map(candidateLine).join('\n') : 'No tasks found.';
}

/** What create answered, in a line (plus the office's note and any start error). */
export function formatCreated(answer) {
  const t = answer?.task ?? {};
  // A start with no room yet is queued: it starts by itself once there is.
  const state = answer?.queued ? 'queued' : answer?.started ? 'started' : `in ${t.status === 'todo' || !t.status ? 'To do' : t.status}`;
  const lines = [`${answer?.existed ? 'Task' : 'Created task'} #${t.id} “${t.title}”${answer?.existed ? ' already existed' : ''} — ${state} — ${t.url ?? `/kanban?task=${t.id}`}`];
  if (answer?.startError) lines.push(`It did not start: ${answer.startError}`);
  if (answer?.note) lines.push(answer.note);
  return lines.join('\n');
}

// --- MCP tools (served by bin/office-workers.js mcp) ----------------------------------------------

export const TASK_TOOLS = [
  {
    name: 'create_task',
    title: 'Create a kanban task',
    description:
      "Puts work on this office's kanban board as a task, which runs through the kanban process (plan, implementation runs, review, the board's columns), not as a plain worker. " +
      'Give a title and a description that is complete on its own (what to change and where, how to check it), unless you give issue. ' +
      'issue links a GitHub issue (a number, or owner/repo#12) or a Jira key, which the task takes like one made from the issues board; it is assigned to whoever you work for when they have their own GitHub sign-in. ' +
      'The task stays in To do for a person unless start is true, which seats a worker for it (or queues it when the office is full); that worker runs without permission prompts, unattended. ' +
      "start is honoured only for an agent a person hired at a desk or a board agent, and only in its own project; for any other caller (a task's worker, an agent-hired or queued worker) or another project the task waits in To do. " +
      'Returns the task\'s number and link; get_task reads it afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title. Needed with description unless issue is given.' },
        description: { type: 'string', description: 'What to do, complete on its own. Needed with title unless issue is given.' },
        project: { type: 'string', description: "The project's id or name. Default: the office's only or current one." },
        repos: { type: 'array', items: { type: 'string' }, description: "The repositories the task touches, by name or id (default: the project's)." },
        issue: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }], description: 'A GitHub issue (12 or owner/repo#12) or a Jira key (UYT-1415) to take the title and description from.' },
        ticket: { type: 'string', description: 'A ticket id to record on the task.' },
        ticketUrl: { type: 'string', description: "The ticket's link." },
        provider: { type: 'string', enum: PROVIDERS, description: "Which agent runs it (default: the project's)." },
        model: { type: 'string', description: "A model for it, instead of the provider's default." },
        effort: { type: 'string', enum: EFFORTS, description: 'Reasoning effort, for agents that take one.' },
        type: { type: 'string', enum: TASK_TYPES, description: 'implement (default) changes code; investigate only reports.' },
        start: { type: 'boolean', description: 'Start it now instead of leaving it in To do. The worker runs unattended without permission prompts; honoured only for a person-hired or board agent, in its own project.' },
        desk: { type: 'string', description: 'A desk id for the worker, when start is true.' },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'get_task',
    title: 'Get a kanban task',
    description:
      'Reads ANOTHER kanban task of this office that the current task refers to ("#14", "task 14", "tehtävä 14", a ticket id like UYT-1415, or a task named by its title): ' +
      "its description, accepted plan, runs and review verdicts, latest comments, repositories and branches, pull requests and report files. Use it instead of guessing what another task contains. " +
      'Several matches come back as candidates: call again with the number of the right one. tail: true adds the end of its worker\'s terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The task number (14 or #14), its ticket id, or part of its title.' },
        tail: { type: 'boolean', description: "Also the last lines of its worker's terminal." },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_tasks',
    title: 'Search kanban tasks',
    description: "Finds this office's kanban tasks with the words in their title, ticket id or description: number, title, ticket, status and project of each. get_task reads one.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for.' } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

/** Runs get_task, search_tasks or create_task; resolves to its text. */
export async function runTaskTool(name, args, io) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'get_task') {
    const ref = String(a.ref ?? '').trim();
    if (!ref) throw new Error('Say which task: ref');
    return { text: formatAnswer(await call('get', { ref, tail: a.tail === true }, io), ref) };
  }
  if (name === 'search_tasks') {
    const query = String(a.query ?? '').trim();
    if (!query) throw new Error('Say what to look for: query');
    return { text: formatSearch(await call('search', { query }, io)) };
  }
  if (name === 'create_task') return { text: formatCreated(await call('create', { body: a }, io)) };
  throw new Error(`Unknown tool: ${name}`);
}

// --- The command ----------------------------------------------------------------------------------

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
/** Stdin to its end; empty when nothing has arrived within idleMs (a pipe nobody closes). Once data starts, it reads to EOF. */
function readStdin(stdin, idleMs) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      stdin.pause?.();
      resolve('');
    }, idleMs);
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => {
      clearTimeout(timer);
      data += c;
    });
    stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    stdin.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  const ctx = { env, fetch: io.fetch ?? fetch };
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(USAGE);
      return 0;
    }
    if (cmd.cmd === 'create') {
      const { cmd: _, json, prompt, noDescription, ...body } = cmd;
      // The description comes from --prompt or stdin; an issue can stand in for it.
      if (prompt !== undefined) body.description = prompt.trim();
      else if (!noDescription && (body.issue === undefined || !(io.stdin ?? process.stdin).isTTY)) {
        const stdin = io.stdin ?? process.stdin;
        if (stdin.isTTY) throw new UsageError(`Give the description on stdin (office-tasks create --title "…" <<'EOF' … EOF) or with --prompt "…"`);
        const text = (await readStdin(stdin, io.stdinIdleMs ?? STDIN_IDLE_MS)).trim();
        if (text) body.description = text;
      }
      if (body.issue === undefined && (!body.title || !body.description)) throw new UsageError('A task needs --title and a description (stdin or --prompt), unless --issue is given');
      const answer = await call('create', { body }, ctx);
      if (json) out(JSON.stringify(answer, null, 2));
      else {
        out(String(answer?.task?.id ?? ''));
        err(formatCreated(answer));
      }
      return 0;
    }
    if (cmd.cmd === 'get') {
      const answer = await call('get', { ref: cmd.ref, tail: cmd.tail }, ctx);
      out(cmd.json ? JSON.stringify(answer, null, 2) : formatAnswer(answer, cmd.ref));
      return answer?.match ? 0 : 1;
    }
    const answer = await call('search', { query: cmd.query }, ctx);
    out(cmd.json ? JSON.stringify(answer, null, 2) : formatSearch(answer));
    return 0;
  } catch (e) {
    err(`office-tasks: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));
