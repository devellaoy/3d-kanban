// The office's two language settings (⚙️ Settings, and a project's own in the kanban's ⚙️ Project):
// the language agents talk to people in, and the one everything that leaves the office is written in
// (issues, pull requests, commits). Unset, agents go by the task's language and the project's
// instructions, as before there were settings.

/** The office's settings (prompts.json): each one unset means "as before". */
export interface LanguageSettings {
  /** What agents talk to people in. */
  talk?: string;
  /** What issues, pull requests, commits and anything else posted outside the office are written in. */
  public?: string;
  /** What comments in the code are written in: resolved per project, never stored in the office's settings. */
  code?: string;
}

/** A project's public language that keeps to the project's own instructions, whatever the office's default. */
export const FOLLOW_PROJECT = '@project';

/** The language code comments are written in when a project doesn't pick one. */
export const DEFAULT_COMMENT_LANGUAGE = 'English';

export const LANGUAGE_MAX = 40;
/** A language by its name: "Finnish", "English", "Brazilian Portuguese". */
export const LANGUAGE_RE = /^\p{L}[\p{L} ()'.-]{0,39}$/u;
export const LANGUAGE_SUGGESTIONS = ['English', 'Finnish', 'Swedish', 'Norwegian', 'Danish', 'Estonian', 'German', 'French', 'Spanish'];

/** A language name, trimmed, or undefined when it isn't one. */
export function cleanLanguage(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/\s+/g, ' ');
  return LANGUAGE_RE.test(s) ? s : undefined;
}

/** The office's settings, from whatever was saved or sent. */
export function cleanLanguages(v: unknown): LanguageSettings {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const talk = cleanLanguage(r.talk);
  const pub = cleanLanguage(r.public);
  return { ...(talk ? { talk } : {}), ...(pub ? { public: pub } : {}) };
}

/** A project's setting: a language, FOLLOW_PROJECT, or undefined (the office's default). */
export function cleanProjectLanguage(v: unknown): string | undefined {
  return v === FOLLOW_PROJECT ? FOLLOW_PROJECT : cleanLanguage(v);
}

/** The language comments in a project's code are written in: undefined when it follows its own conventions. */
export function resolveCommentLanguage(projectComment?: string): string | undefined {
  return projectComment === FOLLOW_PROJECT ? undefined : projectComment || DEFAULT_COMMENT_LANGUAGE;
}

/** The languages a project's agents go by: its own public language over the office's default, and its comment language. */
export function resolveLanguages(office: LanguageSettings | undefined, projectPublic?: string, projectComment?: string): LanguageSettings {
  const pub = projectPublic === FOLLOW_PROJECT ? undefined : projectPublic || office?.public;
  const code = resolveCommentLanguage(projectComment);
  return { ...(office?.talk ? { talk: office.talk } : {}), ...(pub ? { public: pub } : {}), ...(code ? { code } : {}) };
}
