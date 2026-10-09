// ── LIVE SHARE LINKS ─────────────────────────────────────────────
// Each plan (PlanStore's planId + gameVersion key) can own one server-side
// link (/<version>/<id>) that follows every change. This half is pure
// bookkeeping over an injected storage so share-tests.js can drive it; the
// network side is LiveSync, next to the share-link UI code.
const LiveLinks = {
  key: 'pp_live_links',
  max: 100,
  ID: /^[0-9A-Za-z]{7}$/,
  planKey(data) {
    return data && typeof data.planId === 'string' ? (data.gameVersion || 'tbc') + '|' + data.planId : null;
  },
  read(storage) {
    try {
      const map = JSON.parse(storage.getItem(this.key) || '{}');
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch { return {}; }
  },
  get(storage, planKey) {
    const entry = planKey ? this.read(storage)[planKey] : null;
    return entry && this.ID.test(entry.id) ? entry : null;
  },
  findById(storage, id) {
    const map = this.read(storage);
    const planKey = Object.keys(map).find(k => map[k] && map[k].id === id);
    return planKey ? { planKey, ...map[planKey] } : null;
  },
  // One plan per link: binding an ID that another plan held moves it over.
  bind(storage, planKey, id, code, updatedAt) {
    const map = this.read(storage);
    for (const k of Object.keys(map)) if (map[k] && map[k].id === id) delete map[k];
    map[planKey] = { id, lastCode: code, updatedAt: updatedAt || 0, touchedAt: Date.now() };
    // Oldest beyond the cap go; the binding just written always stays.
    const stale = Object.keys(map).filter(k => k !== planKey)
      .sort((a, b) => (map[b].touchedAt || 0) - (map[a].touchedAt || 0)).slice(this.max - 1);
    for (const k of stale) delete map[k];
    storage.setItem(this.key, JSON.stringify(map));
    return map[planKey];
  },
  // What is on screen differs from what this browser last synced.
  needsPush(entry, localCode) {
    return !!entry && !!localCode && localCode !== entry.lastCode;
  },
  // A remote copy replaces the local plan only when it is newer than the last
  // sync and no local save is waiting; a waiting local save wins instead.
  shouldApply(entry, remote, pending) {
    return !!entry && !!remote && !pending && remote.updatedAt > entry.updatedAt;
  },
  // Mirrors MAX_CODE_LENGTH in api/share.js: a larger code is always refused.
  maxCodeLength: 32 * 1024,
  // Why the server would refuse this code (shown instead of retrying), or null.
  rejection(code) {
    if (typeof code !== 'string' || code.length <= this.maxCodeLength) return null;
    const kb = n => Math.ceil(n / 1024);
    return `plan is too large for a live link (${kb(code.length)} KB, limit ${kb(this.maxCodeLength)} KB)`;
  },
  // A 4xx a retry cannot fix. 404 (link gone: replaced by a new link), 408 and 429
  // (rate limited: back off) are transient.
  isPermanentFailure(status) {
    return status >= 400 && status < 500 && status !== 404 && status !== 408 && status !== 429;
  },
  // Retry-After header (seconds) -> milliseconds to back off.
  retryAfterMs(header, fallbackMs = 30000, capMs = 300000) {
    const seconds = Number(header);
    return seconds > 0 ? Math.min(seconds * 1000, capMs) : fallbackMs;
  },
};

// How often to poll a live link. 15 s while changes keep arriving; after a few polls
// that found nothing the gap widens (60 s, then 120 s) so an idle open tab costs almost
// nothing. Any change (remote, a local edit, coming back to the tab) starts over at 15 s.
const LivePoll = {
  fastMs: 15000,
  steps: [{ quiet: 8, ms: 120000 }, { quiet: 4, ms: 60000 }], // largest threshold first
  quiet: 0, // consecutive polls that found nothing new
  intervalMs(quiet = this.quiet) {
    const step = this.steps.find(s => quiet >= s.quiet);
    return step ? step.ms : this.fastMs;
  },
  sawChange() { this.quiet = 0; },
  sawNothing() { this.quiet++; },
};

// What a live-link update must not wipe from this browser's copy: the totem and
// aura picks (State.buffOverrides) are not part of the share code, and an open
// editor, picker or Undo points at players by uid, which a re-import renews.
// Players are matched by name; a pick follows its player to their new group
// and is dropped if that player can no longer provide the buff.
const LocalPicks = {
  capture() {
    return {
      players: [...State.groups.flat(), ...(State.bench || [])].map(p => ({ name: p.name, uid: p.uid })),
      overrides: JSON.parse(JSON.stringify(State.buffOverrides || {})),
    };
  },
  // Call once the update's players are in State.
  restore(snapshot) {
    const uidsByName = {};
    for (const p of snapshot.players) (uidsByName[p.name] ||= []).push(p.uid);
    for (const p of [...State.groups.flat(), ...(State.bench || [])]) {
      const uids = uidsByName[p.name];
      if (uids && uids.length) p.uid = uids.shift();
    }
    State.buffOverrides = {};
    for (const [key, pick] of Object.entries(snapshot.overrides)) {
      const [, uid, slot] = key.split(':');
      const groupIdx = State.groups.findIndex(g => g.some(p => p.uid === uid));
      if (groupIdx < 0) continue;
      const player = State.groups[groupIdx].find(p => p.uid === uid);
      const buff = pick && Config.Buffs[pick.buffId];
      if (buff && canProvideBuff(buff, player)) State.buffOverrides[`${groupIdx}:${uid}:${slot}`] = pick;
    }
  },
};

// AbortSignal.timeout where it exists, otherwise an AbortController timer, so
// a hung request cannot wedge sync on older browsers. undefined = no timeout.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

