// Outbound reads for the two imports: a Raid-Helper event and a Warcraft Logs report. The fetch is injected
// (ctx.fetch). Nothing here is stored; callers copy only what an officer adds.
import { HttpError } from './http.js';
import { DEFAULT_WCL_FLAVOUR, WCL_CLASS, WCL_FLAVOURS, ownValue } from './roster-data.js';

const RAID_HELPER_DEFAULT_BASE = 'https://raid-helper.dev';
const LOCAL_BASE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;
const EVENT_ID = /^\d{6,25}$/;
const WCL_CODE = /^[A-Za-z0-9]{16}$/;
const FETCH_TIMEOUT_MS = 10000;
const RAID_HELPER_MAX_BYTES = 1024 * 1024;
const WCL_MAX_BYTES = 2 * 1024 * 1024;

// RAID_HELPER_API_BASE / WCL_API_BASE are honoured only for a local fake (http://localhost:<port>), like DISCORD_API_BASE.
function localBase(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return LOCAL_BASE.test(raw) ? raw : null;
}

const sourceError = (message) => new HttpError(400, 'bad_request', message, { field: 'source' });

// ---------------------------------------------------------------------------
// Link parsing (ported from the planner's normalizeImportSource, js/modals.js)

const NOT_RAID_HELPER = 'Only Raid-Helper links can be imported (raid-helper.dev or raid-helper.xyz). Paste the event link or ID.';

// -> the event id (digits). Throws a 400 naming `source`.
export function parseRaidHelperSource(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw sourceError('Paste a Raid-Helper event link or ID.');
  if (EVENT_ID.test(text)) return text;
  if (/^\d+$/.test(text)) throw sourceError('A Raid-Helper event ID is 6 to 25 digits.');
  if (!/^https:\/\//i.test(text)) throw sourceError('Paste a Raid-Helper event link (https) or an event ID.');
  // https, no port or userinfo: the host group stops at the first / ? # or space, and must be a plain host name.
  const parts = text.match(/^https:\/\/([^/?#\s]+)(\/\S*)?(?:\s[\s\S]*)?$/i);
  const host = parts ? parts[1].toLowerCase() : '';
  const rest = parts ? (parts[2] || '') : '';
  const exactHost = host === 'raid-helper.dev' || host === 'raid-helper.xyz';
  const raidHelperHost = exactHost || /^(?:[a-z0-9-]+\.)+raid-helper\.(?:dev|xyz)$/.test(host);
  if (!raidHelperHost) throw sourceError(NOT_RAID_HELPER);
  let id;
  if (/^\/api\//i.test(rest)) {
    if (!exactHost) throw sourceError(NOT_RAID_HELPER);
    const api = rest.match(/^\/api\/v4\/events\/(\d+)/i);
    id = api ? api[1] : null;
  } else {
    const page = rest.match(/^\/(?:event|raidplan)\/(\d+)/i);
    id = page ? page[1] : null;
  }
  if (!id) throw sourceError('That Raid-Helper link is not an event link. Paste the event link or ID.');
  if (!EVENT_ID.test(id)) throw sourceError('A Raid-Helper event ID is 6 to 25 digits.');
  return id;
}

export function isEventId(value) {
  return typeof value === 'string' && EVENT_ID.test(value);
}

export function isWclCode(value) {
  return typeof value === 'string' && WCL_CODE.test(value);
}

export function isWclFlavour(value) {
  return typeof value === 'string' && WCL_FLAVOURS.includes(value);
}

// -> { flavour, code }. A bare code uses the guild's default flavour (a Forever guild must paste a full link).
export function parseWclSource(raw, gameVersion) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw sourceError('Paste a Warcraft Logs report link or code.');
  if (WCL_CODE.test(text)) {
    const flavour = DEFAULT_WCL_FLAVOUR[gameVersion];
    if (!flavour) throw sourceError('Paste the full Warcraft Logs link; a bare code does not say which site it is on.');
    return { flavour, code: text };
  }
  const match = text.match(/^https:\/\/(www|classic|fresh)\.warcraftlogs\.com\/reports\/([^/?#\s]+)(?:[/?#]\S*)?$/i);
  if (!match) throw sourceError('Paste a Warcraft Logs report link (www, classic or fresh) or the 16-character report code.');
  const code = match[2];
  if (/^a:/i.test(code)) throw sourceError('Anonymous reports cannot be imported.');
  if (!WCL_CODE.test(code)) throw sourceError('That report code is not 16 letters and digits.');
  return { flavour: match[1].toLowerCase(), code };
}

// ---------------------------------------------------------------------------
// Fetching

// Redirects are never followed. workerd accepts only "follow" and "manual" for `redirect`, so we ask for "manual"
// and treat any redirect answer (3xx, an opaque redirect, or status 0) as the source being unavailable.
export async function fetchWithTimeout(ctx, url, init, failure) {
  let response;
  try {
    response = await ctx.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw failure();
  }
  if (!response || response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw failure();
  }
  return response;
}

// The body text, capped; null when it is over the cap.
export async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

const raidHelperDown = () => new HttpError(502, 'raid_helper_unavailable', 'Raid-Helper did not answer. Try again in a moment.');

export const cleanLine = (value, max) => (typeof value === 'string'
  ? Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, max).join('')
  : '');

// Free text of an event (its description, its channel name) for zone inference only (never stored): line breaks become spaces, so words do not run together.
const freeText = (value, max) => cleanLine(typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ') : '', max) || null;

// -> { id, title, displayTitle | null, description | null, channelName | null, serverId, startTime (ms | null), signUps: [{ id, userId | null, name, className, specName, status, position }] }
export async function fetchRaidHelperEvent(ctx, id) {
  if (!isEventId(id)) throw new Error('fetchRaidHelperEvent needs a validated event id');
  const base = localBase(ctx.env.RAID_HELPER_API_BASE) || RAID_HELPER_DEFAULT_BASE;
  const response = await fetchWithTimeout(ctx, `${base}/api/v4/events/${id}`,
    { method: 'GET', headers: { Accept: 'application/json' } }, raidHelperDown);
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(403, 'event_private', 'That Raid-Helper event is private. Ask its leader to open it up.');
  }
  if (response.status === 404) throw new HttpError(404, 'not_found', 'Raid-Helper has no event with that ID.');
  if (!response.ok) throw raidHelperDown();
  let text;
  try { text = await readCapped(response, RAID_HELPER_MAX_BYTES); } catch { throw raidHelperDown(); }
  if (text === null) throw raidHelperDown();
  let event;
  try { event = JSON.parse(text); } catch { event = null; }
  if (!event || typeof event !== 'object' || !Array.isArray(event.signUps)) {
    throw new HttpError(502, 'not_an_event', 'Raid-Helper answered with something that is not an event.');
  }
  const startSeconds = Number(event.startTime);
  return {
    id: String(event.id ?? id),
    title: cleanLine(event.title, 100),
    displayTitle: freeText(event.displayTitle, 100),
    description: freeText(event.description, 2000),
    channelName: freeText(event.channelName, 100),
    serverId: event.serverId === undefined || event.serverId === null ? null : String(event.serverId),
    startTime: Number.isFinite(startSeconds) && startSeconds > 0 ? startSeconds * 1000 : null,
    signUps: event.signUps.filter((entry) => entry && typeof entry === 'object' && Number.isInteger(entry.id)).map((entry, index) => ({
      id: entry.id,
      userId: typeof entry.userId === 'string' && /^\d{17,20}$/.test(entry.userId) ? entry.userId : null,
      name: cleanLine(entry.name, 64),
      className: typeof entry.className === 'string' ? entry.className : '',
      specName: typeof entry.specName === 'string' ? entry.specName : '',
      status: typeof entry.status === 'string' ? entry.status : '',
      position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : 1_000_000 + index,
    })),
  };
}

// ---------------------------------------------------------------------------
// Warcraft Logs

const wclTokens = new Map();

// Tests reset the module-level token cache.
export function resetWclTokenCache() {
  wclTokens.clear();
}

function wclUrl(env, flavour, path) {
  const base = localBase(env.WCL_API_BASE) || `https://${flavour}.warcraftlogs.com`;
  return `${base}${path}`;
}

const wclDown = () => new HttpError(502, 'wcl_unavailable', 'Warcraft Logs did not answer. Try again in a moment.');

async function wclToken(ctx, flavour, forceNew = false) {
  const id = ctx.env.WCL_CLIENT_ID;
  const secret = ctx.env.WCL_CLIENT_SECRET;
  const cacheKey = `${flavour}|${id}`;
  const cached = wclTokens.get(cacheKey);
  if (!forceNew && cached && cached.expiresAt > ctx.now()) return cached.token;
  const response = await fetchWithTimeout(ctx, wclUrl(ctx.env, flavour, '/oauth/token'), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  }, wclDown);
  if (!response.ok) throw wclDown();
  let body;
  try { body = JSON.parse(await readCapped(response, 64 * 1024)); } catch { throw wclDown(); }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw wclDown();
  const lifetime = Number(body.expires_in);
  const seconds = Number.isFinite(lifetime) ? Math.min(Math.max(lifetime - 60, 0), 6 * 3600) : 0;
  wclTokens.set(cacheKey, { token: body.access_token, expiresAt: ctx.now() + seconds * 1000 });
  return body.access_token;
}

const WCL_QUERY = 'query($code: String!) { reportData { report(code: $code) { title startTime zone { name } masterData { actors(type: "Player") { name type subType server } } } } }';

async function postGraphql(ctx, flavour, query, variables, token) {
  return fetchWithTimeout(ctx, wclUrl(ctx.env, flavour, '/api/v2/client'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, wclDown);
}

export function requireWclConfigured(env) {
  if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
    throw new HttpError(503, 'wcl_not_configured', 'Warcraft Logs imports are not set up on this server.');
  }
}

// One GraphQL call (a 401 refetches the token once) -> the `reportData` object. Errors map to the Phase 2 error codes.
async function wclData(ctx, flavour, query, variables) {
  requireWclConfigured(ctx.env);
  let response = await postGraphql(ctx, flavour, query, variables, await wclToken(ctx, flavour));
  if (response.status === 401) response = await postGraphql(ctx, flavour, query, variables, await wclToken(ctx, flavour, true));
  if (!response.ok) throw wclDown();
  let body;
  try { body = JSON.parse(await readCapped(response, WCL_MAX_BYTES)); } catch { throw wclDown(); }
  if (!body || typeof body !== 'object') throw wclDown();
  if (Array.isArray(body.errors) && body.errors.length) {
    const text = body.errors.map((entry) => String(entry && entry.message)).join(' ');
    if (/permission|private|not authori[sz]ed|unauthori[sz]ed/i.test(text)) {
      throw new HttpError(403, 'report_private', 'That report is private or not available to Raidsmith.');
    }
    if (/does not exist|not found/i.test(text)) throw new HttpError(404, 'not_found', 'Warcraft Logs has no report with that code.');
    throw wclDown();
  }
  return body.data && body.data.reportData ? body.data.reportData : null;
}

const finiteMs = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

// -> { title, zone | null, startTime (ms | null), actors: [{ name, subType, server | null }] } (Pets are not filtered here).
export async function fetchWclReport(ctx, flavour, code) {
  if (!isWclFlavour(flavour) || !isWclCode(code)) throw new Error('fetchWclReport needs a validated flavour and code');
  const data = await wclData(ctx, flavour, WCL_QUERY, { code });
  const report = data && data.report;
  if (report === null || report === undefined) throw new HttpError(404, 'not_found', 'Warcraft Logs has no report with that code.');
  const actors = report.masterData && Array.isArray(report.masterData.actors) ? report.masterData.actors : [];
  return {
    title: cleanLine(report.title, 100),
    zone: report.zone && typeof report.zone.name === 'string' ? cleanLine(report.zone.name, 60) : null,
    startTime: finiteMs(report.startTime),
    actors: actors.filter((actor) => actor && typeof actor.name === 'string').map((actor) => ({
      name: actor.name,
      subType: typeof actor.subType === 'string' ? actor.subType : '',
      server: typeof actor.server === 'string' && actor.server.trim() ? cleanLine(actor.server, 40) : null,
    })),
  };
}

// Raid attendance reads only what presence needs: the fights (boss pulls with the players in them) and who they were.
// No title, events, damage, healing or gear is requested, so none can be stored.
const WCL_PULLS_QUERY = 'query($code: String!) { reportData { report(code: $code) { startTime endTime zone { name } owner { name } '
  + 'fights { id name encounterID kill startTime endTime friendlyPlayers } masterData { actors(type: "Player") { id name server subType } } } } }';

// -> { startTime, endTime | null, zone | null, owner | null,
//      pulls: [{ fightId, encounterId, name, kill, startedAt, endedAt, players: [{ name, server | null, class }] }] }
// Boss pulls only (encounterID > 0); a fight whose `kill` is null is still being uploaded and is skipped. startedAt is absolute
// (report start + the fight's offset). Pets and unknown sub types are dropped.
export async function fetchWclPulls(ctx, flavour, code) {
  if (!isWclFlavour(flavour) || !isWclCode(code)) throw new Error('fetchWclPulls needs a validated flavour and code');
  const data = await wclData(ctx, flavour, WCL_PULLS_QUERY, { code });
  const report = data && data.report;
  if (report === null || report === undefined) throw new HttpError(404, 'not_found', 'Warcraft Logs has no report with that code.');
  const startTime = finiteMs(report.startTime);
  if (startTime === null) throw wclDown();
  const actors = new Map();
  for (const actor of report.masterData && Array.isArray(report.masterData.actors) ? report.masterData.actors : []) {
    const classId = actor && typeof actor.subType === 'string' ? ownValue(WCL_CLASS, actor.subType) : undefined;
    if (!classId || typeof actor.name !== 'string' || !Number.isInteger(actor.id)) continue;
    actors.set(actor.id, {
      name: actor.name,
      server: typeof actor.server === 'string' && actor.server.trim() ? cleanLine(actor.server, 40) : null,
      class: classId,
    });
  }
  const pulls = [];
  for (const fight of Array.isArray(report.fights) ? report.fights : []) {
    if (!fight || !Number.isInteger(fight.id) || !(Number(fight.encounterID) > 0)) continue;
    if (fight.kill === null || fight.kill === undefined) continue;
    const offset = Number(fight.startTime);
    const endOffset = Number(fight.endTime);
    if (!Number.isFinite(offset) || !Number.isFinite(endOffset) || endOffset < offset) continue;
    const seen = new Set();
    const players = [];
    for (const id of Array.isArray(fight.friendlyPlayers) ? fight.friendlyPlayers : []) {
      const actor = actors.get(id);
      if (!actor || seen.has(id)) continue;
      seen.add(id);
      players.push(actor);
    }
    pulls.push({
      fightId: fight.id,
      encounterId: Number(fight.encounterID),
      name: cleanLine(fight.name, 60) || 'Boss',
      kill: fight.kill === true,
      startedAt: startTime + offset,
      endedAt: startTime + endOffset,
      players,
    });
  }
  pulls.sort((a, b) => a.startedAt - b.startedAt || a.fightId - b.fightId);
  return {
    startTime,
    endTime: finiteMs(report.endTime),
    zone: report.zone && typeof report.zone.name === 'string' ? cleanLine(report.zone.name, 60) : null,
    owner: report.owner && typeof report.owner.name === 'string' ? cleanLine(report.owner.name, 40) || null : null,
    pulls,
  };
}

const WCL_LIST_FIELDS = 'data { code title startTime endTime zone { name } owner { name } } has_more_pages';

// guildRef: { id } (the Warcraft Logs guild id) or { name, serverSlug, serverRegion }.
// -> { reports: [{ code, title, startTime, endTime | null, zone | null, owner | null }], hasMore }. Titles are shown, never stored.
export async function listWclReports(ctx, flavour, guildRef, page) {
  if (!isWclFlavour(flavour)) throw new Error('listWclReports needs a validated flavour');
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('listWclReports needs a page from 1');
  const byId = !!guildRef && Number.isInteger(guildRef.id);
  const query = byId
    ? `query($guildID: Int, $page: Int) { reportData { reports(guildID: $guildID, limit: 25, page: $page) { ${WCL_LIST_FIELDS} } } }`
    : `query($guildName: String, $guildServerSlug: String, $guildServerRegion: String, $page: Int) { reportData { reports(guildName: $guildName, guildServerSlug: $guildServerSlug, guildServerRegion: $guildServerRegion, limit: 25, page: $page) { ${WCL_LIST_FIELDS} } } }`;
  const variables = byId
    ? { guildID: guildRef.id, page }
    : { guildName: guildRef.name, guildServerSlug: guildRef.serverSlug, guildServerRegion: guildRef.serverRegion, page };
  const data = await wclData(ctx, flavour, query, variables);
  const list = data && data.reports;
  if (!list || !Array.isArray(list.data)) throw new HttpError(404, 'not_found', 'Warcraft Logs has no guild with those details.');
  return {
    reports: list.data.filter((entry) => entry && isWclCode(entry.code) && finiteMs(entry.startTime) !== null).map((entry) => ({
      code: entry.code,
      title: cleanLine(entry.title, 100),
      startTime: finiteMs(entry.startTime),
      endTime: finiteMs(entry.endTime),
      zone: entry.zone && typeof entry.zone.name === 'string' ? cleanLine(entry.zone.name, 60) : null,
      owner: entry.owner && typeof entry.owner.name === 'string' ? cleanLine(entry.owner.name, 40) || null : null,
    })),
    hasMore: list.has_more_pages === true,
  };
}
