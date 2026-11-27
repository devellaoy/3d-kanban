// Splits a finished pull-request review's text into one part per pull request (postreview.ts): a review of several pull requests is
// asked to write each one's findings under a heading `## <owner/repo#number>: APPROVED|CHANGES REQUESTED`, and a line
// `Pictures: a.png, b.png` ending a part names the UI-test pictures its findings show. Pure; the text is already without its verdict
// and WORK DONE lines. Headings and Pictures lines inside a code fence are ordinary text, as is a heading naming no (or several) pull requests.

import type { PrRef } from '../../../../shared/kanban/types.js';

export interface Part {
  text: string;
  /** The picture names the reviewer gave (not yet checked against the task's images). */
  pictures: string[];
  verdict?: 'approved' | 'changes_requested';
}

export interface ReviewParts {
  /** At least one pull request's heading was found. */
  split: boolean;
  /** What comes before the first heading (or the whole text when there is none). */
  common: Part;
  /** By `${repo.toLowerCase()}#${number}`. */
  parts: Map<string, Part>;
}

export const partKey = (p: PrRef): string => `${p.repo.toLowerCase()}#${p.number}`;

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const PICTURES = /^\s*(?:[-*+]\s+)?[*_`]*pictures[*_`]*\s*:[*_`]*\s*(.*)$/i;
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const VERDICT = /^\s*[:\u2013\u2014-]\s*(approved|changes[ _]requested)$/i;

const namesIn = (list: string): string[] =>
  list
    .split(/[,\s]+/)
    .map((n) => n.replace(/[`*_"'()[\]]/g, '').replace(/[.;:]+$/, '').trim())
    .filter(Boolean);

/**
 * A part's heading: the pull request's label `<repo>#<number>` alone (bold and backticks aside), or followed by `: APPROVED` or
 * `: CHANGES REQUESTED`. Anything else that names a pull request (a finding's own title, say) is ordinary text.
 */
function partHeading(heading: string, prs: readonly PrRef[]): { pr: PrRef; verdict?: Part['verdict'] } | undefined {
  const h = heading.replace(/[*`]/g, '').trim().toLowerCase();
  for (const pr of prs) {
    const label = partKey(pr);
    if (!h.startsWith(label)) continue;
    const rest = h.slice(label.length);
    if (!rest.trim()) return { pr };
    const v = VERDICT.exec(rest);
    if (v) return { pr, verdict: v[1] === 'approved' ? 'approved' : 'changes_requested' };
  }
  return undefined;
}

export function reviewParts(prs: readonly PrRef[], text: string): ReviewParts {
  const acc = new Map<string, { lines: string[]; pictures: string[]; verdict?: Part['verdict'] }>();
  const common = { lines: [] as string[], pictures: [] as string[] };
  let cur: { lines: string[]; pictures: string[]; verdict?: Part['verdict'] } = common;
  let fence: string | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^[`~]+$/.test(t)) fence = undefined;
      cur.lines.push(line);
      continue;
    }
    if (!fence) {
      const h = HEADING.exec(line);
      const hit = h && prs.length > 1 ? partHeading(h[1], prs) : undefined;
      if (hit) {
        const key = partKey(hit.pr);
        let part = acc.get(key);
        if (!part) acc.set(key, (part = { lines: [], pictures: [] }));
        cur = part;
        if (hit.verdict) part.verdict = hit.verdict;
        continue;
      }
      // Only a line that goes on with an image file name is the pictures line: a finding that starts with the word is text.
      const pic = PICTURES.exec(line);
      const listed = pic ? namesIn(pic[1]) : [];
      if (listed.length && IMAGE.test(listed[0])) {
        cur.pictures.push(...listed);
        continue;
      }
    }
    cur.lines.push(line);
  }
  const done = (a: { lines: string[]; pictures: string[]; verdict?: Part['verdict'] }): Part => ({ text: a.lines.join('\n').trim(), pictures: a.pictures, ...(a.verdict ? { verdict: a.verdict } : {}) });
  // A part for every pull request, or none: a reply that names only some of them (or was cut before the rest) is posted whole on each.
  if (prs.length > 1 && prs.every((p) => acc.has(partKey(p)))) return { split: true, common: done(common), parts: new Map([...acc].map(([k, a]) => [k, done(a)])) };
  return reviewWhole(text);
}

/** The text as one part: its pictures lines taken out, every heading left as it is. */
function reviewWhole(text: string): ReviewParts {
  const lines: string[] = [], pictures: string[] = [];
  let fence: string | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^[`~]+$/.test(t)) fence = undefined;
    } else if (!fence) {
      const pic = PICTURES.exec(line);
      const listed = pic ? namesIn(pic[1]) : [];
      if (listed.length && IMAGE.test(listed[0])) {
        pictures.push(...listed);
        continue;
      }
    }
    lines.push(line);
  }
  return { split: false, common: { text: lines.join('\n').trim(), pictures }, parts: new Map() };
}
