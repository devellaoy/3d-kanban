// What each agent CLI the kanban drives is called, for the board and the office's own notes alike.

import type { KanbanTool } from './types.js';

export const KANBAN_TOOL_NAMES: Record<KanbanTool, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
