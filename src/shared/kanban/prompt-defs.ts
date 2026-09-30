// The kanban's prefilled prompts: every text the engine sends a task's agents, as upstream PromptDefs
// in the 'kanban' group. shared/prompts.ts spreads them into its DEFS, so they show in the office's
// prompt editor and can be rewritten office-wide; a project can override each one again (see
// resolveKanbanPrompt in ./prompts.ts). The machine-read markers are NOT in these editable texts: they
// are the fixed contract blocks in ./prompts.ts, which the engine appends.
//
// This module imports nothing at runtime, so shared/prompts.ts can import it without a cycle.

import type { PromptDef } from '../prompts.js';

// --- Placeholders several prompts share -----------------------------------------------------------

const TASK_VARS = {
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
const ROUND_VARS = { round: 'The review round, from 1', rounds: 'How many review rounds the task gets' };
const PLAN_VAR = { plan: 'The accepted plan, under a heading; empty when the task ran without a plan' };

const DEFS = {
  'kanban.plan': {
    group: 'kanban',
    label: 'Plan',
    used: "The first turn of a task with planning on. The task's agent runs read-only (Claude in plan mode, Codex in a read-only sandbox); the office appends the fixed plan contract (PLAN READY / QUESTIONS:).",
    vars: TASK_VARS,
    needs: ['description'],
    text: `You are planning kanban task #{{taskId}} in the project {{project}}: {{title}}

{{ticket}}

What the user wants:
{{description}}

{{attachments}}

Your workspace:
{{repos}}

{{instructions}}

{{goal}}

{{taskRefs}}

{{skills}}

This turn is for planning only. Read whatever code, docs and referenced tasks you need, but don't change files, create branches or commit. Then write a plan another developer could follow without you: what changes in which repository and file, in which order, how it will be tested, and what could go wrong. Where something essential is unclear and neither the code nor the referenced tasks answer it, ask rather than guess.

{{language}}`,
  },
  'kanban.replan': {
    group: 'kanban',
    label: 'Plan · answers and change requests',
    used: 'Sent to the planning session when the user answers its questions or asks for changes to the plan. The office appends the plan contract again.',
    vars: { taskId: TASK_VARS.taskId, answer: "The user's answers or requested changes", language: TASK_VARS.language },
    needs: ['answer'],
    text: `The user replied about the plan for task #{{taskId}}:

{{answer}}

Take this into account and write the whole plan again, complete, so it can be read on its own. Still don't change any files.

{{language}}`,
  },
  'kanban.branch': {
    group: 'kanban',
    label: 'Branch naming (default)',
    used: "How the working branch is named when the project's settings give no branch instructions. Goes into the implement prompt's branch step.",
    vars: { taskId: TASK_VARS.taskId, slug: 'A short slug of the title (fix-login-redirect)', ticketId: "The ticket id (UYT-1415), or the task number when there's no ticket" },
    text: 'Name it kanban/{{ticketId}}-{{slug}}, the same name in every repository.',
  },
  'kanban.checkout': {
    group: 'kanban',
    label: "Carry on on the task's branch",
    used: "When a task that already has a branch gets a fresh worktree (its old one was removed, the task was reset, or it was migrated): in place of the implement prompt's branch step, and ahead of any other prompt until the branch is checked out.",
    vars: { taskId: TASK_VARS.taskId, branches: "The task's branch in each repository, one per line" },
    needs: ['branches'],
    text: `The work on task #{{taskId}} is already on its branch:
{{branches}}
You are in a fresh worktree on a new branch the office cut, so before anything else check the task's branch out in each repository of your workspace (git checkout <branch>; when it's only on the remote, git fetch origin <branch> and git checkout -b <branch> origin/<branch>; when git says it's checked out in a worktree that no longer exists, git worktree prune first). Work and commit on it from then on. If a branch exists in neither place, say so, and create it with that name where you are.`,
  },
  'kanban.implement': {
    group: 'kanban',
    label: 'Implement',
    used: 'The implementation turn, in the same session as the plan (or the first turn when planning is off). The office appends the safety contract.',
    vars: {
      ...TASK_VARS,
      ...PLAN_VAR,
      branchInstructions: "The project's branch instructions, or the “Branch naming (default)” prompt",
      ticketId: "The ticket id to put in commit messages, or 'none'",
    },
    needs: ['description', 'branchInstructions'],
    text: `Implement kanban task #{{taskId}} in the project {{project}}: {{title}}

{{ticket}}

What the user wants:
{{description}}

{{attachments}}

{{plan}}

Your workspace (each folder is a git repository of its own):
{{repos}}

1. Before you change anything, create the task's working branch in every repository above. {{branchInstructions}}
2. Make the change, following the project's instructions (below, when it has any).
3. Verify it: run the tests and builds the instructions name, or the project's usual ones, and fix what fails.
4. Commit your work locally in each repository you changed, in small commits with clear messages. When the task has a ticket id, put it in every commit message (ticket: {{ticketId}}).

{{instructions}}

{{goal}}

{{taskRefs}}

{{skills}}

Never push, open pull requests or merge in this turn: that only happens when the user asks for a pull request. When you're done, reply with a short summary: what changed in which repository, how you verified it, and anything left open.

{{language}}`,
  },
  'kanban.implement.folder': {
    group: 'kanban',
    label: 'Implement · folder project',
    used: 'The implementation turn for a project whose repository is a plain folder, not git: no branches or commits.',
    vars: { ...TASK_VARS, ...PLAN_VAR },
    needs: ['description'],
    text: `Do kanban task #{{taskId}} in the project {{project}}: {{title}}

{{ticket}}

What the user wants:
{{description}}

{{attachments}}

{{plan}}

Where you work (plain folders, not git repositories: there are no branches or commits, your edits are the result):
{{repos}}

{{instructions}}

{{goal}}

{{taskRefs}}

{{skills}}

Make the change carefully, since there is no version control to undo it: don't delete or overwrite anything the task doesn't ask for. Check the result the way the instructions say. When you're done, reply with a short summary: which files you changed or created, how you checked them, and anything left open.

{{language}}`,
  },
  'kanban.investigate': {
    group: 'kanban',
    label: 'Investigate',
    used: 'An investigation task: read-only, the findings go to report files in the given folder.',
    vars: { ...TASK_VARS, reportDir: 'The folder the report files go in (absolute path)' },
    needs: ['description', 'reportDir'],
    text: `Investigate kanban task #{{taskId}} in the project {{project}}: {{title}}

{{ticket}}

The question:
{{description}}

{{attachments}}

Where to look:
{{repos}}

{{instructions}}

{{goal}}

{{taskRefs}}

{{skills}}

Don't change anything in the repositories: no edits, branches or commits. Read the code, logs and docs you need and run read-only commands. Write your findings as Markdown files in {{reportDir}} (start with report.md: the answer first, then the evidence with file:line references, then open questions). Reply with a short summary of the answer and the paths of the files you wrote.

{{language}}`,
  },
  'kanban.review': {
    group: 'kanban',
    label: 'Review',
    used: 'A review round, for the reviewer: a separate worker (its own tool, model and effort) in the same workspace, without file-editing tools. The office appends the review contract (REVIEW: APPROVED / CHANGES_REQUESTED).',
    vars: { ...TASK_VARS, ...PLAN_VAR, ...ROUND_VARS },
    needs: ['description'],
    text: `You are reviewing the work done for kanban task #{{taskId}} in the project {{project}}: {{title}}. This is review round {{round}} of {{rounds}}.

{{ticket}}

What the user asked for:
{{description}}

{{attachments}}

{{plan}}

The workspace, with the task's branch in each repository:
{{repos}}

{{instructions}}

{{goal}}

{{taskRefs}}

{{skills}}

Review the task's commits and any uncommitted changes in each repository against where its branch started (git log, git diff). Check that it does what was asked, that it's correct (edge cases, errors, security), that it fits the project's conventions, and that it's tested. Don't change, stage or commit anything, and run only read-only commands. List your findings, the most serious first, each with its file:line, what's wrong and what to do about it. Only ask for changes that matter; note small matters as optional.

{{language}}`,
  },
  'kanban.rereview': {
    group: 'kanban',
    label: 'Review · next round',
    used: "Sent to the reviewer's session for the next round, after the implementer fixed the findings. The office appends the review contract.",
    vars: { taskId: TASK_VARS.taskId, ...ROUND_VARS, fixSummary: "The implementer's reply to the findings", language: TASK_VARS.language },
    needs: ['fixSummary'],
    text: `The implementer of task #{{taskId}} has worked on your findings. Their reply:

{{fixSummary}}

Review the changes again (round {{round}} of {{rounds}}): check that each finding was really fixed or rightly rejected, and that the fixes didn't break anything else. Still don't change any files.

{{language}}`,
  },
  'kanban.fix': {
    group: 'kanban',
    label: 'Fix review findings',
    used: "Sent to the implementer's session when a review round requests changes.",
    vars: { taskId: TASK_VARS.taskId, ...ROUND_VARS, findings: "The reviewer's findings", language: TASK_VARS.language },
    needs: ['findings'],
    text: `The review of task #{{taskId}} (round {{round}} of {{rounds}}) asks for changes:

{{findings}}

Fix every finding that is right, verify the result again, and commit locally in each repository you change (never push). If you think a finding is wrong, don't change the code for it: say why. Reply with what you did about each finding.

{{language}}`,
  },
  'kanban.resume': {
    group: 'kanban',
    label: 'Comment for the agent',
    used: "A user's comment on a task that has already been worked on, typed into the agent's session (or a resumed one).",
    vars: { taskId: TASK_VARS.taskId, author: 'Who wrote the comment', message: 'The comment', attachments: TASK_VARS.attachments, language: TASK_VARS.language },
    needs: ['message'],
    text: `{{author}} commented on task #{{taskId}}:

{{message}}

{{attachments}}

Do what the comment asks. Commit any changes locally as before (never push unless the comment asks for a pull request). Reply with a short summary of what you did.

{{language}}`,
  },
  'kanban.goal': {
    group: 'kanban',
    label: 'Acceptance criteria',
    used: 'Added to the plan, implement, review and investigate prompts when a task has acceptance criteria. Left empty, criteria are not sent.',
    vars: { criteria: 'The criteria, as the user wrote them' },
    needs: ['criteria'],
    optional: true,
    text: `Acceptance criteria — the task is done only when all of these hold. Check each one before you finish and say how you checked it:
{{criteria}}`,
  },
  'kanban.pr.create': {
    group: 'kanban',
    label: 'Open pull requests',
    used: "What “O” and the task's PR action send: the agent pushes and opens (or updates) a pull request in every repository of the task (or of the worker's workspace, for an office worker) that has commits. The office appends the PR contract (PR: lines).",
    vars: {
      subject: "What the pull requests are for: “kanban task #12: Fix the login redirect” for a task, “your current work (…)” for an office worker at its desk",
      taskId: "The task number, or '-' for an office worker that has no task",
      title: "The task's title, or the worker's current task",
      ticket: TASK_VARS.ticket,
      ticketId: "The ticket id, or 'none'",
      repos: TASK_VARS.repos,
      summary: 'What the task did (its latest summary) under a heading; empty when there is none',
      skills: TASK_VARS.skills,
      language: TASK_VARS.language,
    },
    needs: ['repos'],
    text: `Open the pull requests for {{subject}}

{{ticket}}

The workspace:
{{repos}}

{{summary}}

{{skills}}

In every repository above whose working branch has commits the base branch doesn't: commit anything still uncommitted that belongs to the work, push the branch, and open a pull request against the base branch, or, when the branch already has an open one, update its title and description instead of opening another. Give each a clear title (with the ticket id when there is one: {{ticketId}}) and a description of what changed and why, how it was tested, and anything reviewers should look at. When there is more than one pull request, list all of them in each one's description so they're reviewed and merged together. Write the titles and descriptions in the same language as the task. Skip repositories with nothing to push, and don't merge anything.

{{language}}`,
  },
  'kanban.pr.fix': {
    group: 'kanban',
    label: 'Fix pull request comments',
    used: "Sent when the user asks the task's agent to address its pull requests' open review threads.",
    vars: { taskId: TASK_VARS.taskId, prs: "The task's open pull requests, one per line (repository and URL)", repos: TASK_VARS.repos, language: TASK_VARS.language },
    needs: ['prs'],
    text: `Address the open review comments on the pull requests of task #{{taskId}}:
{{prs}}

The workspace:
{{repos}}

Read each pull request's unresolved review threads and comments (gh pr view <url> --comments, and gh api repos/<owner>/<repo>/pulls/<number>/comments for the ones on lines of code). Fix what the reviewers are right about, verify the result, commit and push to the same branch. Reply on each thread with what you did, or why you didn't change it. Handle only the open review comments: nothing else, and don't merge.

{{language}}`,
  },
  'kanban.pr.review': {
    group: 'kanban',
    label: 'Review pull requests together',
    used: "Sent to a reviewer hired for several pull requests at once (picked across the project's repositories, or a task's bundle): they are reviewed as one change set.",
    vars: {
      prs: 'The pull requests, one per line: owner/repo#number, its URL and its branch',
      project: TASK_VARS.project,
      task: 'A line naming the kanban task they belong to (its number and title); empty when they are not one task’s',
      repos: "The reviewer's own worktrees of the repositories, for reading the code around the changes",
      language: TASK_VARS.language,
    },
    needs: ['prs'],
    text: `Review these pull requests in the project {{project}} together, as one change set:
{{prs}}

{{task}}

Your workspace, fresh worktrees of the repositories for reading the code around the changes (the pull requests' own code is in gh pr diff, not here):
{{repos}}

They belong together: one change spread over several repositories. Read each one (gh pr view <url> --comments, gh pr diff <url>) and check the change as a whole: that the parts fit each other (APIs, data shapes, config and migrations match on both sides, nothing one side needs is missing from the other), that each part is correct (edge cases, errors, security), tested, and fits its repository's conventions, and that they can be merged and deployed in some safe order. Don't check out, change, push or merge anything.

Reply with your findings, the most serious first, each with its repository, file:line, what's wrong and what to do about it; then which order to merge them in, and whether you would approve the set as it is.

{{language}}`,
  },
  'kanban.continue': {
    group: 'kanban',
    label: 'Carry on after an interruption',
    used: "Typed into a task's agent session when its turn was cut short (a usage limit, a lost connection, a stop, an office restart) and it's put back to work. The office appends the phase's contract again.",
    vars: { taskId: TASK_VARS.taskId, language: TASK_VARS.language },
    text: `Your last turn on task #{{taskId}} was cut short before you finished. Carry on from where you left off and finish what that turn was for; check first what is already done (git status, git log) so nothing is done twice.

{{language}}`,
  },
  'kanban.compact': {
    group: 'kanban',
    label: 'Compact the session',
    used: "Typed into the task's agent session to compact its context (both Claude and Codex take /compact).",
    vars: {},
    text: '/compact Keep the task, the accepted plan, the decisions made so far, what is done and what is still left.',
  },
  'kanban.language': {
    group: 'kanban',
    label: 'Language',
    used: 'Added at the end of every kanban prompt.',
    vars: {},
    optional: true,
    text: "Write your replies, plans, summaries and pull request texts in the language the task is written in (Finnish for a task in Finnish, for example), unless the project's instructions say otherwise. Code, identifiers and commit messages follow the project's own conventions.",
  },
  'kanban.taskRefs': {
    group: 'kanban',
    label: 'Reading other tasks',
    used: 'Added to the plan, implement, review and investigate prompts: how an agent reads another kanban task the task refers to.',
    vars: { taskId: TASK_VARS.taskId, refsFile: 'A line naming the file the referenced tasks were fetched into before the turn; empty when none were referenced' },
    optional: true,
    text: `The task may refer to other kanban tasks (#14, "task 14", "tehtävä 14", a ticket id). Don't guess what they contain: read them with \`office-tasks get 14\` (on your PATH), the agent-office MCP tool get_task, or \`curl -s "$AIKANBAN_API_BASE/api/tasks/reference?ref=14"\`. Your own task is #{{taskId}}.
{{refsFile}}`,
  },
  'kanban.handoff': {
    group: 'kanban',
    label: 'Handoff to a new session',
    used: "The first message of a fresh session that takes a task over: a switch of tool, a session that couldn't be resumed, or a migrated task.",
    vars: {
      taskId: TASK_VARS.taskId,
      title: TASK_VARS.title,
      description: TASK_VARS.description,
      project: TASK_VARS.project,
      status: 'Where the task is: its column and phase',
      ...PLAN_VAR,
      summary: "The task's latest summary, under a heading; empty when there's none",
      recent: 'The latest comments, oldest first; empty when there are none',
      repos: TASK_VARS.repos,
      language: TASK_VARS.language,
    },
    needs: ['description'],
    text: `You are taking over kanban task #{{taskId}} in the project {{project}}: {{title}}. Someone worked on it before you in another session; this is what you need to carry on.

What the user wants:
{{description}}

Where it is: {{status}}

{{plan}}

{{summary}}

{{recent}}

Your workspace, with the work so far on the task's branch:
{{repos}}

Look at the branch's commits and uncommitted changes (git log, git status, git diff) before you do anything, so you know what is already done. Then wait for the next instruction, which follows.

{{language}}`,
  },
} satisfies Record<string, PromptDef>;

/** The kanban's prompts, by id, with their defaults (spread into shared/prompts.ts's DEFS). */
export const KANBAN_PROMPT_DEFS = DEFS;
export type KanbanPromptId = keyof typeof DEFS;
export const KANBAN_PROMPT_IDS = Object.keys(DEFS) as KanbanPromptId[];
