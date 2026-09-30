# 3d-kanban (fork of agent-office)

- This is a fork of AgentSystemLabs/agent-office with a kanban task process on top. Read `docs/kanban-architecture.md` (the contract) and `docs/fork.md` (seams into upstream files and the sync policy) before changing anything.
- Fork code lives in `src/shared/kanban/`, `src/server/kanban/`, `src/client/kanban/`, `bin/office-tasks.js`, `scripts/migrate-ai-kanban/`, `skills/` and `tests/kanban-*.test.ts`. Upstream files get only small seams, each listed in `docs/fork.md`; never reformat, reorder or rename upstream code.
- Do not open pull requests, push, or merge anything unless the user asks; there is no upstream-style PR workflow in this fork.
- Verify with `npm run typecheck`, `npm test` and `npm run build`, plus a headless-browser screenshot for visual changes.
- When a change affects how people run or use the office or the kanban, update `README.md` and the matching `docs/*.md` page in the same change.
- Every modal needs a top-right ✕, and closing it by ✕ or Esc must put the player straight back into mouse-look with no extra click.
