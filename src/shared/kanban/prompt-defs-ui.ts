// The kanban's UI testing prompts: the blocks about before/after images that the implement, review, fix,
// comment and pull-request-fix prompts carry as {{uiTesting}}. prompt-defs.ts spreads them into its DEFS.
// No runtime imports besides the shared placeholders, so shared/prompts.ts can import it without a cycle.

import type { PromptDef } from '../prompts.js';

/** The placeholder the prompts that carry the block share. */
export const UI_TESTING_VAR = { uiTesting: 'The UI testing block (one of the “UI testing” prompts, by the task’s choice and phase); empty when it does not apply' };

const NAMING = `Name each image <subject>-before.png or <subject>-after.png, where <subject> says what the view is (login-form, board-narrow) in lower-case letters, digits, dots, dashes and underscores, up to 80 characters; png, jpg or webp, each under 20 MB. A before and an after of the same view share their subject.`;

const SHOT = `Use the kanban-ui-screenshots skill for the pictures if it is available to you, else whatever the project itself has for looking at its UI (its dev server and a headless browser, its screenshot tests, a storybook). Use test data and test accounts only: the images are kept with the task and may end up in its pull request, so no real people's data, passwords or tokens in them.`;

export const UI_DEFS = {
  'kanban.uiTesting': {
    group: 'kanban',
    label: 'UI testing',
    used: 'Added to the implement prompt when the task has UI testing on (the checkbox in the task, or the project’s or the office’s default). Left empty, nothing is added.',
    vars: { imagesDir: 'The folder the task’s images go in (absolute path)' },
    needs: ['imagesDir'],
    optional: true,
    text: `UI testing is on for this task. If the change alters what a user sees in the app's UI (a page, a dialog, a component, its layout or its styles), save pictures of it for review and the pull request:
1. Before you change any code, take a picture of the view you are about to change, as it is now.
2. After the change works, take a picture of the same view in the same state and size.
3. Save them in {{imagesDir}} (it exists; make it if it does not).
${NAMING}
If the change touches several views, take a pair for each. A view that is new has only an after picture. If the change does not alter the UI, do nothing about pictures.
${SHOT}
If you cannot take a picture (the app does not start, it needs a login you do not have, there is no browser), do not get stuck on it: carry on with the task and say in your summary what you could not capture and why.`,
  },
  'kanban.uiTesting.onRequest': {
    group: 'kanban',
    label: 'UI testing · when asked',
    used: 'Added to the implement prompt, and to comments and pull request fixes, when the task has UI testing off: the agent takes pictures only if the task or a comment asks for UI testing.',
    vars: { imagesDir: 'The folder the task’s images go in (absolute path)' },
    needs: ['imagesDir'],
    optional: true,
    text: `UI testing is off for this task by default. Only if the task's description or a comment on it asks for UI testing, screenshots or before and after pictures, do it: take a picture of the view you are about to change before you change any code, and one of the same view in the same state and size after, and save them in {{imagesDir}} (it exists; make it if it does not).
${NAMING}
${SHOT}
If you cannot take a picture, do not get stuck on it: say in your summary what you could not capture and why. If nobody asked for it, do nothing about pictures.`,
  },
  'kanban.uiTesting.review': {
    group: 'kanban',
    label: 'UI testing · review',
    used: 'Added to the review prompts when the task has UI testing on, or has images already.',
    vars: { imagesDir: 'The folder the task’s images are in (absolute path)', imageList: 'The images there, one per line, by subject; “none yet” when there are none' },
    needs: ['imagesDir'],
    optional: true,
    text: `The implementer may have saved before and after pictures of the UI change in {{imagesDir}}:
{{imageList}}
Look at the ones that are there (open the image files) and check that they show this task's change and that the UI they show is right: nothing broken, cut off, overlapping or unreadable, and the after picture matching what the task asked for. A wrong UI in the pictures is a finding. Pictures that are missing are not: if the change alters the UI and there are none, note it as optional, and do not ask for changes only because of it (the implementer may have had no way to take them). Never modify, move or delete the images.`,
  },
  'kanban.uiTesting.fix': {
    group: 'kanban',
    label: 'UI testing · fixes',
    used: 'Added to the fix, comment and pull request fix prompts when the task has UI testing on, or has images already.',
    vars: { imagesDir: 'The folder the task’s images are in (absolute path)' },
    needs: ['imagesDir'],
    optional: true,
    text: `The task keeps before and after pictures of its UI change in {{imagesDir}}. If what you do now changes how that UI looks, take the after pictures again under the same names (the before pictures stay as they are), and delete the images that no longer apply. If there are no pictures yet and this change alters the UI, save an after picture there, and a before one too if you can still see the old state.
${NAMING}
${SHOT}
If you cannot take a picture, do not get stuck on it: say in your summary what you could not capture and why. If your change does not alter the UI, leave the images alone.`,
  },
} satisfies Record<string, PromptDef>;
