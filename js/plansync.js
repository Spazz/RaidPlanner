// ── GUILD RAID PLANS IN THE DATABASE (client engine) ─────────────
// A guild raid's Planner plan ('raid:<id>') is stored whole on the server (worker/routes/plan-doc.js: GET/PUT
// /api/guild/:gid/raids/:rid/plan-doc, revision numbers, 409 when someone saved first). This file is the browser half and
// nothing in it runs by itself: RaidContext starts it once a raid plan is open in database mode, and every call site is
// guarded with `typeof PlanDb`, so a signed-out or standalone Planner never touches it.
//   PlanDbLinks  pure bookkeeping (key pp_plan_db): which plan is bound to which raid, at which revision, with unsent edits
//   PlanDb       the saver of the open plan: debounce, one request at a time, retries, 409 and permanent failures
//   PlanPoll     the co-editing pull of the open plan: a cadence that widens when idle and stands aside while the user works

// Which raid a plan belongs to and the revision this browser last saw: {planKey: {gid, rid, rev, dirty}}. `dirty` = this
// browser holds edits the server has not acknowledged (kept even when the tab closed first).
const PlanDbLinks = {
  key: 'pp_plan_db',
  max: 100,
  planKey(data) { return LiveLinks.planKey(data); },
  wellFormed(entry) {
    return !!entry && typeof entry === 'object' && typeof entry.gid === 'string' && !!entry.gid && typeof entry.rid === 'string' && !!entry.rid &&
      Number.isInteger(entry.rev) && entry.rev >= 0 && typeof entry.dirty === 'boolean';
  },
  read(storage) {
    try {
      const map = JSON.parse(storage.getItem(this.key) || '{}');
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch { return {}; }
  },
  get(storage, planKey) {
    const entry = planKey ? this.read(storage)[planKey] : null;
    return this.wellFormed(entry) ? entry : null;
  },
  _write(storage, map) {
    try { storage.setItem(this.key, JSON.stringify(map)); return true; } catch { return false; }
  },
  // Binds the plan to a raid at a revision, clean. Beyond the cap the least recently touched clean bindings go; dirty ones stay.
  bind(storage, planKey, { gid, rid, rev }) {
    if (!planKey) return null;
    const map = this.read(storage);
    map[planKey] = { gid, rid, rev, dirty: false, touchedAt: Date.now() };
    const stale = Object.keys(map).filter(k => k !== planKey && !(map[k] && map[k].dirty))
      .sort((a, b) => ((map[b] && map[b].touchedAt) || 0) - ((map[a] && map[a].touchedAt) || 0));
    const room = Math.max(0, this.max - 1 - Object.keys(map).filter(k => k !== planKey && map[k] && map[k].dirty).length);
    for (const k of stale.slice(room)) delete map[k];
    this._write(storage, map);
    return map[planKey];
  },
  // The server holds this revision. `dirty: true` keeps the flag when edits made since are still unsent.
  markSaved(storage, planKey, rev, { dirty = false } = {}) {
    const map = this.read(storage);
    if (!planKey || !this.wellFormed(map[planKey])) return null;
    map[planKey] = { ...map[planKey], rev, dirty, touchedAt: Date.now() };
    this._write(storage, map);
    return map[planKey];
  },
  markDirty(storage, planKey) {
    const map = this.read(storage);
    if (!planKey || !this.wellFormed(map[planKey])) return null;
    if (map[planKey].dirty) return map[planKey];
    map[planKey] = { ...map[planKey], dirty: true, touchedAt: Date.now() };
    this._write(storage, map);
    return map[planKey];
  },
  forget(storage, planKey) {
    const map = this.read(storage);
    if (!planKey || !Object.prototype.hasOwnProperty.call(map, planKey)) return false;
    delete map[planKey];
    return this._write(storage, map);
  },
  // Plan keys holding unsent edits: PlanStore.save never evicts these.
  dirtyKeys(storage) {
    const map = this.read(storage);
    return Object.keys(map).filter(k => this.wellFormed(map[k]) && map[k].dirty);
  },
  // What opening a raid plan does with this browser's copy, given the binding (or null), the revision the server holds now and
  // whether this browser's copy of the plan differs from the server's. Returns one of
  //   'migrate'          the server holds no plan yet (remoteRev 0): the first-open sources decide (plan section 6)
  //   'use-db'           take the server's plan
  //   'push-local'       the server still has the revision this browser edited from: send the unsent edits
  //   'use-db-with-undo' take the server's plan and offer the unsent local edits as Undo
  //   'use-db-save-copy' unbound but different local copy: save it to Saved copies first, then take the server's plan
  decide({ binding, remoteRev, localDiffers = true } = {}) {
    if (!Number.isInteger(remoteRev) || remoteRev <= 0) return 'migrate';
    if (!this.wellFormed(binding)) return localDiffers ? 'use-db-save-copy' : 'use-db';
    if (binding.rev === remoteRev) return binding.dirty ? 'push-local' : 'use-db';
    return binding.dirty ? 'use-db-with-undo' : 'use-db'; // the server moved on (or was reset): its plan wins
  },
};

// Bytes of a string as the request body counts them.
function planBodyBytes(text) {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}

const PLAN_STATUS_TEXT = {
  saved: 'Saved to the raid',
  saving: 'Saving to the raid...',
  retrying: 'Not saved to the raid yet, retrying. Your changes are safe on this device.',
  invalid: 'Not saved to the raid: the server refused this plan. Your changes are safe on this device.',
  'signed-out': 'Not saved to the raid: you are signed out. Your changes are safe on this device.',
  forbidden: 'Not saved to the raid: you can no longer edit it. Your changes are safe on this device.',
  gone: 'This raid no longer exists. Your changes are safe on this device.',
  'too-large': 'Not saved to the raid: the plan is too large. Your changes are safe on this device.',
  refused: 'Not saved to the raid: the server refused this plan. Your changes are safe on this device.',
};

// Why a status stops saving for good (a retry cannot fix it): 400 invalid plan, 401 signed out, 403 lost the right to edit,
// 404 raid gone, 413 too large; any other 4xx except 408/429 is 'refused'. Null = transient.
function planPermanentKind(status) {
  const named = { 400: 'invalid', 401: 'signed-out', 403: 'forbidden', 404: 'gone', 413: 'too-large' };
  if (named[status]) return named[status];
  return LiveLinks.isPermanentFailure(status) ? 'refused' : null;
}

function planDocUrl(gid, rid) {
  return `/api/guild/${encodeURIComponent(gid)}/raids/${encodeURIComponent(rid)}/plan-doc`;
}

// The saver of the open plan. A factory so tests can inject fetch, the clock and timers; `PlanDb` below is the app's instance.
// start() takes {gid, rid, rev, planKey, dirty, onConflict, onPermanent, onSaved, onStatus}; RaidContext calls onRender() after every
// plan change. Edits are compared as captured JSON (PlanStore.capture), sent after a 1.5 s pause, at least 3 s apart, one request
// at a time; an edit made while a request is out gets its own request when it returns.
function createPlanDb(deps = {}) {
  const limits = { debounceMs: 1500, minGapMs: 3000, retryFirstMs: 2000, retryMaxMs: 30000, keepaliveMaxBytes: 60 * 1024, timeoutMs: 15000, settleMaxMs: 10000, ...(deps.limits || {}) };
  const env = {
    fetch: (...args) => (deps.fetch || fetch)(...args),
    now: () => (deps.now || Date.now)(),
    setTimeout: (fn, ms) => (deps.setTimeout || setTimeout)(fn, ms),
    clearTimeout: id => (deps.clearTimeout || clearTimeout)(id),
    capture: () => (deps.capture || (() => PlanStore.capture()))(),
    storage: () => deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null),
    doc: () => deps.doc || (typeof document !== 'undefined' ? document : null),
    win: () => deps.win || (typeof window !== 'undefined' ? window : null),
    signal: ms => (deps.signal ? deps.signal(ms) : (typeof timeoutSignal === 'function' ? timeoutSignal(ms) : undefined)),
    schemaVersion: () => (deps.schemaVersion !== undefined ? deps.schemaVersion : (typeof PlanStore !== 'undefined' ? PlanStore.schemaVersion : 1)),
  };
  let s = null; // the open plan's saver state; null = not started / stopped

  const links = fn => { const storage = env.storage(); if (storage && s) { try { fn(storage); } catch {} } };
  const notify = () => { if (s && s.onStatus) { try { s.onStatus(); } catch {} } };
  const captureJson = () => { try { return JSON.stringify(env.capture()); } catch { return null; } };
  const needsSave = () => !!s && s.current !== null && s.current !== s.savedJson;
  const retryDelay = failures => Math.min(limits.retryMaxMs, limits.retryFirstMs * 2 ** Math.max(0, failures - 1));

  // One timer: the next request goes out no sooner than `delayMs`, the minimum gap since the last request started and any 429 backoff.
  function schedule(delayMs) {
    if (!s) return;
    env.clearTimeout(s.timer);
    const now = env.now();
    const wait = Math.max(delayMs, s.lastStart ? s.lastStart + limits.minGapMs - now : 0, s.backoffUntil - now, 0);
    s.timer = env.setTimeout(() => { if (s) { s.timer = null; fire(); } }, wait);
    s.timerAt = now + wait;
  }
  function clearTimer() { if (s) { env.clearTimeout(s.timer); s.timer = null; } }

  function fire() {
    if (!s || s.permanent || s.inFlight) return;
    if (!needsSave()) { settleClean(); return; }
    send();
  }

  // Nothing (left) to save: the server holds what is on screen.
  function settleClean() {
    clearTimer();
    s.failures = 0; s.failed = false;
    links(storage => PlanDbLinks.markSaved(storage, s.planKey, s.rev, { dirty: false }));
    notify();
  }

  function stopForGood(kind, status, message) {
    clearTimer();
    s.inFlight = false;
    s.permanent = { kind, status, message: message || '' };
    notify();
    if (s.onPermanent) { try { s.onPermanent({ kind, status, message: s.permanent.message }); } catch {} }
  }

  function failTransient() {
    s.inFlight = false;
    s.failures++;
    s.failed = true;
    schedule(retryDelay(s.failures));
    notify();
  }

  async function send({ keepalive = false } = {}) {
    const json = captureJson();
    if (json === null) return;
    s.current = json;
    s.inFlight = true;
    s.sentJson = json;
    s.lastStart = env.now();
    const token = s.token;
    notify();
    let res;
    try {
      res = await env.fetch(planDocUrl(s.gid, s.rid), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: `{"baseRev":${s.rev},"schemaVersion":${env.schemaVersion()},"plan":${json}}`,
        keepalive,
        signal: env.signal(limits.timeoutMs),
      });
    } catch {
      if (s && s.token === token) failTransient();
      return;
    }
    if (!s || s.token !== token) return;
    let body = {};
    try { body = (await res.json()) || {}; } catch { body = {}; }
    if (!s || s.token !== token) return;
    if (res.ok) return onSaved(body);
    if (res.status === 409) return onConflict(body);
    if (res.status === 429) {
      s.backoffUntil = env.now() + LiveLinks.retryAfterMs(res.headers && res.headers.get ? res.headers.get('Retry-After') : null);
      return failTransient();
    }
    const kind = planPermanentKind(res.status);
    if (kind) return stopForGood(kind, res.status, body.message);
    failTransient();
  }

  function onSaved(body) {
    if (Number.isInteger(body.rev)) s.rev = body.rev;
    s.savedJson = s.sentJson;
    s.inFlight = false;
    s.failures = 0; s.failed = false; s.backoffUntil = 0;
    s.savedAt = env.now();
    const more = needsSave();
    links(storage => PlanDbLinks.markSaved(storage, s.planKey, s.rev, { dirty: more }));
    if (more) schedule(limits.debounceMs);
    notify();
    if (s.onSaved) { try { s.onSaved({ rev: s.rev, updatedAt: body.updatedAt, unchanged: !!body.unchanged }); } catch {} }
  }

  // 409: someone saved first. Newest plan wins (user decision 2026-10-20): the server's plan goes to the merge callback, which applies it
  // and keeps the local state as Undo; returning true says it did. Without that answer, this browser's plan goes out again on top.
  async function onConflict(remote) {
    s.inFlight = false;
    const remoteRev = Number.isInteger(remote.rev) ? remote.rev : 0;
    if (!remote.plan) { s.rev = remoteRev; schedule(0); return; } // the document is gone (rev 0): this plan recreates it
    let applied = false;
    const token = s.token;
    if (s.onConflict) {
      try {
        applied = !!(await s.onConflict({ rev: remoteRev, plan: remote.plan, updatedBy: remote.updatedBy || null, schemaVersion: remote.schemaVersion, updatedAt: remote.updatedAt }));
      } catch { applied = false; }
    }
    if (!s || s.token !== token) return;
    s.rev = remoteRev;
    if (applied) {
      const json = captureJson();
      if (json !== null) { s.current = json; s.savedJson = json; }
      s.failures = 0; s.failed = false;
      clearTimer();
      links(storage => PlanDbLinks.markSaved(storage, s.planKey, s.rev, { dirty: false }));
      notify();
      if (s.onSaved) { try { s.onSaved({ rev: s.rev, updatedAt: remote.updatedAt, unchanged: false, adopted: true }); } catch {} }
      return;
    }
    schedule(0);
  }

  // Back online, or the tab is visible again: a failed save tries now (still no sooner than the minimum gap or a 429 backoff).
  function retryNow() {
    if (!s || s.permanent || s.inFlight || !s.failed || !needsSave()) return;
    schedule(0);
  }

  // The tab is hidden or closing: send the waiting save now, if it fits a keepalive request; otherwise it stays marked dirty
  // and the next open pushes it.
  function flushOnExit() {
    if (!s || s.permanent || s.inFlight) return;
    const json = captureJson();
    if (json === null || json === s.savedJson) return;
    s.current = json;
    links(storage => PlanDbLinks.markDirty(storage, s.planKey));
    if (env.now() < s.backoffUntil) return;
    if (planBodyBytes(`{"baseRev":${s.rev},"schemaVersion":${env.schemaVersion()},"plan":${json}}`) >= limits.keepaliveMaxBytes) return;
    clearTimer();
    send({ keepalive: true });
  }

  function listen() {
    const win = env.win(), doc = env.doc();
    const onOnline = () => retryNow();
    const onVisibility = () => { if (doc && doc.hidden) flushOnExit(); else retryNow(); };
    const onHide = () => flushOnExit();
    if (win && win.addEventListener) { win.addEventListener('online', onOnline); win.addEventListener('pagehide', onHide); }
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (win && win.removeEventListener) { win.removeEventListener('online', onOnline); win.removeEventListener('pagehide', onHide); }
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
    };
  }

  const api = {
    // Opens the saver on a plan that is on screen. `dirty: true` = the screen holds edits the server lacks (decide() said 'push-local'):
    // they go out at once. Otherwise what is on screen is the baseline.
    start({ gid, rid, rev, planKey, dirty = false, onConflict, onPermanent, onSaved, onStatus } = {}) {
      api.stop();
      if (!gid || !rid || !Number.isInteger(rev) || rev < 0 || !planKey) throw new Error('PlanDb.start needs gid, rid, rev and planKey');
      const json = captureJson();
      s = {
        gid, rid, rev, planKey, onConflict, onPermanent, onSaved, onStatus, token: Symbol('plan-db'),
        current: json, savedJson: dirty ? null : json, sentJson: null, inFlight: false, timer: null, timerAt: 0, lastStart: 0,
        failures: 0, failed: false, backoffUntil: 0, permanent: null, savedAt: null, unlisten: null,
      };
      links(storage => { PlanDbLinks.bind(storage, planKey, { gid, rid, rev }); if (dirty) PlanDbLinks.markDirty(storage, planKey); });
      s.unlisten = listen();
      if (dirty) schedule(0);
      notify();
    },
    stop() {
      if (!s) return;
      env.clearTimeout(s.timer);
      if (s.unlisten) s.unlisten();
      s = null;
    },
    // After every plan change (RaidContext.onCommit).
    onRender() {
      if (!s || s.permanent) return;
      const json = captureJson();
      if (json === null) return;
      s.current = json;
      if (s.inFlight) { // its own request follows when this one returns (onSaved)
        if (needsSave()) links(storage => PlanDbLinks.markDirty(storage, s.planKey));
        notify();
        return;
      }
      if (!needsSave()) { if (s.timer || s.failed) settleClean(); return; } // changed back to what the server holds
      links(storage => PlanDbLinks.markDirty(storage, s.planKey));
      if (!(s.failed && s.timer)) schedule(limits.debounceMs); // a failing save keeps its retry schedule
      notify();
    },
    // The open plan was replaced by the server's plan at `rev` (a poll update, or an opening decision): that is the new baseline.
    adopt(rev) {
      if (!s) return;
      if (Number.isInteger(rev)) s.rev = rev;
      const json = captureJson();
      if (json !== null) { s.current = json; s.savedJson = json; }
      clearTimer();
      s.failures = 0; s.failed = false;
      links(storage => PlanDbLinks.markSaved(storage, s.planKey, s.rev, { dirty: false }));
      notify();
    },
    // Resolves true once the server holds what is on screen, false when it cannot (stopped, refused, offline past the wait).
    async settle() {
      if (!s) return false;
      const token = s.token;
      const started = env.now();
      if (needsSave() && !s.inFlight && !s.permanent) schedule(0);
      while (s && s.token === token && !s.permanent && (needsSave() || s.inFlight) && env.now() - started < limits.settleMaxMs) {
        await new Promise(resolve => env.setTimeout(resolve, 100));
      }
      return !!s && s.token === token && !s.permanent && !needsSave() && !s.inFlight;
    },
    // Unsent changes or a request in flight: the poll stands aside.
    busy() { return !!s && !s.permanent && (needsSave() || s.inFlight); },
    active() { return !!s; },
    rev() { return s ? s.rev : null; },
    savedAt() { return s ? s.savedAt : null; },
    failure() { return s && s.permanent ? { ...s.permanent } : null; },
    statusKey() {
      if (!s) return null;
      if (s.permanent) return s.permanent.kind;
      if (s.failed) return 'retrying';
      return needsSave() || s.inFlight ? 'saving' : 'saved';
    },
    statusText(fallback) {
      const key = api.statusKey();
      return key ? PLAN_STATUS_TEXT[key] : fallback;
    },
  };
  return api;
}
const PlanDb = createPlanDb();

// The pull of the open plan: GET plan-doc?since=<rev> answers {changed:false} or the newer plan. 4 s while changes keep arriving or the
// user edits, 10 s after 5 quiet polls, 30 s after 20. Paused while the tab is hidden (an immediate pull on return); a poll is skipped
// while a save is pending or in flight, during a drag, or while the user is in the editor, picker or notes (checked again after the
// answer arrives, so a plan is never swapped under them). start() takes {gid, rid, rev, onPlan, onFailure}: onPlan({rev, plan,
// updatedBy, schemaVersion, updatedAt}) applies the plan (return false = not applied, it will be offered again).
function createPlanPoll(deps = {}) {
  const config = { fastMs: 4000, steps: [{ quiet: 20, ms: 30000 }, { quiet: 5, ms: 10000 }], timeoutMs: 15000, ...(deps.config || {}) }; // largest threshold first
  const env = {
    fetch: (...args) => (deps.fetch || fetch)(...args),
    now: () => (deps.now || Date.now)(),
    setTimeout: (fn, ms) => (deps.setTimeout || setTimeout)(fn, ms),
    clearTimeout: id => (deps.clearTimeout || clearTimeout)(id),
    doc: () => deps.doc || (typeof document !== 'undefined' ? document : null),
    signal: ms => (deps.signal ? deps.signal(ms) : (typeof timeoutSignal === 'function' ? timeoutSignal(ms) : undefined)),
    saving: () => (deps.saving ? deps.saving() : (typeof PlanDb !== 'undefined' && PlanDb.busy())),
    editing: () => (deps.editing ? deps.editing() : UserEditing.active(env.doc())),
    dragging: () => {
      if (deps.dragging) return deps.dragging();
      const doc = env.doc();
      return (typeof dragData !== 'undefined' && !!dragData) || !!(doc && doc.querySelector && doc.querySelector('.dragging'));
    },
  };
  let s = null;
  const hidden = () => { const doc = env.doc(); return !!(doc && doc.hidden); };
  const blocked = () => env.saving() || env.dragging() || env.editing();

  function intervalMs(quiet) {
    const step = config.steps.find(x => quiet >= x.quiet);
    return step ? step.ms : config.fastMs;
  }
  function schedule(ms) {
    if (!s) return;
    env.clearTimeout(s.timer);
    s.timer = hidden() ? null : env.setTimeout(tick, ms);
    s.timerAt = env.now() + ms;
  }
  async function tick() {
    if (!s) return;
    s.timer = null;
    const token = s.token;
    let outcome = 'skipped';
    try { outcome = await pull(); } catch { outcome = 'skipped'; }
    if (!s || s.token !== token || outcome === 'stopped') return;
    if (outcome === 'changed') s.quiet = 0;
    else if (outcome === 'quiet') s.quiet++;
    schedule(intervalMs(s.quiet));
  }

  // One poll: 'changed' | 'quiet' | 'skipped' | 'stopped' (a permanent failure, reported to onFailure).
  async function pull() {
    if (!s || s.inFlight || hidden() || blocked() || env.now() < s.backoffUntil) return 'skipped';
    const token = s.token;
    s.inFlight = true;
    let res;
    try {
      res = await env.fetch(`${planDocUrl(s.gid, s.rid)}?since=${s.rev}`, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }, signal: env.signal(config.timeoutMs) });
    } catch { if (s && s.token === token) s.inFlight = false; return 'skipped'; }
    if (!s || s.token !== token) return 'stopped';
    s.inFlight = false;
    if (res.status === 429) {
      s.backoffUntil = env.now() + LiveLinks.retryAfterMs(res.headers && res.headers.get ? res.headers.get('Retry-After') : null);
      return 'skipped';
    }
    if (!res.ok) {
      const kind = [401, 403, 404].includes(res.status) ? planPermanentKind(res.status) : null;
      if (!kind) return 'skipped';
      const { onFailure } = s;
      api.stop();
      if (onFailure) { try { onFailure({ kind, status: res.status }); } catch {} }
      return 'stopped';
    }
    let body;
    try { body = await res.json(); } catch { return 'skipped'; }
    if (!s || s.token !== token) return 'stopped';
    if (!body || body.changed === false) return 'quiet';
    if (!body.plan || !Number.isInteger(body.rev) || body.rev <= s.rev) return 'quiet'; // our own save, or the plan is gone (the saver's 409 finds that out)
    if (hidden() || blocked()) return 'skipped'; // the user started working while the answer travelled: ask again later
    let applied;
    try { applied = s.onPlan({ rev: body.rev, plan: body.plan, updatedBy: body.updatedBy || null, schemaVersion: body.schemaVersion, updatedAt: body.updatedAt }); } catch { applied = false; }
    if (applied === false) return 'skipped';
    if (s) s.rev = body.rev;
    return 'changed';
  }

  const api = {
    config,
    intervalMs,
    start({ gid, rid, rev, onPlan, onFailure } = {}) {
      api.stop();
      if (!gid || !rid || !Number.isInteger(rev) || rev < 0 || typeof onPlan !== 'function') throw new Error('PlanPoll.start needs gid, rid, rev and onPlan');
      const doc = env.doc();
      const onVisibility = () => { if (!s) return; if (hidden()) { env.clearTimeout(s.timer); s.timer = null; } else api.wake({ now: true }); };
      s = { gid, rid, rev, onPlan, onFailure, token: Symbol('plan-poll'), timer: null, timerAt: 0, quiet: 0, inFlight: false, backoffUntil: 0, unlisten: null };
      if (doc && doc.addEventListener) {
        doc.addEventListener('visibilitychange', onVisibility);
        s.unlisten = () => { if (doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility); };
      }
      schedule(config.fastMs);
    },
    stop() {
      if (!s) return;
      env.clearTimeout(s.timer);
      if (s.unlisten) s.unlisten();
      s = null;
    },
    // Our own save moved the revision on.
    setRev(rev) { if (s && Number.isInteger(rev) && rev > s.rev) s.rev = rev; },
    // Back to the fast cadence (a local edit, the tab coming back); `now` pulls immediately.
    wake({ now = false } = {}) {
      if (!s) return;
      s.quiet = 0;
      if (now) schedule(0);
      else if (s.timer === null || s.timerAt - env.now() > config.fastMs) schedule(config.fastMs); // only ever sooner, so edits do not keep postponing the pull
    },
    active() { return !!s; },
    rev() { return s ? s.rev : null; },
    quiet() { return s ? s.quiet : 0; },
  };
  return api;
}
const PlanPoll = createPlanPoll();
