// Syncs the repository's user-skills/ into the machine's Claude and Codex homes when the server
// starts (see ./sync.ts). AGENT_OFFICE_USER_SKILLS=off turns it off; an agent's worktree
// (.agent-office/worktrees/) skips it unless it is =on, so a branch's skills don't overwrite the
// ones of the main checkout.

import path from 'node:path';
import type { KanbanPlugin } from '../../registry.js';
import type { KanbanContext } from '../../registry.js';
import type { SyncResult } from '../skills/delivery.js';
import { defaultRoots } from '../skills/registry.js';
import { logResults, syncUserSkills, userSkillsDir } from './sync.js';

export interface UserSkillsOptions {
  homes?: () => { source?: string; claudeHome: string; codexHome: string };
}

/** The sync without the start-up guards (the admin's 🔄 Sync): [] when there's no user-skills/ folder. */
export function syncUserSkillsNow(homes: { source?: string; claudeHome: string; codexHome: string }): SyncResult[] {
  const source = homes.source ?? userSkillsDir();
  return source ? syncUserSkills({ source, claudeHome: homes.claudeHome, codexHome: homes.codexHome }) : [];
}

export function createUserSkillsPlugin(ctx: KanbanContext, opts: UserSkillsOptions = {}): KanbanPlugin {
  return {
    name: 'user-skills',
    start() {
      try {
        const mode = process.env.AGENT_OFFICE_USER_SKILLS;
        if (mode === 'off') {
          console.log('agent-office: user skills sync is off (AGENT_OFFICE_USER_SKILLS=off)');
          return;
        }
        const homes = opts.homes ? opts.homes() : { ...defaultRoots(ctx.dataDir, []), source: userSkillsDir() };
        if (!homes.source) {
          console.warn('agent-office: user-skills/ not found, its skills were not synced');
          return;
        }
        if (mode !== 'on' && homes.source.includes(`${path.sep}.agent-office${path.sep}worktrees${path.sep}`)) {
          console.log('agent-office: user skills sync skipped (worktree; AGENT_OFFICE_USER_SKILLS=on forces it)');
          return;
        }
        logResults(syncUserSkillsNow(homes));
      } catch (err) {
        console.warn('agent-office: user skills sync failed:', (err as Error).message);
      }
    },
  };
}
