// The kanban's settings defaults, for the page's fallbacks: before the settings have loaded, and for
// a number box left empty. They mirror src/server/kanban/settings.ts (defaultKanbanSettings,
// DEFAULT_REVIEW, defaultProjectSettings), which the browser can't import (it reads files with
// node:fs); tests/kanban-ui-defaults.test.ts fails when the two drift apart.

import type { KanbanSettings, ProjectSettings, ReviewSettings } from '../../shared/kanban/types.js';

/** DEFAULT_REVIEW. */
export const REVIEW_DEFAULTS: Readonly<ReviewSettings> = { tool: 'claude', rounds: 2, reReviewLastFix: false, sandbox: true };

/** defaultKanbanSettings(), without schemaVersion and projects. */
export const KANBAN_DEFAULTS: Readonly<Pick<KanbanSettings, 'defaults' | 'review' | 'autoResume' | 'archiveAfterDays'>> = {
  defaults: { tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, implementPermission: 'bypass' },
  review: REVIEW_DEFAULTS,
  autoResume: { enabled: true, maxAttempts: 5, maxWaitHours: 6 },
  archiveAfterDays: 30,
};

/** defaultProjectSettings(), a fresh copy each time. */
export function projectDefaults(): ProjectSettings {
  return { branchInstructions: '', generalInstructions: '', testingInstructions: '', maxConcurrent: 2, issueSources: [], prompts: {}, skills: {} };
}
