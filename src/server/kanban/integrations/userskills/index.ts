// Syncs the repository's user-skills/ into the machine's Claude and Codex homes when the server
// starts (see ./sync.ts) and on the admin's 🔄 Sync (through the skills integration's onSkillsSync).
// AGENT_OFFICE_USER_SKILLS=off turns both off; a source in a linked git worktree (an agent's checkout)
// is skipped unless it is =on, so a branch's skills don't overwrite the ones of the main checkout.

import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import type { SyncResult } from '../skills/delivery.js';
import { onSkillsSync } from '../skills/index.js';
import { defaultRoots } from '../skills/registry.js';
import { logResults, syncUserSkills, userSkillsDir } from './sync.js';

export interface UserSkillsHomes {
  source?: string;
  claudeHome: string;
  codexHome: string;
}

export interface UserSkillsOptions {
  homes?: () => UserSkillsHomes;
}

/** True when `source` lies in a linked git worktree: the first `.git` above it is a file. A main checkout (a folder) and an install without git are not. */
export function inLinkedWorktree(source: string): boolean {
  for (let dir = path.resolve(source); ; dir = path.dirname(dir)) {
    const g = path.join(dir, '.git');
    if (existsSync(g)) return lstatSync(g).isFile();
    if (path.dirname(dir) === dir) return false;
  }
}

/** The sync behind AGENT_OFFICE_USER_SKILLS=off and the linked-worktree guard (=on lifts the guard). [] when it is off or skipped, or there's no user-skills/ folder. */
export function syncUserSkillsNow(homes: UserSkillsHomes): SyncResult[] {
  const mode = process.env.AGENT_OFFICE_USER_SKILLS;
  if (mode === 'off') {
    console.log('agent-office: user skills sync is off (AGENT_OFFICE_USER_SKILLS=off)');
    return [];
  }
  const source = homes.source ?? userSkillsDir();
  if (!source) {
    console.warn('agent-office: user-skills/ not found, its skills were not synced');
    return [];
  }
  if (mode !== 'on' && inLinkedWorktree(source)) {
    console.log('agent-office: user skills sync skipped (git worktree; AGENT_OFFICE_USER_SKILLS=on forces it)');
    return [];
  }
  return syncUserSkills({ source, claudeHome: homes.claudeHome, codexHome: homes.codexHome });
}

export function createUserSkillsPlugin(ctx: KanbanContext, opts: UserSkillsOptions = {}): KanbanPlugin {
  const homes = (): UserSkillsHomes => (opts.homes ? opts.homes() : { ...defaultRoots(ctx.dataDir, []), source: userSkillsDir() });
  let unhook: (() => void) | undefined;
  return {
    name: 'user-skills',
    start() {
      unhook = onSkillsSync(() => syncUserSkillsNow(homes()));
      // Not on the start-up path: copying files shouldn't hold the server's start.
      setImmediate(() => {
        try {
          logResults(syncUserSkillsNow(homes()));
        } catch (err) {
          console.warn('agent-office: user skills sync failed:', (err as Error).message);
        }
      });
    },
    stop() {
      unhook?.();
      unhook = undefined;
    },
  };
}
