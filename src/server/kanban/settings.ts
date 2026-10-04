// The kanban's settings (<officeData>/.agent-office/kanban-settings.json, versioned by schemaVersion)
// and its secrets (kanban-secrets.json, chmod 600). Every field is sanitised on the way in, from the
// file and from the browser alike, so what the engine reads is always complete and in range. The
// secrets never leave the server: the browser only ever gets secretStatus().

import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ImplementPermission,
  IssueSourceConfig,
  KanbanEffort,
  KanbanSettings,
  KanbanTool,
  PlanApproval,
  ProjectSettings,
  ReviewSettings,
  SecretStatus,
  SkillSelection,
  TaskOverrides,
} from '../../shared/kanban/types.js';
import { KANBAN_EFFORTS, KANBAN_TOOLS, SKILL_PHASES } from '../../shared/kanban/types.js';
import { GH_REPO_RE, MODEL_RE, PROJECT_ID_RE, type KanbanSettingsPatch } from '../../shared/kanban/protocol.js';
import { isKanbanPromptId } from '../../shared/kanban/prompts.js';
import { PROMPT_MAX } from '../../shared/prompts.js';
import { cleanProjectLanguage } from '../../shared/language.js';

export const SETTINGS_SCHEMA_VERSION = 1;
export const INSTRUCTIONS_MAX = 20_000;
export const MAX_ISSUE_SOURCES = 10;

export const DEFAULT_REVIEW: ReviewSettings = { tool: 'claude', rounds: 2, reReviewLastFix: false, sandbox: true };

export function defaultProjectSettings(): ProjectSettings {
  return { branchInstructions: '', generalInstructions: '', testingInstructions: '', maxConcurrent: 2, issueSources: [], prompts: {}, skills: {} };
}

export function defaultKanbanSettings(): KanbanSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    defaults: { tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, implementPermission: 'bypass' },
    review: { ...DEFAULT_REVIEW },
    autoResume: { enabled: true, maxAttempts: 5, maxWaitHours: 6 },
    archiveAfterDays: 30,
    projects: {},
  };
}

// --- Sanitising -----------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const int = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : fallback);
const optOneOf = <T extends string>(v: unknown, all: readonly T[]): T | undefined => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : undefined);
const text = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : fallback);
const model = (v: unknown) => (typeof v === 'string' && MODEL_RE.test(v) ? v : undefined);
const strings = (v: unknown, maxItems: number, maxLen: number, re?: RegExp) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= maxLen && (!re || re.test(x))))].slice(0, maxItems) : [];
const PLAN_APPROVALS: readonly PlanApproval[] = ['auto', 'manual'];
const PERMISSIONS: readonly ImplementPermission[] = ['bypass', 'workspace-write'];

/** A complete review setting, from whatever came in, over `base`. */
export function sanitizeReview(raw: unknown, base: ReviewSettings = DEFAULT_REVIEW): ReviewSettings {
  const r = obj(raw);
  const out: ReviewSettings = {
    tool: oneOf<KanbanTool>(r.tool, KANBAN_TOOLS, base.tool),
    rounds: int(r.rounds, 1, 10, base.rounds),
    reReviewLastFix: bool(r.reReviewLastFix, base.reReviewLastFix),
    sandbox: bool(r.sandbox, base.sandbox),
  };
  const m = 'model' in r ? model(r.model) : base.model;
  if (m) out.model = m;
  const e = 'effort' in r ? optOneOf<KanbanEffort>(r.effort, KANBAN_EFFORTS) : base.effort;
  if (e) out.effort = e;
  return out;
}

/** Only the review fields that were given and are valid (a project's or a task's override). */
export function sanitizePartialReview(raw: unknown): Partial<ReviewSettings> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Partial<ReviewSettings> = {};
  const tool = optOneOf<KanbanTool>(raw.tool, KANBAN_TOOLS);
  if (tool) out.tool = tool;
  const m = model(raw.model);
  if (m) out.model = m;
  const e = optOneOf<KanbanEffort>(raw.effort, KANBAN_EFFORTS);
  if (e) out.effort = e;
  if (typeof raw.rounds === 'number' && Number.isFinite(raw.rounds)) out.rounds = int(raw.rounds, 1, 10, 1);
  if (typeof raw.reReviewLastFix === 'boolean') out.reReviewLastFix = raw.reReviewLastFix;
  if (typeof raw.sandbox === 'boolean') out.sandbox = raw.sandbox;
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeSkillSelection(raw: unknown): SkillSelection {
  const r = obj(raw);
  const out: SkillSelection = {};
  const name = /^[A-Za-z0-9][\w.:-]{0,99}$/;
  for (const phase of SKILL_PHASES) {
    const p = obj(r[phase]);
    const claude = strings(p.claude, 30, 100, name);
    const codex = strings(p.codex, 30, 100, name);
    if (claude.length || codex.length) out[phase] = { ...(claude.length ? { claude } : {}), ...(codex.length ? { codex } : {}) };
  }
  return out;
}

const SOURCE_ID = /^[A-Za-z0-9_-]{1,40}$/;
let sourceSeq = 0;
const newSourceId = () => `src-${Date.now().toString(36)}-${(sourceSeq++).toString(36)}`;

/** One issue source, or undefined when it can't be one. */
export function sanitizeIssueSource(raw: unknown): IssueSourceConfig | undefined {
  if (!isObj(raw)) return undefined;
  const id = typeof raw.id === 'string' && SOURCE_ID.test(raw.id) ? raw.id : newSourceId();
  const f = obj(raw.filters);
  const opt = (v: unknown, max = 200) => {
    const s = text(v, max).trim();
    return s || undefined;
  };
  const compact = <T extends object>(o: T): T => {
    for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || (Array.isArray(o[k]) && !(o[k] as unknown[]).length)) delete o[k];
    return o;
  };
  switch (raw.kind) {
    case 'github-repo':
      return {
        id,
        kind: 'github-repo',
        repos: strings(raw.repos, 20, 201, GH_REPO_RE),
        filters: compact({ assignee: opt(f.assignee, 100), labels: strings(f.labels, 20, 100), state: optOneOf(f.state, ['open', 'closed', 'all'] as const) }),
      };
    case 'github-project': {
      const owner = opt(raw.owner, 100);
      const number = typeof raw.number === 'number' && Number.isSafeInteger(raw.number) && raw.number > 0 ? raw.number : undefined;
      if (!owner || !/^[A-Za-z0-9_.-]+$/.test(owner) || number === undefined) return undefined;
      return { id, kind: 'github-project', owner, number, filters: compact({ assignee: opt(f.assignee, 100), status: opt(f.status, 100), iteration: opt(f.iteration, 100) }) };
    }
    case 'jira': {
      const site = opt(raw.site, 200)?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!site || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(site)) return undefined;
      return {
        id,
        kind: 'jira',
        site,
        projectKeys: strings(raw.projectKeys, 20, 50, /^[A-Z][A-Z0-9_]*$/),
        filters: compact({ assignee: opt(f.assignee, 100), epic: opt(f.epic, 100), labels: strings(f.labels, 20, 100), statusCategoryNot: strings(f.statusCategoryNot, 10, 50), jql: opt(f.jql, 2000) }),
      };
    }
    default:
      return undefined;
  }
}

/** A complete project setting, from whatever came in, over `base`. */
export function sanitizeProjectSettings(raw: unknown, base: ProjectSettings = defaultProjectSettings()): ProjectSettings {
  const r = obj(raw);
  const out: ProjectSettings = {
    branchInstructions: 'branchInstructions' in r ? text(r.branchInstructions, INSTRUCTIONS_MAX) : base.branchInstructions,
    generalInstructions: 'generalInstructions' in r ? text(r.generalInstructions, INSTRUCTIONS_MAX) : base.generalInstructions,
    testingInstructions: 'testingInstructions' in r ? text(r.testingInstructions, INSTRUCTIONS_MAX) : base.testingInstructions,
    maxConcurrent: int(r.maxConcurrent, 1, 20, base.maxConcurrent),
    issueSources: 'issueSources' in r ? (Array.isArray(r.issueSources) ? r.issueSources : []).map(sanitizeIssueSource).filter((s): s is IssueSourceConfig => !!s).slice(0, MAX_ISSUE_SOURCES) : base.issueSources,
    prompts: 'prompts' in r ? sanitizePrompts(r.prompts) : base.prompts,
    skills: 'skills' in r ? sanitizeSkillSelection(r.skills) : base.skills,
  };
  const approval = 'planApproval' in r ? optOneOf(r.planApproval, PLAN_APPROVALS) : base.planApproval;
  if (approval) out.planApproval = approval;
  const permission = 'implementPermission' in r ? optOneOf(r.implementPermission, PERMISSIONS) : base.implementPermission;
  if (permission) out.implementPermission = permission;
  // An invalid value keeps the earlier choice; clearing is setProject's null.
  const lang = 'publicLanguage' in r ? cleanProjectLanguage(r.publicLanguage) ?? base.publicLanguage : base.publicLanguage;
  if (lang) out.publicLanguage = lang;
  const comment = 'commentLanguage' in r ? cleanProjectLanguage(r.commentLanguage) ?? base.commentLanguage : base.commentLanguage;
  if (comment) out.commentLanguage = comment;
  const review = 'review' in r ? sanitizePartialReview(r.review) : base.review;
  if (review) out.review = review;
  return out;
}

function sanitizePrompts(raw: unknown): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const [id, v] of Object.entries(obj(raw))) if (isKanbanPromptId(id) && typeof v === 'string') out[id] = v.replace(/\r\n?/g, '\n').slice(0, PROMPT_MAX);
  return out;
}

/** The whole settings file, from whatever was read (a missing or broken file is the defaults). */
export function sanitizeKanbanSettings(raw: unknown, base: KanbanSettings = defaultKanbanSettings()): KanbanSettings {
  const r = obj(raw);
  const d = obj(r.defaults);
  const a = obj(r.autoResume);
  const defaults: KanbanSettings['defaults'] = {
    tool: oneOf<KanbanTool>(d.tool, KANBAN_TOOLS, base.defaults.tool),
    usePlan: bool(d.usePlan, base.defaults.usePlan),
    planApproval: oneOf(d.planApproval, PLAN_APPROVALS, base.defaults.planApproval),
    useReview: bool(d.useReview, base.defaults.useReview),
    implementPermission: oneOf(d.implementPermission, PERMISSIONS, base.defaults.implementPermission),
  };
  const m = 'model' in d ? model(d.model) : base.defaults.model;
  if (m) defaults.model = m;
  const e = 'effort' in d ? optOneOf<KanbanEffort>(d.effort, KANBAN_EFFORTS) : base.defaults.effort;
  if (e) defaults.effort = e;
  const projects: Record<string, ProjectSettings> = {};
  const rawProjects = 'projects' in r ? obj(r.projects) : base.projects;
  for (const [id, p] of Object.entries(rawProjects)) if (PROJECT_ID_RE.test(id)) projects[id] = sanitizeProjectSettings(p);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    defaults,
    review: sanitizeReview(r.review, base.review),
    autoResume: {
      enabled: bool(a.enabled, base.autoResume.enabled),
      maxAttempts: int(a.maxAttempts, 0, 50, base.autoResume.maxAttempts),
      maxWaitHours: int(a.maxWaitHours, 1, 168, base.autoResume.maxWaitHours),
    },
    archiveAfterDays: int(r.archiveAfterDays, 0, 3650, base.archiveAfterDays),
    projects,
  };
}

// --- The settings file ----------------------------------------------------------------------------

/** Writes a file whole or not at all: a crash mid-write never leaves half a settings file. */
function writeAtomic(file: string, body: string, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

export class KanbanSettingsStore {
  private settings: KanbanSettings;
  readonly file: string;

  constructor(
    dataDir: string,
    private onChange: (settings: KanbanSettings) => void = () => {},
  ) {
    this.file = path.join(dataDir, 'kanban-settings.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      raw = undefined; // never saved, or unreadable: the defaults
    }
    this.settings = sanitizeKanbanSettings(raw);
  }

  /** A copy of the settings as they stand. */
  get(): KanbanSettings {
    return structuredClone(this.settings);
  }

  /** Changes the office-wide settings (not the projects'). */
  set(patch: KanbanSettingsPatch): KanbanSettings {
    const p = obj(patch);
    const merged = {
      defaults: { ...this.settings.defaults, ...obj(p.defaults) },
      review: { ...this.settings.review, ...obj(p.review) },
      autoResume: { ...this.settings.autoResume, ...obj(p.autoResume) },
      archiveAfterDays: 'archiveAfterDays' in p ? p.archiveAfterDays : this.settings.archiveAfterDays,
      projects: this.settings.projects,
    };
    // Fields set to null go back to their defaults (a model or effort cleared, say).
    for (const part of [merged.defaults, merged.review] as Obj[]) for (const k of Object.keys(part)) if (part[k] === null) delete part[k];
    this.settings = sanitizeKanbanSettings(merged, { ...defaultKanbanSettings(), projects: this.settings.projects });
    this.changed();
    return this.get();
  }

  /** A project's settings, the defaults for any it doesn't have. */
  project(id: string): ProjectSettings {
    return structuredClone(this.settings.projects[id] ?? defaultProjectSettings());
  }

  /** Changes some of a project's settings. */
  setProject(id: string, patch: Partial<ProjectSettings>): ProjectSettings {
    if (!PROJECT_ID_RE.test(id)) throw new Error('Not a project id');
    // A copy: the fields set to null (cleared) are dropped from it, and read from the patch after.
    const p = { ...obj(patch) };
    const cleared = new Set(Object.keys(p).filter((k) => p[k] === null));
    for (const k of cleared) delete p[k];
    this.settings.projects[id] = sanitizeProjectSettings(p, this.settings.projects[id] ?? defaultProjectSettings());
    if (cleared.has('review')) delete this.settings.projects[id].review;
    for (const k of ['publicLanguage', 'commentLanguage'] as const) if (cleared.has(k)) delete this.settings.projects[id][k];
    if (cleared.has('planApproval')) delete this.settings.projects[id].planApproval;
    if (cleared.has('implementPermission')) delete this.settings.projects[id].implementPermission;
    this.changed();
    return this.project(id);
  }

  /** A project's own text for a kanban prompt; null goes back to the office's. Returns why not, if not. */
  setProjectPrompt(id: string, promptId: string, text: string | null): string | undefined {
    if (!PROJECT_ID_RE.test(id)) return 'Not a project id';
    if (!isKanbanPromptId(promptId)) return 'Only kanban prompts can be overridden per project';
    const clean = text === null ? null : text.replace(/\r\n?/g, '\n').trim();
    if (clean !== null && clean.length > PROMPT_MAX) return `A prompt can be ${PROMPT_MAX.toLocaleString('en-US')} characters at most`;
    const p = (this.settings.projects[id] ??= defaultProjectSettings());
    if (clean === null) delete p.prompts[promptId];
    else p.prompts[promptId] = clean;
    this.changed();
    return undefined;
  }

  /** Forgets a project's settings (its floor was taken off for good). */
  removeProject(id: string) {
    if (!this.settings.projects[id]) return;
    delete this.settings.projects[id];
    this.changed();
  }

  /** The review setting that applies to a task: the office's, the project's over it, the task's over both. */
  effectiveReview(project: string, overrides?: TaskOverrides): ReviewSettings {
    const p = this.settings.projects[project]?.review ?? {};
    return sanitizeReview({ ...this.settings.review, ...p, ...(overrides?.review ?? {}) });
  }

  /** The plan approval that applies to a project's new tasks. */
  planApproval(project: string): PlanApproval {
    return this.settings.projects[project]?.planApproval ?? this.settings.defaults.planApproval;
  }

  /** How implement-like phases run for a task: the task's choice, the project's, else the office's. */
  implementPermission(project: string, overrides?: TaskOverrides): ImplementPermission {
    return overrides?.implementPermission ?? this.settings.projects[project]?.implementPermission ?? this.settings.defaults.implementPermission;
  }

  private changed() {
    try {
      writeAtomic(this.file, `${JSON.stringify(this.settings, null, 2)}\n`, 0o600);
    } catch (err) {
      console.error(`agent-office: couldn't save the kanban settings: ${(err as Error).message}`);
    }
    this.onChange(this.get());
  }
}

// --- Secrets --------------------------------------------------------------------------------------

interface SecretsFile {
  jira?: { site: string; email: string; token: string };
  /** hashApiKey of the /api/v1 key (a file from before hashing may hold the key itself). */
  apiKey?: string;
}

/** How the /api/v1 key is kept: `sha256:<hex>`, so even the secrets file doesn't give it away. */
export function hashApiKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/**
 * Tokens the integrations need (Jira's API token, the /api/v1 key), in kanban-secrets.json with only
 * the office's user able to read it. Nothing here is ever sent to a browser.
 */
export class KanbanSecrets {
  private secrets: SecretsFile = {};
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'kanban-secrets.json');
    try {
      const raw = obj(JSON.parse(readFileSync(this.file, 'utf8')));
      const j = obj(raw.jira);
      if (typeof j.site === 'string' && typeof j.email === 'string' && typeof j.token === 'string' && j.token) this.secrets.jira = { site: j.site, email: j.email, token: j.token };
      if (typeof raw.apiKey === 'string' && raw.apiKey) this.secrets.apiKey = raw.apiKey;
    } catch {
      // none yet
    }
  }

  /** What the browser may know: which are set (and the Jira site, which isn't secret). */
  status(): SecretStatus {
    return { jira: { configured: !!this.secrets.jira, ...(this.secrets.jira ? { site: this.secrets.jira.site } : {}) }, apiKey: { configured: !!this.secrets.apiKey } };
  }

  jira(): { site: string; email: string; token: string } | undefined {
    return this.secrets.jira && { ...this.secrets.jira };
  }

  /** The /api/v1 key as kept: hashApiKey of it (see checkApiKey). */
  apiKey(): string | undefined {
    return this.secrets.apiKey;
  }

  /** Whether `key` is the /api/v1 key, compared in constant time. */
  checkApiKey(key: string | undefined): boolean {
    const kept = this.secrets.apiKey;
    if (!kept || !key) return false;
    const want = Buffer.from(kept.startsWith('sha256:') ? kept : hashApiKey(kept));
    const got = Buffer.from(hashApiKey(key));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Sets or (null) clears them; what isn't given stays. */
  set(patch: { jira?: { site: string; email: string; token: string } | null; apiKey?: string | null }): SecretStatus {
    if (patch.jira === null) delete this.secrets.jira;
    else if (patch.jira) this.secrets.jira = { site: patch.jira.site, email: patch.jira.email, token: patch.jira.token };
    if (patch.apiKey === null) delete this.secrets.apiKey;
    else if (typeof patch.apiKey === 'string') this.secrets.apiKey = hashApiKey(patch.apiKey);
    writeAtomic(this.file, `${JSON.stringify(this.secrets, null, 2)}\n`, 0o600);
    return this.status();
  }
}
