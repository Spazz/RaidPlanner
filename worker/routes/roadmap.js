// The idea box on the Future enhancements page. Any signed-in person suggests an idea (title, area, optional details);
// every signed-in person reads the list. App-wide, not scoped to a guild. There are no edit or delete routes: the
// orchestrator triages the rows with tools/roadmap-ideas.js, and Delete my data unlinks them (submitted_by goes NULL).
import { HttpError, jsonResponse } from '../http.js';
import { newId } from '../ids.js';
import { IDEA_LIMIT, IDEA_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';
import { MULTI_LINE_STRIP, SINGLE_LINE_STRIP } from '../roster-data.js';

// The same list as AREAS in js/guild/pages-roadmap.js and the CHECK in migrations/0007_roadmap_ideas.sql (a test keeps them equal).
export const IDEA_AREAS = ['loot', 'roster', 'raids', 'attendance', 'signups', 'planner', 'discord', 'battlenet', 'platform', 'guilds', 'other'];
export const MIN_TITLE = 3;
export const MAX_TITLE = 120;
export const MAX_DETAILS = 2000;
// The list is capped: 20 ideas an hour per person adds up, and the page shows a screenful.
const MAX_LISTED = 300;

const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });

function cleanTitle(raw) {
  if (typeof raw !== 'string') throw bad('Give your idea a title.', 'title');
  const text = raw.replace(SINGLE_LINE_STRIP, ' ').replace(/ {2,}/g, ' ').trim();
  const length = Array.from(text).length;
  if (length < MIN_TITLE || length > MAX_TITLE) throw bad(`The title must be ${MIN_TITLE} to ${MAX_TITLE} characters.`, 'title');
  return text;
}

// Optional; line breaks stay. Empty or missing is null.
function cleanDetails(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad('The details must be text.', 'details');
  const text = raw.replace(/\r\n?/g, '\n').replace(MULTI_LINE_STRIP, '').trim();
  if (Array.from(text).length > MAX_DETAILS) throw bad(`The details can be at most ${MAX_DETAILS} characters.`, 'details');
  return text || null;
}

function cleanArea(raw) {
  if (typeof raw !== 'string' || !IDEA_AREAS.includes(raw)) throw bad('Pick the area your idea belongs to.', 'area');
  return raw;
}

// A row as the page sees it. Who submitted it is never sent; `mine` says whether the viewer did.
export function ideaView(row, viewerId) {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    area: row.area,
    status: row.status,
    roadmapId: row.roadmap_id,
    triageNote: row.triage_note,
    createdAt: row.created_at,
    mine: !!viewerId && row.submitted_by === viewerId,
  };
}

// Newest first.
export async function listIdeas(ctx) {
  const result = await ctx.db.prepare(
    `SELECT id, title, details, area, status, roadmap_id, triage_note, submitted_by, created_at
       FROM roadmap_ideas ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(MAX_LISTED).all();
  return jsonResponse({ ideas: result.results.map((row) => ideaView(row, ctx.session.user.id)) });
}

export async function createIdea(ctx) {
  const { body } = ctx;
  const userId = ctx.session.user.id;
  const title = cleanTitle(body.title);
  const details = cleanDetails(body.details);
  const area = cleanArea(body.area);
  // An invalid idea is refused above, before the hour's window is counted.
  await enforceRateLimit(ctx.db, userId, ctx.now(), { key: `idea:${userId}`, limit: IDEA_LIMIT, windowMs: IDEA_WINDOW_MS });
  const id = newId('ri', ctx.randomBytes);
  const now = ctx.now();
  await ctx.db.prepare(
    `INSERT INTO roadmap_ideas (id, title, details, area, status, roadmap_id, triage_note, submitted_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new', NULL, NULL, ?, ?, ?)`,
  ).bind(id, title, details, area, userId, now, now).run();
  return jsonResponse({
    idea: ideaView({ id, title, details, area, status: 'new', roadmap_id: null, triage_note: null, submitted_by: userId, created_at: now }, userId),
  }, 201);
}
