// What the hook helpers of Codex and Antigravity share (both are self-contained scripts, so this is
// source text they carry, not an import): the bounded copy of a question tool's input that the kanban
// keeps as a task comment (heardQuestion in kanban/engine/signals.ts reads it as `tool_input`).

/** Defines QUESTION_TOOL (the kanban's own pattern: keep the two the same) and questionInput(raw) in a helper's source. */
export const QUESTION_INPUT_SOURCE = String.raw`// The bridge is deliberately minimal: of a tool's input only a question tool's question (and its options) is forwarded, as bounded strings.
// Nothing is cut silently: a clipped string ends in a marker saying how much was left out, and the counts of dropped questions and options are forwarded as numbers.
const QUESTION_TOOL = /(?:^|[._])(?:AskUserQuestion|ask_user_question|request_user_input|ask_question)$/;
const MAX_QUESTION = 2000;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const clip = (value) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  return text.length > MAX_QUESTION ? text.slice(0, MAX_QUESTION) + ' (cut here: ' + (text.length - MAX_QUESTION) + ' more characters)' : text;
};
const questionInput = (raw) => {
  let input = raw;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return undefined; } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  for (const key of ['question', 'prompt', 'message']) { const text = clip(input[key]); if (text) out[key] = text; }
  if (Array.isArray(input.questions)) {
    const questions = [];
    if (input.questions.length > MAX_QUESTIONS) out.moreQuestions = input.questions.length - MAX_QUESTIONS;
    for (const q of input.questions.slice(0, MAX_QUESTIONS)) {
      if (!q || typeof q !== 'object') continue;
      const item = {};
      for (const key of ['question', 'header']) { const text = clip(q[key]); if (text) item[key] = text; }
      if (Array.isArray(q.options)) {
        const options = [];
        for (const o of q.options.slice(0, MAX_OPTIONS)) {
          if (typeof o === 'string') { const label = clip(o); if (label) options.push(label); continue; }
          if (!o || typeof o !== 'object') continue;
          const option = {};
          for (const key of ['label', 'description']) { const text = clip(o[key]); if (text) option[key] = text; }
          if (option.label) options.push(option);
        }
        if (options.length) item.options = options;
        if (q.options.length > MAX_OPTIONS) item.moreOptions = q.options.length - MAX_OPTIONS;
      }
      if (item.question) questions.push(item);
    }
    if (questions.length) out.questions = questions;
  }
  return Object.keys(out).length ? out : undefined;
};
`;
