// ⚙️ Project's public language (shared/language.ts): the office's default, the project's own
// instructions whatever the office says, or a language of its own.
import { h } from '../ui/dom';
import { store } from '../state';
import { FOLLOW_PROJECT } from '../../shared/language';
import { languageInput, languageList, readLanguage } from '../ui/language';
import { field, select } from './ui';

type Pick = '' | typeof FOLLOW_PROJECT | 'other';

/** The field, and what to save: a language, FOLLOW_PROJECT, null (the office's default) or undefined when the language isn't one. */
export function publicLanguageField(saved: string | undefined): { el: HTMLElement; value(): string | null | undefined } {
  const office = store.prompts.language?.public;
  const now: Pick = !saved ? '' : saved === FOLLOW_PROJECT ? FOLLOW_PROJECT : 'other';
  const pick = select<Pick>(
    [
      ['', `Office default (${office || 'the project’s instructions'})`],
      [FOLLOW_PROJECT, 'The project’s own instructions'],
      ['other', 'Another language…'],
    ],
    now,
  );
  const input = languageInput(now === 'other' ? saved! : '', 'e.g. English', 'Public language of this project');
  const own = h('div.kb-row', {}, input, languageList(input));
  const paint = () => own.classList.toggle('hidden', pick.value !== 'other');
  pick.addEventListener('change', paint);
  paint();
  return {
    el: h('div', {}, field('Public language', pick, 'What issues, pull requests and commits are written in.'), own),
    value: () => {
      if (pick.value !== 'other') return pick.value || null;
      const { language } = readLanguage(input);
      return language;
    },
  };
}
