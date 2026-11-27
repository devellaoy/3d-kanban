// Splits a finished pull-request review's text into one part per pull request (postreview.ts): a review of several pull requests is
// asked to write each one's findings under a heading `## <owner/repo#number>: APPROVED|CHANGES REQUESTED`, and a line
// `Pictures: a.png, b.png` ending a part names the UI-test pictures its findings show. Pure; the text is already without its verdict
// and WORK DONE lines. Headings and Pictures lines inside a code fence are ordinary text, as is a heading that is not a pull request's
// label alone. A review of one pull request is never split: its whole text is `common`. A heading at a part's own level that names
// another pull request but is no part heading (its verdict in another language, say) ends the part: what follows is nobody's (`common`).

import type { PrRef } from '../../../../shared/kanban/types.js';

export interface Part {
  text: string;
  /** The pictures the reviewer named, as written (not yet checked against the task's images). */
  pictures: string[];
  verdict?: 'approved' | 'changes_requested';
}

export interface ReviewParts {
  /** What is in no pull request's part: before the first heading of a review of several, the whole text of a review of one. */
  common: Part;
  /** By `${repo.toLowerCase()}#${number}`: only the pull requests the review has a heading for. */
  parts: Map<string, Part>;
}

export const partKey = (p: PrRef): string => `${p.repo.toLowerCase()}#${p.number}`;

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const PICTURES = /^\s*(?:[-*+]\s+)?[*_`]*pictures[*_`]*\s*:[*_`]*\s*(.*)$/i;
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
/** A local path: a pictures line that starts with one is never text to post, whatever became of its end. */
const PATHLIKE = /^(?:\/|~|\.{1,2}[\\/]|[A-Za-z]:[\\/])/;
const VERDICT = /^\s*[:–—-]\s*(approved|changes[ _]requested)$/i;

/** The names on a pictures line, separated by commas: only the formatting around a name goes, never a character inside it. */
const namesIn = (list: string): string[] =>
  list
    .split(',')
    .map((n) => n.trim().replace(/^[`*"'([<]+/, '').replace(/[`*"'\])>.;:]+$/, '').trim())
    .filter(Boolean);

/**
 * A part's heading: the pull request's label `<repo>#<number>` alone (bold and backticks aside), or followed by `: APPROVED` or
 * `: CHANGES REQUESTED`. Anything else that names a pull request (a finding's own title, say) is ordinary text.
 */
function partHeading(heading: string, prs: readonly PrRef[]): { pr: PrRef; verdict?: Part['verdict']; unclear?: boolean } | undefined {
  const h = heading.replace(/[*`]/g, '').trim().toLowerCase();
  let unclear: PrRef | undefined;
  for (const pr of prs) {
    const label = partKey(pr);
    if (!h.startsWith(label) || /\d/.test(h[label.length] ?? '')) continue;
    const rest = h.slice(label.length);
    if (!rest.trim()) return { pr };
    const v = VERDICT.exec(rest);
    if (v) return { pr, verdict: v[1] === 'approved' ? 'approved' : 'changes_requested' };
    unclear ??= pr;
  }
  // It starts with a pull request's label and goes on with something that is no verdict.
  return unclear ? { pr: unclear, unclear: true } : undefined;
}

type Acc = { lines: string[]; pictures: string[]; verdict?: Part['verdict'] };

/** `cut`: the text is only the first part of the review, so a pictures line it ends with is unfinished and goes, whatever is left of it. */
export function reviewParts(prs: readonly PrRef[], text: string, cut = false): ReviewParts {
  const acc = new Map<string, Acc>();
  const common: Acc = { lines: [], pictures: [] };
  let cur = common;
  /** The pull request and the heading level of the part being read. */
  let at: { key: string; level: number } | undefined;
  let fence: string | undefined;
  const all = text.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  for (const [i, line] of all.entries()) {
    const t = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^[`~]+$/.test(t)) fence = undefined;
    } else if (!fence) {
      const h = HEADING.exec(line);
      const hit = h && prs.length > 1 ? partHeading(h[1], prs) : undefined;
      const level = /#+/.exec(line)?.[0].length ?? 0;
      if (hit?.unclear) {
        // Another pull request's heading the office cannot read, at this part's level or above: the part ends, and the rest is no one's.
        if (at && partKey(hit.pr) !== at.key && level <= at.level) (cur = common), (at = undefined);
      } else if (hit) {
        const key = partKey(hit.pr);
        at = { key, level };
        let part = acc.get(key);
        if (!part) acc.set(key, (part = { lines: [], pictures: [] }));
        cur = part;
        if (hit.verdict) part.verdict = hit.verdict;
        continue;
      }
      // Only a line that goes on with an image file's name is the pictures line: a finding that starts with the word is text.
      const pic = PICTURES.exec(line);
      const listed = pic ? namesIn(pic[1]) : [];
      if (pic && cut && i === all.length - 1) continue;
      if (listed.length && (IMAGE.test(listed[0]) || PATHLIKE.test(listed[0]))) {
        cur.pictures.push(...listed);
        continue;
      }
    }
    cur.lines.push(line);
  }
  const done = (a: Acc): Part => ({ text: a.lines.join('\n').trim(), pictures: a.pictures, ...(a.verdict ? { verdict: a.verdict } : {}) });
  return { common: done(common), parts: new Map([...acc].map(([k, a]) => [k, done(a)])) };
}
