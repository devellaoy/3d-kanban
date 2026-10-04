// The language rule agents are given (⚙️ Settings, and a project's own public language in the kanban):
// two lines, one for what they talk to people in and one for what leaves the office.
import { resolveLanguages, type LanguageSettings } from '../shared/language.js';
import type { Ctx } from './office/context.js';
import { officePrompt, type PromptSource } from './prompts.js';

export const TALK_FALLBACK = "the language the task or the user's message is written in";

/**
 * The rule for `langs`: empty when neither is set. One set says the other goes by the task and the project, as
 * before: with only the conversation language set, the public line leaves commits and branch names alone.
 */
export function languageRule(source: Pick<PromptSource, 'text'> | undefined, langs: LanguageSettings): string {
  if (!langs.talk && !langs.public) return '';
  const talk = officePrompt(source, 'language.talk', { language: langs.talk ?? TALK_FALLBACK });
  const pub = langs.public ? officePrompt(source, 'language.public', { language: langs.public }) : officePrompt(source, 'language.public.unset');
  return [talk, pub].filter(Boolean).join('\n');
}

/** The comment rule for the code language: empty when the project follows its own conventions. */
export function codeRule(source: Pick<PromptSource, 'text'> | undefined, code: string | undefined): string {
  return code ? officePrompt(source, 'language.code', { language: code }) : '';
}

/** The whole rule: the language lines (or `fallback` when none is set) and then the comment rule for the code. */
export function languageRules(source: Pick<PromptSource, 'text'> | undefined, langs: LanguageSettings, fallback?: string): string {
  return [languageRule(source, langs) || fallback, codeRule(source, langs.code)].filter(Boolean).join('\n');
}

/**
 * The office's prompts for one project's floor: the same texts and worker, and the language rule with
 * the project's own public language over the office's. The kanban is installed after the floors open,
 * so its settings are looked up when the rule is asked for, and none (yet) is the office's.
 */
export function boundPrompts(ctx: Pick<Ctx, 'prompts' | 'kanban'>, projectId: string): PromptSource {
  const { prompts } = ctx;
  return {
    text: (id) => prompts.text(id),
    agent: () => prompts.agent(),
    language: () => {
      const project = ctx.kanban?.ctx.settings.project(projectId);
      const langs = resolveLanguages(prompts.languages(), project?.publicLanguage, project?.commentLanguage);
      return languageRules(prompts, langs);
    },
  };
}
