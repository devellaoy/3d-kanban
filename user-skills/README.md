# user-skills

Skills for the people who develop with this repository. They are not the skills the office delivers to
its task workers (those are in `skills/`); they are meant for your own Claude Code, Codex and Antigravity.

```
user-skills/
  claude/<skill>/SKILL.md   -> <claude home>/skills/<skill>/    (CLAUDE_CONFIG_DIR, else ~/.claude)
  codex/<skill>/SKILL.md    -> <codex home>/skills/<skill>/     (CODEX_HOME, else ~/.codex)
  antigravity/<skill>/SKILL.md -> ~/.gemini/config/skills/<skill>/
```

Now: `claude/kanban-dev`, `claude/kanban-dev-sonnet`, `claude/kanban-ui-screenshots`, `codex/kanban-dev`,
`codex/kanban-ui-screenshots`, `antigravity/kanban-dev`, `antigravity/kanban-ui-screenshots`.

## Adding a skill

Add a folder with a `SKILL.md` (frontmatter `name` equal to the folder name, and a `description`) under
`claude/`, `codex/` or `antigravity/`, plus any scripts or references it needs. Do not commit `node_modules`.
Right under the `# title`, add a `## Contents` list naming every heading with a few words on what it
covers, so an agent that reads only the start of the file still knows what the rest holds.
`tests/kanban-integrations-user-skills.test.ts` lists the skills this folder is expected to hold; update it
when you add or remove one.

## When and how it is synced

When the server starts, every skill folder is copied into the matching home (the admin's **🔄 Sync** in
Settings -> Kanban -> Skills runs it too).

- A copy is marked with `.office-user-skill.json` (the source's hash). A marked copy is overwritten when the
  source has changed, even if you edited it by hand; nothing is written when it is current.
- A copy ai-kanban made (`.aikanban-sync`) is adopted the same way. If ai-kanban runs on the same machine
  too, whichever app started last wins; 3d-kanban takes the skills back on its next start.
- A skill of the same name without either marker is yours: it is left alone and a warning is logged. A
  symbolic link is never written through either.
- Copies are built in `<home>/.office-user-skills-tmp/` and swapped in whole, so a failed update leaves the old
  copy. `node_modules` is never copied, and a `node_modules` already in the target survives an update. Files
  deleted from the source disappear from the target.
- `AGENT_OFFICE_USER_SKILLS=off` turns the sync off (start-up and the admin's 🔄 Sync). A source in a linked
  git worktree (an agent's checkout) is skipped by both, so a branch doesn't overwrite your skills, unless
  `AGENT_OFFICE_USER_SKILLS=on`. A main checkout and an install without git sync.
- `kanban-ui-screenshots` is kept in three copies, `claude/`, `codex/` and `antigravity/`, identical apart from `SKILL.md`
  and `agents/` (Codex's `openai.yaml`; Antigravity has none): `scripts/`, `tests/`, `references/` and the package files
  must be byte for byte the same (a test compares all three). Change the Claude copy and copy the rest over the other two.
  The skill's own tests are not part of `npm test`: run `npm ci` in a copy's folder, then
  `node --test scripts/*.test.mjs tests/*.test.mjs` there (the tests under `tests/` drive a real browser and need Chrome or Edge).

`kanban-ui-screenshots` needs `npm install` in its folder (`<home>/skills/kanban-ui-screenshots`) the first
time you use it.

Details: [docs/kanban.md](../docs/kanban.md#skills-synced-to-your-own-home).
