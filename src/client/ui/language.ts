// The office's languages (shared/language.ts): a box for a language by its name, with the usual ones
// to pick from, and ⚙️ Settings → 🤖 Workers' two rows that set them for everyone. Admins change them.
import type { Net } from '../net';
import { store } from '../state';
import { LANGUAGE_MAX, LANGUAGE_SUGGESTIONS, cleanLanguage } from '../../shared/language';
import { h, timeAgo, toast } from './dom';
import { setting } from './settingrow';

export const LANGUAGE_HELP = 'Write a language by its name, e.g. English';

let seq = 0;
/** A text box for a language, suggesting the usual ones (put languageList() of it next to it). */
export function languageInput(value: string, placeholder: string, label = placeholder): HTMLInputElement {
  const id = `language-list-${++seq}`;
  const input = h('input', { type: 'text', list: id, placeholder, maxlength: LANGUAGE_MAX, 'aria-label': label, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  input.value = value;
  return input;
}

/** The suggestions a languageInput() points at, to put next to it. */
export const languageList = (input: HTMLInputElement) => h('datalist', { id: input.getAttribute('list') ?? '' }, ...LANGUAGE_SUGGESTIONS.map((l) => h('option', { value: l })));

/** What's in a language box: undefined when empty, the language, or an error when it isn't one. */
export function readLanguage(input: HTMLInputElement): { language?: string; error?: string } {
  if (!input.value.trim()) return {};
  const language = cleanLanguage(input.value);
  return language ? { language } : { error: LANGUAGE_HELP };
}

/** ⚙️ Settings → 🤖 Workers: the language agents talk to you in, and the one they write public texts in. */
export function languageRows(net: Net): { rows: Node[]; off: () => void } {
  const talk = languageInput('', 'Same as the task / your message', 'Conversation language');
  const pub = languageInput('', 'The project’s own instructions', 'Public language');
  const save = h('button.btn.primary', { type: 'button' }, 'Save') as HTMLButtonElement;
  const actions = h('div.seg', { style: 'margin-top:8px' }, save);
  const note = h('p.setting-note');
  let touched = false;
  for (const input of [talk, pub]) input.addEventListener('input', () => (touched = true));
  const paint = () => {
    const admin = store.me.admin;
    const set = store.prompts.language;
    for (const input of [talk, pub]) input.disabled = !admin;
    actions.classList.toggle('hidden', !admin);
    if (!touched) {
      talk.value = set?.talk ?? '';
      pub.value = set?.public ?? '';
    }
    note.textContent = (set ? `Set by ${set.by} ${timeAgo(set.at)}.` : 'Unset, agents go by the task and the project, as before.') + (admin ? '' : ' Admins can change them.');
  };
  paint();
  const send = () => {
    const [t, p] = [readLanguage(talk), readLanguage(pub)];
    if (t.error || p.error) return toast(LANGUAGE_HELP, 'warn');
    touched = false;
    const language = { ...(t.language ? { talk: t.language } : {}), ...(p.language ? { public: p.language } : {}) };
    net.send({ t: 'prompts.language', language: t.language || p.language ? language : null });
  };
  save.addEventListener('click', send);
  for (const input of [talk, pub])
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') send();
    });
  const offs = [store.on('prompts', paint), store.on('me', paint)];
  return {
    rows: [
      setting('Conversation language', 'office', h('div.webhook', {}, talk, languageList(talk)), h('p.setting-note', {}, 'Agents talk to you in this.')),
      setting('Public language', 'office', h('div.webhook', {}, pub, languageList(pub)), h('p.setting-note', {}, 'Issues, pull requests and commits are written in this, unless a project picks its own.'), actions, note),
    ],
    off: () => offs.forEach((off) => off()),
  };
}
