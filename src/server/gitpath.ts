// A path in a diff's header lines, shared by the diffs the office builds itself (prfiles.ts for
// GitHub's files API, hosting/azure-diff.ts for Azure DevOps). No imports, so either may use it.

/** A path as git writes it in a diff header: C-quoted when it has a quote, backslash or control character, so a file name can't start a header line of its own. */
export function gitPath(prefix: string, p: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return prefix + p;
  const esc: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
  return `"${(prefix + p).replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}
