// Pure rules of the applications inbox (no I/O): the officer-written questions of a guild and the answers an applicant gives to them.
import { base64url } from './ids.js';
import { MULTI_LINE_STRIP, SINGLE_LINE_STRIP } from './roster-data.js';

export const MAX_QUESTIONS = 8;
export const QUESTION_TYPES = ['short', 'long', 'choice'];
export const LABEL_MAX = 120;
export const OPTION_MAX = 40;
export const MAX_OPTIONS = 8;
export const MIN_OPTIONS = 2;
export const ANSWER_MAX = { short: 200, long: 1500 };
export const CONTACT_MAX = 100;
export const NOTES_MAX = 2000;
export const QUESTION_ID = /^[A-Za-z0-9_-]{4,16}$/;
export const APPLY_STATUSES = ['new', 'reviewing', 'accepted', 'declined'];

// One line of plain text: control and bidi characters become spaces, runs of spaces collapse. -> string (maybe empty)
export function oneLine(raw) {
  return typeof raw === 'string' ? raw.replace(SINGLE_LINE_STRIP, ' ').replace(/\s+/g, ' ').trim() : '';
}

// Several lines: line breaks stay, other control characters go, each line trimmed, three or more breaks in a row become two.
export function manyLines(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r\n?/g, '\n').replace(MULTI_LINE_STRIP, ' ').split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const length = (text) => Array.from(text).length;

// raw: the body's questions. -> { ok: true, value: [{ id, label, type, options, required }] } or { ok: false, message, index }.
// A question keeps the id it came with (so the form an applicant already has still matches) when it is well formed and not repeated; any other gets
// a fresh one from `randomBytes`.
export function readQuestions(raw, randomBytes) {
  if (!Array.isArray(raw)) return { ok: false, message: 'Send the questions as a list.', index: null };
  if (raw.length > MAX_QUESTIONS) return { ok: false, message: `A guild can ask at most ${MAX_QUESTIONS} questions.`, index: null };
  const used = new Set();
  const value = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    const fail = (message) => ({ ok: false, message, index });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('Each question must be an object.');
    const label = oneLine(entry.label);
    if (!label || length(label) > LABEL_MAX) return fail(`A question is 1 to ${LABEL_MAX} characters.`);
    if (!QUESTION_TYPES.includes(entry.type)) return fail('Pick short text, long text or choice.');
    let options = [];
    if (entry.type === 'choice') {
      if (!Array.isArray(entry.options)) return fail('A choice question needs its options.');
      options = [];
      for (const option of entry.options) {
        const text = oneLine(option);
        if (!text || length(text) > OPTION_MAX) return fail(`An option is 1 to ${OPTION_MAX} characters.`);
        if (!options.some((known) => known.toLowerCase() === text.toLowerCase())) options.push(text);
      }
      if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return fail(`A choice question has ${MIN_OPTIONS} to ${MAX_OPTIONS} different options.`);
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') return fail('required must be true or false.');
    let id = typeof entry.id === 'string' && QUESTION_ID.test(entry.id) && !used.has(entry.id) ? entry.id : null;
    while (!id || used.has(id)) id = base64url(randomBytes(6));
    used.add(id);
    value.push({ id, label, type: entry.type, options, required: entry.required === true });
  }
  return { ok: true, value };
}

// The stored JSON -> questions (a damaged value reads as none).
export function questionsOf(stored) {
  try {
    const list = JSON.parse(stored);
    return Array.isArray(list) ? list.filter((q) => q && typeof q.id === 'string' && typeof q.label === 'string' && QUESTION_TYPES.includes(q.type)) : [];
  } catch {
    return [];
  }
}

// questions: the guild's. raw: { <question id>: text }. -> { ok: true, value: [{ label, type, answer }] } or { ok: false, message, field }.
// The stored answers carry the question's wording, so editing the questions later changes no old application.
export function readAnswers(questions, raw) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = [];
  for (const question of questions) {
    const field = `answers.${question.id}`;
    const has = Object.prototype.hasOwnProperty.call(given, question.id);
    const text = has ? (question.type === 'long' ? manyLines(given[question.id]) : oneLine(given[question.id])) : '';
    if (!text) {
      if (question.required) return { ok: false, message: `Answer: ${question.label}`, field };
      continue;
    }
    if (question.type === 'choice') {
      const option = question.options.find((known) => known.toLowerCase() === text.toLowerCase());
      if (!option) return { ok: false, message: `Pick one of the options for: ${question.label}`, field };
      value.push({ label: question.label, type: question.type, answer: option });
      continue;
    }
    const max = ANSWER_MAX[question.type];
    if (length(text) > max) return { ok: false, message: `That answer is too long (at most ${max} characters).`, field };
    value.push({ label: question.label, type: question.type, answer: text });
  }
  return { ok: true, value };
}
