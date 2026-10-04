// The review and per-project override fields of the kanban's settings (settings.ts draws them):
// the reviewer's choices, and a project's own limits, languages and review settings.
import { h, toast } from '../ui/dom';
import { LANGUAGE_HELP } from '../ui/language';
import { KANBAN_LIMITS } from '../../shared/kanban/protocol.js';
import {
  KANBAN_EFFORTS,
  KANBAN_TOOLS,
  type ImplementPermission,
  type KanbanEffort,
  type KanbanSettings,
  type KanbanTool,
  type PlanApproval,
  type ProjectSettings,
  type ReviewSettings,
} from '../../shared/kanban/types.js';
import { projectDefaults, REVIEW_DEFAULTS } from './defaults';
import { commentLanguageField, publicLanguageField } from './language-field';
import { APPROVAL_NAMES, effortName, toolName } from './labels';
import { checkbox, field, numberInput, numberValue, select, textInput } from './ui';

export const PERMISSION_NAMES: Record<ImplementPermission, string> = { bypass: 'without permission prompts', 'workspace-write': 'in Codex’s workspace sandbox' };

export const optionalModel = (v: string) => v.trim() || null;

export function reviewFields(r: Partial<ReviewSettings>, base: ReviewSettings | null) {
  const tool = select<KanbanTool | ''>([...(base ? [] : ([['', 'Default']] as const)), ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], r.tool ?? (base ? base.tool : ''));
  const model = textInput(r.model ?? '', { maxlength: KANBAN_LIMITS.model, placeholder: 'Default' });
  const effort = select<KanbanEffort | ''>([['', 'Default'], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], r.effort ?? '');
  const rounds = numberInput(r.rounds ?? base?.rounds ?? REVIEW_DEFAULTS.rounds, 1, 10);
  const reRev = checkbox('Review the last fix too', r.reReviewLastFix ?? base?.reReviewLastFix ?? REVIEW_DEFAULTS.reReviewLastFix);
  const sandbox = checkbox('Keep the reviewer off the web', r.sandbox ?? base?.sandbox ?? REVIEW_DEFAULTS.sandbox);
  const el = h('div.kb-subfields', {}, field('Reviewer', tool), field('Model', model), field('Effort', effort), field('Rounds', rounds, '1–10 review rounds, each followed by a fix when changes are asked for'), reRev.el, sandbox.el);
  const value = (): { tool?: KanbanTool; model: string | null; effort: KanbanEffort | null; rounds: number; reReviewLastFix: boolean; sandbox: boolean } => ({
    ...(tool.value ? { tool: tool.value as KanbanTool } : {}),
    model: optionalModel(model.value),
    effort: (effort.value as KanbanEffort) || null,
    rounds: numberValue(rounds, 1, 10, REVIEW_DEFAULTS.rounds),
    reReviewLastFix: reRev.box.checked,
    sandbox: sandbox.box.checked,
  });
  return { el, value };
}

/** The "This project" fieldset: what a project overrides of the office's defaults, and what it reads back as. */
export function thisProjectFields(ps: ProjectSettings, s: KanbanSettings): { el: HTMLElement; read(): Record<string, unknown> | undefined } {
  const maxConc = numberInput(ps.maxConcurrent, 1, 20);
  const approval = select<PlanApproval | ''>(
    [['', `Default (${APPROVAL_NAMES[s.defaults.planApproval]})`], ['auto', APPROVAL_NAMES.auto], ['manual', APPROVAL_NAMES.manual]],
    ps.planApproval ?? '',
  );
  const perm = select<ImplementPermission | ''>(
    [
      ['', `Default (${PERMISSION_NAMES[s.defaults.implementPermission]})`],
      ['bypass', PERMISSION_NAMES.bypass],
      ['workspace-write', PERMISSION_NAMES['workspace-write']],
    ],
    ps.implementPermission ?? '',
  );
  const language = publicLanguageField(ps.publicLanguage);
  const comments = commentLanguageField(ps.commentLanguage);
  const overrideReview = checkbox('Its own review settings', !!ps.review);
  const review = reviewFields(ps.review ?? {}, { ...s.review, ...ps.review });
  const paintReview = () => review.el.classList.toggle('hidden', !overrideReview.box.checked);
  overrideReview.box.addEventListener('change', paintReview);
  paintReview();
  const el = h(
    'fieldset',
    {},
    h('legend', {}, 'This project'),
    h('div.kb-three', {}, field('Tasks at once', maxConc), field('Plan approval', approval), field('Implementation runs', perm)),
    language.el,
    comments.el,
    overrideReview.el,
    review.el,
  );
  return {
    el,
    read: () => {
      const rv = review.value();
      const publicLanguage = language.value();
      const commentLanguage = comments.value();
      if (publicLanguage === undefined || commentLanguage === undefined) {
        toast(LANGUAGE_HELP, 'warn');
        return undefined;
      }
      return {
        maxConcurrent: numberValue(maxConc, 1, 20, projectDefaults().maxConcurrent),
        // null: back to the office's.
        planApproval: approval.value || null,
        implementPermission: perm.value || null,
        publicLanguage,
        commentLanguage,
        review: overrideReview.box.checked ? { ...rv, model: rv.model ?? undefined, effort: rv.effort ?? undefined } : null,
      };
    },
  };
}
