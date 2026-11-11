import type { GhCloseReason, GhIssue, GhPull } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store, workerForPull } from '../../state';
import { h } from '../dom';
import { icon } from '../icons';
import { btn, checkLine, formField, segmented } from '../kit';
import { modalShell, openShell } from '../shell';
import { ghKey, ghLabel, ghRepoField } from './ghrepo';
import { closeWaiters } from './api';

// ---- Close dialog -------------------------------------------------------------------------------

const REASON_LABEL: Record<GhCloseReason, string> = { completed: 'Completed', 'not planned': 'Not planned' };

/** Closes an issue (as completed or not planned) or a PR without merging, with an optional comment. */
export function openClose(kind: 'issue' | 'pull', it: GhIssue | GhPull, net: Net, onClosed: () => void) {
  // By the repository it's in too.
  const key = ghKey(kind, it.number, it.repo);
  const label = ghLabel(it.number, it.repo);
  const pull = kind === 'pull' ? (it as GhPull) : null;
  let reason: GhCloseReason = 'completed';
  let busy = false;

  const goText = h('span');
  const go = h('button.btn.danger.lg', { type: 'button' }, icon(pull ? 'git-pull-request-closed' : 'circle-check'), goText) as HTMLButtonElement;
  const paintGo = () => (goText.textContent = pull ? 'Close pull request' : `Close as ${reason}`);
  const reasons = segmented<GhCloseReason>((Object.keys(REASON_LABEL) as GhCloseReason[]).map((r) => [r, REASON_LABEL[r]] as const), reason, (r) => ((reason = r), paintGo()), 'Why');
  const comment = h('textarea.inp', { rows: 4, placeholder: 'Leave a comment', 'aria-label': 'Closing comment', autofocus: true }) as HTMLTextAreaElement;
  const del = pull ? checkLine(['Delete ', h('code.code-chip', {}, pull.headRefName), ' too'], { id: 'close-del' }) : null;
  const w = pull && workerForPull(store.workers.values(), pull);
  const result = h('div.gh-merge-result.hidden');
  const cancel = btn('Cancel', { kind: 'quiet' });
  const noun = pull ? 'pull request' : 'issue';

  const shell = modalShell({
    cls: 'gh-merge',
    icon: pull ? 'git-pull-request-closed' : 'circle-check',
    title: `Close ${noun}`,
    id: label,
    label: `Close ${noun} ${label}`,
    body: h(
      'div.gh-merge-body',
      {},
      h('p.gh-merge-title', {}, it.title, pull ? h('small', {}, `${pull.headRefName} into ${pull.baseRefName}`) : null),
      pull ? h('p.gh-note', {}, icon('info', { size: 16 }), h('span', {}, `It won't be merged, and can be reopened on GitHub later.${w ? ` ${w.name} is still at a desk working on its branch.` : ''}`)) : formField('Why', reasons.el),
      del?.el ?? null,
      formField('Comment', comment, { optional: true }),
      result,
    ),
    footerRight: [cancel, go],
  });
  paintGo();

  const modal = openShell(shell, { onClose: () => closeWaiters.delete(key) });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    go.disabled = true;
    result.className = 'gh-merge-result';
    result.replaceChildren(h('span.spinner'), `Closing the ${noun}…`);
    closeWaiters.set(key, (msg) => {
      closeWaiters.delete(key);
      busy = false;
      if (msg.error) {
        go.disabled = false;
        result.className = 'gh-merge-result error';
        result.replaceChildren(msg.error);
        return;
      }
      modal.close();
      onClosed();
    });
    // The repo it's in.
    net.send({ t: 'gh.close', kind, number: it.number, comment: comment.value.trim() || undefined, reason: pull ? undefined : reason, deleteBranch: !!pull && !!del?.box.checked, ...ghRepoField(it.repo) });
  });
}
