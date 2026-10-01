# 3d-kanban (fork of agent-office)

- This is a fork of AgentSystemLabs/agent-office with a kanban task process on top. Read `docs/kanban-architecture.md` (the kanban's contract), `docs/code-layout.md` and `docs/fork.md` (origin and upstream) before changing anything.
- The kanban is part of the project. Kanban-specific code lives in `src/shared/kanban/`, `src/server/kanban/` and `src/client/kanban/` (plus `bin/office-tasks.js`, `scripts/migrate-ai-kanban/`, `skills/` and `tests/kanban-*.test.ts`); general code lives where it belongs (`ui/`, `player/`, `server/` and so on). Any file may be changed where that is the clean solution.
- Do not open pull requests, push, or merge anything unless the user asks; there is no upstream-style PR workflow in this fork.
- Verify with `npm run typecheck`, `npm test` and `npm run build`, plus a headless-browser screenshot for visual changes.
- New upstream-style features plug in through the registries as modules of their own (see `docs/code-layout.md`), never by adding their code to `main.ts`, `server.ts`, the state store, `protocol.ts` or another feature's files, and `tests/size.test.ts` must stay green. The registries and the size guard apply to all code, the kanban included.
- When a change affects how people run or use the office or the kanban, update `README.md` and the matching `docs/*.md` page in the same change.
- Every modal needs a top-right ✕, and closing it by ✕ or Esc must put the player straight back into mouse-look with no extra click.
