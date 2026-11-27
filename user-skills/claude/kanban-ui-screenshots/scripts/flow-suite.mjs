// Pure helpers for screenshot.mjs: argument parsing, settle planning, flow/job
// expansion, output file names, the concurrency pool and the summary lines.
// No browser and no side effects at import, so everything here is unit-testable.

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------

/** Flags that take no value. They only consume the next token when it is true/false-like. */
export const BOOLEAN_FLAGS = new Set(['mobile', 'viewport-only', 'list-devices', 'no-settle', 'settle'])
const BOOL_VALUE = /^(true|false|1|0|yes|no|on|off)$/i

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      let key = a.slice(2)
      let val
      const eq = key.indexOf('=')
      if (eq >= 0) {
        val = key.slice(eq + 1)
        key = key.slice(0, eq)
      } else {
        const next = argv[i + 1]
        const wantsValue = next !== undefined && !/^--/.test(next)
        if (wantsValue && (!BOOLEAN_FLAGS.has(key) || BOOL_VALUE.test(next))) {
          val = next
          i++
        } else {
          val = true
        }
      }
      // A repeated flag (several --click, several --flow) is collected into an array.
      if (key in args) {
        if (Array.isArray(args[key])) args[key].push(val)
        else args[key] = [args[key], val]
      } else {
        args[key] = val
      }
    } else {
      args._.push(a)
    }
  }
  return args
}

/** A flag without a value (--mobile) or an explicit --mobile=false. */
export function boolFlag(v, def = false) {
  if (v === undefined) return def
  if (v === true) return true
  if (typeof v === 'string') return !/^(false|0|no|off)$/i.test(v)
  return def
}

export function posNum(v, def) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}

/** Like posNum but 0 is allowed (an explicit "no delay"). */
export function nonNegNum(v, def) {
  if (v === undefined || v === null || v === true || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : def
}

/** Whitespace in a flow name becomes "-" so that FLOW/JOBS/[name] labels stay token-parsable. */
export function labelName(name) {
  return String(name).trim().replace(/\s+/g, '-') || 'flow'
}

export function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shot'
}

// ---------------------------------------------------------------------------------
// Settle planning
// ---------------------------------------------------------------------------------

export const DEFAULT_DELAY_MS = 800
export const DEFAULT_IDLE_CAP_MS = 2000
export const LOAD_CAP_MS = 2000

/**
 * Decides how long to wait after a navigation.
 *   setting: false = never settle (no idle, no load wait), true = force the idle wait,
 *            undefined = automatic.
 * Automatic: the networkidle wait is skipped when the step proves readiness itself
 * (waitSelector) or only asserts (assertions without click/actions/eval, which retry).
 * A skipped idle wait still waits for the load state. The default delay is not run
 * when a waitSelector is given, but an explicit delay (CLI or step) always is.
 * Returns { idleMs, loadMs, delayMs }; 0 means "do not wait".
 */
export function settlePlan({
  timeout = 30000,
  hasWaitSelector = false,
  hasAssertions = false,
  hasInteraction = false,
  setting,
  settleTimeout,
  delay = DEFAULT_DELAY_MS,
  delayExplicit = false,
} = {}) {
  const delayMs = hasWaitSelector && !delayExplicit ? 0 : Math.max(0, delay)
  if (setting === false) return { idleMs: 0, loadMs: 0, delayMs }
  const cap = Math.min(timeout, posNum(settleTimeout, DEFAULT_IDLE_CAP_MS))
  const skipIdle = setting !== true && (hasWaitSelector || (hasAssertions && !hasInteraction))
  if (skipIdle) return { idleMs: 0, loadMs: Math.min(timeout, LOAD_CAP_MS), delayMs }
  return { idleMs: cap, loadMs: 0, delayMs }
}

// ---------------------------------------------------------------------------------
// Flows and jobs
// ---------------------------------------------------------------------------------

/**
 * Expands --flow values into flow file paths: repeated --flow, a folder (its *.json,
 * sorted, not recursive) and .json positionals when --flow is present (shell globs).
 * A JSON file in a folder that has no "steps" array is skipped with a note.
 * Returns { files, notes }.
 */
export async function expandFlowArgs(args) {
  const values = (Array.isArray(args.flow) ? args.flow : [args.flow]).filter((v) => typeof v === 'string')
  const files = []
  const notes = []
  if (!values.length) return { files, notes }
  const positional = new Set((args._ ?? []).filter((p) => /\.json$/i.test(p)))
  const candidates = [...values, ...positional]
  const seen = new Set()
  const add = (p) => {
    const key = resolve(p)
    if (seen.has(key)) return
    seen.add(key)
    files.push(p)
  }
  for (const value of candidates) {
    let info = null
    try {
      info = await stat(value)
    } catch {
      // Missing path: keep it, the job reports the read error on its own.
    }
    if (!info?.isDirectory()) {
      // A positional JSON file (shell glob) that parses but is not a flow is skipped;
      // a file named directly by --flow always becomes a job.
      if (positional.has(value) && !values.includes(value)) {
        let parsed
        try {
          parsed = JSON.parse(await readFile(value, 'utf-8'))
        } catch {
          parsed = undefined // broken file: kept, its job fails
        }
        if (parsed !== undefined && !Array.isArray(parsed?.steps)) {
          notes.push(`Skipped ${value}: no "steps" array, not a flow`)
          continue
        }
      }
      add(value)
      continue
    }
    const names = (await readdir(value)).filter((n) => /\.json$/i.test(n)).sort()
    for (const name of names) {
      const path = join(value, name)
      let parsed
      try {
        parsed = JSON.parse(await readFile(path, 'utf-8'))
      } catch {
        // Unreadable or invalid JSON: it becomes a job that fails on its own (safe message).
        add(path)
        continue
      }
      if (!Array.isArray(parsed?.steps)) {
        notes.push(`Skipped ${path}: no "steps" array, not a flow`)
        continue
      }
      add(path)
    }
  }
  return { files, notes }
}

/**
 * One job per flow, or two (before, after) when both --before-url and --after-url are given.
 * entries: [{ path, flow?, loadError? }].
 * opts: { baseUrl, beforeUrl, afterUrl, side }.
 */
export function buildJobs(entries, { baseUrl, beforeUrl, afterUrl, side } = {}) {
  if (side !== undefined && side !== 'before' && side !== 'after') throw new Error('--side must be before or after')
  if (side && (beforeUrl || afterUrl)) throw new Error('--side cannot be combined with --before-url/--after-url')
  if (baseUrl && (beforeUrl || afterUrl)) throw new Error('--base-url cannot be combined with --before-url/--after-url (they already set the address of each side)')
  const variants = []
  if (beforeUrl || afterUrl) {
    if (beforeUrl) variants.push({ side: 'before', baseUrl: beforeUrl, overridden: true })
    if (afterUrl) variants.push({ side: 'after', baseUrl: afterUrl, overridden: true })
  } else {
    variants.push({ side: side ?? null, baseUrl: baseUrl ?? null, overridden: !!baseUrl })
  }
  const jobs = []
  for (const entry of entries) {
    const flow = entry.flow
    const name = labelName(typeof flow?.name === 'string' && flow.name.trim() ? flow.name : basename(entry.path, '.json'))
    for (const v of variants) {
      jobs.push({
        seq: jobs.length + 1,
        name,
        label: v.side ? `${name}@${v.side}` : name,
        path: entry.path,
        flow,
        loadError: entry.loadError ?? null,
        side: v.side,
        baseUrl: v.baseUrl ?? (typeof flow?.baseUrl === 'string' ? flow.baseUrl : null),
        overridden: v.overridden,
      })
    }
  }
  for (const job of jobs) job.multi = jobs.length > 1
  return jobs
}

// ---------------------------------------------------------------------------------
// State files
// ---------------------------------------------------------------------------------

/** s.json -> s.before.json / s.after.json */
export function sidedStatePath(path, side) {
  return /\.json$/i.test(path) ? path.replace(/\.json$/i, `.${side}.json`) : `${path}.${side}`
}

/**
 * Resolves each job's state file: the flow's own "state", else the CLI --state. A run with
 * both sides uses side-specific files. A path used by more than one job is read-only.
 * Sets job.statePath and job.stateWritable; returns notes for the shared paths.
 */
export function assignStatePaths(jobs, cliState, exists = existsSync) {
  const bothSides = jobs.some((j) => j.side === 'before') && jobs.some((j) => j.side === 'after')
  const notes = []
  const uses = new Map()
  const missing = new Map()
  for (const job of jobs) {
    const raw = typeof job.flow?.state === 'string' && job.flow.state ? job.flow.state : cliState
    let path = raw ? resolve(raw) : null
    const unsided = path
    if (path && bothSides && job.side) path = sidedStatePath(path, job.side)
    job.statePath = path
    if (path) uses.set(path, (uses.get(path) ?? 0) + 1)
    if (path && (jobs.length > 1 || job.side) && !exists(path)) missing.set(path, path !== unsided && exists(unsided) ? unsided : null)
  }
  for (const job of jobs) job.stateWritable = !!job.statePath && uses.get(job.statePath) === 1
  for (const [path, count] of uses) {
    if (count > 1) notes.push(`State file ${path} is used by ${count} jobs; it is read-only in this run (not saved).`)
  }
  // No fallback to the unsided file: a session belongs to one address.
  for (const [path, unsided] of missing) {
    notes.push(`State file ${path} does not exist; the session starts empty.` +
      (unsided ? ` The unsided ${unsided} is not used because a session belongs to one address; run the login flow with both --before-url and --after-url.` : ''))
  }
  return notes
}

/**
 * Loaded state as it may be used for a job's address. When the state has nothing for that
 * origin, its sessionStorage (which is stored without an origin) is dropped, since the values
 * belong to another address. Returns { state, missingOrigin }.
 */
export function usableState(state, url) {
  const missingOrigin = stateMissingOrigin(state, url)
  return { state: missingOrigin ? { ...state, sessionStorage: {} } : state, missingOrigin }
}

/** True for a state whose sessionStorage has values but no recorded origin (legacy file). */
export function hasLegacySessionStorage(state) {
  return !!state && !state.sessionStorageOrigin && Object.keys(state.sessionStorage ?? {}).length > 0
}

export const LEGACY_SESSION_NOTE =
  'Note: the state file\'s sessionStorage has no recorded origin and is not restored; run the login flow again to save a new state file, or add "sessionStorageOrigin": "<origin>" to the file if you know where it was saved.'

/** Origin of a URL for reports; '[redacted]' if it cannot be parsed. */
export function safeOrigin(url) {
  if (url == null) return null
  try {
    return new URL(url).origin
  } catch {
    return '[redacted]'
  }
}

/**
 * Last-resort net for text the code does not compose itself (Playwright errors): every URL-like
 * token (up to whitespace or a quote, so ")" and "]" inside the URL are part of it) becomes its
 * origin; one that cannot be parsed becomes [redacted-url].
 */
export function scrubUrls(text) {
  return String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, (m) => {
    try {
      const origin = new URL(m).origin
      return origin === 'null' ? '[redacted-url]' : origin
    } catch {
      return '[redacted-url]'
    }
  })
}

/** Address for a log line: the origin by default, the full URL only for an includeValues flow. */
export function displayUrl(url, full = false) {
  if (full) return url
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? '[redacted-url]' : origin
  } catch {
    return '[redacted-url]'
  }
}

/** Writes a file atomically with mode 0600: random temp name beside it ('wx'), then rename. */
export async function writeFileAtomic(path, text) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * True when a loaded state has neither a cookie nor an origin entry for the job's origin
 * (typically a login made against another address). Null state (no file yet) is not flagged.
 */
export function stateMissingOrigin(state, url) {
  if (!state) return false
  let origin
  try {
    origin = new URL(url)
  } catch {
    return false
  }
  const host = origin.hostname
  for (const c of state.cookies ?? []) {
    if (c?.url) {
      try {
        if (new URL(c.url).origin === origin.origin) return false
      } catch {
        // ignore
      }
    }
    const domain = String(c?.domain ?? '').replace(/^\./, '').toLowerCase()
    if (domain && (host === domain || host.endsWith('.' + domain))) return false
  }
  for (const o of state.origins ?? []) {
    if (o?.origin === origin.origin) return false
  }
  // A login that lives only in sessionStorage has no origins entry: use the saved origin.
  // Legacy sessionStorage without a recorded origin never counts (its origin is unknown).
  return state.sessionStorageOrigin !== origin.origin
}

// ---------------------------------------------------------------------------------
// Output names
// ---------------------------------------------------------------------------------

/** Lower-case, only [a-z0-9._-], starts with [a-z0-9], at most 80 characters. */
export function subjectSlug(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 80)
  return s || 'shot'
}

/**
 * File name of a requested shot. job.namedBySide (a side AND --out-dir):
 * <subject>-<side>.png (no timestamp, overwrites). Otherwise <flow>-<shot>[-<side>]-<timestamp>.png
 * (plus the job number in a multi-job run), so two tasks never overwrite each other in tmp.
 * shotName is the step's "shot" string, or null for an unnamed shot (shot: true).
 */
export function shotFileName(job, shotName, index, now) {
  const flowName = job.name ?? 'flow'
  if (job.side && job.namedBySide) {
    const subject = typeof shotName === 'string' && shotName ? shotName : `${flowName}-shot-${index}`
    return `${subjectSlug(subject)}-${job.side}.png`
  }
  const shot = typeof shotName === 'string' && shotName ? slug(shotName) : `shot-${index}`
  const side = job.side ? `-${job.side}` : ''
  return `${slug(flowName)}-${shot}${side}-${now}${job.multi ? `-${job.seq}` : ''}.png`
}

/** Sided shot files that two shots of the run would write to. Returns [{ file, owners }]. */
export function findNameCollisions(jobs) {
  const byFile = new Map()
  for (const job of jobs) {
    if (!job.namedBySide || !Array.isArray(job.flow?.steps)) continue
    let index = 0
    for (const step of job.flow.steps) {
      if (!step || typeof step !== 'object' || !step.shot) continue
      index++
      const file = shotFileName(job, typeof step.shot === 'string' ? step.shot : null, index, 0)
      byFile.set(file, [...(byFile.get(file) ?? []), job.label])
    }
  }
  return [...byFile].filter(([, owners]) => owners.length > 1).map(([file, owners]) => ({ file, owners }))
}

// ---------------------------------------------------------------------------------
// Pool and summaries
// ---------------------------------------------------------------------------------

/**
 * Runs worker(item, index) for every item with at most `limit` running at once.
 * One rejection does not stop the others. Returns settled results in item order:
 * { status: 'fulfilled', value } | { status: 'rejected', reason }.
 */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  return results
}

/**
 * FLOW <name>[@side] <status> shots=<n> [state=missing-origin] report=<path>
 *   [failed-step=<i> <action|assertion|step> <j> <type>: <reason>, matches=<k>]
 * Unknown parts are omitted. Never includes selectors, values or page text.
 */
export function summaryLine(result) {
  const name = result.side ? `${result.name}@${result.side}` : result.name
  const shots = Array.isArray(result.shots) ? result.shots.length : Number(result.shots) || 0
  let line = `FLOW ${name} ${result.status} shots=${shots}`
  if (result.stateMissingOrigin) line += ' state=missing-origin'
  if (result.reportPath) line += ` report=${result.reportPath}`
  if (result.status === 'failed') {
    if (result.failedStep != null) {
      const f = result.failure ?? {}
      let part = ` failed-step=${result.failedStep}`
      if (f.kind) part += ` ${f.kind}`
      else if (f.type) part += ' step'
      if (f.index != null) part += ` ${f.index}`
      if (f.type) part += ` ${f.type}${f.target === 'to' ? ' (to)' : ''}`
      if (f.reason) part += `: ${f.reason}`
      if (f.matches != null) part += `${f.reason ? ',' : ':'} matches=${f.matches}`
      line += part
    } else if (result.error) {
      line += ` error=${String(result.error).replace(/\s+/g, ' ').slice(0, 200)}`
    }
  }
  return line
}

/** SUITE <passed>/<total> passed, <f> failed, <c> capture-only, <ms> ms */
export function suiteLine(results, ms) {
  const count = (s) => results.filter((r) => r.status === s).length
  return `SUITE ${count('passed')}/${results.length} passed, ${count('failed')} failed, ${count('capture-only')} capture-only, ${Math.round(ms)} ms`
}
