// The kanban's project-instructions prompts: the {{instructions}} block of the task prompts and its parts, as
// references to the instruction files (or as text, when a file could not be written). prompt-defs.ts spreads them into its DEFS.
// No runtime imports besides the shared placeholders, so shared/prompts.ts can import it without a cycle.

import type { PromptDef } from '../prompts.js';

export const INSTRUCTION_DEFS = {
  'kanban.instructions': {
    group: 'kanban',
    label: "Project's instructions",
    used: "The {{instructions}} of the task prompts, when the project's kanban settings or its repositories have instructions. Each part is one of the prompts below: a reference to the file that holds the instructions, or the text itself when that file could not be written.",
    vars: { parts: 'The general, testing and per-repository instructions, each as a reference to its file (or as text under its own heading)' },
    needs: ['parts'],
    text: `The project's instructions (the files named here are kept up to date by the office: read them again at any time):

{{parts}}`,
  },
  'kanban.instructions.general.file': {
    group: 'kanban',
    label: "Project's instructions · general (file)",
    used: "The general instructions from the project's kanban settings, as a part of the project's instructions: a reference to the file that holds them.",
    vars: { path: 'The path of the file' },
    needs: ['path'],
    text: `General: the project's general instructions are in \`{{path}}\`. Read it now, before anything else, and follow it in all your work; read it again whenever you are unsure what the project expects.`,
  },
  'kanban.instructions.testing.file': {
    group: 'kanban',
    label: "Project's instructions · testing (file)",
    used: "The testing instructions from the project's kanban settings, as a part of the project's instructions: a reference to the file that holds them.",
    vars: { path: 'The path of the file' },
    needs: ['path'],
    text: `Testing and verifying: the instructions are in \`{{path}}\`. Read it again every time before you test, debug or verify anything.`,
  },
  'kanban.instructions.repo.file': {
    group: 'kanban',
    label: "Project's instructions · a repository's (file)",
    used: "A repository's own instructions (from the project's repositories), as a part of the project's instructions: a reference to the file that holds them.",
    vars: { repo: "The repository's name", path: 'The path of the file' },
    needs: ['repo', 'path'],
    text: `In {{repo}}: read \`{{path}}\` before you work in {{repo}}.`,
  },
  'kanban.instructions.general': {
    group: 'kanban',
    label: "Project's instructions · general (text)",
    used: "The general instructions from the project's kanban settings, as a part of the project's instructions, as text: used only when their file could not be written.",
    vars: { text: 'The instructions' },
    needs: ['text'],
    text: `General:
{{text}}`,
  },
  'kanban.instructions.testing': {
    group: 'kanban',
    label: "Project's instructions · testing (text)",
    used: "The testing instructions from the project's kanban settings, as a part of the project's instructions, as text: used only when their file could not be written.",
    vars: { text: 'The instructions' },
    needs: ['text'],
    text: `Testing and verifying:
{{text}}`,
  },
  'kanban.instructions.repo': {
    group: 'kanban',
    label: "Project's instructions · a repository's (text)",
    used: "A repository's own instructions (from the project's repositories), as a part of the project's instructions, as text: used only when their file could not be written.",
    vars: { repo: "The repository's name", text: 'The instructions' },
    needs: ['text'],
    text: `In {{repo}}:
{{text}}`,
  },
} satisfies Record<string, PromptDef>;
