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
| Checks and reviews on the board | ✅ | statuses and branch policies (build validation, required statuses: a posted status shows the policy's state when that is worse), votes | build statuses, approvals |
| The PR window | everything | description, checks, comments, commenting, the diff | description, checks, comments, commenting, the diff |
| Merging, closing, labels from the office | ✅ | do it on Azure DevOps | do it on Bitbucket |
| Fix PRs, Resolve conflicts, 🔍 Review (kanban) | ✅ | ✅ (the agent uses `office-pr`) | ✅ (the agent uses `office-pr`) |
| 🤝 Review panel | ✅ | the review is posted as a comment | the review is posted as a comment |
| Closing the ticket on merge | `Closes #12` | an Azure Boards work item is completed (below) | a Jira key goes in the title and branch, as before |
| Issues | the repository's issues | Azure Boards as an issue source | Jira (an issue source) |

## Tokens

Open **☰ → 🔐 Your sign-ins**. Below Claude and GitHub there is a card for each host:

- **Azure DevOps**: an organisation-scoped personal access token (dev.azure.com → User settings →
  Personal access tokens) with **Code (Read & write)** and **Work Items (Read & write)**, and the name of
  its organisation (`dev.azure.com/<organisation>`). The office checks the token there (the
  organisation's `connectionData`: Azure DevOps' Profiles API doesn't take PATs). Global PATs stop
  working on 1 December 2026, and a PAT reaches only its own organisations, so keep the projects of
  one office in one organisation, or use a token for each.
- **Bitbucket**: an Atlassian API token *with scopes*
  (id.atlassian.com → Security → API tokens → *Create API token with scopes* → Bitbucket) and the
  e-mail of your Atlassian account. Scopes: `read:repository:bitbucket`, `write:repository:bitbucket`,
  `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`, `read:user:bitbucket` and
  `read:workspace:bitbucket` (who is a workspace member, for whose review comments count). (Bitbucket's
  app passwords are gone.)

The office checks a token with the host when you save it, and shows whom it belongs to. The token
itself never goes back to a browser.

- **Yours** is what the office acts with when you click (opening a PR from a shell worker or the
  Changes window, commenting in the PR window, an Azure Boards card's status, comments and assignee),
  and what your workers' `office-pr` uses. Pull requests and comments show up under your name.
- **The office's own** (admins set it under the same card) is for everyone who has none of their own,
  and for the PR board, the issue sources and the office's fetches, which nobody in particular asks
  for. Those read with the office's own only, never with somebody's personal token: what one person
  can see isn't everybody's to see. Without it, the PR board and the Azure Boards sources say so. An
  office without accounts (just you, on the shared password) uses only the office's own.
- **Azure DevOps organisations.** A PAT reaches only its own organisation, so a token is used only
  for the organisation it was saved with: yours, else the office's. When neither is for the
  repository's organisation, the action says whose token is for which.

When a token is missing, the action says so and opens 🔐 Your sign-ins.

**Pushing over HTTPS.** The office's credential helper (`office-git-credential`) answers for
`dev.azure.com` (by the organisation in the path), `*.visualstudio.com` and `bitbucket.org`. Git
gets it through its environment (git 2.31 or newer), ahead of any the machine has for those hosts:

- **A worker's own git** (agents and shells alike) gets the token of the person who hired it, and
  only theirs: the office's is never handed to a worker of an account, as anything a worker can run,
  `git credential fill` included, can read what its git is given. A worker of someone with no token
  of their own can't push to those hosts over HTTPS; `office-pr` still works for it, the office
  acting with its own token without handing it over. In an office without accounts (everyone is its
  admin), workers get the office's.
- **The office's own pushes for you** (O on a 🐚 shell worker, the Changes window's pull request): your
  token, else the office's; git runs in the office, not in a worker.
- **The office's fetch of a worktree's base branch**: the office's token.

That holds whatever your GitHub sign-in is. Remotes over SSH keep using the machine's SSH keys.

**Each repository by its own host.** O and the Changes window ask for the sign-ins the repositories
they push to need: GitHub's only when one of them is on GitHub, and your token for each other host. A
worker across repositories on GitHub and Bitbucket opens each pull request on its own host.

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
branch's pull request. `diff` is read from the host (Bitbucket's own diff; on Azure DevOps the
changed files' contents, diffed by the office), so it fetches nothing into the checkout and works in a
reviewer's read-only one. `office-pr` asks the office through the hook server, and the office talks to
the host with the credentials of the account the worker runs as (else the office's), so `office-pr`
itself hands no token to the worker; the worker's own git has its owner's token (see *Pushing over HTTPS*).
It acts only on the project's own repositories (its floor's, and those of a worker across
repositories), read from the office's checkouts: a checkout whose `origin` was pointed somewhere
else is refused. On a GitHub repository it says to use `gh`.

**Whose review comments count.** GitHub says how each commenter stands to the repository
(`author_association`), and Fix PRs acts only on its owners', members' and collaborators'. Azure DevOps
and Bitbucket don't, so `office-pr view --comments` marks each comment `[trusted]` or `[untrusted]`,
and Fix PRs acts only on trusted ones (the *Fix pull requests · on Azure DevOps and Bitbucket* prompt):

- **Bitbucket**: trusted when its author is a member of the repository's workspace, or the repository
  is private (only people given access can comment there). Being the pull request's author or one of
  its reviewers isn't enough: anybody's fork picks those. A repository the token can't read counts as
  public, and a membership the token can't read (it needs `read:workspace:bitbucket`) as none.
- **Azure DevOps**: every comment, since only a project's members can comment at all (a public project
  lets everyone else read, not write).

The kanban's prompts add a note about `office-pr` (the *Repositories on Azure DevOps and Bitbucket*
prompt, editable) after the workspace lines, only when a repository of the task or worker is
elsewhere. A GitHub project's prompts are unchanged.

## Azure Boards

**As an issue source.** ⚙️ Settings → 📁 Projects → 📌 Issue sources → **＋ Azure Boards**:
organisation, project, assignee (`@Me` or a name or e-mail), work item types, area path, whether to
include completed ones, and an extra WIQL condition. Cards are keyed `ab:org/project#123`. Their
window changes the status (the work item type's own states), comments and the assignee, as you.
The source reads with the office's Azure DevOps token for that organisation (an admin sets it); a card's actions use yours, else the office's.

**Closing it on merge.** A task whose ticket is a work item (made from an Azure Boards card, or
`office-tasks create --ticket ab:org/project#123`):

1. The *Open pull requests* prompt asks for `AB#123` in the description of each pull request on Azure
   DevOps (the *Pull requests · linking the work item* prompt).
2. `office-pr create` links the work item to the pull request it opens, and sets *complete linked work
   items* on it. So does any `AB#n` in its title or description.
3. On each board refresh, a task's open pull request on Azure DevOps that isn't linked to the work item
   yet (one opened another way) is linked. Once one of them merges, the office moves the work item to
   its type's *Completed* state (Done, Closed, …), unless Azure DevOps already did. Each step goes on the
   task as a status comment, and happens once; one that fails (Azure DevOps down, say) is tried again
   on the next refreshes, three times in all.

Both are done with the Azure DevOps token of the task's creator, else the office's own, never with
another person's. Without either, they wait (the task says so once) and go ahead on the first refresh
after someone sets one.

Only work items in the same organisation as the repository are linked.

## Bitbucket Server and Data Center

Not supported yet. An admin can list the hosts (`hosting-secrets.json`'s `servers`, or the
`hosting.servers` message) so their remotes are recognised. The boards then say the host isn't
supported, rather than showing a `gh` error.

## API limits

Bitbucket Cloud allows a token about 1000 requests an hour, Azure DevOps throttles one that asks too
much, and the PR board is read every 90 seconds while someone is on its floor. Each look lists the
open, merged and closed pull requests (three requests); what the list leaves out of an open one
(Bitbucket's reviewers and build statuses, Azure DevOps' statuses and policy evaluations) is asked
for again only when it changed (updated, or pushed to; on Azure DevOps also its target branch,
merge status or votes), or after 30 minutes (5 while its checks run). Azure DevOps cuts the list's
descriptions to 400 characters, so a longer one is read whole once (for the *Opened from Agent Office
by* line the PR board's 👤 Mine reads). A dozen open pull requests stay well under 300 requests an
hour. The kanban reads a project's pull requests from the board; before the board has them it lists
none there (no request per pull request), and a task's linked ones stand. When a host answers 429 (too many requests), the office sends
nothing more with that token until the time it asks for has passed (Retry-After, else a minute),
and the board says when it tries again.

## Limitations

- The board's merge and close buttons and labels are GitHub's: on the other hosts, open the pull
  request there (the window's footer links to it). On Azure DevOps the diff shows the latest
  iteration's first 300 files, each up to 1 MB and 16 MB in all (the rest are named); it's worked
  out once per push. A big file changed all over shows as its old lines taken out and the new put in.
- On Azure DevOps a pull request is 👍 Approved only once every required reviewer approved; a
  *rejected* or *waiting for author* vote is changes requested. The PR board's 👀 To review is
  GitHub's review requests, so it shows nothing for the other hosts.
- Upstream's PR-window prompts (*Fix comments & merge*, *Fix conflicts & merge*) use `gh` and are hidden
  for pull requests elsewhere. The kanban's Fix PRs and Resolve conflicts work. 🔍 Review of a pull
  request elsewhere goes to the kanban's reviewer even for just that one (its prompt says to use
  `office-pr`), and *Ask a worker…* adds the same note to the office's prompt.
- Azure DevOps doesn't link a work item that isn't in the repository's organisation.
