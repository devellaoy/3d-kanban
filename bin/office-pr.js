#!/usr/bin/env node
// office-pr: pull requests for a repository on Azure DevOps or Bitbucket, where there's no gh. Run
// inside a checkout of the worker's workspace: `office-pr create --title "…" --body-file f` pushes
// nothing (push the branch first) and opens the current branch's pull request, or updates the one
// it has; `view`, `checks`, `diff`, `comment` and `list` read and answer them. The office puts it on
// every worker's PATH with AGENT_OFFICE_HOOK_URL, AGENT_OFFICE_WORKER_ID and AGENT_OFFICE_HOOK_TOKEN,
// and does the asking on the host with the credentials of the account the worker runs as, so no
// token reaches the worker (src/server/kanban/integrations/hosting/officepr.ts). A repository on
// GitHub keeps using gh. Plain Node, no build step, no dependencies.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage (inside your checkout; for a repository on GitHub, use gh):
  office-pr create --title "…" (--body-file <file|-> | --body "…") [--base <branch>]
                   [--head <branch>] [--draft] [--json]
                                    opens the pull request of the current branch (push it first),
                                    or updates the title and description of the one it has; prints
                                    PR: <url>
  office-pr view [<number>] [--comments] [--json]
                                    a pull request (by default the current branch's): its state,
                                    branches, description, checks and with --comments its comments
  office-pr checks [<number>] [--json]   its checks / pipelines
  office-pr diff [<number>]         its changes, as git diff of its base and head (fetched from origin)
  office-pr comment <number> (--body-file <file|-> | --body "…")
                                    comments on its conversation
  office-pr list [--all] [--head <branch>] [--json]
                                    the open pull requests (--all: merged and closed too)`;

export class UsageError extends Error {}

const ENV = ['AGENT_OFFICE_HOOK_URL', 'AGENT_OFFICE_WORKER_ID', 'AGENT_OFFICE_HOOK_TOKEN'];
const TIMEOUT_MS = 90_000;
const BRANCH = /^[\w./-]{1,200}$/;

/**
 * @param {string[]} args
 * @param {string[]} valued flags that take a value
 * @param {string[]} bare flags that don't
 */
function options(args, valued, bare) {
  /** @type {Record<string, string | true>} */
  const opts = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg !== '-') throw new UsageError(`Unknown option: ${arg}`);
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (bare.includes(flag)) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      opts[flag] = true;
    } else if (valued.includes(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      opts[flag] = value;
    } else throw new UsageError(`Unknown option: ${flag}`);
  }
  return { opts, words };
}

/** @param {string | undefined} w */
function prNumber(w) {
  if (w === undefined) return undefined;
  const n = Number(String(w).replace(/^#/, ''));
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`${w} isn't a pull request number`);
  return n;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || rest.some(help)) return { cmd: 'help' };
  if (cmd === 'create') {
    const { opts, words } = options(rest, ['--title', '--body', '--body-file', '--base', '--head'], ['--draft', '--json']);
    if (words.length) throw new UsageError(`create takes no words: ${words.join(' ')}`);
    if (typeof opts['--title'] !== 'string' || !opts['--title'].trim()) throw new UsageError('create needs --title');
    if (opts['--body'] !== undefined && opts['--body-file'] !== undefined) throw new UsageError('Give --body or --body-file, not both');
    for (const f of ['--base', '--head']) if (opts[f] !== undefined && !BRANCH.test(String(opts[f]))) throw new UsageError(`${f} isn't a branch name`);
    return { cmd, title: opts['--title'], body: opts['--body'], bodyFile: opts['--body-file'], base: opts['--base'], head: opts['--head'], draft: opts['--draft'] === true, json: opts['--json'] === true };
  }
  if (cmd === 'view' || cmd === 'checks' || cmd === 'diff') {
    const { opts, words } = options(rest, [], cmd === 'view' ? ['--comments', '--json'] : cmd === 'checks' ? ['--json'] : []);
    if (words.length > 1) throw new UsageError(`${cmd} takes at most one pull request number`);
    return { cmd, number: prNumber(words[0]), comments: opts['--comments'] === true, json: opts['--json'] === true };
  }
  if (cmd === 'comment') {
    const { opts, words } = options(rest, ['--body', '--body-file'], []);
    if (words.length !== 1) throw new UsageError('comment takes the pull request number');
    if ((opts['--body'] === undefined) === (opts['--body-file'] === undefined)) throw new UsageError('comment needs --body or --body-file');
    return { cmd, number: prNumber(words[0]), body: opts['--body'], bodyFile: opts['--body-file'] };
  }
  if (cmd === 'list') {
    const { opts, words } = options(rest, ['--head'], ['--all', '--json']);
    if (words.length) throw new UsageError(`list takes no words: ${words.join(' ')}`);
    return { cmd, all: opts['--all'] === true, head: opts['--head'], json: opts['--json'] === true };
  }
  throw new UsageError(`Unknown command: ${cmd}`);
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

/** The text of --body, or of --body-file (- for stdin). */
function bodyOf(cmd, readFile) {
  if (cmd.body !== undefined) return String(cmd.body);
  if (cmd.bodyFile === undefined) return '';
  return readFile(cmd.bodyFile === '-' ? 0 : String(cmd.bodyFile));
}

/** Asks the office. @returns {Promise<any>} */
async function ask(action, body, env, fetchImpl) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) throw new Error(`This only works inside a worker of the office (${missing.join(', ')} not set)`);
  const url = new URL(`${env.AGENT_OFFICE_HOOK_URL.replace(/\/+$/, '')}/office/pr/${action}`);
  url.searchParams.set('worker', env.AGENT_OFFICE_WORKER_ID);
  const res = await fetchImpl(url.href, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AGENT_OFFICE_HOOK_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let answer;
  try {
    answer = await res.json();
  } catch {
    answer = {};
  }
  if (!res.ok || answer?.error) throw new Error(answer?.error || `The office answered ${res.status}`);
  return answer;
}

/** @param {any} pr @param {any[]} checks @param {any[] | undefined} comments */
export function formatView(pr, checks, comments) {
  const lines = [`#${pr.number} ${pr.title}`, `${pr.state}${pr.isDraft ? ' (draft)' : ''} · ${pr.headRefName} → ${pr.baseRefName} · by ${pr.author}${pr.reviewDecision ? ` · ${pr.reviewDecision}` : ''}`, pr.url, ''];
  if (pr.body?.trim()) lines.push(pr.body.trim(), '');
  lines.push(...formatChecks(checks));
  if (comments) {
    lines.push('', `Comments (${comments.length}):`);
    for (const c of comments) lines.push('', `— ${c.author}, ${c.createdAt}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}:`, c.body);
  }
  return lines.join('\n');
}

/** @param {any[]} checks */
export function formatChecks(checks) {
  if (!checks?.length) return ['No checks.'];
  return ['Checks:', ...checks.map((c) => `  ${c.state.padEnd(7)} ${c.name}${c.url ? `  ${c.url}` : ''}`)];
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, cwd?: string, out?: (s: string) => void, err?: (s: string) => void, readFile?: (f: string | number) => string, git?: typeof git }} [io]
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = io.env ?? process.env;
  const fetchImpl = io.fetch ?? fetch;
  const runGit = io.git ?? git;
  const readFile = io.readFile ?? ((f) => readFileSync(f, 'utf8'));
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(USAGE);
      return 0;
    }
    const cwd = io.cwd ?? process.cwd();
    let dir;
    try {
      dir = runGit(['rev-parse', '--show-toplevel'], cwd);
    } catch {
      throw new UsageError('Run it inside a git checkout');
    }
    const current = () => {
      const b = runGit(['branch', '--show-current'], dir);
      if (!b) throw new UsageError('Not on a branch: name it with --head');
      return b;
    };
    if (cmd.cmd === 'create') {
      const answer = await ask('create', { dir, title: cmd.title, body: bodyOf(cmd, readFile), head: cmd.head ?? current(), ...(cmd.base ? { base: cmd.base } : {}), draft: cmd.draft }, env, fetchImpl);
      if (cmd.json) out(JSON.stringify(answer, null, 2));
      else {
        out(`PR: ${answer.url}`);
        err(answer.updated ? `Updated the title and description of #${answer.number}.` : `Opened #${answer.number}${answer.workItems?.length ? `, linked to work item${answer.workItems.length > 1 ? 's' : ''} ${answer.workItems.map((w) => `#${w}`).join(', ')}` : ''}.`);
      }
      return 0;
    }
    if (cmd.cmd === 'comment') {
      const answer = await ask('comment', { dir, number: cmd.number, body: bodyOf(cmd, readFile) }, env, fetchImpl);
      out(answer.url ?? `Commented on #${cmd.number}`);
      return 0;
    }
    if (cmd.cmd === 'list') {
      const answer = await ask('list', { dir, state: cmd.all ? 'all' : 'open', ...(cmd.head ? { head: cmd.head } : {}) }, env, fetchImpl);
      if (cmd.json) out(JSON.stringify(answer.prs, null, 2));
      else out(answer.prs.length ? answer.prs.map((p) => `#${p.number}\t${p.state}${p.isDraft ? ' (draft)' : ''}\t${p.headRefName} → ${p.baseRefName}\t${p.title}\t${p.url}`).join('\n') : 'No pull requests.');
      return 0;
    }
    // view, checks, diff: the pull request by number, else the current branch's.
    const answer = await ask('view', { dir, ...(cmd.number ? { number: cmd.number } : { head: current() }), comments: cmd.comments === true }, env, fetchImpl);
    if (cmd.cmd === 'diff') {
      const { baseRefName: base, headRefName: head } = answer.pr;
      if (!BRANCH.test(base) || !BRANCH.test(head)) throw new Error('Its branch names have characters this won’t pass to git');
      runGit(['fetch', '--quiet', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`, `refs/heads/${head}:refs/remotes/origin/${head}`], dir);
      out(runGit(['diff', '--no-color', `origin/${base}...origin/${head}`], dir));
      return 0;
    }
    if (cmd.json) out(JSON.stringify(cmd.cmd === 'checks' ? answer.checks : answer, null, 2));
    else out(cmd.cmd === 'checks' ? formatChecks(answer.checks).join('\n') : formatView(answer.pr, answer.checks, answer.comments));
    return 0;
  } catch (e) {
    err(`office-pr: ${e.message}`);
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
