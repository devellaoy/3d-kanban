import type { GhCheck, GhMergeMethod, GhPull, GhPullDetail } from '../../../shared/protocol';
import type { Net } from '../../net';
import { h } from '../dom';
import { icon, type IconName } from '../icons';
import { btn, checkLine, formField, segmented } from '../kit';
import { modalShell, openShell } from '../shell';
import { mergeWaiters } from './api';
import { ghKey, ghLabel, ghRepoField } from './ghrepo';
import { MERGE_KEY, mergePref, savePref } from './prefs';

// ---- Whether a PR can merge ---------------------------------------------------------------------

const CHECK_ICON: Record<GhCheck['state'], IconName> = { pass: 'circle-check', fail: 'circle-x', pending: 'circle-dashed', skip: 'minus' };
const CHECK_WORD: Record<GhCheck['state'], string> = { pass: 'Passed', fail: 'Failed', pending: 'Running', skip: 'Skipped' };

interface MergeStatus {
  icon: IconName;
  text: string;
  cls: 'ok' | 'warn' | 'bad' | 'muted';
  /** False when merging can't work at all (draft, conflicts, already merged). */
  can: boolean;
  /** GitHub could merge it on its own once the requirements pass. */
  auto: boolean;
}

/** An open PR whose branch can't merge until someone resolves conflicts with the base. */
export function conflicted(d: GhPullDetail) {
  return d.state === 'OPEN' && !d.isDraft && (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY');
}

export function mergeStatus(d: GhPullDetail): MergeStatus {
  const failing = d.checks.filter((c) => c.state === 'fail').length;
  const pending = d.checks.filter((c) => c.state === 'pending').length;
  if (d.state === 'MERGED') return { icon: 'git-merge', text: 'Merged.', cls: 'ok', can: false, auto: false };
  if (d.state === 'CLOSED') return { icon: 'git-pull-request-closed', text: 'Closed without merging.', cls: 'muted', can: false, auto: false };
  if (d.isDraft) return { icon: 'circle-dashed', text: 'This is still a draft. Mark it ready for review on GitHub before merging.', cls: 'muted', can: false, auto: false };
  if (conflicted(d))
    return { icon: 'triangle-alert', text: `This branch has conflicts with ${d.baseRefName} that must be resolved first.`, cls: 'bad', can: false, auto: false };
  if (d.mergeStateStatus === 'BEHIND') return { icon: 'arrow-down', text: `The branch is behind ${d.baseRefName}, and this repo wants it up to date before merging.`, cls: 'warn', can: true, auto: true };
  if (d.mergeStateStatus === 'BLOCKED') {
    const why = d.reviewDecision === 'CHANGES_REQUESTED' ? 'changes were requested' : d.reviewDecision === 'REVIEW_REQUIRED' ? 'it needs an approving review' : failing ? `${failing} check${failing > 1 ? 's are' : ' is'} failing` : pending ? 'required checks are still running' : 'a branch rule is not met yet';
    return { icon: 'circle-x', text: `Merging is blocked: ${why}.`, cls: 'bad', can: true, auto: true };
  }
  if (failing) return { icon: 'circle-x', text: `${failing} check${failing > 1 ? 's' : ''} failing. It can still be merged.`, cls: 'warn', can: true, auto: false };
  if (pending || d.mergeStateStatus === 'UNSTABLE') return { icon: 'circle-dashed', text: 'Checks are still running. It can be merged now, or once they pass.', cls: 'warn', can: true, auto: true };
  if (d.mergeStateStatus === 'UNKNOWN' || d.mergeable === 'UNKNOWN') return { icon: 'clock', text: 'GitHub is still working out whether this can merge. Refresh in a moment.', cls: 'muted', can: true, auto: false };
  return { icon: 'circle-check', text: `Ready to merge: no conflicts with ${d.baseRefName}${d.checks.length ? ' and all checks passed' : ''}.`, cls: 'ok', can: true, auto: false };
}

/**
 * mergeStatus for a pull request on Azure DevOps or Bitbucket (`host`), which the office doesn't
 * merge: what its checks and reviews say, and that it merges there. `can` is always false.
 */
export function hostedMergeStatus(d: GhPullDetail, host: string): MergeStatus {
  const failing = d.checks.filter((c) => c.state === 'fail').length;
  const pending = d.checks.filter((c) => c.state === 'pending').length;
  const no = { can: false, auto: false } as const;
  if (d.state === 'MERGED') return { icon: 'git-merge', text: 'Merged.', cls: 'ok', ...no };
  if (d.state === 'CLOSED') return { icon: 'git-pull-request-closed', text: 'Closed without merging.', cls: 'muted', ...no };
  if (d.isDraft) return { icon: 'circle-dashed', text: `This is still a draft: publish it on ${host} when it's ready.`, cls: 'muted', ...no };
  if (failing) return { icon: 'circle-x', text: `${failing} check${failing > 1 ? 's' : ''} failing. Merge it on ${host}.`, cls: 'warn', ...no };
  if (d.reviewDecision === 'CHANGES_REQUESTED') return { icon: 'circle-x', text: `Changes were requested. Merge it on ${host}.`, cls: 'bad', ...no };
  if (pending) return { icon: 'circle-dashed', text: `Checks are still running. Merge it on ${host}.`, cls: 'warn', ...no };
  return { icon: 'git-merge', text: `Merge it on ${host}: the office doesn't merge pull requests there.`, cls: 'muted', ...no };
}

/**
 * How a pull request stands, as a list box: the verdict (its icon, the sentence and how many checks
 * passed), then a row for each check, the failing ones first.
 */
export function mergeBox(st: MergeStatus, checks: GhCheck[]): HTMLElement {
  const order: GhCheck['state'][] = ['fail', 'pending', 'pass', 'skip'];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const passed = checks.filter((c) => c.state === 'pass').length;
  return h(
    'section.list-box.gh-mergebox',
    { 'aria-label': 'Merge status' },
    h('div.gh-merge-verdict', { class: st.cls }, icon(st.icon, { size: 18 }), h('div', {}, h('strong', {}, st.text), checks.length ? h('span', {}, `${passed} of ${checks.length} check${checks.length === 1 ? '' : 's'} passed`) : null)),
    ...sorted.map((c) =>
      h(
        'div.gh-check-row',
        { class: c.state },
        icon(CHECK_ICON[c.state], { size: 16, label: c.state }),
        c.url ? h('a.gh-check-name', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.name) : h('span.gh-check-name', {}, c.name),
        h('span.gh-check-state', {}, CHECK_WORD[c.state]),
      ),
    ),
  );
}

// ---- Merge dialog -------------------------------------------------------------------------------

const METHOD_LABEL: Record<GhMergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const METHOD_SHORT: Record<GhMergeMethod, string> = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' };

export function openMerge(it: GhPull, d: GhPullDetail, net: Net, handToWorker: () => void, onMerged: () => void) {
  const st = mergeStatus(d);
  // Which of the project's repositories it's in.
  const key = ghKey('pull', it.number, it.repo);
  const label = ghLabel(it.number, it.repo);
  const methods = d.repo.methods;
  let { method, deleteBranch } = mergePref(methods);
  let busy = false;

  const goText = h('span');
  const go = h('button.btn.primary.lg', { type: 'button', autofocus: st.can }, icon('git-merge'), goText) as HTMLButtonElement;
  const auto = checkLine('Merge automatically once the requirements pass', { id: 'merge-auto' });
  auto.el.title = 'gh pr merge --auto (the repo must allow auto-merge)';
  auto.box.checked = st.auto && st.cls !== 'ok';
  const paintGo = () => (goText.textContent = auto.box.checked ? 'Merge when ready' : METHOD_LABEL[method]);
  const methodBtns = segmented<GhMergeMethod>(methods.map((m) => [m, METHOD_SHORT[m]] as const), method, (m) => ((method = m), savePref(MERGE_KEY, { method, deleteBranch }), paintGo()), 'How to merge');
  for (const [m, b] of methodBtns.buttons) b.title = METHOD_LABEL[m];
  auto.box.addEventListener('change', paintGo);
  const del = checkLine(['Delete ', h('code.code-chip', {}, it.headRefName), ' after merging'], { id: 'merge-del' });
  del.box.checked = deleteBranch;
  del.box.addEventListener('change', () => {
    deleteBranch = del.box.checked;
    savePref(MERGE_KEY, { method, deleteBranch });
  });
  const result = h('div.gh-merge-result.hidden');
  const cancel = btn('Cancel', { kind: 'quiet', attrs: { autofocus: !st.can } });
  // Conflicts can't be merged from here, so fixing them is the main button.
  const worker = conflicted(d)
    ? btn('Fix conflicts and merge', { kind: 'primary', icon: 'wrench', attrs: { title: 'A new worker merges the base in, resolves the conflicts, then merges it the way picked above' } })
    : btn('Hand to a worker', { icon: 'bot', attrs: { title: 'A worker fixes whatever is in the way, then merges' } });

  const shell = modalShell({
    cls: 'gh-merge',
    icon: 'git-merge',
    title: 'Merge',
    id: label,
    label: `Merge PR ${label}`,
    body: h(
      'div.gh-merge-body',
      {},
      h('p.gh-merge-title', {}, it.title, h('small', {}, `${it.headRefName} into ${it.baseRefName}`)),
      mergeBox(st, d.checks),
      formField('How', methodBtns.el),
      del.el,
      st.auto ? auto.el : null,
      result,
    ),
    footerLeft: [st.can || conflicted(d) ? null : worker],
    footerRight: [cancel, conflicted(d) ? worker : go],
  });
  paintGo();
  if (!st.can) go.disabled = true;

  const modal = openShell(shell, { onClose: () => mergeWaiters.delete(key) });
  cancel.addEventListener('click', () => modal.close());
  worker.addEventListener('click', () => {
    modal.close();
    handToWorker();
  });
  go.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    go.disabled = true;
    result.className = 'gh-merge-result';
    result.replaceChildren(h('span.spinner'), auto.box.checked && st.auto ? 'Asking GitHub to merge it when ready…' : 'Merging…');
    // key.
    mergeWaiters.set(key, (msg) => {
      mergeWaiters.delete(key);
      busy = false;
      if (msg.error) {
        go.disabled = false;
        result.className = 'gh-merge-result error';
        result.replaceChildren(msg.error);
        return;
      }
      modal.close();
      onMerged();
    });
    net.send({ t: 'gh.merge', number: it.number, method, deleteBranch, auto: auto.box.checked && st.auto, ...ghRepoField(it.repo) });
  });
}
