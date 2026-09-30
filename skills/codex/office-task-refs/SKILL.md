---
name: office-task-refs
description: Read another kanban task of this office when the task you are working on refers to one ("#14", "task 14", "tehtävä 14", a ticket id such as UYT-1415, or a task named by its title). Use it whenever the task or a comment builds on another task's plan, changes, review, branch or report, so you work from that task's real data instead of guessing.
---

# Reading other kanban tasks

You work in a 3d-kanban office. Tasks often build on each other: "do it the way #14 planned",
"like we did in tehtävä 17", "the rest of UYT-1415". When the task, its plan or a comment points
at another task, fetch that task and read it before you rely on anything about it.

## How to fetch one

Pick the first of these that works where you are:

1. The MCP tool `get_task` of the `agent-office` server (Codex lists it among your tools), with `ref` set to the task's number,
   ticket id or a piece of its title. `search_tasks` finds tasks by words.
2. The command on your PATH:
   ```bash
   office-tasks get 14            # by number (14 or #14)
   office-tasks get UYT-1415      # by ticket id
   office-tasks get "login fix"   # by part of the title (quote it)
   office-tasks get 14 --tail     # also the end of its worker's terminal
   office-tasks search webhook    # find tasks
   ```
3. Plain HTTP, for scripts that already speak ai-kanban's API:
   ```bash
   curl -s "$AIKANBAN_API_BASE/api/tasks/reference?ref=14"
   ```
   (URL-encode a title: `ref=login%20fix`.)

Turn phrases into a reference first: "tehtävä 14" and "task #14" are `14`.

`AIKANBAN_TASK_ID` is your own task's number. Don't fetch it as if it were the other task,
unless you really need your own task's data (a fresh session picking a task up, for example).

## Planning in read-only mode

In a read-only plan phase you may not be able to run commands. Tasks the description names by
number or ticket id are then fetched for you beforehand: the prompt names a
`referenced-tasks.md` file. Read that file. If a task you need isn't in it, say so plainly and
read it later, when you can run commands. Never make up what it says.

## Is it a task, or a GitHub issue or PR?

`#12` can also be a GitHub pull request or issue. "PR #12", "issue #12" and links to GitHub are
GitHub: use `gh`. "Task 12", "tehtävä 12" and talk about another task's plan or review are the
kanban. When you can't tell, fetch the task, and fall back to GitHub if nothing fits. Say which
you picked.

## What you get

- One match: the task in full. Several: a list of candidates; ask again with the right number
  (the most recently updated one is usually meant; ask the user if you really can't tell).
  None: say the task wasn't found.
- `status`: todo (not started), in_progress, waiting (for the user), review (finished, being
  checked), done, archived. Work that isn't done yet can still change.
- `type`: `investigate` tasks deliver their summary, comments and report files, not code;
  `implement` tasks deliver code on their branches.
- `acceptedPlan`: the plan the user accepted. Usually what "do it like #14 planned" means.
- `runs`: each phase that ran, with review verdicts and summaries. `comments`: the latest
  conversation, oldest first; later comments overrule earlier ones.
- `repos` with their `branch`, and `prs`: where the code is. In the same repository,
  `git log <base>..<branch>` and `git diff <base>...<branch>` show what was really done.
- `reportFiles`: absolute paths of files an investigation wrote. Read them directly.

## Leave something the next task can read

- In an investigation, save reports in the report folder your prompt names, not in a temporary
  folder or inside a repository.
- In an implementation, what lasts belongs in the repository, committed on the task's branch.
- When you write a plan into a file, end your reply with its absolute path.
