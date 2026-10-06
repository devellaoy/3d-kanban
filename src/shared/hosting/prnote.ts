// What a worker's prompt about a pull request on Azure DevOps or Bitbucket adds to the office's own
// PR prompts, which use gh. Pure, so the pages and the tests share it.

import { hostLabel, hostOfUrl } from './remote.js';

/**
 * For a pull request on Azure DevOps or Bitbucket, where the office's PR prompts' gh doesn't work:
 * what to use instead (office-pr, read-only for view and diff). '' for one on GitHub, so its prompts are as they were.
 */
export function elsewhereNote(it: { number: number; url: string }): string {
  const host = hostOfUrl(it.url);
  if (!host || host === 'github') return '';
  return `\n\nThis pull request is on ${hostLabel(host)}, where gh doesn't work: wherever the above says gh, use office-pr inside the repository's checkout instead. Read it with \`office-pr view ${it.number} --comments\` and its changes with \`office-pr diff ${it.number}\` (both only read; nothing is fetched into the checkout), its checks with \`office-pr checks ${it.number}\`, and comment with \`office-pr comment ${it.number} --body-file <file>\`.`;
}
