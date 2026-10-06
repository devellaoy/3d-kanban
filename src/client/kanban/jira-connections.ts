// 🗂️ Kanban → Jira connections (settings.ts secretsPane): the office's Jira sites and the accounts it
// reads them as (shared/kanban/jira-connections.ts). Each is listed by its name and site, never its
// e-mail or token; admins add, edit, test and remove them here, in forms inside the list rather than
// windows of their own. Saving or removing answers with kanban.settings, which redraws the pane.

import { h, toast } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { JIRA_CONNECTION_NAME_MAX, cleanJiraSite, sameJiraSite, type JiraConnectionStatus } from '../../shared/kanban/jira-connections.js';
import type { KanbanApi, KanbanError } from './api';
import { kstore } from './store';
import { field, run, textInput } from './ui';

type Tested = Extract<KanbanServerMsg, { t: 'kanban.secrets.jiraTested' }>;

/** A connection as people read it: its name and site, or the site alone when it has no name of its own. */
export const connectionLabel = (c: JiraConnectionStatus): string => (c.name && c.name !== c.site ? `${c.name} · ${c.site}` : c.site);

const adminButton = (label: string, cls: `button.${string}` = 'button.btn.small.kb-admin', attrs: Record<string, string> = {}) => h(cls, { type: 'button', ...attrs }, label) as HTMLButtonElement;

/** The Jira fieldset: the connections, each with Test, Edit and Remove, and ＋ Add Jira connection. */
export function jiraConnectionsFieldset(api: KanbanApi): HTMLElement {
  const conns = kstore.secrets.jira;
  const list = h('div.kb-jira-conns');
  const add = adminButton('＋ Add Jira connection', 'button.btn.kb-admin');
  const addSlot = h('div');
  add.addEventListener('click', () => {
    add.classList.add('hidden');
    addSlot.replaceChildren(connectionForm(api, undefined, () => (addSlot.replaceChildren(), add.classList.remove('hidden'))));
  });
  if (!conns.length) list.append(h('p.kb-muted', {}, 'No Jira connections yet: add one for each Jira site (or account) the projects read.'));
  for (const c of conns) list.append(connectionRow(api, c));
  return h(
    'fieldset',
    {},
    h('legend', {}, 'Jira connections'),
    h('p.kb-hint', {}, 'A Jira issue source uses the connection it names, or the first one for its site.'),
    list,
    addSlot,
    h('div.kb-row', {}, add),
  );
}

function connectionRow(api: KanbanApi, c: JiraConnectionStatus): HTMLElement {
  const test = adminButton('Test');
  const edit = adminButton('Edit');
  const remove = adminButton('Remove', 'button.btn.small.kb-admin', { 'aria-label': `Remove ${c.name}` });
  const result = h('small.kb-jira-result');
  const below = h('div');
  const buttons = h('span.kb-row', {}, test, edit, remove);
  const head = h(
    'div.kb-repo-head',
    {},
    h('b', {}, c.name || c.site),
    c.name && c.name !== c.site ? h('span.kb-muted', {}, c.site) : null,
    h('span.kb-secret.on', {}, '✅ token set'),
    h('span.grow'),
    buttons,
  );
  const el = h('div.kb-source.kb-jira-conn', {}, head, result, below);

  test.addEventListener('click', async () => {
    test.disabled = true;
    result.className = 'kb-jira-result';
    result.textContent = 'Asking Jira…';
    try {
      const r = await api.request<Tested>({ t: 'kanban.secrets.jira.test', id: c.id });
      result.className = 'kb-jira-result ok';
      result.textContent = `✅ Connected as ${r.name}`;
    } catch (err) {
      result.className = 'kb-jira-result bad';
      result.textContent = `⚠️ ${(err as KanbanError).message || 'That didn’t work'}`;
    } finally {
      test.disabled = false;
    }
  });
  const closeBelow = () => {
    below.replaceChildren();
    buttons.classList.remove('hidden');
  };
  edit.addEventListener('click', () => {
    buttons.classList.add('hidden');
    below.replaceChildren(connectionForm(api, c, closeBelow));
  });
  remove.addEventListener('click', () => {
    // Asked here in the row: a window over ⚙️ Settings would be one more to shut.
    const yes = adminButton('Remove', 'button.btn.small.danger.kb-admin');
    const no = adminButton('Never mind', 'button.btn.small');
    no.addEventListener('click', closeBelow);
    yes.addEventListener('click', () => void run(() => api.request({ t: 'kanban.secrets.jira.remove', id: c.id }), yes, 'Removed').then((ok) => ok || closeBelow()));
    buttons.classList.add('hidden');
    below.replaceChildren(h('div.kb-row.kb-jira-confirm', {}, h('span.grow', {}, `Remove ${c.name || c.site}? Sources that name it stop reading until they pick another; those on Automatic take the next one for their site.`), no, yes));
    setTimeout(() => no.focus(), 0);
  });
  return el;
}

/** Adding a connection (`c` undefined) or editing one: what's left empty in an edit stays as it is. */
function connectionForm(api: KanbanApi, c: JiraConnectionStatus | undefined, done: () => void): HTMLElement {
  const keep = c ? 'Unchanged: leave empty to keep' : '';
  const name = textInput(c && c.name !== c.site ? c.name : '', { maxlength: JIRA_CONNECTION_NAME_MAX, placeholder: 'Customer X', 'aria-label': 'Name' });
  const site = textInput(c?.site ?? '', { maxlength: 200, placeholder: 'yourteam.atlassian.net', 'aria-label': 'Jira site' });
  const email = textInput('', { type: 'email', placeholder: keep || 'me@example.com', 'aria-label': 'E-mail' });
  const token = h('input', { type: 'password', autocomplete: 'new-password', placeholder: keep, 'aria-label': 'API token' }) as HTMLInputElement;
  const save = adminButton(c ? 'Save' : 'Add', 'button.btn.primary.kb-admin');
  const cancel = adminButton('Cancel', 'button.btn');
  cancel.addEventListener('click', done);
  save.addEventListener('click', () => {
    const host = cleanJiraSite(site.value);
    if (!host) return toast('The Jira site is a host name, like yourteam.atlassian.net', 'warn');
    const e = email.value.trim();
    const t = token.value.trim();
    if (!c && (!e || !t)) return toast('A new Jira connection needs the e-mail and the API token', 'warn');
    if (c && !sameJiraSite(host, c.site) && (!e || !t)) return toast(`A new site needs the e-mail and the API token again: the ones saved are for ${c.site}`, 'warn');
    void run(() => api.request({ t: 'kanban.secrets.jira.set', ...(c ? { id: c.id } : {}), name: name.value.trim(), site: host, ...(e ? { email: e } : {}), ...(t ? { token: t } : {}) }), save, 'Saved');
  });
  // Moving a connection to another site changes what every source that names it reads: say which.
  const warning = h('small.kb-hint');
  const paintWarning = () => {
    const host = cleanJiraSite(site.value);
    const using = c && host && !sameJiraSite(host, c.site) ? sourcesUsing(c.id) : [];
    warning.textContent = using.length ? `⚠️ Sources that name it: ${using.join(', ')}. They still name the old site, so they stop reading until you change them.` : '';
  };
  site.addEventListener('input', paintWarning);
  setTimeout(() => name.focus(), 0);
  return h(
    'div.kb-subfields.kb-jira-form',
    {},
    h('b', {}, c ? `Edit ${c.name || c.site}` : 'New Jira connection'),
    h('div.kb-two', {}, field('Name', name, 'What people call it; the site when empty'), field('Jira site', site, c ? 'A changed site needs the e-mail and the API token again' : undefined)),
    warning,
    h('div.kb-two', {}, field('E-mail', email), field('API token', token, 'id.atlassian.com → Security → API tokens')),
    h('div.kb-row', {}, h('span.grow'), cancel, save),
  );
}

/** The issue sources, across the projects, that name this connection ("Web: Jira UYT"), for the warning when its site is changed. */
function sourcesUsing(connection: string): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(kstore.settings?.projects ?? {})) {
    for (const s of p.issueSources) if (s.kind === 'jira' && s.connection === connection) out.push(`${kstore.projectOf(id)?.name ?? id}: Jira ${s.projectKeys.join(', ') || s.site}`);
  }
  return out;
}
