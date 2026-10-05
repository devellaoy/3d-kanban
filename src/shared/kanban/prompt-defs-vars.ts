// Placeholders several kanban prompts share (prompt-defs.ts and prompt-defs-pr.ts); no runtime imports, like them.

export const TASK_VARS = {
  taskId: 'The task number (123, shown as #123)',
  title: "The task's title",
  description: "The task's description, as the user wrote it",
  project: "The project's name",
  ticket: 'A line naming the ticket and its link, when the task has one; empty otherwise',
  attachments: 'A list of the files attached to the task, with their paths on this machine; empty when there are none',
  repos: "The repositories in the agent's workspace: each one's folder, what it is and its branch",
  instructions: "The project's general and testing instructions under a heading, when it has any (from its kanban settings); empty otherwise",
  goal: 'The acceptance criteria block (the “Acceptance criteria” prompt), when the task has criteria; empty otherwise',
  taskRefs: 'How to read other tasks (the “Reading other tasks” prompt)',
  skills: 'The skills picked for this phase in the project settings, as a line to use them; empty when none are picked',
  language: 'The language rule (the “Language” prompt)',
};
