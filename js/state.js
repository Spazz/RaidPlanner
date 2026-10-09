// ── STATE ───────────────────────────────────────────────────────
// Placeholder shown while the planner is empty. It is a UI label, not a real
// roster name, so it must never travel in an export or a share link.
const NO_ROSTER_NAME = 'No Roster Loaded';

// The Assignments view is hidden for now (nav slim-down, 2026-10-09). Its
// rendering code (renderAssignments) stays in place, but while this is false
// switchTab() lands on the plan instead, and the '2' shortcut and its help row
// are left out. To bring it back: set true and give it an entry point again
// (the old Plan | Assignments tab bar was removed from index.html).
const ASSIGNMENTS_TAB_ENABLED = false;

const State = {
  campfires: {professions:[], fires:[]},
  preferredSlots: [], // Open class/spec requests, separate from real players.
  preserveGroupOrder: false,
  roster: [],
  groups: [],
  bench: [], // players not assigned to a group (groupNumber 0); never touched by the Optimizer
  // Sign-ups that can't be benched as-is: marked Absent on Raid-Helper, or
  // sent with no class. {uid, name, signupStatus, class|null, spec|null, role|null}.
  // Kept apart from the bench so nothing treats them as available players.
  unplaced: [],
  gameVersion: 'tbc',
  selectedRaid: 'bt',
  rosterName: NO_ROSTER_NAME,
  planId: null,
  sourceEventId: null, // Raid-Helper event the roster was imported from; enables Refresh
  eventStartTime: null, // That event's start (epoch ms); dates exports and the print sheet. null = use today.
  optimizerMode: 'max_dps', // 'max_dps' | 'tank_mit' | 'balanced' | 'relaxed'
  buffOverrides: {}, // key: "groupIdx:playerName:element|aura" → { buffId, originalBuffId }
  // Manual overrides only (name-keyed, like buffOverrides) — see the
  // Assignments module. Live suggestions are always recomputed from the
  // current roster and merged with these at render/serialize time. The user's
  // own rows live in an optional `custom` array (absent while there are none).
  assignments: { tankHealers:{}, blessings:{}, debuffs:{} },
  // Planned bench backups (name-keyed, like buffOverrides/assignments — see
  // the Backups module): seated player's name -> the benched player pinned
  // as their pre-planned replacement.
  backups: {},
  activeTab: 'plan', // 'plan' | 'ideal' | 'assignments'
  view: 'landing', // 'landing' | 'app'
  notes: '', // Free-text raid notes (MT swaps, add plans); capped at NOTES_MAX_LENGTH.
  // uids a Raid size shrink moved to the bench (see SizeBench). Saved with the plan.
  sizeBenched: [],
  // Per-plan hard constraints between two named players (backlog #3):
  // [{a: name, b: name, type: 'together'|'apart'}]. See the Constraints module.
  playerConstraints: [],
  // TBC-only Leatherworker drum tags (feature-backlog-3 #5): [{player: name,
  // drum: 'Battle'|'War'|'Restoration'|''}]. Name-keyed like backups/
  // constraints — see the Drummers module. Classic Era has no Drums
  // equivalent and Forever's status is unconfirmed, so nothing outside TBC
  // ever reads this.
  drummers: [],
};
const NOTES_MAX_LENGTH = 2000;

const PreferredSlots = {
  clean(items, raid = State.selectedRaid) {
    const counts = {};
    return (Array.isArray(items) ? items : []).filter(p => {
      if (!p || !Number.isInteger(p.group) || p.group < 0 || p.group >= (Config.Raids[raid]?.groups || 5) ||
          !Object.values(Config.Specs[p.class] || {}).some(s => s.name === p.spec)) return false;
      counts[p.group] = (counts[p.group] || 0) + 1;
      return counts[p.group] <= 5;
    }).map(p => ({group:p.group, class:p.class, spec:p.spec, ...(p.auto === true ? {auto:true} : {})}));
  },
  forGroup(group) { return State.preferredSlots.filter(p => p.group === group); },
  // Slots the leader set by hand. Auto-suggested ones (OpenSlots) are left
  // out wherever a slot means "keep this group as I arranged it".
  manual() { return State.preferredSlots.filter(p => !p.auto); },
  hasManual(list = State.preferredSlots) { return (list || []).some(p => !p.auto); },
  add(group, classFile, spec, existing) {
    if (!this.clean([{group, class:classFile, spec}]).length) return false;
    if (!existing) {
      const seated = State.groups[group]?.length || 0;
      const requests = this.forGroup(group);
      if (seated + requests.filter(p => !p.auto).length >= 5) return false;
      // A suggested Open gives its seat up to the leader's own request.
      if (seated + requests.length >= 5) this.remove(requests.filter(p => p.auto).pop());
    }
    // Editing a suggested slot makes it the leader's own: never auto-replaced.
    if (existing) { Object.assign(existing, {class:classFile, spec}); delete existing.auto; }
    else State.preferredSlots.push({group, class:classFile, spec});
    State.preserveGroupOrder = true;
    return true;
  },
  remove(preference) { State.preferredSlots = State.preferredSlots.filter(p => p !== preference); },
  match(player) {
    return State.preferredSlots.find(p => p.class === player.class && p.spec === player.spec && (State.groups[p.group]?.length || 0) < 5);
  },
  seat(player) {
    const preference = this.match(player);
    if (!preference) return false;
    State.groups[preference.group] ||= [];
    State.groups[preference.group].push(player);
    player.groupNumber = preference.group + 1;
    State.bench = State.bench.filter(p => p !== player);
    this.remove(preference);
    State.roster = State.groups.flat();
    return true;
  },
  // Manual assignments are authoritative. Matching requests are fulfilled first;
  // a full group replaces the last remaining request instead of hiding it.
  reconcile() {
    State.preferredSlots = this.clean(State.preferredSlots);
    State.groups.forEach((group, gi) => {
      while (group.length + this.forGroup(gi).length > 5) {
        const requests = this.forGroup(gi);
        const suggested = requests.filter(r => r.auto);
        this.remove(requests.find(r => group.some(p => p.class === r.class && p.spec === r.spec))
          || suggested[suggested.length - 1] || requests[requests.length - 1]);
      }
    });
  },
};

// ── PLAYER CONSTRAINTS (backlog #3: keep-together / keep-apart) ──
// Per-plan hard constraints between two named players, by name (case-
// insensitive identity; original casing kept for display). This module owns
// State.playerConstraints and the pure fixup/violation-detection logic;
// Optimizer.arrange() calls enforce() as its own final phase (see the note
// there) and Readiness.balanceWarnings() calls violations() every render so
// a manual drag that breaks a constraint is flagged too, not just the
// straight-after-Optimize case.
const Constraints = {
  TYPES: ['together', 'apart'],

  clean(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const out = [];
    for (const c of items) {
      if (!c || typeof c.a !== 'string' || typeof c.b !== 'string' || !this.TYPES.includes(c.type)) continue;
      const a = c.a.trim(), b = c.b.trim();
      if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
      const pairKey = [a.toLowerCase(), b.toLowerCase()].sort().join('\u0001');
      if (seen.has(pairKey)) continue; // one relationship per named pair
      seen.add(pairKey);
      out.push({ a, b, type: c.type });
    }
    return out;
  },

  // The pairs in force: State's, or the running plan's own.
  pairs() {
    return LayoutScope.current ? LayoutScope.current.constraints : (State.playerConstraints || []);
  },

  forPlayer(name) {
    const lower = String(name || '').toLowerCase();
    return (State.playerConstraints || []).filter(c => c.a.toLowerCase() === lower || c.b.toLowerCase() === lower);
  },
  otherName(c, name) {
    return c.a.toLowerCase() === String(name || '').toLowerCase() ? c.b : c.a;
  },
  nick(name) { return String(name || '').split('-')[0]; },

  // Adds/replaces the relationship between two names. Returns false for a
  // no-op (empty name, self-pair, unknown type).
  add(nameA, nameB, type) {
    const a = String(nameA || '').trim(), b = String(nameB || '').trim();
    if (!a || !b || a.toLowerCase() === b.toLowerCase() || !this.TYPES.includes(type)) return false;
    this.remove(a, b);
    State.playerConstraints = State.playerConstraints || [];
    State.playerConstraints.push({ a, b, type });
    return true;
  },
  remove(nameA, nameB) {
    const pair = [String(nameA || '').toLowerCase(), String(nameB || '').toLowerCase()].sort();
    State.playerConstraints = (State.playerConstraints || []).filter(c =>
      [c.a.toLowerCase(), c.b.toLowerCase()].sort().join('\u0001') !== pair.join('\u0001'));
  },

  // Drops any constraint referencing a name no longer in the roster — called
  // from RosterEdit.DeletePlayer, mirroring ClearOverridesFor/Backups.clearForName.
  clearForName(name) {
    const lower = String(name || '').toLowerCase();
    State.playerConstraints = (State.playerConstraints || []).filter(c =>
      c.a.toLowerCase() !== lower && c.b.toLowerCase() !== lower);
  },

  // Drops any constraint where either side is no longer anywhere in the
  // roster or bench — run on every commit (reconcilePlan), like Backups.reconcile()/
  // Assignments.reconcileRoster(), so a departure path with no explicit
  // clearForName() call (e.g. RaidSplit moving a player out of this plan)
  // still self-heals instead of leaving a name-keyed constraint dangling.
  reconcile() {
    const names = new Set([...(State.roster || []), ...(State.bench || [])].map(p => (p.name || '').toLowerCase()));
    State.playerConstraints = (State.playerConstraints || []).filter(c =>
      names.has(c.a.toLowerCase()) && names.has(c.b.toLowerCase()));
  },

  _locate(groups, name) {
    const lower = String(name || '').toLowerCase();
    for (let gi = 0; gi < groups.length; gi++) {
      const player = groups[gi].find(p => (p.name || '').toLowerCase() === lower);
      if (player) return { player, gi };
    }
    return null;
  },

  // Read-only: constraints violated in `groups` as they stand, without moving
  // anyone. A constraint naming someone not currently seated is silently
  // skipped (nothing to report — they're on the bench or gone).
  violations(groups) {
    const pairs = this.pairs();
    if (!pairs.length) return [];
    const out = [];
    for (const c of pairs) {
      const a = this._locate(groups, c.a), b = this._locate(groups, c.b);
      if (!a || !b) continue;
      if (c.type === 'together' && a.gi !== b.gi) {
        out.push({ type: 'together', a: c.a, b: c.b,
          text: `${this.nick(c.a)} and ${this.nick(c.b)} are supposed to be kept together but landed in different groups` });
      } else if (c.type === 'apart' && a.gi === b.gi) {
        out.push({ type: 'apart', a: c.a, b: c.b,
          text: `${this.nick(c.a)} and ${this.nick(c.b)} are supposed to be kept apart but are both in Group ${a.gi + 1}` });
      }
    }
    return out;
  },

  // Consolidates every located member of one "together" cluster into whichever
  // of their current groups already holds the most of them (least disruptive),
  // or the group of a locked (template-pinned) member when one exists — a
  // locked player never moves. Evicts the lowest dps-weight non-pinned,
  // non-cluster member to make room when the target is full. Returns true on
  // success, false when it couldn't be done (reported as a violation by the
  // caller via violations(), never thrown).
  _gatherIntoOneGroup(groups, located, max) {
    const members = located.map(l => l.player);
    const isMember = (p) => members.includes(p);
    const lockedAt = located.filter(l => l.player.locked);
    if (lockedAt.length && lockedAt.some(l => l.gi !== lockedAt[0].gi)) return false; // locked in 2+ different groups — unfixable
    let targetGi;
    if (lockedAt.length) {
      targetGi = lockedAt[0].gi;
    } else {
      let bestAlready = -1;
      targetGi = located[0].gi;
      for (let gi = 0; gi < groups.length; gi++) {
        const already = located.filter(l => l.gi === gi).length;
        if (already > bestAlready) { bestAlready = already; targetGi = gi; }
      }
    }
    const targetGroup = groups[targetGi];
    for (const { player, gi } of located) {
      if (gi === targetGi) continue;
      if (player.locked) return false;
      const fromGroup = groups[gi];
      if (targetGroup.length < max) {
        fromGroup.splice(fromGroup.indexOf(player), 1);
        targetGroup.push(player);
        continue;
      }
      let evictIdx = -1, evictWeight = Infinity;
      for (let pi = 0; pi < targetGroup.length; pi++) {
        const cand = targetGroup[pi];
        if (isMember(cand) || cand.locked) continue;
        const w = dpsWeightFor(cand);
        if (w < evictWeight) { evictWeight = w; evictIdx = pi; }
      }
      if (evictIdx < 0) return false; // nowhere to put the displaced member
      const displaced = targetGroup[evictIdx];
      fromGroup.splice(fromGroup.indexOf(player), 1, displaced);
      targetGroup[evictIdx] = player;
    }
    return true;
  },

  // Moves whichever of a/b isn't locked into the first other group that (a)
  // has room or a swappable non-pinned member, and (b) wouldn't create a
  // different apart-violation for the mover. Returns true on success.
  _separate(groups, a, b, max) {
    const mover = a.player.locked ? (b.player.locked ? null : b) : a;
    if (!mover) return false;
    const moverName = (mover.player.name || '').toLowerCase();
    const wouldViolate = (gi) => this.pairs().some(c => {
      if (c.type !== 'apart') return false;
      const names = [c.a.toLowerCase(), c.b.toLowerCase()];
      if (!names.includes(moverName)) return false;
      const otherName = names[0] === moverName ? names[1] : names[0];
      return groups[gi].some(p => (p.name || '').toLowerCase() === otherName);
    });
    for (let gi = 0; gi < groups.length; gi++) {
      if (gi === mover.gi || wouldViolate(gi)) continue;
      const group = groups[gi];
      const fromGroup = groups[mover.gi];
      if (group.length < max) {
        fromGroup.splice(fromGroup.indexOf(mover.player), 1);
        group.push(mover.player);
        return true;
      }
      let evictIdx = -1, evictWeight = Infinity;
      for (let pi = 0; pi < group.length; pi++) {
        if (group[pi].locked) continue;
        const w = dpsWeightFor(group[pi]);
        if (w < evictWeight) { evictWeight = w; evictIdx = pi; }
      }
      if (evictIdx < 0) continue;
      const displaced = group[evictIdx];
      group[evictIdx] = mover.player;
      fromGroup.splice(fromGroup.indexOf(mover.player), 1, displaced);
      return true;
    }
    return false;
  },

  // The hard-constraint fixup pass, run LAST in Optimizer.arrange() (see the
  // note there). Mutates `groups` in place, same splice/push convention as
  // every other Optimizer phase, then reports the actual resulting state via
  // violations() rather than tracking a parallel success/failure log — the
  // report can't drift from what the board actually ended up as.
  enforce(groups, max) {
    const pairs = this.pairs();
    if (!pairs.length) return { violations: [] };

    // TOGETHER: union-find into clusters, then gather each into one group.
    const together = pairs.filter(c => c.type === 'together');
    const parent = {};
    const find = (x) => { if (!(x in parent)) parent[x] = x; return parent[x] === x ? x : (parent[x] = find(parent[x])); };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (const c of together) union(c.a.toLowerCase(), c.b.toLowerCase());
    const clusters = {};
    for (const key of Object.keys(parent)) (clusters[find(key)] = clusters[find(key)] || []).push(key);

    for (const key of Object.keys(clusters).sort()) {
      const names = clusters[key].sort();
      if (names.length < 2) continue;
      const located = names.map(n => this._locate(groups, n)).filter(Boolean);
      if (located.length < 2 || located.length > max) continue; // nothing seated to fix, or structurally impossible
      if (new Set(located.map(l => l.gi)).size === 1) continue; // already together
      this._gatherIntoOneGroup(groups, located, max);
    }

    // APART: any pair still sharing a group (after TOGETHER settled above)
    // gets one member relocated. Sorted for a deterministic fix order.
    const apart = pairs.filter(c => c.type === 'apart')
      .slice().sort((x, y) => [x.a, x.b].sort().join().localeCompare([y.a, y.b].sort().join()));
    for (const c of apart) {
      const a = this._locate(groups, c.a), b = this._locate(groups, c.b);
      if (!a || !b || a.gi !== b.gi) continue;
      this._separate(groups, a, b, max);
    }

    return { violations: this.violations(groups) };
  },
};

// ── DRUMMERS (feature-backlog-3 #5: TBC Leatherworker drum tracking) ──
// A minimal profession flag, name-keyed exactly like Backups/Constraints:
// which players the leader has tagged as Leatherworkers carrying drums, and
// (optionally) which drum type. TBC-only — Drums don't exist in Classic Era
// and Forever's status is unconfirmed (tasks/lessons.md item #5), so every
// call site that reads this gates on State.gameVersion === 'tbc' rather than
// this module gating itself, the same convention Campfires uses for its own
// Forever-only data (it stays a plain array here, always reset with the
// roster, and simply never read outside TBC).
const DRUM_TYPES = ['Battle', 'War', 'Restoration'];
const Drummers = {
  clean(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const out = [];
    for (const d of items) {
      if (!d || typeof d.player !== 'string') continue;
      const name = d.player.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue; // one drummer entry per named player
      seen.add(key);
      out.push({ player: name, drum: DRUM_TYPES.includes(d.drum) ? d.drum : '' });
    }
    return out;
  },

  // The tagged drummers in force: State's, or the running plan's own.
  tagged() {
    return LayoutScope.current ? LayoutScope.current.drummers : (State.drummers || []);
  },
  isDrummer(name) {
    const lower = String(name || '').toLowerCase();
    return this.tagged().some(d => d.player.toLowerCase() === lower);
  },
  get(name) {
    const lower = String(name || '').toLowerCase();
    return (State.drummers || []).find(d => d.player.toLowerCase() === lower) || null;
  },
  // Tags (or updates) `name` as a drummer. `drum` is optional — an empty/
  // unrecognized value just means "drummer, type unspecified".
  set(name, drum) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    State.drummers = State.drummers || [];
    const cleanDrum = DRUM_TYPES.includes(drum) ? drum : '';
    const existing = State.drummers.find(d => d.player.toLowerCase() === trimmed.toLowerCase());
    if (existing) { existing.player = trimmed; existing.drum = cleanDrum; }
    else State.drummers.push({ player: trimmed, drum: cleanDrum });
    return true;
  },
  remove(name) {
    const lower = String(name || '').toLowerCase();
    State.drummers = (State.drummers || []).filter(d => d.player.toLowerCase() !== lower);
  },
  // Leaving the roster for good (delete) or losing their identity (rename)
  // drops the tag — mirrors Backups.clearForName/Constraints.clearForName,
  // called from the same RosterEdit call sites.
  clearForName(name) { this.remove(name); },

  // Drops any drummer tag for a name no longer in the roster or bench — run
  // on every commit (reconcilePlan), mirroring Constraints.reconcile()/Backups.reconcile(),
  // so departure paths without an explicit clearForName() call (e.g.
  // RaidSplit) don't leave a stale tag that could resurface on a future
  // name collision.
  reconcile() {
    const names = new Set([...(State.roster || []), ...(State.bench || [])].map(p => (p.name || '').toLowerCase()));
    State.drummers = (State.drummers || []).filter(d => names.has(d.player.toLowerCase()));
  },

  // Per-group booleans: does this seated group hold at least one drummer?
  // Empty/nonexistent groups are simply `false`, same as "no members yet".
  coverageByGroup(groups) {
    return (groups || []).map(g => (g || []).some(p => this.isDrummer(p.name)));
  },
};

// ── FACTION (Classic Era: Shaman = Horde only, Paladin = Alliance only) ──
// Only meaningful for rulesets with rules.factionLock (Classic; Forever opts
// out per its own ruleset). Ambient over State like activeRules() elsewhere
// in this file, rather than threading a faction argument through every
// optimizer/insight call site.
const Faction = {
  detect(players) {
    if (!Array.isArray(players) || !players.length) return null;
    const hasShaman = players.some(p => p.class === 'SHAMAN');
    const hasPaladin = players.some(p => p.class === 'PALADIN');
    if (hasShaman && hasPaladin) return 'mixed';
    if (hasShaman) return 'horde';
    if (hasPaladin) return 'alliance';
    return null;
  },
  // Detected faction of the whole current roster (seated + benched).
  current() {
    if (LayoutScope.current) return LayoutScope.current.faction;
    return this.detect((State.groups || []).flat().concat(State.bench || []));
  },
};

// Config.Buffs filtered to what the detected faction can actually provide,
// for rulesets with rules.factionLock — an Alliance roster can never field a
// Shaman totem, a Horde roster can never field a Paladin aura, so neither
// should show up as a permanently "missing" buff. Unfiltered (returns
// Config.Buffs as-is) once the roster is empty/mixed/unknown, or for any
// ruleset that doesn't lock factions.
function factionRelevantBuffs() {
  const buffs = Config.Buffs;
  const rules = activeRules();
  if (!rules.rules || !rules.rules.factionLock) return buffs;
  const faction = Faction.current();
  if (faction !== 'horde' && faction !== 'alliance') return buffs;
  const out = {};
  for (const [id, buff] of Object.entries(buffs)) {
    if (faction === 'horde' && buff.sourceClass === 'PALADIN') continue;
    if (faction === 'alliance' && buff.sourceClass === 'SHAMAN') continue;
    out[id] = buff;
  }
  return out;
}

// ── RAID CAPACITY ───────────────────────────────────────────────
// A raid template only has room for numGroups x 5. Anyone past that — extra
// groups, or a sixth player in a group — is moved onto the bench rather than
// silently dropped, so nobody vanishes on import or when switching raids.
// Returns the number of players benched.
function enforceRaidCapacity(groups, bench, numGroups, maxPerGroup = 5) {
  const overflow = [];
  while (groups.length > numGroups) overflow.push(...groups.pop());
  for (const group of groups) {
    while (group.length > maxPerGroup) overflow.push(group.pop());
  }
  let benched = 0;
  for (const p of overflow) {
    const gi = groups.findIndex(g => g.length < maxPerGroup);
    if (gi >= 0) { groups[gi].push(p); p.groupNumber = gi + 1; }
    else { p.groupNumber = 0; bench.push(p); benched++; }
  }
  return benched;
}

// Players a Raid size shrink benched (nav slim-down), as State.sizeBenched (uids).
// Growing the size again re-seats the ones still on the bench into the new open
// seats, so 25 -> 10 -> 25 ends with everyone seated again. The list is part of
// the plan: PlanStore.capture/restore carry it, so undo/redo and a reload keep
// it, and another plan brings its own (or none). prune() runs on every commit, so
// a remembered player who gets seated drops off for good: benching them by hand
// later never makes a size change re-seat them. Players the leader benched
// themselves are never remembered.
const SizeBench = {
  clean(list) {
    return Array.isArray(list) ? [...new Set(list.filter(uid => typeof uid === 'string' && uid))] : [];
  },
  remember(uids) {
    State.sizeBenched = this.clean([...(State.sizeBenched || []), ...uids]);
  },
  // Keeps only remembered players who are on the bench right now.
  prune() {
    const onBench = new Set((State.bench || []).map(p => p.uid));
    State.sizeBenched = this.clean(State.sizeBenched).filter(uid => onBench.has(uid));
  },
  // Moves remembered players still on the bench into open seats, in the order
  // they were benched. Returns how many were seated.
  reseat(maxPerGroup = 5) {
    this.prune();
    const bench = State.bench || [];
    let seated = 0;
    for (const uid of [...State.sizeBenched]) {
      const gi = State.groups.findIndex(g => g.length < maxPerGroup);
      if (gi < 0) break;
      const [player] = bench.splice(bench.findIndex(p => p.uid === uid), 1);
      player.groupNumber = gi + 1;
      State.groups[gi].push(player);
      State.sizeBenched = State.sizeBenched.filter(u => u !== uid);
      seated++;
    }
    if (seated) State.roster = State.groups.flat();
    return seated;
  },
};

// ── PLAYER IDENTITY ─────────────────────────────────────────────
// class/spec/role reach the app from share links, live links, v1 strings,
// JSON rosters and saved plans, then get used as lookup keys and rendered
// into HTML. Only values the active ruleset knows are accepted; everything
// else is dropped at the door (own-property checks, so "constructor" and
// "__proto__" are not mistaken for classes).
const PlayerIdentity = {
  isClass(cls) { return typeof cls === 'string' && Object.prototype.hasOwnProperty.call(Config.Specs, cls); },
  isSpec(cls, spec) {
    return this.isClass(cls) && typeof spec === 'string' && Object.values(Config.Specs[cls]).some(s => s.name === spec);
  },
  isRole(role) { return Object.values(Config.Roles).includes(role); },
  isValid(p) {
    return !!p && typeof p.name === 'string' && this.isSpec(p.class, p.spec) && this.isRole(p.role);
  },
  cleanList(list) { return Array.isArray(list) ? list.filter(p => this.isValid(p)) : []; },
};

// ── SIGN-UP STATUS ──────────────────────────────────────────────
// How a person marked themselves on Raid-Helper, kept on the player as
// `signupStatus` so the sign-up tray can file everyone off the raid by why
// they're out. Raid-Helper carries Bench/Tentative/Late/Absence in className;
// any real class (or Tank) is a confirmed sign-up. Players added by hand or
// saved before this existed have no status and file under Bench.
const SignupStatus = {
  ALL: ['confirmed', 'bench', 'tentative', 'late', 'absent'],
  LABELS: { confirmed:'Signed up', bench:'Bench', tentative:'Tentative', late:'Late', absent:'Absent' },
  FROM_RAID_HELPER: { Bench:'bench', Tentative:'tentative', Late:'late', Absence:'absent' },

  fromRaidHelper(className) { return this.FROM_RAID_HELPER[className] || 'confirmed'; },
  clean(status) { return this.ALL.includes(status) ? status : undefined; },
  label(status) { return this.LABELS[status] || ''; },

  // Where a sign-up lands on import: confirmed people go to the optimizer,
  // Bench/Tentative/Late wait on the bench, and anyone Absent or without a
  // class is held as unplaced.
  categoryFor(status, classFile) {
    if (status === 'absent' || !classFile) return 'unplaced';
    return status === 'confirmed' ? 'raider' : 'bench';
  },

  // The tray tab a benched or unplaced player is filed under.
  tabFor(status) { return ['tentative', 'late', 'absent'].includes(status) ? status : 'bench'; },

  // Unplaced entries survive storage only with a name; class/spec/role are
  // kept when the ruleset knows them, otherwise null (the drag-in picker asks).
  cleanUnplaced(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(p => p && typeof p.name === 'string' && p.name).map(p => {
      const known = PlayerIdentity.isClass(p.class);
      return {
        uid: typeof p.uid === 'string' ? p.uid : nextUid(), name: p.name,
        signupStatus: this.clean(p.signupStatus) || 'absent',
        class: known ? p.class : null,
        spec: PlayerIdentity.isSpec(p.class, p.spec) ? p.spec : null,
        role: known && PlayerIdentity.isRole(p.role) ? p.role : null,
      };
    });
  },
};

