// The agent adapter of each tool the kanban drives (docs/kanban-architecture.md §4): a record, so a tool added to KanbanTool must have one.

import type { KanbanTool } from '../../../../shared/kanban/types.js';
import { antigravityAdapter } from './antigravity.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import type { TaskAgentAdapter } from './types.js';

export const ADAPTERS: Record<KanbanTool, TaskAgentAdapter> = { claude: claudeAdapter, codex: codexAdapter, antigravity: antigravityAdapter };
