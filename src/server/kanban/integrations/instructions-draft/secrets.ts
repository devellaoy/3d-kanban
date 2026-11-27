// A rough scan of a drafted text for things that look like secrets, so the review window can warn before
// the text is saved. It never changes the text and never repeats what it found.

const PLACEHOLDER = /^(?:<[^>]*>|\{[^}]*\}|\[[^\]]*\]|\$\{?\w+\}?|%\w+%|x{3,}|\*{3,}|\.{3,}|your[-_ ].*|changeme|password|secret|todo|tbd|none|null|empty|example)$/i;

const RULES: { re: RegExp; what: string; /** Whether the captured group 1 must be a real (non-placeholder) value. */ value?: boolean }[] = [
  { re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/, what: 'a token' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, what: 'a GitHub token' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'an API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS key' },
  // A key that names a secret, alone or as the end of a longer name (PGPASSWORD=, DB_PASSWORD: x, "Password": "x", API_SECRET=).
  { re: /(?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[=:]\s*([^;,\s"'`]+|"[^"]*"|'[^']*')/i, what: 'a password or key', value: true },
  // The password of a connection URL (postgres://user:password@host).
  { re: /\b[a-z][\w+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/i, what: 'a password in a URL', value: true },
  // A password given to a database client as a flag (mysql -pX, sqlcmd -P X).
  { re: /\b(?:mysql|mysqldump|mysqladmin)\b[^\n]*?\s-p([^\s-]\S*)/, what: 'a password', value: true },
  { re: /\b(?:sqlcmd|bcp)\b[^\n]*?\s-P\s?([^\s-]\S*)/, what: 'a password', value: true },
  { re: /(?<![A-Za-z0-9+/=_-])(?:[0-9a-fA-F]{40,}|[A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=_-])/, what: 'a long key' },
];

/** Warnings like `Line 12 may hold a secret (a token)`, one per line at most; 1-based line numbers. */
export function findSecrets(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    rules: for (const { re, what, value } of RULES) {
      // Every match of the rule on the line: a placeholder earlier on it must not hide a real value after it.
      for (const m of line.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
        if (value) {
          const v = (m[1] ?? '').replace(/^["']|["']$/g, '').trim();
          if (!v || /^[<{[$%]/.test(v) || PLACEHOLDER.test(v)) continue;
        } else if (what === 'a long key' && /^[A-Za-z]+$|^[/\\.]|\//.test(m[0]) && !/^[0-9a-fA-F]+$/.test(m[0])) {
          // A long run of letters or a path-like run is prose or a path, not a key.
          if (!/\d/.test(m[0])) continue;
        }
        out.push(`Line ${i + 1} may hold a secret (${what})`);
        break rules;
      }
    }
  });
  return out;
}
