// The categories down the side of ⚙️ Settings (ui/settings.ts), in their own file so the window's
// file stays short: the window's, then each feature's own panes (the kanban's, multiplayer's).
import { KANBAN_PANES, type KanbanSettingsPane } from '../kanban/settingsslot';
import { MULTIPLAYER_PANES, type MultiplayerSettingsPane } from '../multiplayer/settingsslot';

/** The categories down the side of ⚙️ Settings. */
export type SettingsPane = 'you' | 'sound' | 'notify' | 'building' | 'workers' | KanbanSettingsPane | MultiplayerSettingsPane;

export const PANES: { id: SettingsPane; icon: string; label: string; blurb: string }[] = [
  { id: 'you', icon: '🧍', label: 'You', blurb: 'How you look, how you see the office, and how you’re signed in.' },
  { id: 'sound', icon: '🔊', label: 'Sound & voice', blurb: 'How loud the office is for you, and how voice chat works.' },
  { id: 'notify', icon: '🔔', label: 'Notifications', blurb: 'Hear about a worker that needs someone, or finished, while you’re somewhere else.' },
  { id: 'building', icon: '🏢', label: 'Building', blurb: 'The map, the decorations, the sky, the dog, and where new floors are cloned.' },
  { id: 'workers', icon: '🤖', label: 'Workers', blurb: 'What workers start on, how many run at once, when they go home and what the office tells them.' },
  ...KANBAN_PANES, // 🗂️ Kanban, 📁 Projects
  ...MULTIPLAYER_PANES, // 🌐 Multiplayer
];
