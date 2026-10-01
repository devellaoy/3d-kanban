# user-skills

Skills for the people who develop with this repository. They are not the skills the office delivers to
its task workers (those are in `skills/`); they are meant for your own Claude Code and Codex.

```
user-skills/
  claude/<skill>/SKILL.md   -> <claude home>/skills/<skill>/    (CLAUDE_CONFIG_DIR, else ~/.claude)
  codex/<skill>/SKILL.md    -> <codex home>/skills/<skill>/     (CODEX_HOME, else ~/.codex)
```

Now: `claude/kanban-dev`, `claude/kanban-dev-sonnet`, `claude/kanban-ui-screenshots`, `codex/kanban-dev`,
`codex/kanban-ui-screenshots`.

## Adding a skill

Add a folder with a `SKILL.md` (frontmatter `name` equal to the folder name, and a `description`) under
`claude/` or `codex/`, plus any scripts or references it needs. Do not commit `node_modules`.
`tests/kanban-integrations-user-skills.test.ts` lists the skills this folder is expected to hold; update it
when you add or remove one.

## When and how it is synced

When the server starts, every skill folder is copied into the matching home (the admin's **🔄 Sync** in
Settings -> Kanban -> Skills runs it too).

- A copy is marked with `.office-user-skill.json` (the source's hash). A marked copy is overwritten when the
  source has changed, even if you edited it by hand; nothing is written when it is current.
- A copy ai-kanban made (`.aikanban-sync`) is adopted the same way. If ai-kanban runs on the same machine
  too, whichever app started last wins; 3d-kanban takes the skills back on its next start.
- A skill of the same name without either marker is yours: it is left alone and a warning is logged.
- `node_modules` is never copied, and a `node_modules` already in the target survives an update. Files
  deleted from the source stay in the target.
- `AGENT_OFFICE_USER_SKILLS=off` turns the sync off (the admin's 🔄 Sync too). An agent's worktree
  (`.agent-office/worktrees/`) skips the start-up sync, so a branch doesn't overwrite your skills, unless
  `AGENT_OFFICE_USER_SKILLS=on`; 🔄 Sync isn't held back by the worktree rule.

`kanban-ui-screenshots` needs `npm install` in its folder (`<home>/skills/kanban-ui-screenshots`) the first
time you use it.

Details: [docs/kanban.md](../docs/kanban.md#skills-synced-to-your-own-home).
