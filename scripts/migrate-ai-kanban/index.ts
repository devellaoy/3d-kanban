// Migration from ai-kanban (docs/migration.md):
//   npm run migrate:ai-kanban -- --from ~/.ai-kanban/data [--home <officeHome>] [--apply]
//                                [--map name=project ...] [--with-stream-logs] [--json]
// A dry run by default: everything is migrated into scratch copies of the office's floors.json,
// kanban database and settings, the report printed, and the copies thrown away. --apply writes into
// the office, which must be stopped. ai-kanban's data is only ever read.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Building } from '../../src/server/building.js';
import { KanbanRepository } from '../../src/server/kanban/db/repository.js';
import { kanbanDbPath, openKanbanDb } from '../../src/server/kanban/db/open.js';
import { KanbanSettingsStore } from '../../src/server/kanban/settings.js';
import { openLegacyDb } from './legacy.js';
import { migrate, type MigrationReport } from './migrate.js';

const USAGE = `Usage: npm run migrate:ai-kanban -- --from <ai-kanban data dir> [options]

  --from <dir>          ai-kanban's data folder (usually ~/.ai-kanban/data); only read
  --home <dir>          the office's home (default $AGENT_OFFICE_HOME or ~/agent-office);
                        its data is <home>/.agent-office
  --apply               write into the office (it must be stopped); without it, a dry run
  --map name=project    put tasks of ai-kanban repository <name> into <project> (a floor id,
                        or an ai-kanban repository's name or id); may be repeated
  --with-stream-logs    also keep ai-kanban's raw agent output (files, not the database)
  --json                print the report as JSON`;

export interface Args {
  from: string;
  home: string;
  apply: boolean;
  map: Record<string, string>;
  withStreamLogs: boolean;
  json: boolean;
}

const untildify = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | string {
  const a: Args = { from: '', home: env.AGENT_OFFICE_HOME || path.join(os.homedir(), 'agent-office'), apply: false, map: {}, withStreamLogs: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') && arg.startsWith('--') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    try {
      if (flag === '--from') a.from = value();
      else if (flag === '--home') a.home = value();
      else if (flag === '--apply') a.apply = true;
      else if (flag === '--dry-run') a.apply = false;
      else if (flag === '--with-stream-logs') a.withStreamLogs = true;
      else if (flag === '--json') a.json = true;
      else if (flag === '--map') {
        const m = /^([^=]+)=(.+)$/.exec(value());
        if (!m) return '--map takes name=project';
        a.map[m[1].trim()] = m[2].trim();
      } else if (flag === '-h' || flag === '--help') return USAGE;
      else return `Unknown option ${arg}\n\n${USAGE}`;
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (!a.from) return `--from is required\n\n${USAGE}`;
  a.from = path.resolve(untildify(a.from));
  a.home = path.resolve(untildify(a.home));
  return a;
}

/** Whether the office is running: its hook server (the port in <dataDir>/hook-port) answers. */
export function officeRunning(dataDir: string): Promise<boolean> {
  let port = 0;
  try {
    port = Number(readFileSync(path.join(dataDir, 'hook-port'), 'utf8').trim());
  } catch {
    return Promise.resolve(false);
  }
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (up: boolean) => {
      s.destroy();
      resolve(up);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Runs the migration: into the office with --apply, else into scratch copies of it. */
export async function run(args: Args): Promise<MigrationReport> {
  const dataDir = path.join(args.home, '.agent-office');
  const filesDir = path.join(dataDir, 'kanban');
  const legacy = openLegacyDb(args.from);
  let scratch: string | undefined;
  let db: Database.Database | undefined;
  try {
    let workDir = dataDir;
    if (!args.apply) {
      scratch = mkdtempSync(path.join(os.tmpdir(), 'migrate-ai-kanban-'));
      workDir = scratch;
      for (const f of ['floors.json', 'local-floor.json', 'projects-folder.json', 'kanban-settings.json']) if (existsSync(path.join(dataDir, f))) copyFileSync(path.join(dataDir, f), path.join(scratch, f));
      const real = kanbanDbPath(dataDir);
      if (existsSync(real)) {
        // A consistent copy even of a database in WAL mode, read-only.
        const src = new Database(real, { readonly: true, fileMustExist: true });
        try {
          await src.backup(kanbanDbPath(scratch));
        } finally {
          src.close();
        }
      }
    }
    db = openKanbanDb(kanbanDbPath(workDir));
    const repo = new KanbanRepository(db);
    const settings = new KanbanSettingsStore(workDir);
    const building = new Building(workDir, args.home);
    let alias: string | undefined;
    try {
      alias = realpathSync(args.from);
    } catch {
      alias = undefined;
    }
    return migrate(legacy, { repo, settings, building, filesDir, home: args.home, dry: !args.apply }, { from: args.from, map: args.map, withStreamLogs: args.withStreamLogs, ...(alias && alias !== args.from ? { fromAliases: [alias] } : {}) });
  } finally {
    db?.close();
    legacy.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** The report, for a person. */
export function formatReport(r: MigrationReport): string {
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const lines = [
    r.apply ? 'ai-kanban → 3d-kanban: MIGRATED' : 'ai-kanban → 3d-kanban: DRY RUN (nothing written; add --apply to migrate)',
    '',
    `Source: ${r.source.tasks} tasks (${kv(r.source.byStatus)}), ${r.source.comments} comments, ${r.source.logs} logs (${kv(r.source.byLogType)})`,
    '',
    'Projects:',
    ...r.projects.map((p) => `  ${p.action.padEnd(8)} ${p.name}${p.floor ? ` → floor ${p.floor}` : ''} (${p.kind}; ${p.repos} repositories${p.linksAdded ? `, ${p.linksAdded} linked added` : ''}${p.linksMissing ? `, ${p.linksMissing} linked missing` : ''}; ${p.tasks} tasks)`),
    `Repository names on tasks: ${r.repositoryNames.distinct} (${r.repositoryNames.resolved} resolved, ${r.repositoryNames.mapped} by --map, ${r.repositoryNames.unassigned} unassigned)`,
    ...r.repositoryNames.unresolved.map((u) => `  unassigned: ${u.name} (${u.tasks} tasks) — --map ${u.name}=<project> to place them`),
    '',
    `Tasks: ${r.tasks.created} new, ${r.tasks.updated} updated, ${r.tasks.skippedEdited.length} skipped (changed in 3d-kanban${r.tasks.skippedEdited.length ? `: ${r.tasks.skippedEdited.map((n) => `#${n}`).join(', ')}` : ''})`,
    `  columns: ${kv(r.tasks.byStatus)}; tags from custom columns: ${kv(r.tasks.tagged)}; folder tasks ${r.tasks.folderTasks}; tool changed to the default ${r.tasks.toolChanged}`,
    `Comments: ${r.comments.imported} imported, ${r.comments.dedupedConsecutive} repeated system comments and ${r.comments.dedupedFlood} more of a flood dropped; ${r.comments.pathsRewritten} file paths rewritten`,
    `Plans: ${r.plans.imported} versions, ${r.plans.accepted} accepted. Runs rebuilt from comments: ${r.runs.reconstructed} (reviews: ${r.runs.reviews.approved} approved, ${r.runs.reviews.changesRequested} changes requested, ${r.runs.reviews.noVerdict} without a verdict)`,
    `History events: ${r.events.imported}. Stream logs: ${r.streamLogs.written} written, ${r.streamLogs.skipped} skipped${r.streamLogs.skipped ? ' (--with-stream-logs keeps them)' : ''}`,
    `Files: ${r.files.uploads} uploads and ${r.files.reports} report files ${r.apply ? 'copied' : 'to copy'}; ${r.files.descriptionPathsRewritten} paths in descriptions rewritten`,
    `Next new task id: #${r.nextTaskId}`,
    '',
    'Settings applied:',
    ...(r.settings.applied.length ? r.settings.applied.map((s) => `  ${s}`) : ['  none']),
    'For you to decide:',
    ...(r.settings.reported.length ? r.settings.reported.map((s) => `  ${s}`) : ['  nothing']),
    ...(r.warnings.length ? ['', 'Warnings:', ...r.warnings.map((w) => `  ${w}`)] : []),
  ];
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(args);
    return args.startsWith('Usage') ? 0 : 2;
  }
  const dataDir = path.join(args.home, '.agent-office');
  if (await officeRunning(dataDir)) {
    if (args.apply) {
      console.error(`migrate:ai-kanban: the office in ${args.home} is running. Stop it first: the migration writes its floors, database and settings.`);
      return 1;
    }
    console.error(`migrate:ai-kanban: WARNING: the office in ${args.home} is running. This dry run only reads it, but stop it before --apply.`);
  }
  try {
    const report = await run(args);
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (err) {
    console.error(`migrate:ai-kanban: ${(err as Error).message}`);
    return 1;
  }
}

const invoked = process.argv[1] && /migrate-ai-kanban[\\/]index\.[cm]?[tj]s$/.test(process.argv[1]);
if (invoked) process.exitCode = await main(process.argv.slice(2));
