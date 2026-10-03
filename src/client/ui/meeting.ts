import './meeting.css';
import { MEETING_PATTERNS, MEETING_PATTERN_IDS, TOKENS_PER_SEAT, meetingAt, meetingSpend, meetingStage, outputProblem, slugify } from '../../shared/meetings';
import { fmtTokens, type Meeting, type MeetingPattern, type MeetingTurn } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast, STATUS_LABEL, type Modal } from './dom';
import { confirmDialog } from './prompt';
import { providerPicker } from './provider';
import { officePrompt } from './prompts';
import { issueVars } from './github/prompts';
import { onSendKey } from '../kanban/sendkey';

/** What a meeting called from an issue, a PR or a task starts out with. */
export interface MeetingPreset {
  /** The room to open (the one a chair is in), or to hold the meeting in; the first free one without. */
  room?: string;
  pattern?: MeetingPattern;
  prompt?: string;
  title?: string;
  pr?: number;
  issue?: number;
}

export interface MeetingActions {
  openTerminal(workerId: string): void;
  /** Push the meeting's branch and open a pull request for it, through the head of the table's worker. */
  openPr(workerId: string): void;
}

/** A meeting about a GitHub issue: the form filled in with it. */
export function issueMeeting(n: number, title: string): MeetingPreset {
  return { issue: n, title: `#${n} ${title}`, prompt: officePrompt('issue.meeting', issueVars({ number: n, title })) };
}

const PART_LABEL: Record<MeetingTurn['state'], string> = { waiting: '⏳ up next', sent: '📨 handed over', working: '💬 on it', done: '✅ written' };

/** Whether a preset asks for a meeting (an issue or a PR to hold one about), rather than only naming a room to look at. */
const calls = (p?: MeetingPreset) => !!p && Object.entries(p).some(([k, v]) => k !== 'room' && v !== undefined);

/**
 * The meeting rooms' window. With a meeting at a table it shows how it's going (and stops it, or
 * clears the table once it's over); otherwise, or with a preset from an issue or a PR, it's the form
 * that calls one. A tab for each room (when there are several) switches between them.
 */
export function openMeeting(net: Net, actions: MeetingActions, preset?: MeetingPreset) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, '🤝 Meeting room');
  const tabs = h('div.meeting-tabs', { role: 'tablist', 'aria-label': 'Meeting rooms' });
  const body = h('div.body.meeting');
  const foot = h('footer');
  const el = h('div.modal.meeting-window', { role: 'dialog', 'aria-label': 'Meeting room' }, h('header', {}, title, close), tabs, body, foot);
  const rooms = () => store.meeting.rooms;
  // The room shown: the one asked for, else the one with a meeting running (or just held), else none yet.
  let shown: string | undefined = preset?.room ?? (calls(preset) ? undefined : (rooms().find((r) => r.current?.status === 'running') ?? rooms().find((r) => r.current))?.id);
  // The room a new meeting goes to: the one asked for or last opened; the first free one without.
  let target: string | undefined = preset?.room;
  let view: 'status' | 'form' = calls(preset) || !(shown && meetingAt(store.meeting, shown)) ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  const pick = (id: string) => {
    shown = target = id;
    view = meetingAt(store.meeting, id) ? 'status' : 'form';
    form = null;
    render();
  };
  const renderTabs = () => {
    tabs.hidden = rooms().length < 2;
    const ids = rooms().map((r) => r.id);
    // Only the shown room's tab is in the tab order; the arrows, Home and End move between the others (they're rebuilt on a pick, so the new one takes the focus).
    const onKey = (e: KeyboardEvent, id: string) => {
      const i = ids.indexOf(id);
      const to = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
      if (!to) return;
      e.preventDefault();
      pick(to);
      (tabs.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus();
    };
    tabs.replaceChildren(
      ...rooms().map((r) => {
        const on = r.current?.status === 'running';
        const sel = r.id === shown;
        const stop = sel || (!ids.includes(shown ?? '') && r.id === ids[0]);
        return h('button.btn.small.meeting-tab', { type: 'button', role: 'tab', 'aria-selected': String(sel), tabindex: stop ? 0 : -1, class: sel ? 'on' : '', onclick: () => pick(r.id), onkeydown: (e: Event) => onKey(e as KeyboardEvent, r.id) }, r.label, on ? ' · in a meeting' : r.current ? ' · done' : ' · free');
      }),
    );
  };
  const render = () => {
    renderTabs();
    const here = shown ? meetingAt(store.meeting, shown) : null;
    if (view === 'status' && here) {
      form = null;
      title.textContent = rooms().find((r) => r.id === shown)?.label ?? '🤝 Meeting room';
      renderStatus(here, body, foot, net, actions, () => {
        view = 'form';
        target = shown;
        render();
      });
      return;
    }
    if (!form) {
      // A room just cleared: the form calls the next meeting in it.
      if (shown && !target) target = shown;
      form = meetingForm(net, preset, () => target, () => modal.close(), () => {
        view = 'status';
        render();
      });
      title.textContent = '🤝 Call a meeting';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
    form.refresh();
  };
  const offs = [store.on('meeting', render), store.on('workers', () => view === 'status' && render()), store.on('pulls', () => form?.refresh())];
  const modal: Modal = openModal(el, { doing: '🤝 at the meeting room', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderStatus(m: Meeting, body: HTMLElement, foot: HTMLElement, net: Net, actions: MeetingActions, callAnother: () => void) {
  const p = MEETING_PATTERNS[m.pattern];
  const running = m.status === 'running';
  const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'in a meeting' : m.status);
  const f = m.budget > 0 ? Math.min(1, m.tokens / m.budget) : 0;
  const seats = h(
    'ul.meeting-seats',
    {},
    ...m.seats.map((s, i) => {
      const w = s.workerId ? store.workers.get(s.workerId) : undefined;
      const t = m.turns.find((x) => x.seat === i);
      const part = running ? (t ? `${PART_LABEL[t.state]}: ${t.doing}` : '👂 listening') : '';
      return h(
        'li',
        {},
        h('span.dot', { style: `background:${w?.color ?? '#adb5bd'}` }),
        h('b', {}, s.role),
        h('span.muted', {}, `${i === 0 ? 'head of the table · ' : ''}${s.workerName ?? '…'}`),
        w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : h('span.pill.exited', {}, 'gone home'),
        part ? h('span.meeting-part', { title: t?.file ?? '' }, part) : null,
        s.tokens ? h('span.muted', {}, `${fmtTokens(s.tokens)} tokens`) : null,
        w ? h('button.btn.small', { type: 'button', onclick: () => actions.openTerminal(w.id) }, '🖥️ Terminal') : null,
      );
    }),
  );
  const where = m.worktree ? h('span', {}, '🌿 ', h('code', {}, m.worktree.branch), m.commit ? ` · committed ${m.commit}` : '') : null;
  const review = m.review?.url ? h('a', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, `🔍 The review on PR #${m.pr} ↗`) : m.review?.error ? h('span.bad', {}, `Couldn't post the review: ${m.review.error}`) : null;
  body.replaceChildren(
    ...present(
    h('div.meeting-head', {}, pill, h('b', {}, `${p.icon} ${p.label}`), h('span.meeting-title', { title: m.prompt }, m.title)),
    h('p.meeting-line', {}, running ? `${meetingStage(m)} · called by ${m.calledBy} ${timeAgo(new Date(m.startedAt).toISOString())}` : m.status === 'done' ? `✅ Wrote ${m.output} in ${m.round} round${m.round === 1 ? '' : 's'}` : `⛔ Stopped in round ${m.round}: ${m.reason ?? 'stopped'}`),
    h('div.meeting-budget', { title: m.budget > 0 ? `${m.tokens.toLocaleString()} of ${m.budget.toLocaleString()} tokens` : `${m.tokens.toLocaleString()} tokens, no limit` }, m.budget > 0 ? h('div.meeting-bar', {}, h('i', { style: `width:${(f * 100).toFixed(1)}%;background:${f > 0.9 ? 'var(--bad)' : f > 0.7 ? 'var(--warn)' : 'var(--good)'}` })) : null, h('span', {}, m.budget > 0 ? `${meetingSpend(m)} of ${fmtTokens(m.budget)} tokens` : `${meetingSpend(m)} · no limit`)),
    seats,
    h('div.meeting-out', {}, h('div.meeting-out-head', {}, h('b', {}, '📄 '), h('code', {}, m.output), where, review), h('pre.meeting-preview', {}, m.preview?.trim() ? m.preview : running ? 'Nothing written yet.' : 'Nothing was written.')),
    store.meeting.past.length
      ? h('details.meeting-past', {}, h('summary', {}, `Earlier meetings (${store.meeting.past.length})`), h('ul', {}, ...store.meeting.past.map((r) => h('li', { title: `Called by ${r.calledBy}` }, h('b', {}, r.title), h('div.muted', {}, r.summary)))))
      : null,
    ),
  );
  const head = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
  foot.replaceChildren(
    ...present(
    h('span.grow', {}, running ? 'The workers stay at the table after it ends, so you can read their terminals.' : 'Clearing the room sends the workers home. A committed output stays on its branch.'),
    running ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Stop the meeting?', `The workers stop where they are and stay at the table. ${m.output} is only there if it was written.`, 'Stop it', () => net.send({ t: 'meeting.stop', room: m.room })) }, '⛔ Stop meeting') : null,
    !running && m.commit && head?.worktree ? h('button.btn', { type: 'button', title: `Push ${m.worktree?.branch} and open a pull request`, onclick: () => actions.openPr(head.id) }, head.pr ? `🔀 PR #${head.pr.number}` : '🔀 Open PR') : null,
    !running ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear', room: m.room }) }, '🧹 Clear the room') : null,
    !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, '🤝 Call a meeting…') : null,
    ),
  );
}

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** The form that calls a meeting: the pattern, what it's about, who sits down, the output, the bounds. */
function meetingForm(net: Net, preset: MeetingPreset | undefined, room: () => string | undefined, done: () => void, back: () => void) {
  let pattern: MeetingPattern = preset?.pattern ?? 'debate';
  let roles: string[] = [];
  let outputTouched = false;
  let budgetTouched = false;
  const patterns = h('div.meeting-patterns', { role: 'radiogroup', 'aria-label': 'Pattern' });
  const about = h('textarea', { rows: 4, placeholder: 'The question to settle, or the task to do: e.g. “Should the dog use A* or a navmesh?”', 'aria-label': 'What the meeting is about' }) as HTMLTextAreaElement;
  about.value = preset?.prompt ?? '';
  const titleIn = h('input', { type: 'text', placeholder: 'Title (optional): the first line otherwise', maxlength: 100, 'aria-label': 'Title' }) as HTMLInputElement;
  titleIn.value = preset?.title ?? '';
  const outputIn = h('input', { type: 'text', 'aria-label': 'Output file', spellcheck: 'false' }) as HTMLInputElement;
  const outputNote = h('small.muted');
  const prSel = h('select.provider-select', { 'aria-label': 'Pull request' }) as HTMLSelectElement;
  const prRow = h('div.meeting-field', {}, h('label', {}, 'Pull request'), prSel);
  const partsIn = h('textarea', { rows: 3, placeholder: 'src/server/\nsrc/client/\nsrc/shared/', 'aria-label': 'Parts', spellcheck: 'false' }) as HTMLTextAreaElement;
  const partsRow = h('div.meeting-field', {}, h('label', {}, 'Parts, one per line'), partsIn, h('small.muted', {}, 'Handed out to the mappers in turn: files, folders, modules or issues.'));
  const count = h('b');
  const minus = h('button.btn.small', { type: 'button', 'aria-label': 'Fewer workers' }, '−');
  const plus = h('button.btn.small', { type: 'button', 'aria-label': 'More workers' }, '+');
  const roleList = h('div.meeting-roles');
  const roundsIn = h('input', { type: 'number', 'aria-label': 'Rounds' }) as HTMLInputElement;
  const roundsNote = h('small.muted');
  const budgetIn = h('input', { type: 'number', min: 50, step: 250, 'aria-label': 'Token budget in thousands' }) as HTMLInputElement;
  const budgetNote = h('small.muted');
  const provider = providerPicker(store.project, 'meeting-provider', 'Workers');
  const busy = h('p.meeting-busy');
  const submit = h('button.btn.primary', { type: 'submit' }, '🤝 Start the meeting');
  const held = !!(room() && meetingAt(store.meeting, room()!));
  const cancel = h('button.btn', { type: 'button', onclick: held ? back : done }, held ? '← Back' : 'Cancel');

  /** No room to call it in: the one asked for is running a meeting, or (without one) every room is. */
  const blocked = () => {
    const t = room();
    return t ? meetingAt(store.meeting, t)?.status === 'running' : store.meeting.rooms.every((r) => r.current?.status === 'running');
  };
  const def = () => MEETING_PATTERNS[pattern];
  const slug = () => slugify(titleIn.value.trim() || about.value.trim().split('\n')[0] || 'meeting', 32);
  const pr = () => Number(prSel.value) || undefined;
  const syncOutput = () => {
    if (!outputTouched) outputIn.value = def().output(slug(), pr());
    const problem = outputProblem(outputIn.value.trim());
    outputNote.textContent = problem ? `⚠️ ${problem}` : pattern === 'review' ? 'It ends when this file is written; the office then posts it on the PR as one review.' : store.project?.branch ? 'It ends when this file is written; the office commits it on the meeting’s own branch.' : 'It ends when this file is written.';
    outputNote.classList.toggle('bad', !!problem);
  };
  const syncBudget = () => {
    budgetIn.placeholder = def().unlimited ? 'No limit' : '';
    if (!budgetTouched) budgetIn.value = def().unlimited ? '' : String((roles.length * TOKENS_PER_SEAT) / 1000);
  };
  const renderRoles = () => {
    const d = def();
    count.textContent = String(roles.length);
    minus.toggleAttribute('disabled', roles.length <= d.seats.min);
    plus.toggleAttribute('disabled', roles.length >= d.seats.max);
    roleList.replaceChildren(
      ...roles.map((r, i) => {
        const input = h('input', { type: 'text', value: r, maxlength: 40, 'aria-label': `Role ${i + 1}` }) as HTMLInputElement;
        input.addEventListener('input', () => (roles[i] = input.value));
        return h('div.meeting-role', {}, h('span.muted', {}, i === 0 ? '👑' : `${i + 1}`), input);
      }),
    );
    syncBudget();
  };
  const pickPattern = (p: MeetingPattern) => {
    pattern = p;
    const d = def();
    roles = d.roles.slice(0, d.seats.default);
    for (const b of patterns.children) b.classList.toggle('on', (b as HTMLElement).dataset.pattern === p);
    for (const b of patterns.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.pattern === p));
    roundsIn.min = String(d.rounds.min);
    roundsIn.max = String(d.rounds.max);
    roundsIn.value = String(d.rounds.default);
    roundsIn.disabled = d.rounds.min === d.rounds.max;
    roundsNote.textContent = d.roundsNote;
    budgetNote.textContent = d.unlimited ? 'For everyone at the table together. Leave it empty for no limit; over a limit, the meeting stops.' : 'For everyone at the table together. Over it, the meeting stops.';
    prRow.classList.toggle('hidden', d.needs !== 'pr');
    partsRow.classList.toggle('hidden', d.needs !== 'parts');
    renderRoles();
    syncOutput();
  };
  for (const id of MEETING_PATTERN_IDS) {
    const d = MEETING_PATTERNS[id];
    patterns.append(h('button.meeting-pattern', { type: 'button', role: 'radio', 'data-pattern': id, onclick: () => pickPattern(id) }, h('b', {}, `${d.icon} ${d.label}`), h('small', {}, d.blurb)));
  }
  minus.addEventListener('click', () => {
    if (roles.length > def().seats.min) roles.pop();
    renderRoles();
  });
  plus.addEventListener('click', () => {
    if (roles.length < def().seats.max) roles.push(def().roles[roles.length] ?? `Worker ${roles.length + 1}`);
    renderRoles();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    syncOutput();
  });
  budgetIn.addEventListener('input', () => (budgetTouched = true));
  titleIn.addEventListener('input', syncOutput);
  about.addEventListener('input', syncOutput);
  prSel.addEventListener('change', syncOutput);

  const bodyEl = h(
    'form.meeting-form',
    {},
    patterns,
    h('div.meeting-field', {}, h('label', {}, 'What’s it about?'), about),
    h('div.meeting-field', {}, titleIn),
    prRow,
    partsRow,
    h('div.meeting-field', {}, h('label', {}, 'Output file'), outputIn, outputNote),
    h('div.meeting-field', {}, h('label.meeting-count', {}, 'Workers at the table', minus, count, plus), roleList),
    h('div.meeting-bounds', {}, h('div.meeting-field', {}, h('label', {}, 'Round limit'), roundsIn, roundsNote), h('div.meeting-field', {}, h('label', {}, 'Token budget (thousands)'), budgetIn, budgetNote)),
    provider.element,
    busy,
  ) as HTMLFormElement;
  bodyEl.noValidate = true;

  const send = () => {
    if (blocked()) return;
    const prompt = about.value.trim();
    if (!prompt) return about.focus();
    if (def().needs === 'pr' && !pr()) return prSel.focus();
    const parts = partsIn.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (def().needs === 'parts' && parts.length < roles.length - 1) {
      toast(`List at least ${roles.length - 1} parts, one per line, or seat fewer workers`, 'warn');
      return partsIn.focus();
    }
    const output = outputIn.value.trim();
    if (outputProblem(output)) return outputIn.focus();
    if (!provider.valid()) return;
    net.send({
      t: 'meeting.start',
      room: room(),
      pattern,
      prompt,
      title: titleIn.value.trim() || undefined,
      output,
      roles: roles.map((r) => r.trim()),
      parts: def().needs === 'parts' ? parts : undefined,
      pr: def().needs === 'pr' ? pr() : undefined,
      issue: preset?.issue,
      rounds: Number(roundsIn.value) || undefined,
      budget: Math.round((Number(budgetIn.value) || 0) * 1000) || undefined,
      provider: provider.value(),
      model: provider.model(),
      effort: provider.effort(),
    });
    toast(`🤝 Calling the ${def().label} meeting: the workers are heading for the meeting room`);
    done();
  };
  onSendKey(about, send);
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  submit.addEventListener('click', (e) => {
    e.preventDefault();
    send();
  });

  /** Keeps what depends on the board and the room up to date: the open PRs, and whether the room is free. */
  const refresh = () => {
    const open = store.pulls.items.filter((p) => p.state === 'OPEN');
    const want = prSel.value || (preset?.pr ? String(preset.pr) : '');
    const opts: (readonly [string, string])[] = open.map((p) => [String(p.number), `#${p.number} ${p.title}`] as const);
    if (preset?.pr && !open.some((p) => p.number === preset.pr)) opts.unshift([String(preset.pr), `#${preset.pr}`]);
    const key = JSON.stringify(opts);
    if (prSel.dataset.key !== key) {
      prSel.dataset.key = key;
      prSel.replaceChildren(h('option', { value: '' }, open.length || preset?.pr ? 'Pick a pull request…' : 'No open pull requests'), ...opts.map(([v, label]) => h('option', { value: v }, label.length > 70 ? `${label.slice(0, 69)}…` : label)));
      prSel.value = want;
      syncOutput();
    }
    const t = room();
    const m = t ? meetingAt(store.meeting, t) : null;
    const rs = store.meeting.rooms;
    busy.textContent = blocked()
      ? m
        ? `The room is busy with “${m.title}” until it ends or someone stops it.`
        : `Every meeting room is busy (${rs.map((r) => `“${r.current?.title}”`).join(', ')}) until one ends or someone stops it.`
      : (m ?? (!t && !rs.some((r) => !r.current) ? rs[0]?.current : null))
        ? `Starting this sends a finished meeting’s workers home.`
        : '';
    submit.toggleAttribute('disabled', blocked());
  };
  pickPattern(pattern);
  if (preset?.pr) prSel.value = String(preset.pr);
  refresh();
  setTimeout(() => (preset?.prompt ? titleIn : about).focus(), 0);
  return { body: bodyEl, foot: [h('span.grow', {}, 'Few rounds and a file at the end: that’s what keeps meetings cheap.'), cancel, submit], refresh };
}
