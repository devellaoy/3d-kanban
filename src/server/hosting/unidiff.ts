// A unified diff of two texts, as `git diff` prints one file's: for a host that gives a pull
// request's changed files and their contents but no diff of them (Azure DevOps). Myers' algorithm on
// lines, after the common head and tail are set aside; a change too big for it to be worth working
// out shows as the old lines taken out and the new put in.

/** Lines of context around each change, as git's default. */
const CONTEXT = 3;
/** Beyond this many differences the edit script isn't searched for (memory grows with its square). */
const MAX_EDITS = 2000;

type Op = { k: ' ' | '-' | '+'; line: string };

/** Marks a file's last line when the file doesn't end with a newline, so that difference is a change too. */
const NO_EOL = '\u0000no-eol';

/** A text's lines; the last one marked when the text doesn't end with a newline. */
function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

/** A line as the diff prints it (`k` and the line), with git's note after a last line without a newline. */
function printed(k: string, line: string): string {
  return line.endsWith(NO_EOL) ? `${k}${line.slice(0, -NO_EOL.length)}\n\\ No newline at end of file\n` : `${k}${line}\n`;
}

/** The shortest edit script from `a` to `b`, or undefined when it needs more than MAX_EDITS edits. */
function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return undefined;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    // trace[d] holds v as it was before step d: indices -d-1..d+1, at offset d+1.
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ k: ' ', line: a[--x] }), y--;
    if (x === prevX) ops.push({ k: '+', line: b[--y] });
    else ops.push({ k: '-', line: a[--x] });
  }
  while (x > 0 && y > 0) ops.push({ k: ' ', line: a[--x] }), y--;
  return ops.reverse();
}

/** The edits from `a` to `b`, the common head and tail kept as context. */
function edits(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const mid = myers(midA, midB) ?? [...midA.map((line): Op => ({ k: '-', line })), ...midB.map((line): Op => ({ k: '+', line }))];
  return [...a.slice(0, head).map((line): Op => ({ k: ' ', line })), ...mid, ...a.slice(a.length - tail).map((line): Op => ({ k: ' ', line }))];
}

/** The hunks (`@@ … @@` and their lines) of the change from `oldText` to `newText`; '' when they're the same. */
export function unifiedHunks(oldText: string, newText: string): string {
  const ops = edits(linesOf(oldText), linesOf(newText));
  // Where each op starts in the old and the new file, to number the hunks.
  const pos: { a: number; b: number }[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    pos.push({ a: ai, b: bi });
    if (op.k !== '+') ai++;
    if (op.k !== '-') bi++;
  }
  const changed = ops.flatMap((op, i) => (op.k === ' ' ? [] : [i]));
  let out = '';
  for (let i = 0; i < changed.length; i++) {
    const first = changed[i];
    // Changes closer than twice the context share a hunk.
    while (i + 1 < changed.length && changed[i + 1] - changed[i] <= 2 * CONTEXT) i++;
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length, changed[i] + CONTEXT + 1);
    const slice = ops.slice(from, to);
    const aLen = slice.filter((op) => op.k !== '+').length;
    const bLen = slice.filter((op) => op.k !== '-').length;
    // git numbers an empty side by the line before it.
    out += `@@ -${aLen ? pos[from].a + 1 : pos[from].a},${aLen} +${bLen ? pos[from].b + 1 : pos[from].b},${bLen} @@\n`;
    for (const op of slice) out += printed(op.k, op.line);
  }
  return out;
}
