// Keeps the tests from syncing the repository's user-skills/ into the real ~/.claude and ~/.codex:
// installKanban starts the user-skills plugin, which would otherwise copy them there whenever a
// test builds the kanban. Set outright (not ??=), so a developer's own =on can't leak into the tests; the
// tests of the sync itself pass their own temporary homes and set the variable themselves.
//
// npm test loads it as #tests/homes (package.json "imports"), like #tests/css.
process.env.AGENT_OFFICE_USER_SKILLS = 'off';
