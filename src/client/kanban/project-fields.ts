// The review and per-project override fields of the kanban's settings (settings.ts draws them):
// the reviewer's choices, and a project's own limits, languages and review settings.
import { h, toast } from '../ui/dom';
import { LANGUAGE_HELP } from '../ui/language';
import { KANBAN_LIMITS } from '../../shared/kanban/protocol.js';
import {
  KANBAN_EFFORTS,
  KANBAN_TOOLS,
  type KanbanEffort,
  type KanbanSettings,
  type KanbanTool,
  type PlanApproval,
  type ProjectSettings,
  type ReviewSettings,
  type ReviewerSpec,
} from '../../shared/kanban/types.js';
import { IMPLEMENT_PERMISSIONS, IMPLEMENT_PERMISSION_INFO, PLAN_PERMISSIONS, PLAN_PERMISSION_INFO, type ImplementPermission, type PlanPermission } from '../../shared/kanban/permissions.js';
import { projectDefaults, REVIEW_DEFAULTS } from './defaults';
import { commentLanguageField, publicLanguageField } from './language-field';
import { APPROVAL_NAMES, effortName, toolName } from './labels';
import { kstore } from './store';
import { focusInput } from './agentfields';
import { extraReviewersField } from './reviewers-field';
import { checkbox, field, numberInput, numberValue, select, textInput } from './ui';

type PermissionInfo = { name: string; claude: string; codex: string; antigravity: string };

/** What a permission value means for each agent, as the line under its select. */
export const permissionHint = (info: PermissionInfo) => `Claude: ${info.claude} · Codex: ${info.codex} · Antigravity: ${info.antigravity}`;

/**
 * A permission select with a hint under it that says what the chosen value means for each agent.
 * With `inherited` (a project's select) the first option is "Default (…)", whose hint is the office's value's.
 */
function permissionField<T extends string>(label: string, values: readonly T[], info: Record<T, PermissionInfo>, value: T | '', inherited?: T): { el: HTMLElement; pick: HTMLSelectElement } {
  const pick = select<T | ''>([...(inherited ? ([['', `Default (${info[inherited].name})`]] as const) : []), ...values.map((v) => [v, info[v].name] as const)], value);
  const hint = h('small.kb-hint', {});
  const paint = () => hint.replaceChildren(permissionHint(info[(pick.value as T) || inherited || values[0]]));
  pick.addEventListener('change', paint);
  paint();
  const el = field(label, pick);
  el.append(hint);
  return { el, pick };
}

/**
 * "Plan phase runs" and "Implementation runs" side by side, each with its per-agent hint, and a line on
 * what they cover. The office's pane passes its values; a project passes its overrides and the office's
 * values as `office`, and reads '' back for "Default".
 */
export function permissionFields(
  now: { planPermission?: PlanPermission; implementPermission?: ImplementPermission },
  office?: { planPermission: PlanPermission; implementPermission: ImplementPermission },
): { el: HTMLElement; plan(): PlanPermission | ''; implement(): ImplementPermission | '' } {
  const plan = permissionField('Plan phase runs', PLAN_PERMISSIONS, PLAN_PERMISSION_INFO, now.planPermission ?? '', office?.planPermission);
  const impl = permissionField('Implementation runs', IMPLEMENT_PERMISSIONS, IMPLEMENT_PERMISSION_INFO, now.implementPermission ?? '', office?.implementPermission);
  const el = h(
    'div.kb-perms',
    {},
    h('div.kb-two', {}, plan.el, impl.el),
    h('small.kb-hint', {}, 'Implementation covers the implement, fix, resume and PR phases. Reviews are not affected by these settings.'),
  );
  return { el, plan: () => plan.pick.value as PlanPermission | '', implement: () => impl.pick.value as ImplementPermission | '' };
}

export const optionalModel = (v: string) => v.trim() || null;

export function reviewFields(r: Partial<ReviewSettings>, base: ReviewSettings | null) {
  const tool = select<KanbanTool | ''>([...(base ? [] : ([['', 'Default']] as const)), ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], r.tool ?? (base ? base.tool : ''));
  const model = textInput(r.model ?? '', { maxlength: KANBAN_LIMITS.model, placeholder: 'Default' });
  const effort = select<KanbanEffort | ''>([['', 'Default'], ...KANBAN_EFFORTS.map((e) => [e, effortName(e)] as const)], r.effort ?? '');
  const focus = focusInput(r.focus ?? base?.focus ?? '');
  const rounds = numberInput(r.rounds ?? base?.rounds ?? REVIEW_DEFAULTS.rounds, 1, 10);
  const reRev = checkbox('Review the last fix too', r.reReviewLastFix ?? base?.reReviewLastFix ?? REVIEW_DEFAULTS.reReviewLastFix);
  const sandbox = checkbox('Keep the reviewer off the web', r.sandbox ?? base?.sandbox ?? REVIEW_DEFAULTS.sandbox);
  const extra = extraReviewersField(r.extra ?? base?.extra);
  // The main reviewer's four fields on a row; Rounds, then the additional reviewers, take the full width under it.
  const roundsField = field('Rounds', rounds, '1–10 review rounds, each followed by a fix when changes are asked for');
  roundsField.classList.add('kb-rounds');
  const el = h('div.kb-subfields', {}, field('Reviewer', tool), field('Model', model), field('Effort', effort), field('Focus', focus.el), roundsField, extra.el, reRev.el, sandbox.el);
  const value = (): { tool?: KanbanTool; model: string | null; effort: KanbanEffort | null; focus: string | null; extra: ReviewerSpec[]; rounds: number; reReviewLastFix: boolean; sandbox: boolean } => ({
    ...(tool.value ? { tool: tool.value as KanbanTool } : {}),
    model: optionalModel(model.value),
    effort: (effort.value as KanbanEffort) || null,
    focus: focus.input.value.trim() || null,
    extra: extra.value(),
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
  const perms = permissionFields(ps, s.defaults);
  const uiTesting = select<'on' | 'off' | ''>([['', `Default (${s.defaults.uiTesting ? 'On' : 'Off'})`], ['on', 'On'], ['off', 'Off']], ps.uiTesting === undefined ? '' : ps.uiTesting ? 'on' : 'off');
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
    // Two short fields and a wide one: the plan approval's "Default (…)" needs the room.
    h('div.kb-three.kb-last-wide', {}, field('Tasks at once', maxConc), field('UI testing', uiTesting, 'Before and after screenshots of UI changes'), field('Plan approval', approval)),
    perms.el,
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
        planPermission: perms.plan() || null,
        implementPermission: perms.implement() || null,
        uiTesting: uiTesting.value ? uiTesting.value === 'on' : null,
        publicLanguage,
        commentLanguage,
        // The focus goes as it is, empty too: a project's empty one stands over the office's.
        review: overrideReview.box.checked ? { ...rv, model: rv.model ?? undefined, effort: rv.effort ?? undefined, focus: rv.focus ?? '' } : null,
      };
    },
  };
}

/** A save button that says whether you may. */
export function saveButton(label = 'Save'): HTMLButtonElement {
  const b = h('button.btn.primary', { type: 'button' }, label) as HTMLButtonElement;
  if (!kstore.me.admin) {
    b.disabled = true;
    b.title = 'Only admins can change this';
  }
  return b;
}
