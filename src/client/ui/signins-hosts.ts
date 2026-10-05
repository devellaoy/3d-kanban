// The Azure DevOps and Bitbucket part of 🔐 Your sign-ins: your own token for each (the office acts
// there as you: office-pr's pull requests, comments, pushes over HTTPS), and the office's own for
// admins, which everyone without one of their own, the PR board and the issue sources use. A token
// goes to the office once and never comes back: the page only learns whom it belongs to.
import type { HostSignIn } from '../../shared/protocol';
import { hostLabel } from '../../shared/hosting/remote';
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { confirmDialog } from './prompt';

const HOW: Record<'azure' | 'bitbucket', { icon: string; make: string; what: string; token: string }> = {
  azure: {
    icon: '🔷',
    make: 'https://dev.azure.com/_usersSettings/tokens',
    what: 'a personal access token with Code (Read & write) and Work Items (Read & write)',
    token: 'Azure DevOps personal access token',
  },
  bitbucket: {
    icon: '🪣',
    make: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    what: 'an API token with scopes for Bitbucket: read and write repositories and pull requests, and read your user',
    token: 'Bitbucket API token',
  },
};

export interface HostCards {
  el: HTMLElement;
  render(): void;
}

/** The two cards, rendered from store.hosting. */
export function hostCards(net: Net): HostCards {
  const el = h('div.signins');
  // Kept across renders, so a half-typed token survives the next update.
  const inputs = {
    azure: { token: field('password', 'Personal access token', HOW.azure.token), office: false },
    bitbucket: { token: field('password', 'API token', HOW.bitbucket.token), email: field('email', 'you@example.com', 'Atlassian account e-mail'), office: false },
  };

  const card = (s: HostSignIn, admin: boolean): HTMLElement => {
    const kind = s.kind as 'azure' | 'bitbucket';
    const label = hostLabel(s.kind);
    const how = HOW[kind];
    const status = s.mine
      ? h('span.signin-who.ok', {}, '✅ ', s.mine.who || 'Token set')
      : s.office
        ? h('span.signin-who', {}, `The office’s own${s.office.who ? ` (${s.office.who})` : ''}`)
        : h('span.signin-who.none', {}, 'No token');
    const body = h('div.signin-body');
    const box = h('section.signin', { class: s.mine ? 'ok' : '', 'data-host': kind }, h('div.team-head', {}, h('h4', {}, `${how.icon} ${label}`), status), body);
    const saved = store.hostingSaved;
    if (saved?.kind === kind && saved.error && Date.now() - saved.at < 60_000) body.append(h('p.team-status.error', {}, saved.error));
    if (s.mine) {
      const clear = h('button.btn', { type: 'button' }, 'Remove my token');
      clear.addEventListener('click', () => confirmDialog(`Remove your ${label} token?`, `The office stops acting on ${label} as you${s.office ? ' and uses its own instead' : ''}.`, 'Remove', () => net.send({ t: 'hosting.clear', kind: s.kind })));
      body.append(h('div.signin-actions', {}, clear));
    } else {
      body.append(
        h('p.note', {}, 'Paste ', h('a', { href: how.make, target: '_blank', rel: 'noopener noreferrer' }, 'a token'), ` (${how.what}).`),
        tokenForm(kind, false),
      );
    }
    if (admin) {
      const office = h('details.signin-office', {}, h('summary', {}, s.office ? `The office’s own: ${s.office.who || 'set'}` : 'The office’s own (for everyone without one, and the boards)'));
      if (s.office) {
        const clear = h('button.btn', { type: 'button' }, 'Remove the office’s token');
        clear.addEventListener('click', () => confirmDialog(`Remove the office’s ${label} token?`, 'People without their own token, the PR board and the issue sources lose it.', 'Remove', () => net.send({ t: 'hosting.clear', kind: s.kind, office: true })));
        office.append(h('div.signin-actions', {}, clear));
      } else office.append(tokenForm(kind, true));
      body.append(office);
    }
    return box;
  };

  /** The form for a token: yours, or the office's (`office`). Bitbucket's also takes the account's e-mail. */
  const tokenForm = (kind: 'azure' | 'bitbucket', office: boolean): HTMLElement => {
    // The office's form has inputs of its own, so typing in one doesn't show in the other.
    const token = office ? field('password', 'Token', HOW[kind].token) : inputs[kind].token;
    const email = kind === 'bitbucket' ? (office ? field('email', 'e-mail', 'Atlassian account e-mail') : inputs.bitbucket.email) : undefined;
    const save = h('button.btn', { type: 'submit' }, 'Save');
    const form = h('form.invite-row', {}, ...(email ? [email] : []), token, save) as HTMLFormElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = token.value.trim();
      if (!t) return token.focus();
      if (email && !email.value.trim()) return email.focus();
      net.send({ t: 'hosting.set', kind, token: t, ...(email ? { email: email.value.trim() } : {}), ...(office ? { office: true } : {}) });
      token.value = '';
    });
    return form;
  };

  const render = () => {
    const s = store.hosting;
    const typing = document.activeElement;
    el.replaceChildren();
    if (!s) return;
    el.append(h('h3.signin-group', {}, 'Azure DevOps and Bitbucket'), h('p.note', {}, 'For repositories there, the office opens and follows pull requests over their APIs, as you when you have a token of your own. Pushes over HTTPS use it too.'));
    for (const host of s.hosts) el.append(card(host, s.admin));
    if (typing instanceof HTMLInputElement && typing.isConnected) typing.focus();
  };

  return { el, render };
}

function field(type: string, placeholder: string, label: string): HTMLInputElement {
  return h('input', { type, placeholder, 'aria-label': label, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
}

