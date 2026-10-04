// The language rule agents are given (⚙️ Settings, and a project's own public language in the kanban):
// two lines, one for what they talk to people in and one for what leaves the office.
import { resolveLanguages, type LanguageSettings } from '../shared/language.js';
import type { Ctx } from './office/context.js';
import { officePrompt, type PromptSource } from './prompts.js';

export const TALK_FALLBACK = "the language the task or the user's message is written in";
export const PUBLIC_FALLBACK = "the language the project's instructions ask for (when they say nothing, the language the task is written in)";

/** The rule for `langs`: empty when neither is set; one set says the other goes by the task and the project, as before. */
export function languageRule(source: Pick<PromptSource, 'text'> | undefined, langs: LanguageSettings): string {
  if (!langs.talk && !langs.public) return '';
  return [officePrompt(source, 'language.talk', { language: langs.talk ?? TALK_FALLBACK }), officePrompt(source, 'language.public', { language: langs.public ?? PUBLIC_FALLBACK })].filter(Boolean).join('\n');
}

/** The comment rule for the code language: empty when the project follows its own conventions. */
export function codeRule(source: Pick<PromptSource, 'text'> | undefined, code: string | undefined): string {
  return code ? officePrompt(source, 'language.code', { language: code }) : '';
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
      return [languageRule(prompts, langs), codeRule(prompts, langs.code)].filter(Boolean).join('\n');
    },
  };
}
