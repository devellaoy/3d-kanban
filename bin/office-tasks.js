#!/usr/bin/env node
// office-tasks: other kanban tasks, from inside 3d-kanban: `office-tasks get 14` prints task #14's
// description, accepted plan, runs and review verdicts, latest comments, repositories and branches,
// pull requests and report files; `office-tasks search <words>` finds tasks. The office puts it on
// every worker's PATH and gives each its own address and token in AGENT_OFFICE_HOOK_URL,
// AGENT_OFFICE_WORKER_ID and AGENT_OFFICE_HOOK_TOKEN; this talks to the hook server's /office/tasks
// endpoints with them (src/server/kanban/integrations/refs). The agent-office MCP server
// (bin/office-workers.js) offers the same as get_task and search_tasks. Plain Node, no build step,
// no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-tasks get <ref> [--tail] [--json]    another kanban task: <ref> is its number (14, #14),
                                              its ticket id (UYT-1415) or part of its title.
                                              --tail adds the end of its worker's terminal
  office-tasks search <words> [--json]        tasks with these words in their title, ticket or
                                              description`;

export class UsageError extends Error {}

const ENV = ['AGENT_OFFICE_HOOK_URL', 'AGENT_OFFICE_WORKER_ID', 'AGENT_OFFICE_HOOK_TOKEN'];
const RETRY_MS = 6000;
const TIMEOUT_MS = 15_000;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || rest.some(help)) return { cmd: 'help' };
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
 * @param {'get' | 'search'} what
 * @param {{ ref?: string, tail?: boolean, query?: string }} args
 * @param {Record<string, string | undefined>} env
 */
export function buildRequest(what, args, env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    if (what === 'get' && env.AIKANBAN_API_BASE) {
      const url = new URL(`${env.AIKANBAN_API_BASE.replace(/\/+$/, '')}/api/tasks/reference`);
      url.searchParams.set('ref', String(args.ref ?? ''));
      return { url: url.href, headers: {}, legacy: true };
    }
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-tasks only works inside the office, from a worker's terminal.`);
  }
  const url = new URL(`${env.AGENT_OFFICE_HOOK_URL.replace(/\/+$/, '')}/office/tasks/${what === 'get' ? 'reference' : 'search'}`);
  url.searchParams.set('worker', env.AGENT_OFFICE_WORKER_ID);
  if (what === 'get') {
    url.searchParams.set('ref', String(args.ref ?? ''));
    if (args.tail) url.searchParams.set('tail', '1');
  } else url.searchParams.set('q', String(args.query ?? ''));
  return { url: url.href, headers: { authorization: `Bearer ${env.AGENT_OFFICE_HOOK_TOKEN}` }, legacy: false };
}

async function send(req, fetchImpl) {
  const until = Date.now() + RETRY_MS;
  for (;;) {
    try {
      const res = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
 * @param {'get' | 'search'} what
 * @param {{ ref?: string, tail?: boolean, query?: string }} args
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch }} io
 */
export async function call(what, args, io) {
  return send(buildRequest(what, args, io.env), io.fetch);
}

const when = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : String(ms ?? ''));

/** A candidate, in a line. */
function candidateLine(t) {
  return `#${t.id}  ${t.title}${t.ticket ?? t.ticketId ? ` [${t.ticket ?? t.ticketId}]` : ''} · ${t.status}${t.project ? ` · ${t.project}` : t.repository ? ` · ${t.repository}` : ''}`;
}

/** A task bundle (the office's /office/tasks/reference match), as text for an agent to read. */
export function formatTask(b) {
  const out = [`# Task #${b.id}: ${b.title}`, ''];
  out.push(`Project: ${b.project?.name ?? b.repository ?? '?'} · status ${b.status}${b.phase ? ` · phase ${b.phase}` : ''}`);
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

// --- MCP tools (served by bin/office-workers.js mcp) ----------------------------------------------

export const TASK_TOOLS = [
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

/** Runs get_task or search_tasks; resolves to its text. */
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
  throw new Error(`Unknown tool: ${name}`);
}

// --- The command ----------------------------------------------------------------------------------

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
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
