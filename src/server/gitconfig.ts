// An account's git config (signins.ts writes it to homes/<id>/gitconfig and points GIT_CONFIG_GLOBAL
// at it): the office machine's own settings included, gh as the credentials for GitHub, the office's
// credential helper for Azure DevOps and Bitbucket (bin/office-git-credential.js, with the account's
// tokens and then the office's: hosting/credentials.ts), so pushes go out as them, and their name and
// email on commits once they're known.

export interface GitConfigParts {
  /** The office machine's own git config files, included first. */
  includes: string[];
  /** gh, for GitHub's credentials. */
  gh?: string;
  /** The credential helper for the other hosts, with the files it reads tokens from (the account's first). */
  hosting?: { helper: string; files: string[] };
  user?: { name: string; email: string };
}

/** The hosts whose HTTPS pushes the office's credential helper answers for. */
export const HELPER_HOSTS = ['https://dev.azure.com', 'https://*.visualstudio.com', 'https://bitbucket.org'];
const AZURE_HOST = 'https://dev.azure.com';

export function gitConfigText(p: GitConfigParts): string {
  const lines = ['# Written by Agent Office: git for this account, on top of the office machine’s own settings.', '[include]', ...p.includes.map((f) => `\tpath = ${quote(f)}`)];
  if (p.gh) {
    for (const host of ['https://github.com', 'https://gist.github.com']) {
      lines.push(`[credential ${quote(host)}]`, '\thelper =', `\thelper = ${quote(`!${shq(p.gh)} auth git-credential`)}`);
    }
  }
  if (p.hosting) {
    const helper = `!${[p.hosting.helper, ...p.hosting.files].map(shq).join(' ')}`;
    // useHttpPath off: one token for the whole host, whatever repository.
    // useHttpPath on dev.azure.com: the path names the organization, whose token the helper picks.
    for (const host of HELPER_HOSTS) lines.push(`[credential ${quote(host)}]`, '\thelper =', `\thelper = ${quote(helper)}`, ...(host === AZURE_HOST ? ['\tuseHttpPath = true'] : []));
  }
  if (p.user) lines.push('[user]', `\tname = ${quote(p.user.name)}`, `\temail = ${quote(p.user.email)}`);
  return `${lines.join('\n')}\n`;
}

/** A value for a git config file, quoted. */
export function quote(v: string): string {
  return `"${v.replace(/[\p{C}]/gu, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A word for the shell git runs a `!helper` with. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `env` with the office's credential helper for the HELPER_HOSTS put in through git's own
 * environment config (GIT_CONFIG_COUNT, git 2.31+), ahead of any helper the machine has for them, so
 * a push over HTTPS goes out with the token in `files` (the first that has one) whatever git config
 * the environment points at. Changed in place, and returned.
 */
export function withHelperEnv(env: Record<string, string>, helper: string, files: string[]): Record<string, string> {
  let n = Number(env.GIT_CONFIG_COUNT) || 0;
  const add = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  };
  const command = `!${[helper, ...files].map(shq).join(' ')}`;
  for (const host of HELPER_HOSTS) {
    // An empty helper first: the machine's own helpers for the host are left out.
    add(`credential.${host}.helper`, '');
    add(`credential.${host}.helper`, command);
    // The path names the organization on dev.azure.com, whose token the helper picks.
    if (host === AZURE_HOST) add(`credential.${host}.useHttpPath`, 'true');
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}
