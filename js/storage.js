// ── STORAGE SAFETY (feature-backlog-3.md #3) ──────────────────────
// A raid leader who has used the tool for months (or is on a browser with a
// smaller per-origin quota — Safari, some mobile browsers) can hit
// QuotaExceededError on a routine save. Every localStorage.setItem call in
// the UI layer that didn't already have a deliberate try/catch of its own
// (persistWorkingPlan and rememberImport both need the raw throw to reach
// their own specific failure messaging, so they're deliberately left alone)
// goes through this instead, so the failure surfaces as a toast rather than
// an uncaught exception that aborts whatever click triggered it mid-way.
// Defined here (before the UI-RENDERING split) rather than next to showToast
// so the pure Spotlight/DataBackup modules below can also use it — `typeof`
// guards the showToast call so this stays safe to run standalone in tests.
function safeSetItem(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (e) {
    try {
      if (typeof showToast === 'function') {
        showToast("Couldn't save — your browser's storage is full. Export a backup and clear old saved rosters.");
      }
    } catch {}
    return false;
  }
}

// Import snapshots are separate from named saves. Storage is injected for tests.
const ImportHistory = {
  key: 'pp_import_history',
  limit: 30,
  read(storage) {
    try {
      const items = JSON.parse(storage.getItem(this.key) || '[]');
      return Array.isArray(items) ? items.filter(item => item && typeof item.id === 'string' &&
        Number.isFinite(item.importedAt) && item.roster && Array.isArray(item.roster.players) &&
        Array.isArray(item.roster.bench) && Config.Raids[item.roster.raid] &&
        [...item.roster.players, ...item.roster.bench].every(p => p && typeof p.name === 'string' &&
          typeof p.class === 'string' && typeof p.spec === 'string' && typeof p.role === 'string' &&
          Number.isInteger(p.groupNumber))).slice(0, this.limit) : [];
    } catch { return []; }
  },
  add(storage, source) {
    const importedAt = Date.now();
    const item = {
      id: importedAt.toString(36) + '-' + Math.random().toString(36).slice(2),
      importedAt, source, roster: Import.exportRoster(),
    };
    storage.setItem(this.key, JSON.stringify([item, ...this.read(storage)].slice(0, this.limit)));
    return item;
  },
  remove(storage, id) {
    storage.setItem(this.key, JSON.stringify(this.read(storage).filter(item => item.id !== id)));
  },
};

// Full working plans preserve identities, overrides, and mode independently of export formats.
const PlanStore = {
  key: 'pp_working_plans',
  capture() {
    return JSON.parse(JSON.stringify({planId:State.planId, groups:State.groups, bench:State.bench, unplaced:State.unplaced || [],
      campfires:State.campfires, gameVersion:State.gameVersion, selectedRaid:State.selectedRaid, rosterName:State.rosterName, sourceEventId:State.sourceEventId, eventStartTime:State.eventStartTime,
      optimizerMode:State.optimizerMode, buffOverrides:State.buffOverrides, preferredSlots:State.preferredSlots, preserveGroupOrder:State.preserveGroupOrder,
      notes:State.notes || '',
      assignments:State.assignments, backups:State.backups, playerConstraints:Constraints.clean(State.playerConstraints),
      drummers:Drummers.clean(State.drummers)}));
  },
  valid(data) {
    return data && typeof data.planId === 'string' && validVersionRaid(data.gameVersion || versionForRaid(data.selectedRaid) || 'tbc', data.selectedRaid) &&
      typeof data.rosterName === 'string' && Array.isArray(data.groups) && data.groups.every(Array.isArray) &&
      ['max_dps','tank_mit','balanced','relaxed'].includes(data.optimizerMode) &&
      (data.notes === undefined || typeof data.notes === 'string') &&
      (data.backups === undefined || (data.backups && typeof data.backups === 'object' && !Array.isArray(data.backups))) &&
      (data.playerConstraints === undefined || Array.isArray(data.playerConstraints)) &&
      (data.drummers === undefined || Array.isArray(data.drummers)) &&
      (data.unplaced === undefined || Array.isArray(data.unplaced)) &&
      data.buffOverrides && typeof data.buffOverrides === 'object' && !Array.isArray(data.buffOverrides) &&
      Array.isArray(data.bench) && [...data.groups.flat(), ...data.bench].every(p => p &&
        typeof p.uid === 'string' && typeof p.name === 'string' && typeof p.class === 'string' && typeof p.spec === 'string' && typeof p.role === 'string');
  },
  // Entries are {updatedAt, schemaVersion, data}. schemaVersion is the shape of
  // `data`; an entry written before it existed counts as version 1. A bump adds
  // migrations[fromVersion] = data => data at fromVersion + 1.
  schemaVersion: 1,
  migrations: {},
  // At most this many plans are kept; the oldest by updatedAt go first, never
  // the plan being saved or one bound to a live link.
  max: 50,
  saveDelayMs: 400,
  corruptKey: 'pp_working_plans_corrupt',
  // planKey -> updatedAt this tab last wrote or read, to tell another tab's save from its own.
  known: {},
  pending: null,
  timer: null,

  // The entry at the current schema, or null when it cannot be read here (a
  // newer build wrote it, or no migration path exists). Unreadable entries are
  // left in storage untouched, never dropped.
  migrate(entry) {
    if (!entry || typeof entry !== 'object') return null;
    let version = Number.isInteger(entry.schemaVersion) && entry.schemaVersion >= 1 ? entry.schemaVersion : 1;
    if (version > this.schemaVersion) return null;
    let data = entry.data;
    while (version < this.schemaVersion) {
      const step = this.migrations[version];
      if (typeof step !== 'function') return null;
      try { data = step(JSON.parse(JSON.stringify(data))); } catch { return null; }
      version++;
    }
    return { ...entry, schemaVersion: version, data };
  },
  // Every stored entry as-is, whatever its shape; `corrupt` holds the raw text when the key is not a JSON list.
  _load(storage) {
    let raw;
    try { raw = storage.getItem(this.key); } catch { return { entries: [], corrupt: null }; }
    if (!raw) return { entries: [], corrupt: null };
    try {
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) return { entries, corrupt: null };
    } catch {}
    return { entries: [], corrupt: raw };
  },
  // The entries of a stored list this build can read, at the current schema. Pure.
  readable(entries) {
    const plans = [];
    for (const entry of entries) {
      const plan = this.migrate(entry);
      if (plan && this.valid(plan.data)) plans.push(plan);
    }
    return plans;
  },
  // Whether a backup may carry this entry: a plan this build reads must pass
  // valid(); one it cannot read only because a newer build wrote it is passed on as is.
  portable(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const plan = this.migrate(entry);
    if (plan) return this.valid(plan.data);
    return !!entry.data && typeof entry.data === 'object';
  },
  // The readable plans, newest save first. Anything else stays in storage.
  read(storage) {
    if (this.pending && this.pending.storage === storage) this.flush();
    const plans = this.readable(this._load(storage).entries);
    for (const plan of plans) this.known[LiveLinks.planKey(plan.data)] = plan.updatedAt;
    return plans;
  },
  isQuotaError(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
  },
  // Read-modify-write: this plan goes first, replacing its own earlier entry,
  // and every other entry is kept as stored, readable or not. Past the cap, or
  // when the browser reports its storage full, the oldest unprotected entries
  // go. Throws if it still cannot be written; returns {evicted: [names], reason},
  // reason being 'quota' when the browser ran out of room, 'cap' when only the
  // plan limit forced the removal, null when nothing was removed.
  save(storage, data) {
    const planKey = LiveLinks.planKey(data);
    const { entries, corrupt } = this._load(storage);
    if (corrupt) { try { storage.setItem(this.corruptKey, corrupt); } catch {} }
    const entry = { updatedAt: Date.now(), schemaVersion: this.schemaVersion, data };
    const list = [entry, ...entries.filter(e => !(planKey && e && e.data && LiveLinks.planKey(e.data) === planKey))];
    let bound = [];
    try { bound = Object.keys(LiveLinks.read(storage)); } catch {}
    const protectedKeys = new Set([planKey, ...bound]);
    const evicted = [];
    let reason = null;
    const stamp = e => (e && Number.isFinite(e.updatedAt) ? e.updatedAt : 0);
    const evictOldest = () => {
      let oldest = -1;
      for (let i = 1; i < list.length; i++) {
        if (list[i] && list[i].data && protectedKeys.has(LiveLinks.planKey(list[i].data))) continue;
        if (oldest < 0 || stamp(list[i]) < stamp(list[oldest])) oldest = i;
      }
      if (oldest < 0) return false;
      const gone = list.splice(oldest, 1)[0];
      evicted.push(gone && gone.data && typeof gone.data.rosterName === 'string' ? gone.data.rosterName : 'an unreadable plan');
      return true;
    };
    while (list.length > this.max && evictOldest()) reason = 'cap';
    for (;;) {
      try { storage.setItem(this.key, JSON.stringify(list)); break; }
      catch (err) { if (!this.isQuotaError(err) || !evictOldest()) throw err; reason = 'quota'; }
    }
    if (planKey) this.known[planKey] = entry.updatedAt;
    return { evicted, reason };
  },
  // save() after a short pause, so typing does not rewrite every plan on each keystroke.
  // onDone gets {ok, evicted} or {ok:false, error}. A waiting save of another plan goes out first.
  saveSoon(storage, data, onDone) {
    if (this.pending && (this.pending.storage !== storage || LiveLinks.planKey(this.pending.data) !== LiveLinks.planKey(data))) this.flush();
    this.pending = { storage, data, onDone };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.saveDelayMs);
  },
  // Writes the waiting save now (page hide, before reading the list).
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const job = this.pending;
    if (!job) return null;
    this.pending = null;
    let outcome;
    try { outcome = { ok: true, ...this.save(job.storage, job.data) }; } catch (error) { outcome = { ok: false, error }; }
    if (job.onDone) job.onDone(outcome);
    return outcome;
  },
  // The stored entry for planKey when `raw` (a storage event's new value) holds
  // a save of it this tab did not make, else null.
  foreignEdit(raw, planKey) {
    if (!planKey || typeof raw !== 'string') return null;
    let list;
    try { list = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(list)) return null;
    for (const e of list) {
      const plan = this.migrate(e);
      if (!plan || !this.valid(plan.data) || LiveLinks.planKey(plan.data) !== planKey) continue;
      return plan.updatedAt === this.known[planKey] ? null : plan;
    }
    return null;
  },
  restore(data) {
    if (!this.valid(data)) return false;
    Object.assign(State, JSON.parse(JSON.stringify(data)));
    State.gameVersion = data.gameVersion || versionForRaid(data.selectedRaid) || 'tbc';
    // Plans saved before the nav slim-down may name another strategy; Optimize only runs Max DPS now.
    State.optimizerMode = 'max_dps';
    State.preferredSlots = PreferredSlots.clean(data.preferredSlots);
    State.preserveGroupOrder = data.preserveGroupOrder === true || PreferredSlots.hasManual();
    State.eventStartTime = this.cleanEventStart(data.eventStartTime);
    State.groups = State.groups.map(g => PlayerIdentity.cleanList(g));
    State.bench = PlayerIdentity.cleanList(State.bench);
    State.roster = State.groups.flat();
    State.unplaced = SignupStatus.cleanUnplaced(data.unplaced);
    State.campfires = Campfires.clean(data.campfires);
    // Explicit reset (not just Object.assign) so a plan saved before this field
    // existed clears any notes left over from whatever was in State before.
    State.notes = typeof data.notes === 'string' ? data.notes.slice(0, NOTES_MAX_LENGTH) : '';
    Assignments.restore(data.assignments);
    Backups.restore(data.backups);
    State.playerConstraints = Constraints.clean(data.playerConstraints);
    State.drummers = Drummers.clean(data.drummers);
    for (const p of [...State.roster, ...State.bench, ...State.unplaced]) {
      const n = /^p(\d+)$/.exec(p.uid);
      if (n) _uid = Math.max(_uid, Number(n[1]));
    }
    return true;
  },
  // Empty every per-plan field (roster, layout, Open-slot requests, notes and
  // the features keyed by player) so whatever loads next starts clean. The
  // plan ID is the caller's call: Clear keeps it, a new plan replaces it.
  startFresh() {
    State.campfires = Campfires.empty();
    State.preferredSlots = [];
    State.preserveGroupOrder = false;
    State.roster = []; State.groups = []; State.bench = []; State.unplaced = [];
    State.rosterName = NO_ROSTER_NAME;
    State.sourceEventId = null;
    State.eventStartTime = null;
    State.buffOverrides = {};
    State.notes = '';
    State.playerConstraints = [];
    State.drummers = [];
    Assignments.restore(null);
    Backups.restore(null);
  },
  // Epoch ms for a stored event start, or null when it is absent or not a usable date.
  cleanEventStart(ms) {
    return Number.isFinite(ms) && ms > 0 && Number.isFinite(new Date(ms).getTime()) ? ms : null;
  },
  // A Raid-Helper event's start as epoch ms, or null. startTime is Unix seconds
  // (a millisecond value is tolerated), so anything below 1e12 is seconds.
  eventStart(data) {
    const raw = Number(data && (data.startTime || data.start_time));
    return this.cleanEventStart(raw < 1e12 ? raw * 1000 : raw);
  },
  // The date exports and the print sheet show: the event's day, else today.
  dayLabel() {
    const start = this.cleanEventStart(State.eventStartTime);
    return (start ? new Date(start) : new Date()).toLocaleDateString();
  },
  nameFor(data, eventId) {
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    const day = new Date(this.eventStart(data) || Date.now()).toLocaleDateString();
    return (title || raidSizeLabel(State.selectedRaid) + (eventId ? ' · Event ' + eventId : '')) + ' · ' + day;
  },
};

// ── COMP TEMPLATES (backlog #1: Weekly Roster / Comp Templates) ──
// Reusable group layouts, scoped to game version + raid (a TBC Black Temple
// template has no business seeding a Classic MC import). Deliberately
// separate from PlanStore/pp_rosters: a template only remembers
// name -> group/role (never full player objects, buffOverrides, notes, etc.)
// plus the name-keyed planning that goes with the layout: assignments
// (custom rows included), bench backups, keep-together/apart constraints and
// drummer tags, each stored only when the plan had some. Templates saved before
// those existed simply lack the fields and leave the open plan's own alone.
// — see applyTemplate() below for the pure seed-and-lock transform, and
// Optimizer.arrange()'s Phase 0/isPinned for how a `.locked` seat survives
// the next Optimize.
const Templates = {
  key: 'pp_roster_templates',

  read(storage) {
    try {
      const all = JSON.parse(storage.getItem(this.key) || '{}');
      return (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
    } catch { return {}; }
  },
  // false when the browser refused the write (safeSetItem has already told the user).
  write(storage, all) { return safeSetItem(storage, this.key, JSON.stringify(all)); },

  // {lowerName: {name, group, role}} snapshot of the CURRENT layout — bench
  // and preferred slots are deliberately excluded per the backlog scope
  // ("keep it to group placement + preferred slots" was considered and cut
  // down to just group placement to keep applying a template simple).
  capture() {
    const players = {};
    (State.groups || []).forEach((group, gi) => {
      for (const p of group) {
        if (!p || !p.name) continue;
        players[p.name.toLowerCase()] = { name: p.name, group: gi, role: p.role };
      }
    });
    return players;
  },

  // The optional planning fields of a template: only the ones the plan has.
  capturePlanning() {
    const planning = {};
    if (Assignments.hasManualEdits()) planning.assignments = Assignments.serialize();
    if (Backups.hasManualEdits()) planning.backups = Backups.serialize();
    const constraints = Constraints.clean(State.playerConstraints);
    if (constraints.length) planning.playerConstraints = constraints;
    const drummers = Drummers.clean(State.drummers);
    if (drummers.length) planning.drummers = drummers;
    return planning;
  },

  save(storage, name, gameVersion, raid) {
    name = String(name || '').trim();
    if (!name) return { success:false, error:'Name cannot be empty' };
    const players = this.capture();
    if (!Object.keys(players).length) return { success:false, error:'Nothing to save — seat some players first' };
    const all = this.read(storage);
    all[gameVersion] = all[gameVersion] || {};
    all[gameVersion][raid] = all[gameVersion][raid] || {};
    all[gameVersion][raid][name] = { savedAt: Date.now(), players, ...this.capturePlanning() };
    if (!this.write(storage, all)) return { success:false, error:'Browser storage is full' };
    return { success:true };
  },

  // [{name, savedAt, count}], newest first.
  list(storage, gameVersion, raid) {
    const all = this.read(storage);
    const scoped = (all[gameVersion] && all[gameVersion][raid]) || {};
    return Object.keys(scoped)
      .map(name => ({ name, savedAt: scoped[name].savedAt || 0, count: Object.keys(scoped[name].players || {}).length }))
      .sort((a, b) => b.savedAt - a.savedAt);
  },

  get(storage, name, gameVersion, raid) {
    const all = this.read(storage);
    return (all[gameVersion] && all[gameVersion][raid] && all[gameVersion][raid][name]) || null;
  },

  rename(storage, oldName, newName, gameVersion, raid) {
    newName = String(newName || '').trim();
    if (!newName) return { success:false, error:'Name cannot be empty' };
    const all = this.read(storage);
    const scoped = all[gameVersion] && all[gameVersion][raid];
    if (!scoped || !scoped[oldName]) return { success:false, error:'Template not found' };
    if (newName !== oldName && scoped[newName]) return { success:false, error:'A template with that name already exists' };
    scoped[newName] = scoped[oldName];
    if (newName !== oldName) delete scoped[oldName];
    if (!this.write(storage, all)) return { success:false, error:'Browser storage is full' };
    return { success:true };
  },

  delete(storage, name, gameVersion, raid) {
    const all = this.read(storage);
    if (all[gameVersion] && all[gameVersion][raid]) {
      delete all[gameVersion][raid][name];
      if (!this.write(storage, all)) return { success:false, error:'Browser storage is full' };
    }
    return { success:true };
  },

  // Seats matching template placements (case-insensitive) into State, locking
  // them so Optimizer.optimize() treats them as fixed and arranges everyone
  // else around them; unmatched entries fill whatever open seats remain
  // (unlocked, so Optimize places them normally) and only true raid-capacity
  // overflow goes to State.bench. State.preserveGroupOrder is set so
  // sortTankGroupFirst() never reshuffles a template's own group numbering.
  applyToState(storage, name, gameVersion = State.gameVersion, raid = State.selectedRaid) {
    const template = this.get(storage, name, gameVersion, raid);
    if (!template) return { success:false, error:'Template not found for this game version and raid' };
    const raidInfo = Config.Raids[raid];
    const numGroups = raidInfo ? raidInfo.groups : 5;
    const entries = [...(State.groups || []).flat(), ...(State.bench || [])];
    if (!entries.length) return { success:false, error:'Nothing to apply the template to — import a roster first' };
    const result = applyTemplate(entries, template, numGroups, RosterEdit.MAX_GROUP_SIZE);
    State.groups = result.groups;
    State.bench = result.bench;
    State.roster = State.groups.flat();
    State.preserveGroupOrder = true;
    // Planning the template carries replaces the open plan's; a field it lacks
    // (an older template, or none was set) leaves the plan's own untouched.
    // Names no longer in the roster are dropped by the restore/reconcile passes.
    if (template.assignments !== undefined) Assignments.restore(template.assignments);
    if (template.backups !== undefined) Backups.restore(template.backups);
    if (template.playerConstraints !== undefined) State.playerConstraints = Constraints.clean(template.playerConstraints);
    if (template.drummers !== undefined) State.drummers = Drummers.clean(template.drummers);
    return { success:true, matched:result.matched, unmatched:result.unmatched };
  },
};

// ── DATA BACKUP (feature-backlog-3.md #3) ─────────────────────────
// Every pp_* localStorage key bundled into one downloadable JSON file, and
// restored back with the same defensive-parsing posture every reader above
// already uses — validate() never trusts a hand-edited/corrupted file, and
// apply() never writes anything unless every present key passes its own
// module's existing shape check first (ImportHistory.read/PlanStore.read/
// Templates.read all silently drop malformed entries rather than throwing,
// so a length mismatch after running the file's raw JSON through them is
// what catches corruption here — no separate validation logic to drift out
// of sync with the readers themselves).
const DataBackup = {
  schema: 'party-planner-backup',
  version: 1,
  // Kept in one place so a future new pp_* key only needs adding here (and,
  // if it has its own shape, to _checkKey/_merge below) to be covered.
  keys: ['pp_rosters', 'pp_import_history', 'pp_working_plans', 'pp_roster_templates',
         'pp_sidebar_expanded', 'pp_whats_new_dismissed_v1', 'pp_spotlight_seen_v1', 'pp_live_links'],
  labels: {
    pp_rosters: 'saved rosters',
    pp_import_history: 'import history entries',
    pp_working_plans: 'working plans',
    pp_roster_templates: 'roster templates',
    pp_sidebar_expanded: 'sidebar preference',
    pp_whats_new_dismissed_v1: '"What\'s new" dismissal',
    pp_spotlight_seen_v1: 'feature tips dismissed',
    pp_live_links: 'live links',
  },

  // Keys with no value in this browser are omitted entirely (not written as
  // null), so restoring a backup made before some feature existed can never
  // wipe that feature's data back out on the machine that already has it.
  build(storage) {
    const data = {};
    for (const key of this.keys) {
      const raw = storage.getItem(key);
      if (raw !== null && raw !== undefined) data[key] = key === 'pp_working_plans' ? this._exportablePlans(raw) : raw;
    }
    return { schema: this.schema, version: this.version, exportedAt: Date.now(), data };
  },

  // PlanStore keeps entries that fail its checks; leave those out so the file
  // always passes validate() (entries only a newer build can read are kept).
  _exportablePlans(raw) {
    let list;
    try { list = JSON.parse(raw); } catch { return raw; }
    return Array.isArray(list) ? JSON.stringify(list.filter(e => PlanStore.portable(e))) : raw;
  },

  // Mirrors the per-player field checks Import.loadRoster/ImportHistory.read
  // already enforce elsewhere — a saved roster is only as trustworthy as
  // those same fields are everywhere else in the file.
  _validRoster(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || !Array.isArray(r.players)) return false;
    const version = r.gameVersion || (typeof versionForRaid === 'function' ? versionForRaid(r.raid) : 'tbc') || 'tbc';
    if (typeof validVersionRaid === 'function' && !validVersionRaid(version, r.raid)) return false;
    return [...r.players, ...(Array.isArray(r.bench) ? r.bench : [])].every(p => p &&
      typeof p.name === 'string' && typeof p.class === 'string' && typeof p.spec === 'string' && typeof p.role === 'string');
  },

  // {valid, error, count} for one key's raw stored string.
  _checkKey(key, raw) {
    if (typeof raw !== 'string') return { valid: false, error: 'expected a stored string value.' };
    if (key === 'pp_sidebar_expanded') return (raw === '0' || raw === '1') ? { valid: true, count: null } : { valid: false, error: 'unrecognized value.' };
    if (key === 'pp_whats_new_dismissed_v1') return (raw === 'true' || raw === 'false' || parseVersion(raw)) ? { valid: true, count: null } : { valid: false, error: 'unrecognized value.' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { valid: false, error: 'not valid JSON.' }; }
    if (key === 'pp_rosters') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, error: 'expected an object of named rosters.' };
      const names = Object.keys(parsed);
      if (!names.every(n => this._validRoster(parsed[n]))) return { valid: false, error: 'one or more saved rosters are malformed.' };
      return { valid: true, count: names.length };
    }
    if (key === 'pp_import_history') {
      if (!Array.isArray(parsed)) return { valid: false, error: 'expected a list.' };
      const kept = ImportHistory.read({ getItem: k => (k === ImportHistory.key ? raw : null) });
      if (kept.length !== parsed.length) return { valid: false, error: 'contains malformed entries.' };
      return { valid: true, count: kept.length };
    }
    if (key === 'pp_working_plans') {
      if (!Array.isArray(parsed)) return { valid: false, error: 'expected a list.' };
      // A newer build's entries are carried as they are (see PlanStore.portable); anything else must pass.
      if (!parsed.every(e => PlanStore.portable(e))) return { valid: false, error: 'contains malformed entries.' };
      return { valid: true, count: PlanStore.readable(parsed).length };
    }
    if (key === 'pp_roster_templates') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, error: 'expected an object of templates.' };
      let count = 0;
      for (const v of Object.keys(parsed)) {
        if (!parsed[v] || typeof parsed[v] !== 'object') return { valid: false, error: 'malformed template entry.' };
        for (const raidKey of Object.keys(parsed[v])) {
          const scoped = parsed[v][raidKey];
          if (!scoped || typeof scoped !== 'object') return { valid: false, error: 'malformed template entry.' };
          count += Object.keys(scoped).length;
        }
      }
      return { valid: true, count };
    }
    if (key === 'pp_spotlight_seen_v1') {
      if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string')) return { valid: false, error: 'expected a list of feature ids.' };
      return { valid: true, count: parsed.length };
    }
    if (key === 'pp_live_links') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, error: 'expected an object of plan links.' };
      const planKeys = Object.keys(parsed);
      const wellFormed = e => e && typeof e === 'object' && LiveLinks.ID.test(e.id) && typeof e.lastCode === 'string';
      if (!planKeys.every(k => wellFormed(parsed[k]))) return { valid: false, error: 'one or more plan links are malformed.' };
      return { valid: true, count: planKeys.length };
    }
    return { valid: false, error: 'unrecognized key.' };
  },

  // Pure structural check of an already-parsed backup object. Never touches
  // storage — safe to call on a freshly-read file before showing the user
  // anything, and again inside apply() so nothing downstream can skip it.
  validate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, errors: ['Not a Party Planner backup file.'] };
    if (obj.schema !== this.schema) return { valid: false, errors: ['Unrecognized backup file — expected a Party Planner backup.'] };
    if (!Number.isFinite(obj.version)) return { valid: false, errors: ['Backup is missing a version number.'] };
    if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) return { valid: false, errors: ['Backup file has no data.'] };
    const errors = [];
    const summary = {};
    const presentKnownKeys = Object.keys(obj.data).filter(k => this.keys.includes(k));
    for (const key of presentKnownKeys) {
      const result = this._checkKey(key, obj.data[key]);
      if (!result.valid) errors.push(`${this.labels[key] || key}: ${result.error}`);
      else summary[key] = { count: result.count, label: this.labels[key] || key };
    }
    if (presentKnownKeys.length === 0) errors.push('Backup file has nothing recognizable to restore.');
    return { valid: errors.length === 0, errors, summary };
  },

  // Per-key merge: add anything missing, keep whichever copy is newer where a
  // timestamp exists, otherwise keep what's already in this browser rather
  // than silently overwriting a live preference with an older file's guess.
  _merge(key, currentRaw, backupRaw) {
    if (key === 'pp_sidebar_expanded' || key === 'pp_whats_new_dismissed_v1') {
      if (currentRaw === null || currentRaw === undefined) return { value: backupRaw, added: 1, updated: 0, unchanged: 0 };
      return { value: currentRaw, added: 0, updated: 0, unchanged: 1 };
    }
    if (key === 'pp_spotlight_seen_v1') {
      let cur = [], inc = [];
      try { cur = currentRaw ? JSON.parse(currentRaw) : []; } catch {}
      try { inc = JSON.parse(backupRaw); } catch {}
      if (!Array.isArray(cur)) cur = [];
      if (!Array.isArray(inc)) inc = [];
      const set = new Set(cur);
      let added = 0;
      for (const id of inc) { if (!set.has(id)) { set.add(id); added++; } }
      return { value: JSON.stringify([...set]), added, updated: 0, unchanged: inc.length - added };
    }
    if (key === 'pp_rosters') {
      let cur = {}, inc = {};
      try { cur = currentRaw ? JSON.parse(currentRaw) : {}; } catch {}
      try { inc = JSON.parse(backupRaw); } catch {}
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
      if (!inc || typeof inc !== 'object' || Array.isArray(inc)) inc = {};
      let added = 0, updated = 0, unchanged = 0;
      for (const name of Object.keys(inc)) {
        if (!(name in cur)) { cur[name] = inc[name]; added++; continue; }
        const curTs = Number(cur[name] && cur[name].timestamp) || 0;
        const incTs = Number(inc[name] && inc[name].timestamp) || 0;
        if (incTs > curTs) { cur[name] = inc[name]; updated++; } else unchanged++;
      }
      return { value: JSON.stringify(cur), added, updated, unchanged };
    }
    if (key === 'pp_working_plans') {
      let cur = [], inc = [];
      try { cur = currentRaw ? JSON.parse(currentRaw) : []; } catch {}
      try { inc = JSON.parse(backupRaw); } catch {}
      if (!Array.isArray(cur)) cur = [];
      if (!Array.isArray(inc)) inc = [];
      // An entry this build cannot read (PlanStore keeps those) is merged as it is, keyed by its text.
      const keyFor = p => (p && p.data && typeof p.data.planId === 'string') ? p.data.planId + '|' + (p.data.gameVersion || 'tbc') : 'raw|' + JSON.stringify(p);
      const byKey = new Map(cur.map(p => [keyFor(p), p]));
      let added = 0, updated = 0, unchanged = 0;
      for (const p of inc) {
        const k = keyFor(p);
        const existing = byKey.get(k);
        if (!existing) { byKey.set(k, p); added++; }
        else if (((p && p.updatedAt) || 0) > ((existing && existing.updatedAt) || 0)) { byKey.set(k, p); updated++; }
        else unchanged++;
      }
      const merged = [...byKey.values()].sort((a, b) => (((b && b.updatedAt) || 0)) - (((a && a.updatedAt) || 0)));
      return { value: JSON.stringify(merged), added, updated, unchanged };
    }
    if (key === 'pp_roster_templates') {
      let cur = {}, inc = {};
      try { cur = currentRaw ? JSON.parse(currentRaw) : {}; } catch {}
      try { inc = JSON.parse(backupRaw); } catch {}
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
      if (!inc || typeof inc !== 'object' || Array.isArray(inc)) inc = {};
      let added = 0, updated = 0, unchanged = 0;
      for (const version of Object.keys(inc)) {
        cur[version] = cur[version] || {};
        for (const raidKey of Object.keys(inc[version] || {})) {
          cur[version][raidKey] = cur[version][raidKey] || {};
          for (const name of Object.keys(inc[version][raidKey] || {})) {
            const incT = inc[version][raidKey][name];
            const curT = cur[version][raidKey][name];
            if (!curT) { cur[version][raidKey][name] = incT; added++; }
            else if ((incT.savedAt || 0) > (curT.savedAt || 0)) { cur[version][raidKey][name] = incT; updated++; }
            else unchanged++;
          }
        }
      }
      return { value: JSON.stringify(cur), added, updated, unchanged };
    }
    if (key === 'pp_import_history') {
      let cur = [], inc = [];
      try { cur = currentRaw ? JSON.parse(currentRaw) : []; } catch {}
      try { inc = JSON.parse(backupRaw); } catch {}
      if (!Array.isArray(cur)) cur = [];
      if (!Array.isArray(inc)) inc = [];
      const ids = new Set(cur.map(i => i && i.id));
      let added = 0;
      for (const item of inc) { if (item && !ids.has(item.id)) { cur.push(item); ids.add(item.id); added++; } }
      cur.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
      const limited = cur.slice(0, ImportHistory.limit);
      return { value: JSON.stringify(limited), added, updated: 0, unchanged: cur.length - added };
    }
    if (key === 'pp_live_links') {
      let cur = {}, inc = {};
      try { cur = currentRaw ? JSON.parse(currentRaw) : {}; } catch {}
      try { inc = JSON.parse(backupRaw); } catch {}
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
      if (!inc || typeof inc !== 'object' || Array.isArray(inc)) inc = {};
      const touched = e => Number(e.touchedAt) || 0;
      const merged = {};
      for (const planKey of Object.keys(cur)) if (cur[planKey] && LiveLinks.ID.test(cur[planKey].id)) merged[planKey] = cur[planKey];
      const how = {};
      for (const planKey of Object.keys(inc)) {
        if (!(planKey in merged)) { merged[planKey] = inc[planKey]; how[planKey] = 'added'; }
        else if (touched(inc[planKey]) > touched(merged[planKey])) { merged[planKey] = inc[planKey]; how[planKey] = 'updated'; }
      }
      // One plan per link ID and at most LiveLinks.max bindings; the most
      // recently touched win (ties keep this browser's copy: it sorts first).
      const kept = {};
      const ids = new Set();
      for (const planKey of Object.keys(merged).sort((a, b) => touched(merged[b]) - touched(merged[a]))) {
        if (ids.has(merged[planKey].id) || Object.keys(kept).length >= LiveLinks.max) continue;
        ids.add(merged[planKey].id);
        kept[planKey] = merged[planKey];
      }
      let added = 0, updated = 0, unchanged = 0;
      for (const planKey of Object.keys(inc)) {
        if (kept[planKey] !== inc[planKey]) unchanged++;
        else if (how[planKey] === 'added') added++;
        else updated++;
      }
      return { value: JSON.stringify(kept), added, updated, unchanged };
    }
    return { value: backupRaw, added: 0, updated: 0, unchanged: 0 };
  },

  // Pure preview of what apply() would write — validates first (so an
  // invalid file reports {valid:false} without ever touching storage) and
  // otherwise never writes; the caller shows `changes` to the user, and
  // apply() below re-derives the exact same plan right before committing it.
  plan(storage, obj, mode) {
    const check = this.validate(obj);
    if (!check.valid) return { valid: false, errors: check.errors };
    mode = mode === 'replace' ? 'replace' : 'merge';
    const writes = {};
    const changes = {};
    for (const key of Object.keys(check.summary)) {
      const raw = obj.data[key];
      const current = storage.getItem(key);
      const result = mode === 'replace'
        ? { value: raw, added: current === null || current === undefined ? (check.summary[key].count || 0) : 0, updated: current === null || current === undefined ? 0 : (check.summary[key].count || 0), unchanged: 0 }
        : this._merge(key, current, raw);
      writes[key] = result.value;
      changes[key] = { label: this.labels[key] || key, added: result.added || 0, updated: result.updated || 0, unchanged: result.unchanged || 0 };
    }
    return { valid: true, mode, writes, changes };
  },

  // Validates, computes the plan, then writes every key. If a write throws
  // partway (quota exceeded mid-restore), every key this call touched is
  // rolled back to its pre-apply value so a bad restore can never leave the
  // browser in a half-written state — the same "never partially write"
  // guarantee applies whether the failure is a validation error or a live
  // storage error.
  apply(storage, obj, mode) {
    const planned = this.plan(storage, obj, mode);
    if (!planned.valid) return { success: false, errors: planned.errors };
    const originals = {};
    const written = [];
    for (const key of Object.keys(planned.writes)) originals[key] = storage.getItem(key);
    try {
      for (const key of Object.keys(planned.writes)) {
        storage.setItem(key, planned.writes[key]);
        written.push(key);
      }
    } catch (e) {
      for (const key of written) {
        try {
          if (originals[key] === null || originals[key] === undefined) storage.removeItem(key);
          else storage.setItem(key, originals[key]);
        } catch {}
      }
      return { success: false, errors: ["Couldn't write the restored data — your browser's storage is full. Free up space (delete old saved rosters) and try again."] };
    }
    return { success: true, mode: planned.mode, changes: planned.changes };
  },
};

// ── FEATURE SPOTLIGHT: seen-state (feature-backlog-3.md #4) ───────
// Pure tracking of which one-time discovery callouts have already been shown
// — a Set persisted as a JSON array. The DOM/positioning half lives in the
// UI-RENDERING section below, keyed off the same ids. Showing a callout
// counts as "seen" immediately (not only on explicit dismissal), so an
// orphaned callout (its anchor's dialog closes before the user reacts) can
// never come back and nag a second time.
const Spotlight = {
  key: 'pp_spotlight_seen_v1',
  _read(storage) {
    try {
      const ids = JSON.parse(storage.getItem(this.key) || '[]');
      return new Set(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []);
    } catch { return new Set(); }
  },
  shouldShow(storage, id) {
    return !this._read(storage).has(id);
  },
  dismiss(storage, id) {
    const seen = this._read(storage);
    if (seen.has(id)) return;
    seen.add(id);
    safeSetItem(storage, this.key, JSON.stringify([...seen]));
  },
  resetAll(storage) {
    try { storage.removeItem(this.key); } catch {}
  },
};

// Pure: seats `entries` (existing player objects — a fresh import's roster +
// bench) into `numGroups` per `template.players` (name.toLowerCase() ->
// {group, role}). Matched entries are locked into their recorded group
// (first-come order wins a group that would otherwise overflow past `max`);
// unmatched entries — no-shows, renamed sign-ups, or a template group that's
// already full — fill remaining open seats unlocked, so a subsequent
// Optimizer.optimize() arranges them normally around the locked seats; only
// genuine raid-capacity overflow lands on the returned bench. Mutates the
// entry objects' `.locked`/`.groupNumber` in place (same convention as every
// other seat-assignment helper in this file) and returns the new
// groups/bench arrays. Never touches State directly — callers do that (see
// Templates.applyToState above) so this stays independently testable.
function applyTemplate(entries, template, numGroups, max = 5) {
  const playersMap = (template && template.players) || {};
  const groups = []; for (let i = 0; i < numGroups; i++) groups.push([]);
  const matched = [], unmatched = [];
  for (const entry of entries) {
    const rec = entry && entry.name ? playersMap[entry.name.toLowerCase()] : null;
    if (rec) { entry._templateGroup = rec.group; matched.push(entry); }
    else unmatched.push(entry);
  }
  let matchedCount = 0;
  for (const entry of matched) {
    const gi = entry._templateGroup;
    delete entry._templateGroup;
    if (Number.isInteger(gi) && gi >= 0 && gi < numGroups && groups[gi].length < max) {
      entry.locked = true;
      groups[gi].push(entry);
      matchedCount++;
    } else {
      entry.locked = false;
      unmatched.push(entry); // template group full/invalid — falls through like any other unmatched entry
    }
  }
  const bench = [];
  for (const entry of unmatched) {
    entry.locked = false;
    const gi = groups.findIndex(g => g.length < max);
    if (gi >= 0) groups[gi].push(entry);
    else bench.push(entry);
  }
  groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  bench.forEach(p => { p.groupNumber = 0; });
  return { groups, bench, matched: matchedCount, unmatched: entries.length - matchedCount };
}

const PlanSession = {
  previous:null, undo:[], redo:[], ready:false, replaying:false,
  observe() {
    if (!this.ready) return;
    if (!State.planId && (State.campfires.fires.length || State.groups.flat().length || State.bench.length || State.preferredSlots.length))
      State.planId = 'plan:' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
    if (!State.planId) return;
    const current = PlanStore.capture();
    const changed = JSON.stringify(current) !== JSON.stringify(this.previous);
    if (this.previous?.planId !== current.planId) { this.undo = []; this.redo = []; }
    else if (changed && !this.replaying) {
      this.undo.push(this.previous);
      if (this.undo.length > 30) this.undo.shift();
      // A genuine new change (not an undo/redo replay) invalidates whatever
      // was available to redo — standard undo/redo semantics.
      this.redo = [];
    }
    this.previous = current;
    this.replaying = false;
    return {current, changed};
  },
  undoLast() {
    const previous = this.undo.pop();
    if (!previous) return false;
    this.redo.push(this.previous);
    if (this.redo.length > 30) this.redo.shift();
    this.replaying = true;
    return PlanStore.restore(previous);
  },
  redoLast() {
    const next = this.redo.pop();
    if (!next) return false;
    this.undo.push(this.previous);
    if (this.undo.length > 30) this.undo.shift();
    this.replaying = true;
    return PlanStore.restore(next);
  },
};

