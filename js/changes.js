// ── ROSTER CHANGE LOG ───────────────────────────────────────────
// What a Raid-Helper sync, a raid size change or a co-editor's live update did
// to the roster, so the leader can see who moved without diffing the board by
// eye. Each of those actions runs through ChangeLog.track(): a snapshot of where
// everyone sits before and after, diffed into one entry of items (benched,
// seated, status, added, dropped and, for live updates only, moved). Optimize,
// manual drags, undo/redo and tab-conflict loads are the user's own doing and
// are never recorded. Session only: nothing here is saved or shared.
//
// The log belongs to one plan: recording on a different planId starts a fresh
// log, and fresh imports clear it explicitly. Highlights (the card outline and
// tag) come from entries not yet marked seen; markAllSeen() drops them and the
// unseen count together, but keeps the entries listed in the panel.
const ChangeLog = {
  MAX_ENTRIES: 20,
  KINDS: ['benched', 'seated', 'status', 'moved', 'added', 'dropped'],
  // The word the panel and the card tag show for each kind.
  WORDS: { benched:'Benched', seated:'Seated', status:'Status', moved:'Moved', added:'New', dropped:'Dropped' },
  LABELS: { sync:'Sign-up sync', size:'Raid size change', live:'Live link update' },

  entries: [], // newest first: {id, kind, label, time, items, seen}
  planId: null, // the plan the entries belong to
  nextId: 1,
  // Set by the UI half: called with each entry right after it is recorded.
  onRecord: null,
  _highlights: null, // cache of {byUid, byName}, rebuilt after any change

  // Where everyone is right now: seated players by group, then the bench, then
  // the unplaced sign-ups. A missing status is a plain sign-up ('confirmed'), or
  // 'absent' for an unplaced player (what cleanUnplaced and a share import assume);
  // hasStatus remembers whether one was actually set (see diff's backfill rule).
  snapshot() {
    const row = (p, loc) => ({
      uid: p.uid, name: p.name, class: p.class || null, spec: p.spec || null, loc,
      status: p.signupStatus || (loc === 'unplaced' ? 'absent' : 'confirmed'), hasStatus: !!p.signupStatus,
    });
    const rows = [];
    (State.groups || []).forEach((g, gi) => { for (const p of g || []) rows.push(row(p, 'g' + (gi + 1))); });
    for (const p of State.bench || []) rows.push(row(p, 'bench'));
    for (const p of State.unplaced || []) rows.push(row(p, 'unplaced'));
    return rows;
  },

  isSeat(loc) { return /^g\d+$/.test(loc); },
  placeText(loc) {
    if (this.isSeat(loc)) return 'Group ' + loc.slice(1);
    return loc === 'bench' ? 'the bench' : 'not seated';
  },
  statusText(status) { return SignupStatus.label(status) || status; },

  // Pairs every before row with its after row (same uid first, then the same
  // name, since a live update re-creates players and only some keep their uid)
  // and describes what changed. Group-to-group moves count only with
  // {moves:true}: a sync or size change never moves seated players itself.
  // A status appearing on someone who had none is a backfill, not a change,
  // unless {ignoreBackfill:false} (a live share code drops all-confirmed statuses,
  // so there a missing status really means Signed up).
  diff(before, after, { moves = false, ignoreBackfill = true } = {}) {
    const claimed = new Set();
    const pairs = new Map(); // before row -> after row
    const byUid = new Map();
    for (const a of after) if (a.uid && !byUid.has(a.uid)) byUid.set(a.uid, a);
    for (const b of before) {
      const a = b.uid ? byUid.get(b.uid) : null;
      if (a && !claimed.has(a)) { pairs.set(b, a); claimed.add(a); }
    }
    // Same name in the same place first, so two uid-less namesakes do not cross.
    for (const b of before) {
      if (pairs.has(b)) continue;
      const a = after.find(x => !claimed.has(x) && x.name === b.name && x.loc === b.loc);
      if (a) { pairs.set(b, a); claimed.add(a); }
    }
    for (const b of before) {
      if (pairs.has(b)) continue;
      const a = after.find(x => !claimed.has(x) && x.name === b.name);
      if (a) { pairs.set(b, a); claimed.add(a); }
    }

    const items = [];
    // A name two players share cannot stand in for a uid (see highlightFor).
    const nameCount = new Map();
    for (const a of after) nameCount.set(a.name, (nameCount.get(a.name) || 0) + 1);
    const item = (kind, row, detail, extra = {}) => items.push({ kind, uid: row.uid, name: row.name, class: row.class, detail,
      ...(nameCount.get(row.name) > 1 ? { sharedName: true } : {}), ...extra });
    for (const b of before) {
      const a = pairs.get(b);
      if (!a) { item('dropped', b, this.isSeat(b.loc) ? 'was in ' + this.placeText(b.loc) : 'was ' + (b.loc === 'bench' ? 'on the bench' : 'not seated'), { from: b.loc }); continue; }
      const statusChanged = b.status !== a.status && (b.hasStatus || !ignoreBackfill);
      const now = statusChanged ? 'now ' + this.statusText(a.status) : '';
      const status = statusChanged ? { oldStatus: b.status, newStatus: a.status } : {};
      const wasSeated = this.isSeat(b.loc), isSeated = this.isSeat(a.loc);
      if (wasSeated && !isSeated) {
        // A demotion always says why, even when the old status was only a backfill.
        const why = now || (b.status !== a.status && a.status !== 'confirmed' ? 'now ' + this.statusText(a.status) : '');
        item('benched', a, [why, 'was in ' + this.placeText(b.loc)].filter(Boolean).join(', '), { from: b.loc, to: a.loc, ...status });
      } else if (!wasSeated && isSeated) {
        item('seated', a, statusChanged ? `${now}, in ${this.placeText(a.loc)}` : 'now in ' + this.placeText(a.loc), { from: b.loc, to: a.loc, ...status });
      } else if (moves && wasSeated && b.loc !== a.loc) {
        item('moved', a, [`${this.placeText(b.loc)} to ${this.placeText(a.loc)}`, now].filter(Boolean).join(', '), { from: b.loc, to: a.loc, ...status });
      } else if (statusChanged) {
        item('status', a, `${this.statusText(b.status)} to ${this.statusText(a.status)}`, { from: b.loc, to: a.loc, ...status });
      }
    }
    for (const a of after) {
      if (claimed.has(a)) continue;
      const marked = a.status !== 'confirmed' && a.status !== 'bench' ? this.statusText(a.status) : '';
      const detail = this.isSeat(a.loc) ? 'added to ' + this.placeText(a.loc)
        : a.loc === 'bench' ? 'added to the bench' + (marked ? ', ' + marked : '')
        : 'added, ' + (marked || 'not seated');
      item('added', a, detail, { to: a.loc });
    }
    return items.sort((x, y) => this.KINDS.indexOf(x.kind) - this.KINDS.indexOf(y.kind));
  },

  // A recording on another plan than the one the log holds starts the log over.
  forPlan(planId) {
    if (this.planId === planId) return;
    this.planId = planId;
    this.entries = [];
    this._highlights = null;
  },

  // Adds one entry (newest first) and returns it; nothing when nothing changed.
  record(kind, items, label) {
    if (!Array.isArray(items) || !items.length) return null;
    this.forPlan(State.planId);
    const entry = { id: this.nextId++, kind, label: label || this.LABELS[kind] || 'Roster change', time: Date.now(), items, seen: false };
    this.entries.unshift(entry);
    if (this.entries.length > this.MAX_ENTRIES) this.entries.length = this.MAX_ENTRIES;
    this._highlights = null;
    if (typeof this.onRecord === 'function') this.onRecord(entry);
    return entry;
  },

  // Snapshot, run the action, snapshot again and record the difference.
  // Returns {result, entry}: what fn returned, and the entry (null if none).
  track(kind, label, fn, opts) {
    const before = this.snapshot();
    const result = fn();
    const entry = this.record(kind, this.diff(before, this.snapshot(), opts), label);
    return { result, entry };
  },

  // How many changes the leader has not looked at yet.
  unseenCount() {
    return this.entries.reduce((n, e) => n + (e.seen ? 0 : e.items.length), 0);
  },

  // The latest unseen change for a player, matched by uid, else by name:
  // {kind, word}, or null. Dropped players are gone, so they never match.
  highlightFor(p) {
    if (!p || !this.entries.length) return null;
    if (!this._highlights) {
      const byUid = new Map(), byName = new Map();
      for (const entry of this.entries) {
        if (entry.seen) continue;
        for (const it of entry.items) {
          if (it.kind === 'dropped') continue;
          const tag = { kind: it.kind, word: this.WORDS[it.kind] };
          if (it.uid && !byUid.has(it.uid)) byUid.set(it.uid, tag);
          if (it.name && !it.sharedName && !byName.has(it.name)) byName.set(it.name, tag);
        }
      }
      this._highlights = { byUid, byName };
    }
    return this._highlights.byUid.get(p.uid) || this._highlights.byName.get(p.name) || null;
  },

  markAllSeen() {
    for (const entry of this.entries) entry.seen = true;
    this._highlights = null;
  },

  // Drops one entry (a live update the user undid) and its highlights.
  remove(entryId) {
    this.entries = this.entries.filter(e => e.id !== entryId);
    this._highlights = null;
  },

  clear() {
    this.entries = [];
    this._highlights = null;
  },

  // Items per kind, in KINDS order: [{kind, word, count}].
  kindCounts(entry) {
    const counts = {};
    for (const it of entry.items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    return this.KINDS.filter(k => counts[k]).map(k => ({ kind: k, word: this.WORDS[k], count: counts[k] }));
  },

  // "just now", "4 min ago", "2 h ago", then the date for anything older than a day.
  ago(time, now = Date.now()) {
    const minutes = Math.round((now - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    return hours < 24 ? hours + ' h ago' : new Date(time).toLocaleDateString();
  },

  // The one line the screen reader hears for an entry ("Sign-up sync: 5 changes").
  summary(entry) {
    const n = entry.items.length;
    return `${entry.label}: ${n} change${n === 1 ? '' : 's'}`;
  },
};
