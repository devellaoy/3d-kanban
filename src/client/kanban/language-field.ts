// ⚙️ Project's public language (shared/language.ts): the office's default, the project's own
// instructions whatever the office says, or a language of its own.
import { h } from '../ui/dom';
import { store } from '../state';
import { FOLLOW_PROJECT } from '../../shared/language';
import { languageInput, languageList, readLanguage } from '../ui/language';
import { field, select } from './ui';

type LanguagePick = '' | typeof FOLLOW_PROJECT | 'other';
type LanguageField = { el: HTMLElement; value(): string | null | undefined };

/** A select (default / follow the project / another language) with a language box; value: a language, FOLLOW_PROJECT, null (the default, also an empty box) or undefined when the language isn't one. */
function languageField(saved: string | undefined, o: { label: string; hint: string; aria: string; options: [string, string]; placeholder: string }): LanguageField {
  const now: LanguagePick = !saved ? '' : saved === FOLLOW_PROJECT ? FOLLOW_PROJECT : 'other';
  const pick = select<LanguagePick>([['', o.options[0]], [FOLLOW_PROJECT, o.options[1]], ['other', 'Another language…']], now);
  const input = languageInput(now === 'other' ? saved! : '', o.placeholder, o.aria);
  const own = h('div.kb-row', {}, input, languageList(input));
  const paint = () => own.classList.toggle('hidden', pick.value !== 'other');
  pick.addEventListener('change', paint);
  paint();
  return {
    el: h('div', {}, field(o.label, pick, o.hint), own),
    value: () => {
      if (pick.value !== 'other') return pick.value || null;
      const read = readLanguage(input);
      return read.error ? undefined : (read.language ?? null);
    },
  };
}

export function publicLanguageField(saved: string | undefined): LanguageField {
  const office = store.prompts.language?.public;
  return languageField(saved, {
    label: 'Public language',
    hint: 'What issues, pull requests and commits are written in.',
    aria: 'Public language of this project',
    options: [`Office default (${office || 'the project’s instructions'})`, 'The project’s own instructions'],
    placeholder: 'e.g. English',
  });
}

export function commentLanguageField(saved: string | undefined): LanguageField {
  return languageField(saved, {
    label: 'Code comment language',
    hint: 'What comments in the code are written in.',
    aria: 'Code comment language of this project',
    options: [`English (default)`, 'The project’s own conventions'],
    placeholder: 'e.g. Finnish',
  });
}
