// How a worker's phases run, by phase group: the values the settings take and what each means for each agent.
// Review phases (review, pr-review) are not here: they keep their own fixed flags.

/** How the plan phase runs: Claude's auto mode with the file editing tools off, or Claude's plan mode. */
export type PlanPermission = 'auto' | 'plan';
/** How implement/fix/resume/pr phases run. */
export type ImplementPermission = 'auto' | 'bypass' | 'workspace-write';
export const PLAN_PERMISSIONS: readonly PlanPermission[] = ['plan', 'auto'];
export const IMPLEMENT_PERMISSIONS: readonly ImplementPermission[] = ['auto', 'bypass', 'workspace-write'];

interface PermissionInfo {
  name: string;
  claude: string;
  codex: string;
  antigravity: string;
}

/** What a value is called in the UI and what it means for each agent. */
export const PLAN_PERMISSION_INFO: Record<PlanPermission, PermissionInfo> = {
  auto: { name: 'auto mode', claude: 'auto mode, with the file editing tools off', codex: 'read-only sandbox', antigravity: 'no sandbox: all permissions, with plan mode added (advisory)' },
  plan: { name: 'plan mode', claude: 'Claude’s plan mode', codex: 'read-only sandbox', antigravity: 'no sandbox: all permissions, with plan mode added (advisory)' },
};

export const IMPLEMENT_PERMISSION_INFO: Record<ImplementPermission, PermissionInfo> = {
  auto: { name: 'auto mode', claude: 'auto mode: a classifier reviews risky actions', codex: 'no auto mode: runs without permission prompts', antigravity: 'no sandbox: runs with all permissions' },
  bypass: { name: 'without permission prompts', claude: 'bypass mode', codex: 'no approvals, no sandbox', antigravity: 'no sandbox: runs with all permissions' },
  'workspace-write': { name: 'in Codex’s workspace sandbox', claude: 'bypass mode (the sandbox is Codex’s)', codex: 'workspace sandbox, no network', antigravity: 'no sandbox it can rely on: runs with all permissions' },
};
