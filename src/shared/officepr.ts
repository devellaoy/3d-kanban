// The line the office ends a pull request it drafted with (server/workers/pr.ts draftPr), saying who
// had it opened, and reading it back for the PR board's 👤 Mine (GhPull.openedBy). Anyone who can
// open a pull request can write this line, so it only ever decides what a filter shows: never use it
// to grant rights or to trigger anything.

/** "_Opened from Agent Office by Ada · Otto at Desk 3_" */
export function officePrFooter(by: string, worker: string, desk: string): string {
  return `_Opened from Agent Office by ${by} · ${worker} at ${desk}_`;
}

/** Who a pull request's description says had the office open it, if it says. */
export function openedFromOfficeBy(body: string): string | undefined {
  return /_Opened from Agent Office by (.+?) · /.exec(body)?.[1];
}
