# Repositories on Azure DevOps and Bitbucket

Back to the [README](../README.md).

A project's repositories don't have to be on GitHub. The office reads where each one is from its
`origin` remote, so one project can mix hosts:

| Host | Remotes it recognises |
|---|---|
| GitHub | `https://github.com/owner/repo`, `git@github.com:owner/repo` |
| Azure DevOps (Azure Repos) | `https://dev.azure.com/org/project/_git/repo`, `git@ssh.dev.azure.com:v3/org/project/repo`, `https://org.visualstudio.com/[DefaultCollection/]project/_git/repo` |
| Bitbucket Cloud | `https://bitbucket.org/workspace/repo`, `git@bitbucket.org:workspace/repo` |
| Bitbucket Server / Data Center | recognised only on a host an admin lists (see [Bitbucket Server](#bitbucket-server-and-data-center)); not supported yet |

GitHub works exactly as before, through `gh`. For the other hosts, the office uses their REST APIs
with a token. It doesn't need the `az` CLI or any Bitbucket tool.

## What works where

| | GitHub | Azure DevOps | Bitbucket Cloud |
|---|---|---|---|
| **O** at a desk, and a task's 🔀 Create PRs (the agent opens the PR) | `gh` | `office-pr` | `office-pr` |
| **O** on a 🐚 shell worker, and the Changes window's PR (the office opens it) | ✅ | ✅ | ✅ |
| The 🔀 PR board, PR states on kanban tasks, a task following its PR to merged | ✅ | ✅ | ✅ |
| Checks and reviews on the board | ✅ | statuses, votes | build statuses, approvals |
| The PR window | everything | description, checks, comments, commenting | description, checks, comments, commenting |
| Merging, closing, labels from the office | ✅ | do it on Azure DevOps | do it on Bitbucket |
| Fix PRs, Resolve conflicts, 🔍 Review (kanban) | ✅ | ✅ (the agent uses `office-pr`) | ✅ (the agent uses `office-pr`) |
| 🤝 Review panel | ✅ | the review is posted as a comment | the review is posted as a comment |
| Closing the ticket on merge | `Closes #12` | an Azure Boards work item is completed (below) | a Jira key goes in the title and branch, as before |
| Issues | the repository's issues | Azure Boards as an issue source | Jira (an issue source) |

## Tokens

Open **☰ → 🔐 Your sign-ins**. Below Claude and GitHub there is a card for each host:

- **Azure DevOps**: a personal access token (dev.azure.com → User settings → Personal access tokens)
  with **Code (Read & write)** and **Work Items (Read & write)**. Pick the organisation the projects are
  in, or all accessible organisations.
- **Bitbucket**: an Atlassian API token *with scopes*
  (id.atlassian.com → Security → API tokens → *Create API token with scopes* → Bitbucket) and the
  e-mail of your Atlassian account. Scopes: `read:repository:bitbucket`, `write:repository:bitbucket`,
  `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` and `read:user:bitbucket`. (Bitbucket's
  app passwords are gone.)

The office checks a token with the host when you save it, and shows whom it belongs to. The token
itself never goes back to a browser.

- **Yours** is what the office acts with when you click (opening a PR from a shell worker or the
  Changes window, commenting in the PR window, an Azure Boards card's status, comments and assignee),
  and what your workers' `office-pr` uses. Pull requests and comments show up under your name.
- **The office's own** (admins set it under the same card) is for everyone who has none of their own,
  and for the PR board and the issue sources, which nobody in particular asks for. Without it, those
  read with the token of the account that saved one most recently. An office without accounts (just
  you, on the shared password) uses only the office's own.

When a token is missing, the action says so and opens 🔐 Your sign-ins.

**Pushing over HTTPS.** Each account's git config has the office's credential helper
(`office-git-credential`) for `dev.azure.com`, `*.visualstudio.com` and `bitbucket.org`, so a push from
a worker or the office uses the same token: yours, else the office's. Remotes over SSH keep using the
machine's SSH keys. Without accounts, the machine's own git credentials are used, as before.

Where they are kept: `<data>/homes/<account>/hosting.json` (yours) and `<data>/hosting-secrets.json`
(the office's), both mode 600. Revoking an account deletes its folder.

## office-pr: pull requests for agents

`gh` doesn't work on Azure DevOps or Bitbucket, so every worker has `office-pr` on its PATH. Run it
inside a checkout of the worker's own workspace:

```
office-pr create --title "…" --body-file pr.md [--base main] [--draft]   # prints PR: <url>
office-pr view [<number>] [--comments]
office-pr checks [<number>]
office-pr diff [<number>]
office-pr comment <number> --body-file reply.md
office-pr list [--all] [--head <branch>]
```

`create` opens the current branch's pull request (push the branch first), or updates the title and
description of the one it already has. Without a number, the other commands mean the current
branch's pull request. `office-pr` asks the office through the hook server, and the office talks to
the host with the credentials of the account the worker runs as, so the token never reaches the worker.
On a GitHub repository it says to use `gh`.

The kanban's prompts add a note about `office-pr` (the *Repositories on Azure DevOps and Bitbucket*
prompt, editable) after the workspace lines, only when a repository of the task or worker is
elsewhere. A GitHub project's prompts are unchanged.

## Azure Boards

**As an issue source.** ⚙️ Settings → 📁 Projects → 📌 Issue sources → **＋ Azure Boards**:
organisation, project, assignee (`@Me` or a name or e-mail), work item types, area path, whether to
include completed ones, and an extra WIQL condition. Cards are keyed `ab:org/project#123`. Their
window changes the status (the work item type's own states), comments and the assignee, as you.
The source reads with the office's Azure DevOps token (or an account's, see above).

**Closing it on merge.** A task whose ticket is a work item (made from an Azure Boards card, or
`office-tasks create --ticket ab:org/project#123`):

1. The *Open pull requests* prompt asks for `AB#123` in the description of each pull request on Azure
   DevOps (the *Pull requests · linking the work item* prompt).
2. `office-pr create` links the work item to the pull request it opens, and sets *complete linked work
   items* on it. So does any `AB#n` in its title or description.
3. On each board refresh, a task's open pull request on Azure DevOps that isn't linked to the work item
   yet (one opened another way) is linked. Once one of them merges, the office moves the work item to
   its type's *Completed* state (Done, Closed, …), unless Azure DevOps already did. Each step goes on the
   task as a status comment, and happens once.

Only work items in the same organisation as the repository are linked.

## Bitbucket Server and Data Center

Not supported yet. An admin can list the hosts (`hosting-secrets.json`'s `servers`, or the
`hosting.servers` message) so their remotes are recognised. The boards then say the host isn't
supported, rather than showing a `gh` error.

## Limitations

- The board's merge and close buttons, labels and the diff tab are GitHub's: on the other hosts, open
  the pull request there (the window's footer links to it).
- Upstream's PR-window prompts (*Fix comments & merge*, *Fix conflicts & merge*) use `gh` and are hidden
  for pull requests elsewhere. The kanban's Fix PRs and Resolve conflicts work.
- A worker across repositories on two different hosts opens its pull requests with the token of the
  host of the floor's own repository; the others fail with a message.
- Azure DevOps doesn't link a work item that isn't in the repository's organisation.
