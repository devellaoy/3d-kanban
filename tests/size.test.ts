// The size guard: no source file grows past a line budget, so the hubs the office was split out of
// can't grow back. A file that gets too long is split along the registries (docs/code-layout.md).
//
// The files are the ones git knows about under src/ (tracked, or new and not ignored), never a walk
// of the folder, so a worktree checked out inside this one can't trip it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

/** The most lines a source file (.ts or .css under src/) may have. */
const BUDGET = 600;

/**
 * The files that were already over the budget when it came in, each with the lines it had then as
 * its ceiling. They may shrink, never grow past it. One that drops to the budget or under comes off
 * this list, so the list only ever gets shorter; nothing new goes on it.
 */
const CEILINGS: Readonly<Record<string, number>> = {
  'src/server/dsh.ts': 1148,
  'src/server/workers/manager.ts': 1029,
  'src/client/features/rooftop/world.ts': 989,
  'src/client/world/sky.ts': 966,
  'src/server/meetings.ts': 768,
  'src/client/features/workers/sendhome.ts': 718,
  'src/client/world/holiday.ts': 702,
  'src/client/features/dog/world.ts': 702,
  'src/client/world/character/person.ts': 699,
  'src/server/signins.ts': 660,
  'src/client/dnb.ts': 641,
  'src/client/features/golf/world.ts': 635,
  'src/client/features/bargames/world.ts': 617,
  'src/client/world/city.ts': 613,
  'src/client/ui/settings.ts': 608,
  'src/client/world/character/worker.ts': 605,
  'src/client/world/costumes.ts': 603,
};

/**
 * 3d-kanban: upstream files over their ceiling only by the fork's seams (docs/fork.md): the indoor fog
 * (upstream PR #207) in sky.ts, and the kanban's settings panes and the mouse sensitivity row in settings.ts.
 * Same rule: never grow.
 */
const FORK_CEILINGS: Readonly<Record<string, number>> = {
  'src/client/world/sky.ts': 1076,
  'src/client/ui/settings.ts': 619,
};

const SPLIT = 'Split it along the registries instead (see docs/code-layout.md).';

/** Every .ts and .css file under src/ that git knows about and that's there on disk. */
function sources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'], { cwd: root, encoding: 'utf8' });
  return [...new Set(out.split('\0'))]
    // 3d-kanban: the fork's own code (src/{client,server,shared}/kanban/) isn't held to upstream's hub budget (docs/fork.md).
    .filter((f) => !/^src\/(client|server|shared)\/kanban\//.test(f))
    .filter((f) => /\.(ts|css)$/.test(f) && existsSync(path.join(root, f))).sort();
}

/** Its lines, as `wc -l` counts them (and a last one without a newline too). */
function linesOf(file: string): number {
  const text = readFileSync(path.join(root, file), 'utf8');
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

test(`no source file is over ${BUDGET} lines, and none of the ones already over grows`, () => {
  const files = sources();
  assert.ok(files.length > 400, `found only ${files.length} source files under src/`);
  const over: string[] = [];
  for (const file of files) {
    const lines = linesOf(file);
    const ceiling = FORK_CEILINGS[file] ?? CEILINGS[file]; // 3d-kanban: FORK_CEILINGS
    if (ceiling === undefined && lines > BUDGET) over.push(`${file} is ${lines} lines, over the ${BUDGET}-line budget. ${SPLIT}`);
    if (ceiling !== undefined && lines > ceiling) over.push(`${file} is ${lines} lines, past its ceiling of ${ceiling} (tests/size.test.ts). ${SPLIT}`);
  }
  assert.equal(over.length, 0, `\n${over.join('\n')}`);
});

test('the list of files over the budget only gets shorter', () => {
  const files = new Set(sources());
  const stale: string[] = [];
  for (const file of Object.keys(CEILINGS)) {
    if (!files.has(file)) stale.push(`${file} is gone: take it off CEILINGS in tests/size.test.ts (its pieces are held to the ${BUDGET}-line budget).`);
    else if (linesOf(file) <= BUDGET) stale.push(`${file} is down to ${linesOf(file)} lines, within the ${BUDGET}-line budget: take it off CEILINGS in tests/size.test.ts.`);
  }
  // 3d-kanban: a fork ceiling is the file's length exactly, so it tightens as the file shrinks, and goes once upstream's ceiling holds it.
  for (const [file, ceiling] of Object.entries(FORK_CEILINGS)) {
    if (!files.has(file)) stale.push(`${file} is gone: take it off FORK_CEILINGS in tests/size.test.ts.`);
    else if (linesOf(file) <= (CEILINGS[file] ?? BUDGET)) stale.push(`${file} is down to ${linesOf(file)} lines, within upstream's limit: take it off FORK_CEILINGS in tests/size.test.ts.`);
    else if (linesOf(file) < ceiling) stale.push(`${file} is down to ${linesOf(file)} lines: lower its FORK_CEILINGS entry in tests/size.test.ts to that.`);
  }
  assert.equal(stale.length, 0, `\n${stale.join('\n')}`);
});
