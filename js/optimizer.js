// ── RANDOM ROSTER GENERATOR ──────────────────────────────────────

const RandomRoster = {
  // Specs grouped by role for quick lookup, cached per gameVersion+faction
  // combo (a faction-locked ruleset excludes the other faction's Shaman or
  // Paladin from the pool, so the cache key has to include it).
  _specsByRole: null,
  _specsByRoleKey: null,

  _buildSpecsByRole(faction) {
    const key = State.gameVersion + ':' + (faction || 'any');
    if (this._specsByRole && this._specsByRoleKey === key) return this._specsByRole;
    const byRole = { tank: [], healer: [], melee_dps: [], ranged_dps: [], caster_dps: [] };
    for (const [cls, specs] of Object.entries(Config.Specs)) {
      if (faction === 'horde' && cls === 'PALADIN') continue;
      if (faction === 'alliance' && cls === 'SHAMAN') continue;
      for (const [, spec] of Object.entries(specs)) {
        byRole[spec.role].push({ class: cls, spec: spec.name, role: spec.role });
      }
    }
    this._specsByRole = byRole;
    this._specsByRoleKey = key;
    return byRole;
  },

  _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  _randomName(usedNames) {
    const syllables = ['Tha','Mor','Kel','Zar','Gor','Ven','Ash','Dra','Lor','Fen',
      'Bri','Nox','Syl','Kor','Tal','Myr','Vor','Gal','Ren','Ula','Kae','Ori','Zan',
      'Thi','Nym','Eld','Rho','Isa','Val','Hel','Sar','Mal','Dun','Tor','Ari','Fyn'];
    for (let attempt = 0; attempt < 100; attempt++) {
      const len = 2 + Math.floor(Math.random() * 2); // 2-3 syllables
      let name = '';
      for (let i = 0; i < len; i++) name += (i === 0 ? this._pick(syllables) : this._pick(syllables).toLowerCase());
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
    }
    return 'Player' + Math.floor(Math.random() * 9999);
  },

  generate() {
    State.campfires = Campfires.empty();
    State.preferredSlots = [];
    State.preserveGroupOrder = false;
    // A random roster is an entirely new cast of (randomly-named) players —
    // notes, name-keyed constraints, bench backups and drum tags from
    // whatever was loaded before would otherwise dangle, referencing nobody
    // in the new roster, and reappear confusingly if a later import happens
    // to reuse one of those names.
    State.notes = '';
    State.playerConstraints = [];
    State.drummers = [];
    Assignments.restore(null);
    Backups.restore(null);
    const raidInfo = Config.Raids[State.selectedRaid];
    const size = raidInfo ? raidInfo.size : 25;
    const numGroups = raidInfo ? raidInfo.groups : 5;

    const tanks = (size === 40) ? 4 : 2;
    const healers = (size === 10) ? 2 : (size === 40) ? 10 : 5;
    const dps = size - tanks - healers;

    // Faction-locked rulesets (Classic) generate a single-faction roster —
    // Shaman = Horde only, Paladin = Alliance only in Classic Era — instead
    // of a roster that could never occur in that game version.
    const rules = activeRules();
    const faction = (rules.rules && rules.rules.factionLock) ? (Math.random() < 0.5 ? 'horde' : 'alliance') : null;
    const byRole = this._buildSpecsByRole(faction);
    const roster = [];
    const usedNames = new Set();

    const makePlayer = (specInfo) => ({
      uid: nextUid(),
      name: this._randomName(usedNames),
      class: specInfo.class,
      spec: specInfo.spec,
      role: specInfo.role,
      groupNumber: 0,
      imported: true,
    });

    // Tanks
    for (let i = 0; i < tanks; i++) roster.push(makePlayer(this._pick(byRole.tank)));

    // Healers
    for (let i = 0; i < healers; i++) roster.push(makePlayer(this._pick(byRole.healer)));

    // DPS — split roughly half melee, half ranged/caster
    const meleeCount = Math.floor(dps / 2);
    const rangedCount = dps - meleeCount;
    for (let i = 0; i < meleeCount; i++) roster.push(makePlayer(this._pick(byRole.melee_dps)));
    for (let i = 0; i < rangedCount; i++) {
      // Mix ranged_dps and caster_dps
      const pool = [...byRole.ranged_dps, ...byRole.caster_dps];
      roster.push(makePlayer(this._pick(pool)));
    }

    // Shuffle and distribute into groups
    this._shuffle(roster);
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);
    for (let i = 0; i < roster.length; i++) {
      const gi = i % numGroups;
      roster[i].groupNumber = gi + 1;
      groups[gi].push(roster[i]);
    }

    State.roster = roster;
    State.groups = groups;
    State.rosterName = 'Random ' + size + '-man Roster';
    State.sourceEventId = null;
    State.eventStartTime = null;
    State.bench = [];
    State.unplaced = [];
    State.buffOverrides = {};
  },
};

// ── OPTIMIZER ────────────────────────────────────────────────────
// Received-value scorer: the objective is what each group member RECEIVES
// from the party buffs present in their group (per-spec DPS weights, and
// per-tank-class mitigation weights for the tank group), plus structural
// terms (healer coverage, role cohesion, spreading pressure). All phases
// (greedy placement, swap refinement, de-isolation) share one groupScore().

// The numbers behind the score are data, not code: each buff's `weight` (what a recipient gains: dps, mitigation for a
// tank, sustain for a healer group), specDpsWeight / roleDpsWeight (a recipient's expected DPS output), the tuning
// numbers in `conventions` and the objective weights per mode in conventions.modeConfig, one file per game version
// (js/rules/tbc.js, classic.js, forever.js, each explained where it is written). Rulesets.compile() (js/rules.js) turns
// them into the tables read below: the active ruleset's dpsValue, mitValue, sustainValue, dpsWeight, dpsWeightByRole,
// cooldownTotems, modeConfig and rules.

// The objective weights of an optimizer mode: the ruleset's modeConfig (dps, mit, structure, cohesion). Only max_dps is
// supported; the other modes are deprecated and kept in the data only so old saved plans and share links still
// validate (see the DEPRECATED note on conventions.modeConfig in js/rules/*.js: never tune or write code for them).
// An unknown mode, e.g. from an old link, scores as max_dps.
function modeConfigFor(rules, mode) {
  return rules.modeConfig[mode] || rules.modeConfig.max_dps;
}

function dpsWeightFor(player) {
  const rules = activeRules();
  const w = (rules.dpsWeight || {})[player.class + ':' + player.spec];
  if (w != null) return w;
  const r = (rules.dpsWeightByRole || {})[player.role];
  // 0.8 only for a player whose role has no roleDpsWeight entry; every version file lists all five roles, so today
  // this is a dead guard, kept on purpose.
  return r != null ? r : 0.8;
}

// True for a buff whose data says scope 'raid' (Rulesets.compile copies the scope onto the compiled buff only for
// raid-wide ones, so Classic and TBC, which have none, never take a raid-wide path).
function isRaidWideBuff(buffId) {
  const buff = Config.Buffs[buffId];
  return !!buff && buff.scope === 'raid';
}

// True when the player can cast the buff (its class, and its spec when the buff names one).
function isBuffSource(buff, player) {
  return player.class === buff.sourceClass && (!buff.sourceSpec || player.spec === buff.sourceSpec);
}

function dpsValueFor(buffId, player) {
  const v = (activeRules().dpsValue || {})[buffId];
  if (!v) return 0;
  const key = player.class + ':' + player.spec;
  let base = 0;
  if (v.key && v.key[key] != null) base = v.key[key];
  else if (v.class && v.class[player.class] != null) base = v.class[player.class];
  else if (v.role && v.role[player.role] != null) base = v.role[player.role];
  return base * dpsWeightFor(player);
}

function mitValueFor(buffId, tank) {
  const v = (activeRules().mitValue || {})[buffId];
  if (!v) return 0;
  const key = tank.class + ':' + tank.spec;
  if (v[key] != null) return v[key];
  if (v['*'] != null) return v['*'];
  return 0;
}

const ROLE_COMPAT = {
  tank:       ['melee_dps', 'healer'],
  healer:     ['tank', 'caster_dps'],
  melee_dps:  ['tank', 'ranged_dps'],
  ranged_dps: ['melee_dps', 'caster_dps'],
  caster_dps: ['healer', 'ranged_dps'],
};

// ?dev only: wraps fn in performance.mark/measure ("pp:optimize", "pp:compare") so the
// browser's Performance panel and performance.getEntriesByType('measure') show what
// Optimize and Compare cost. Production (no ?dev) just calls fn.
function devPerfEnabled() {
  return typeof location !== 'undefined' && /[?&]dev(?:[&=]|$)/.test(location.search || '') &&
    typeof performance !== 'undefined' && typeof performance.mark === 'function' && typeof performance.measure === 'function';
}
function devMeasure(name, fn) {
  if (!devPerfEnabled()) return fn();
  performance.mark(name + ':start');
  try {
    return fn();
  } finally {
    performance.mark(name + ':end');
    performance.measure(name, name + ':start', name + ':end');
    performance.clearMarks(name + ':start');
    performance.clearMarks(name + ':end');
  }
}

const Optimizer = {
  // How much raid total (the points groupScore sums) a bench choice may give up and still count as a tie: the bench refinement takes a trade only for more than
  // this, and the fairness pass (refineFairness) and the Standby rule (refineBench) treat anything within it as equal value.
  BENCH_TOLERANCE: 0.5,

  // Every Optimize replaces the previous run's suggested Open slots: drop
  // them and lay out the real players with the leader's own Open slots, then
  // suggest a spec for every seat still empty (OpenSlots.choose) and lay the
  // whole raid out again with every Open slot as a stand-in member, so a
  // suggested Enh Shaman sits with the melee it buffs even when real players
  // have to move to make room. The first layout is a draft (one swap pass,
  // no further refinement): it only gives choose() a board that does not
  // depend on how the players arrived, at a fraction of the full cost.
  // Nobody already on the bench is seated (user rule 2026-10-21), with ONE exception that stays until the user decides:
  // players a raid-size shrink parked (_sizeBenchedPlayers). opts.joiners (the new Signed up sign-ups of a Raid-Helper
  // sync, see Import.seatNewRaiders) replaces that exception for this run: the pool is the board plus those players only,
  // and whoever is left out is just on the bench (not remembered as size-benched).
  optimize(opts = {}) {
    const joiners = Array.isArray(opts.joiners) ? opts.joiners : null;
    devMeasure('pp:optimize', () => {
      State.preferredSlots = PreferredSlots.manual();
      // A full raid has no seat to suggest for: skip the draft.
      // Size-benched players count as seated here: the draft would pull them in anyway, so this only skips it.
      const raid = Config.Raids[State.selectedRaid];
      const seats = raid ? Math.min(raid.size, State.groups.length * RosterEdit.MAX_GROUP_SIZE) : 0;
      if (State.groups.flat().length + this._benchPool(joiners).length + State.preferredSlots.length < seats) {
        this._optimizeSeats(true, joiners);
        State.preferredSlots.push(...OpenSlots.choose().map(p => ({ group: -1, class: p.class, spec: p.spec, auto: true, ...(p.alts.length ? { alts: p.alts } : {}) })));
      }
      this._optimizeSeats(false, joiners);
    });
  },

  // The bench players this run may seat: the sync's joiners when given, else the shrink-parked ones.
  _benchPool(joiners) {
    return joiners ? joiners.filter(p => (State.bench || []).includes(p)) : this._sizeBenchedPlayers();
  },

  // Players a raid-size shrink benched (State.sizeBenched, see SizeBench in js/state.js) are the optimizer's to seat
  // again: the shrink benched them by position, so Optimize decides who sits from the board plus these players, by
  // the role floors, the healer cap and value, exactly as an import does. Anyone benched by hand, and Bench/Tentative
  // sign-ups, are not remembered there and stay on the bench.
  _sizeBenchedPlayers() {
    const remembered = new Set(State.sizeBenched || []);
    return (State.bench || []).filter(p => remembered.has(p.uid));
  },

  // The adapter between State and plan(): reads the board and its settings,
  // asks plan() for a layout, and applies the result. Open slots (manual and
  // suggested alike) join the layout as stand-in members and come back in the
  // group plan() put them in; no group is held back for them. Slots past the
  // raid's seats are dropped (suggested ones first), never a real player.
  // The pool is the board plus the players a raid-size shrink benched (_sizeBenchedPlayers).
  // draft: a quick layout for choose() to price on (see plan).
  _optimizeSeats(draft = false, joiners = null) {
    if (!GameVersions[State.gameVersion].modeled) {
      enforceRaidCapacity(State.groups, State.bench, Config.Raids[State.selectedRaid].groups);
      State.roster = State.groups.flat();
      return;
    }
    const inputs = {
      gameVersion: State.gameVersion,
      mode: State.optimizerMode || 'max_dps',
      constraints: State.playerConstraints || [],
      drummers: State.drummers || [],
      faction: Faction.current(),
    };
    const raidInfo = Config.Raids[State.selectedRaid];
    const numGroups = raidInfo ? raidInfo.groups : 5;
    const pulled = this._benchPool(joiners);
    if (pulled.length) State.bench = State.bench.filter(p => !pulled.includes(p));
    const players = State.groups.flat().concat(pulled);
    State.preferredSlots = State.preferredSlots.slice(0, Math.max(0, numGroups * RosterEdit.MAX_GROUP_SIZE - players.length));
    const standIns = State.preferredSlots.map(OpenSlots.standIn);
    if (!players.length && !standIns.length) return;
    const { groups, bench } = this.plan(players.concat(standIns), {
      ...inputs, numGroups, raidSize: raidInfo ? raidInfo.size : 25, draft,
    });
    // Each slot takes its stand-in's group.
    State.preferredSlots.forEach((slot, i) => { slot.group = groups.findIndex(g => g.includes(standIns[i])); });
    for (const group of groups) {
      for (let i = group.length - 1; i >= 0; i--) if (group[i].openSlot) group.splice(i, 1);
    }
    // Once a shrink's players are pooled, everyone plan() leaves out is the size change's bench (remembered, so a
    // later grow seats them all); the player the leader benched by hand was never in the pool.
    if (pulled.length && !joiners) SizeBench.remember(bench.filter(p => !p.openSlot).map(p => p.uid));
    this._applyPlan(groups, bench);
  },

  // Writes a plan() result to the board: overflow joins the bench, every seated
  // player learns their group, and the roster follows the groups.
  _applyPlan(groups, bench) {
    if (!State.bench) State.bench = [];
    State.bench.push(...bench);
    for (let gi = 0; gi < groups.length; gi++) {
      for (const p of groups[gi]) p.groupNumber = gi + 1;
    }
    State.groups = groups;
    State.roster = groups.flat();
  },

  // Lays `players` out into groups from explicit inputs only: it reads and
  // writes no State and no DOM (the rule lookups it leans on read `opts`
  // through LayoutScope while it runs), so a caller can plan any roster under
  // any settings without staging a board first. Deterministic for a given
  // player set and opts, whatever order or arrangement the players arrive in.
  //
  // opts: { gameVersion, numGroups, raidSize, mode = 'max_dps', max = 5,
  //   constraints = [], drummers = [], faction (default: detected from players),
  //   draft (true: seeding, greedy placement and one swap pass only; a quick
  //   canonical board for pricing Open slots, not one to ship) }.
  // Returns { groups, bench }: `groups` is the board (it also carries
  // _roleIdentities/_anchors for later scoring) and `bench` the players left
  // over when the roster exceeds the raid. Seated players are stamped with
  // their group (groupNumber) by the caller; the players passed in are not
  // copied, so a benched one comes back with groupNumber 0 and a stale
  // comp-template lock is cleared, exactly as arrange() has always done.
  plan(players, opts) {
    const { gameVersion, numGroups, raidSize, mode = 'max_dps', max = 5, constraints = [], drummers = [], draft = false } = opts;
    const faction = opts.faction !== undefined ? opts.faction : Faction.detect(players);
    return LayoutScope.run({ gameVersion, faction, constraints, drummers }, () => {
      // Raid-wide buffs are valued over the players the current step plans (see raidWideValues): everyone while the
      // seats are chosen, the seated set once they are laid out, exactly as a seated-only run would (so the next Optimize
      // click reproduces this board).
      const outerRaidScope = this._raidScope;
      try {
        this._raidScope = { pool: players, byMode: {} };
        // Over capacity: decide WHO sits first (floors, greedy, bench trades),
        // then lay the seated set out exactly as a seated-only run would. The
        // selection search takes a different path than a plain layout of the same
        // players, so laying out from its intermediate board would leave the next
        // Optimize click (which never sees the bench) in a different local optimum
        // and reshuffle a board the first click just produced.
        let seated = players, bench = [];
        if (players.length > numGroups * max) {
          ({ seated, bench } = this.selectSeated(players, numGroups, raidSize, max, mode));
        }
        this._raidScope = { pool: seated, byMode: {} };
        return { groups: this.arrange(seated, numGroups, raidSize, max, mode, draft), bench };
      } finally { this._raidScope = outerRaidScope; }
    });
  },

  // Canonical order. Greedy placement and swap refinement break ties by
  // iteration order, so the result must not depend on how the board
  // happened to be arranged before the click — otherwise every Optimize
  // lands in a different local optimum and the second click reshuffles
  // a layout the first one just produced.
  sortedPool(players) {
    return players.slice().sort((a, b) => {
      const ka = a.role + '|' + a.class + '|' + a.spec + '|' + (a.name || '');
      const kb = b.role + '|' + b.class + '|' + b.spec + '|' + (b.name || '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  },

  // Seated-only refinement: pairwise swaps alone cannot change group sizes,
  // so a group the greedy phase filled last stays starved while other groups
  // sit full; single-player moves into open slots fix that. Alternate until
  // neither neighbourhood improves. Skipped for relaxed.
  refineRounds(groups, max, mode) {
    if (mode === 'relaxed') return;
    for (let round = 0; round < 6; round++) {
      this.refineSwaps(groups, max, mode);
      const moved = this.refineMoves(groups, max, mode);
      const exchanged = this.refinePairExchanges(groups, mode);
      // 3-cycles reach rebalances no swap/exchange can (e.g. the suggested Ret
      // rotating from the tank group to the Enh Shaman's group while a
      // displaced player fills the seat it leaves). 2026-10-10 comp rules.
      const rotated = this.refineRotations(groups, mode);
      if (!moved && !exchanged && !rotated) break;
    }
  },

  // Lays out a set of players that fits the raid. Deterministic for a given
  // set: the same players always produce the same board, whatever order or
  // arrangement they arrive in. draft stops after one swap pass (see plan).
  arrange(players, numGroups, raidSize, max, mode, draft = false) {
    const pool = this.sortedPool(players);
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);

    // Phase 0: Seat locked players (comp-template placements, backlog #1)
    // into their fixed group before anything else runs, and pull them out of
    // the pool so no later phase treats them as available. isPinned() (below)
    // then keeps every refinement phase from moving them again — the same
    // mechanism the seeded anchor tank already relies on. A no-op unless a
    // template was just applied (nothing else ever sets .locked), so this
    // changes nothing for the existing scenario-tests fixtures.
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      if (!p.locked) continue;
      const gi = p.groupNumber ? p.groupNumber - 1 : -1;
      if (gi >= 0 && gi < numGroups && this.hasRoom(groups, gi, max)) {
        groups[gi].push(p);
        pool.splice(i, 1);
      } else {
        p.locked = false; // stale/out-of-range group index — fall back to normal placement
      }
    }

    // Phase 1: Seed groups with role identities
    this.seedGroups(pool, groups, numGroups, raidSize, max, mode);

    // Phase 2: Greedy marginal-gain placement of remaining players
    this.greedyPlace(pool, groups, max, mode);
    if (draft) {
      this.refineSwaps(groups, max, mode);
      return groups;
    }

    // Phase 3: Refinement
    this.refineRounds(groups, max, mode);

    // Phase 3b: Guest optimization — the tank group is filled last by the
    // greedy phase (it's the least attractive), so its leftover DPS guests
    // are near-arbitrary. Re-audit them with a zero swap threshold: any
    // strictly better guest choice is taken, even ones too small for
    // refineSwaps' churn threshold.
    this.optimizeTankGuests(groups, mode);

    // Phase 4: De-isolation — always runs, every mode. A player who benefits
    // from nobody in their group (e.g. the lone melee DPS in an otherwise
    // all-caster/healer group) is worse than a small buff-score inefficiency,
    // but refineSwaps only takes a swap that clears SWAP_THRESHOLD, so an
    // isolated player can survive it if no single swap scores well enough.
    this.deIsolate(groups, mode, max);

    // Phase 4b: final refine. Phases 3b/4 run after the last refineRounds, so
    // plain swaps / rotations they left on the table are taken here, guarded
    // so a candidate never isolates a member (de-isolation is never undone).
    // deIsolate then runs once more and must be a no-op. Before Phase 5 so the
    // Classic/Forever spreadProviders ordering stays true.
    if (mode !== 'relaxed' && activeRules().rules.rotationSearch) {
      const guard = { noIsolate: true };
      for (let iter = 0; iter < 6; iter++) {
        const swapped = this.refineSwaps(groups, max, mode, guard);
        const rotated = this.refineRotations(groups, mode, guard);
        if (!swapped && !rotated) break;
      }
      this.deIsolate(groups, mode, max);
    }

    // Phase 5: Spread scarce single-point-of-failure providers (ruleset-gated;
    // a no-op unless rules.spreadProviders is set — TBC is untouched). Must
    // run LAST: de-isolating a group that lost its second shaman to this pass
    // can leave the remaining one as that group's only caster-family member,
    // which deIsolate would then "fix" by pulling it out again — silently
    // re-creating the exact stack this phase exists to prevent. Nothing runs
    // after it, so its rebalance is what the board actually ships with.
    // spreadProviders itself now refuses to pick a source whose removal would
    // strand a melee/caster DPS deIsolate just fixed (see its wouldIsolate()
    // guard) — the mirror case of the one this comment already described,
    // and the one that used to survive into Relaxed mode's shipped board
    // since nothing ran after Phase 5 to catch it there. `mode` is passed
    // through so its very last-resort source tier (spareProtected) — a
    // deliberate softening of the "never touch a guest's only buff" courtesy,
    // needed to fully close Relaxed's known gaps — only engages for Relaxed;
    // every other mode already reaches full coverage via refineRounds before
    // Phase 5 even runs, so leaving their spreadProviders behavior untouched
    // avoids trading a fixed gap for a fresh one elsewhere (see spreadProviders).
    this.spreadProviders(groups, mode);

    // Phase 5b: Spread TBC drummers (feature-backlog-3 #5). A Leatherworker's
    // Drums is party-scoped exactly like Windfury/an aura, but drummers are
    // tagged per-player independent of class/spec, so spreadProviders' class-
    // matching machinery doesn't apply — this is a small, dedicated pass
    // instead. Strict no-op unless State.drummers is non-empty on a TBC
    // roster, so the TBC scenario suite (which never tags any) is completely
    // untouched. Runs before Phase 6 so any constraint it happens to disturb
    // is still fixed up right after, same ordering reasoning as Phase 5.
    this.spreadDrummers(groups, mode);

    // Phase 6: Hard player constraints (backlog #3) — keep-together/keep-apart
    // pairs win over every structural/buff preference above, so this must run
    // absolutely last (same "nothing runs after it" reasoning as Phase 5). A
    // no-op unless State.playerConstraints is non-empty, so the TBC scenario
    // suite (which never sets it) is untouched. Readiness.balanceWarnings()
    // recomputes Constraints.violations() live from State.groups every render
    // rather than trusting a cached report, so a later manual drag that
    // breaks a constraint is still caught even though enforce() only runs
    // here, right after Optimize.
    Constraints.enforce(groups, max);
    return groups;
  },

  // A melee group's Windfury (or an Alliance melee group's aura, or a melee
  // group's Leader of the Pack) depends on exactly one class member being
  // present. groupScore's per-group penalties (meleeWantsWindfury etc.) can
  // still let greedy placement + pairwise swaps settle on two of that class
  // stacked in one group while a same-identity group has zero: the stack
  // isn't penalized (nothing scores an *excess* of a buff down), and undoing
  // it is a two-hop trade no single pairwise swap can discover on its own —
  // exactly the class of local optimum documented in tasks/lessons.md
  // (2026-08-19, "model-optimal is not the acceptance criterion"). This phase
  // looks at the whole board instead of one group at a time and rebalances
  // that specific case. No-op unless the active ruleset sets
  // rules.spreadProviders (Classic only — see Rulesets.classic.rules).
  spreadProviders(groups, mode) {
    const rules = activeRules();
    const specs = (rules.rules && rules.rules.spreadProviders) || [];
    if (!specs.length) return;
    // Every group that actually holds melee dps (Windfury/aura/LotP
    // convention). Checked by ACTUAL role membership, not the abstract seed
    // identity from seedGroups — a group seeded 'caster_dps' can still end up
    // holding melee dps members (overflow, ROLE_COMPAT cohesion), and those
    // players need Windfury exactly as much as a 'melee_dps'-seeded group's
    // do. Melee coverage runs first and always wins ties over caster
    // coverage below, per this task's stated priority order.
    // Only providers with a PARTY-scoped buff for melee are spread over the melee groups: a raid-wide buff (Forever's
    // Windfury, Leader of the Pack, ...) reaches every group wherever its provider sits, so spreading for it would
    // be placement driven by a buff that has no placement value (the same rule as Bloodlust).
    const meleeSpecs = specs.filter(s => this.providesPartyBuffTo(s, 'melee_dps'));
    if (meleeSpecs.length) this._spreadPass(groups, meleeSpecs, 'melee_dps', { mode });

    // Surplus shamans (more shamans than melee-identity groups) then cover
    // caster groups with Mana Spring. This used to be left entirely to
    // groupScore's ordinary buff-value pull, which under-covered casters in
    // practice (a lone extra shaman often scored better riding with the tank
    // group's healers than hopping to an already-full caster group). Restricted
    // to SHAMAN only — Paladin/Feral have no caster-facing equivalent buff —
    // and passes `protectRoles: ['melee_dps']` so this pass can never treat a
    // melee group's sole shaman as "spare" just because that melee group
    // itself has no caster_dps members; only a genuine surplus (2+ in one
    // group) or an idle shaman sitting somewhere with neither a melee_dps NOR
    // a caster_dps member relying on it (e.g. alone with the tank/healer
    // group) is fair game as a source. A no-op unless the ruleset actually
    // lists SHAMAN as a spread provider (Classic/Forever; TBC has none).
    const shamanSpec = specs.filter(s => s.class === 'SHAMAN');
    if (shamanSpec.length) this._spreadPass(groups, shamanSpec, ['caster_dps', 'healer'], { protectRoles: ['melee_dps'], mode });
  },

  // TBC-only (feature-backlog-3 #5): spread Leatherworker drummers one per
  // party before letting any group hold two. Deliberately simpler than
  // _spreadPass above — drums aren't tied to a class/spec or a benefiting
  // role, so none of that machinery's role-targeting guards apply.
  // Every group that already has >=1 drummer is left alone; a group with
  // zero only gets one moved in if another group has a genuine surplus
  // (2+), and only by swapping with a non-pinned member (isPinned covers
  // both `.locked` and the seeded anchor tank, same guard every other phase
  // uses) — never into/out of an empty seat, since a full 25/40-man raid has
  // none.
  //
  // Drums are worth less than the buffs a swap can take away, so a candidate
  // swap (needy member <-> surplus drummer) is skipped when it would remove
  // the only provider of a buff either group's members actually use (the
  // melee group's sole Feral = Leader of the Pack, the caster group's sole
  // Boomkin, ...) or leave a melee/caster DPS with no same-family peer
  // (wouldIsolate, the same lookahead spreadProviders uses; a group that was
  // already isolated before the swap doesn't block it). Of the swaps that
  // remain, the one losing the least groupScore across the two groups wins.
  // Bounded, deterministic, and a strict no-op with zero drummers tagged, so
  // the TBC scenario suite (which never tags any) is completely unaffected.
  spreadDrummers(groups, mode = State.optimizerMode || 'max_dps') {
    if (activeVersion() !== 'tbc') return;
    if (!Drummers.tagged().length) return;
    const isDrummer = p => Drummers.isDrummer(p.name);
    const pairScore = (a, b) => this.groupScore(groups[a], a, groups, mode) + this.groupScore(groups[b], b, groups, mode);
    // Buff ids a group resolves that at least one of its members gets value from.
    // The warrior shouts count as one buff (Battle or Commanding Shout): a swap may
    // turn a group's second shout into nothing, never its only one.
    const shouts = activeRules().shouts || [];
    const family = (id) => shouts.includes(id) ? 'SHOUT' : id;
    const usedBuffs = (grp) => [...this.resolveGroupBuffs(grp, () => 1)].filter(id =>
      grp.some(m => dpsValueFor(id, m) > 0 || (m.role === 'tank' && mitValueFor(id, m) > 0)));
    const keepsBuffs = (before, after) => {
      const kept = new Set([...this.resolveGroupBuffs(after, () => 1)].map(family));
      return usedBuffs(before).every(id => kept.has(family(id)));
    };
    const isolatedNow = (gi) => this.wouldIsolate(groups[gi], -1);

    for (let iter = 0; iter < 8; iter++) {
      const counts = groups.map(g => g.filter(isDrummer).length);
      const needy = [];
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].length > 0 && counts[gi] === 0) needy.push(gi);
      }
      if (!needy.length) break; // every non-empty group already has a drummer

      // Try each needy group in turn (a pinned-out needy group, or one whose
      // only surplus sources are themselves all pinned, must not block a
      // DIFFERENT needy group from being fixed this same round).
      let moved = false;
      for (const toGi of needy) {
        // Surplus groups (2+), most-surplus first, so a group with 3 gives
        // up its spare before one with exactly 2 does.
        const surplus = groups
          .map((g, gi) => ({ gi, count: counts[gi] }))
          .filter(x => x.gi !== toGi && x.count >= 2)
          .sort((a, b) => b.count - a.count);

        let best = null;
        for (const { gi: fromGi } of surplus) {
          const toIsolated = isolatedNow(toGi), fromIsolated = isolatedNow(fromGi);
          const before = pairScore(toGi, fromGi);
          for (let targetIdx = 0; targetIdx < groups[toGi].length; targetIdx++) {
            const target = groups[toGi][targetIdx];
            if (this.isPinned(target, toGi, groups)) continue;
            for (let sourceIdx = 0; sourceIdx < groups[fromGi].length; sourceIdx++) {
              const source = groups[fromGi][sourceIdx];
              if (!isDrummer(source) || this.isPinned(source, fromGi, groups)) continue;
              if (!toIsolated && this.wouldIsolate(groups[toGi], targetIdx, source)) continue;
              if (!fromIsolated && this.wouldIsolate(groups[fromGi], sourceIdx, target)) continue;

              const toBefore = groups[toGi], fromBefore = groups[fromGi];
              const toAfter = toBefore.map(p => p === target ? source : p);
              const fromAfter = fromBefore.map(p => p === source ? target : p);
              if (!keepsBuffs(toBefore, toAfter) || !keepsBuffs(fromBefore, fromAfter)) continue;

              groups[toGi][targetIdx] = source;
              groups[fromGi][sourceIdx] = target;
              const delta = pairScore(toGi, fromGi) - before;
              groups[toGi][targetIdx] = target;
              groups[fromGi][sourceIdx] = source;
              if (!best || delta > best.delta) best = { toGi, targetIdx, fromGi, sourceIdx, delta };
            }
          }
        }

        if (best) {
          const source = groups[best.fromGi][best.sourceIdx];
          groups[best.fromGi][best.sourceIdx] = groups[best.toGi][best.targetIdx];
          groups[best.toGi][best.targetIdx] = source;
          moved = true;
          break; // recompute counts fresh before tackling the next needy group
        }
      }
      if (!moved) break; // nothing resolvable this round (locks, or every swap costs a sole provider) — stop rather than spin
    }
  },

  // True when a provider entry of rules.spreadProviders ({ class, spec? }, spec a name or a list) has at least one
  // party-scoped buff that benefits `role`. Every Classic and TBC buff is party-scoped, so there it is true for any
  // provider that has a buff for the role at all.
  providesPartyBuffTo(spec, role) {
    const specs = spec.spec === undefined ? null : [].concat(spec.spec);
    return Object.values(Config.Buffs).some(b => b.sourceClass === spec.class && b.scope !== 'raid'
      && (!b.sourceSpec || !specs || specs.includes(b.sourceSpec)) && (b.benefitsRoles || []).includes(role));
  },

  // One rebalancing pass for a single target role. Repeatedly finds a group
  // that actually holds a member of that role but has zero of the class, and
  // moves a provider in from elsewhere: straight into an open seat, or
  // swapped for whichever non-pinned member of the needy group benefits
  // least (lowest dpsWeightFor) if the needy group is full.
  //
  // Two source tiers, tried in priority order:
  //   - "surplus" groups holding 2+ (a real excess — taking one never drops
  //     that group below one).
  //   - failing that, "spare" groups holding exactly 1 that this pass's role
  //     doesn't actually need there (e.g. a shaman parked with 3 Warlocks and
  //     no melee dps during the melee pass, or riding with the tank/healer
  //     group) — a lone provider sitting somewhere it isn't needed outranks
  //     a melee group getting none at all. This is what lets 4 shamans still
  //     reach all 4 melee groups even when greedy placement already spread
  //     them to exactly one-each in the wrong 4 groups first.
  // The tank/healer group is never itself a needy target — it doesn't need
  // Windfury — but it's fair game as a source under either tier, per this
  // task's stated priority: melee groups first, then casters, then healers.
  _spreadPass(groups, specs, wantsRole, opts) {
    // wantsRole is usually one role ('melee_dps'), but the caster-facing Mana
    // Spring/Tide pass passes ['caster_dps','healer'] — both roles actually
    // benefit from a shaman's water totem, and a "caster-identity" group that
    // greedy placement filled almost entirely with overflow healers (no real
    // caster_dps member at all) still needs sustain coverage exactly like one
    // with casters in it.
    const wantsRoles = Array.isArray(wantsRole) ? wantsRole : [wantsRole];
    // Roles this pass must never strip coverage from, even when the group has
    // no member of THIS pass's wantsRole(s). Used by the caster-facing Mana
    // Spring pass (protectRoles: ['melee_dps']) so it can't mistake a melee
    // group's sole shaman for "spare" just because that melee group happens
    // to have no caster_dps/healer member of its own — the shaman is still
    // needed there for Windfury, which is a different pass's job to have
    // already set up.
    const protectRoles = ((opts && opts.protectRoles) || []).filter(r => !wantsRoles.includes(r));
    // Relaxed-only: whether the very last fallback tier (spareProtected,
    // below) is allowed to engage at all. It's a deliberate softening of the
    // "never touch a guest's only buff" courtesy, and only Relaxed actually
    // needs it — every other mode already reaches full provider coverage via
    // refineRounds before Phase 5 runs, so letting spareProtected fire there
    // too just trades one mode's already-closed gap for a fresh one
    // elsewhere (confirmed via classic-forever-scenarios.js: enabling it
    // unconditionally regressed tank_mit on the Forever mixed 40 fixture).
    const allowProtectedFallback = (opts && opts.mode) === 'relaxed';
    // Last-resort-only source identity: the melee-facing (Windfury) pass must
    // never be the one that strips the raid's caster-identity group of its
    // own natural mana-sustain shaman just because that group has no
    // melee_dps member to "protect" it (protectRoles above only guards the
    // reverse direction — the caster-facing pass never touching a melee
    // group's shaman). Concretely: with exactly enough shamans for one per
    // melee group plus one spare, greedy placement can seat that spare
    // shaman right in the caster-identity group (where it's doing exactly
    // the job invariant (d) wants), and a melee-identity group elsewhere can
    // come up needy for Windfury with the tank/healer group ALSO holding a
    // spare shaman. Both groups are equally "spare" by the hasWantedRole
    // check, and plain gi-ascending order can pick the caster group first —
    // taking the one shaman that was already correctly placed instead of the
    // one riding along with a healer-stacked tank group that doesn't need it
    // for anything this suite checks. Demoting the opposing identity to a
    // last-resort tier (tried only when no other source exists, so Windfury
    // coverage — checked unconditionally, every mode — never regresses)
    // fixes that without touching the caster-facing pass's own logic.
    const oppositeIdentity = wantsRoles.includes('melee_dps') ? 'caster_dps'
      : (wantsRoles.includes('caster_dps') || wantsRoles.includes('healer')) ? 'melee_dps'
      : null;
    const isLastResortSource = gi => !!(oppositeIdentity && groups._roleIdentities && groups._roleIdentities[gi] === oppositeIdentity);
    // A group can be the fixed point for more than one tracked provider type
    // at once (e.g. a melee group holding both the shaman the SHAMAN pass
    // placed and the paladin the PALADIN pass is about to place). Without
    // this, the swap-eviction branch below picks whoever has the lowest
    // dpsWeightFor as the outgoing member — which happily evicts that very
    // shaman (a healer-role Resto Shaman's weight is high, but an
    // Enhancement Shaman's class:spec weight is low) the moment it's the
    // weakest body in the group, silently undoing an earlier spec's fix
    // later in this same pass. See tasks/lessons.md "model-optimal is not
    // the acceptance criterion" — the earlier fix is the convention; it must
    // survive a later spec's pass, not be sacrificed to it.
    const isSoleOtherProvider = (cand, group, currentSpec) => {
      for (const other of specs) {
        if (other === currentSpec) continue;
        const m = p => p.class === other.class && (!other.spec || (Array.isArray(other.spec) ? other.spec.includes(p.spec) : p.spec === other.spec));
        if (m(cand) && group.filter(m).length <= 1) return true;
      }
      return false;
    };
    // Outer fixed-point loop over the WHOLE spec list. A single pass over
    // specs in order (old behavior) lets a later spec's swap silently
    // re-break an earlier spec's already-fixed group: the swap-eviction
    // branch's "displaced" member lands in the FROM group, which can hand
    // that group a melee_dps member it didn't have before (so it only
    // becomes shaman-needy AFTER the shaman pass already finished). Re-running
    // every spec until nothing moves catches that follow-on need instead of
    // shipping the board mid-fix. Bounded rounds since isSoleOtherProvider
    // above stops any single spec from undoing another's OWN placement, so
    // this converges quickly in practice.
    for (let round = 0; round < 6; round++) {
      let changedAny = false;
      for (const spec of specs) {
        // spec.spec may be a single spec name (Classic: 'Feral') or an array of
        // specs that share one provider slot (Forever: Feral+Balance druids
        // both cover the same now-exclusive crit aura — see rules.exclusiveBuffs).
        const matches = p => p.class === spec.class && (!spec.spec || (Array.isArray(spec.spec) ? spec.spec.includes(p.spec) : p.spec === spec.spec));
        for (let iter = 0; iter < 6; iter++) {
          const needy = [];
          const surplus = [], surplusLast = [];
          const spare = [], spareLast = [], spareProtected = [];
          for (let gi = 0; gi < groups.length; gi++) {
            const count = groups[gi].filter(matches).length;
            const isTank = this.isTankGroup(gi, groups);
            // Excludes members that are themselves this pass's provider class —
            // an Enhancement Shaman's own role IS melee_dps, so without this a
            // shaman stranded alone among casters would count as "already
            // satisfying" the group's melee need (itself) and never be
            // considered spare.
            const hasWantedRole = !isTank && groups[gi].some(p => wantsRoles.includes(p.role) && !matches(p));
            // No `!isTank` guard here (unlike hasWantedRole above): a stray
            // melee_dps guest who ended up in the tank/healer group is still
            // relying on whatever shaman happens to be sitting there for
            // Windfury — that placement was never guaranteed by design, but
            // this pass must not actively break it. hasWantedRole's `!isTank`
            // only says the tank group is never a Windfury-pass TARGET; it
            // doesn't make its sole shaman fair game for a DIFFERENT pass to
            // take away from a melee_dps player who has no other source.
            const protectedElsewhere = protectRoles.some(r => groups[gi].some(p => p.role === r && !matches(p)));
            if (hasWantedRole && count === 0) { needy.push(gi); continue; }
            const lastResort = isLastResortSource(gi);
            if (count >= 2) (lastResort ? surplusLast : surplus).push(gi);
            else if (count === 1 && !hasWantedRole) {
              if (protectedElsewhere && allowProtectedFallback) {
                // protectedElsewhere used to disqualify a group outright —
                // but "never touch a guest's only buff source" is a
                // courtesy, not a structural guarantee (that placement was
                // never guaranteed by design, per the comment above), while a
                // genuinely needy group elsewhere going completely uncovered
                // IS one of the invariants this suite checks unconditionally.
                // Demoting it to a final fallback tier — tried only when
                // every unprotected option is exhausted, and only in Relaxed
                // (see allowProtectedFallback) — lets a raid with just enough
                // providers for "one per real need plus one spare" still
                // reach its last needy group instead of stranding that spare
                // behind an incidental guest's nice-to-have.
                spareProtected.push(gi);
              } else if (!protectedElsewhere) {
                (lastResort ? spareLast : spare).push(gi);
              }
            }
          }
          // Try, in order: a real surplus outside the opposing identity, a
          // spare outside it, the opposing identity's own surplus/spare, and
          // finally a spare that's only protected by the soft guest-courtesy
          // rule above — each tier is only consulted once every earlier one
          // has nothing left to offer.
          const source = surplus.length ? surplus : spare.length ? spare
            : surplusLast.length ? surplusLast : spareLast.length ? spareLast : spareProtected;
          if (!needy.length || !source.length) break;

          // toGi/toGroup and whichever member a full toGroup would have to
          // evict (`displaced`) don't depend on which source group supplies
          // the provider, so resolve them once up front — the source search
          // below needs `displaced` to run its wouldIsolate() lookahead.
          const toGi = needy[0];
          const toGroup = groups[toGi];
          let displaced = null, displacedIdx = -1;
          if (!this.hasRoom(groups, toGi, 5)) {
            let bestIdx = -1, bestWeight = Infinity;
            for (let pi = 0; pi < toGroup.length; pi++) {
              if (this.isPinned(toGroup[pi], toGi, groups) || matches(toGroup[pi])) continue;
              if (isSoleOtherProvider(toGroup[pi], toGroup, spec)) continue;
              const w = dpsWeightFor(toGroup[pi]);
              if (w < bestWeight) { bestWeight = w; bestIdx = pi; }
            }
            if (bestIdx < 0) break; // no room to swap into — leave this group needy
            displacedIdx = bestIdx;
            displaced = toGroup[bestIdx];
          }

          // Pick the first source group with a non-pinned provider whose
          // departure — and, on a full toGroup, `displaced`'s arrival in
          // their seat — wouldn't strand a melee/caster DPS teammate behind.
          // Without this, moving a group's only Feral Druid/Shaman/Paladin
          // out to cover a needier group can silently re-isolate whoever was
          // relying on it for their only same-family peer; nothing runs after
          // Phase 5 (spreadProviders) to catch that, so it shipped straight
          // through in Relaxed mode, where refineRounds isn't there beforehand
          // to have already prevented the conditions that cause it.
          let fromGi = -1, providerIdx = -1;
          for (const gi of source) {
            const fg = groups[gi];
            for (let pi = 0; pi < fg.length; pi++) {
              if (!matches(fg[pi]) || this.isPinned(fg[pi], gi, groups)) continue;
              if (this.wouldIsolate(fg, pi, displaced)) continue;
              fromGi = gi; providerIdx = pi; break;
            }
            if (fromGi >= 0) break;
          }
          if (fromGi < 0) break; // every candidate source would strand someone — leave this group needy

          const fromGroup = groups[fromGi];
          const provider = fromGroup[providerIdx];

          if (displaced === null) {
            fromGroup.splice(providerIdx, 1);
            toGroup.push(provider);
          } else {
            toGroup[displacedIdx] = provider;
            fromGroup[providerIdx] = displaced;
          }
          changedAny = true;
        }
      }
      if (!changedAny) break;
    }
  },

  // Decides who sits when more players are in the pool than the raid holds.
  // Returns { seated, bench }: the leftovers (groupNumber 0) are the bench, and
  // the caller lays the seated players out with arrange().
  selectSeated(players, numGroups, raidSize, max, mode) {
    const pool = this.sortedPool(players);
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);
    const floors = this.floorsFor(raidSize);

    // Standby players (the guild's marker, SignupMarker) volunteered to sit out when the raid is over-full: as many as
    // the overflow needs are held out of the first pass and join the overflow list below, where the bench refinement
    // can still pull one back in when seating them raises the raid total more than its threshold.
    const held = this.holdStandby(pool, numGroups * max, floors);
    for (const p of held) pool.splice(pool.indexOf(p), 1);

    this.seedGroups(pool, groups, numGroups, raidSize, max, mode);

    // Role floors. The raid's minimum tanks and healers get a seat before DPS
    // compete for the rest, so a late-signing healer is never benched behind
    // a twelfth mage. Within a role the greedy scorer still picks who sits.
    for (const role of ['tank', 'healer']) {
      const have = groups.flat().filter(p => p.role === role).length;
      const need = Math.max(0, (floors[role] || 0) - have);
      if (need > 0) this.greedyPlace(pool, groups, max, mode, { eligible: p => p.role === role, limit: need });
    }

    // Healer cap (TBC comp rules, user decision 2026-10-10): when players exceed
    // seats, seat at most floor + rules.healerCapOverFloor healers; DPS take the
    // rest. A second uncapped pass fills any seat the DPS could not use. The
    // rule is off in Classic (healerCapOverFloor: null), so this is a
    // no-op there.
    const healerCap = this.healerCapFor(raidSize);
    const healersSeated = () => groups.reduce((n, g) => n + g.filter(p => p.role === 'healer').length, 0);
    if (healerCap != null) {
      this.greedyPlace(pool, groups, max, mode, { eligible: p => p.role !== 'healer' || healersSeated() < healerCap });
    }
    this.greedyPlace(pool, groups, max, mode);

    // Bench the leftovers instead of dropping them from the roster. They stay
    // eligible for the bench refinement below; Tentative/Bench sign-ups and
    // anyone benched by hand are not in this list and are never pulled in.
    const overflow = [];
    for (const p of pool.splice(0).concat(held)) { p.groupNumber = 0; overflow.push(p); }

    this.refineRounds(groups, max, mode);

    // Bench refinement. Greedy placement benches whoever is left when the
    // seats run out, which punishes pure recipients (a Combat Rogue gives
    // nothing, so he only scores once a melee group already has Windfury and
    // Leader of the Pack) even when they are worth far more to the raid than
    // a fourth tank. Trade benched overflow players against seated ones
    // whenever the raid total rises, then let the seated-only refinement
    // settle the new layout before the next trade is judged.
    if (this.refineBench(groups, overflow, raidSize, mode)) this.refineRounds(groups, max, mode);

    // Fair bench and Standby volunteers (wave 6): among players of the same worth (within BENCH_TOLERANCE), bench the Standby volunteers first, then the people who
    // have sat out least. Skipped, so the result is exactly the value-only one, unless a seed's sit-out history is loaded or a Standby volunteer is seated.
    if ((Fairness.active() || groups.some(g => g.some(p => SignupMarker.isStandby(p)))) && this.refineFairness(groups, overflow, mode)) this.refineRounds(groups, max, mode);

    return { seated: groups.flat(), bench: overflow };
  },

  // The Standby players selectSeated keeps out of the first pass: at most as many as the pool exceeds the seats, and
  // never so many that a role is left with fewer players than its floor (tanks and healers are held only beyond the
  // floors, counted on the pool that remains). Comp-template locked players stay. Without a Standby marker: none.
  holdStandby(pool, seats, floors) {
    const held = [];
    const room = pool.length - seats;
    for (const p of pool) {
      if (held.length >= room) break;
      if (!SignupMarker.isStandby(p) || p.locked) continue;
      const left = pool.filter(q => q.role === p.role).length - held.filter(h => h.role === p.role).length - 1;
      if (left >= (floors[p.role] || 0)) held.push(p);
    }
    return held;
  },

  // Seated-healer cap for over-capacity rosters, or null when the ruleset has
  // none (Classic). TBC: floor + 1 (user decision 2026-10-10); Forever: the floor.
  healerCapFor(raidSize) {
    const over = activeRules().rules.healerCapOverFloor;
    if (over == null) return null;
    return (this.floorsFor(raidSize).healer || 0) + over;
  },

  // Minimum tanks/healers for a raid size (see Config.RaidFloors).
  floorsFor(raidSize) {
    const exact = Config.RaidFloors[raidSize];
    if (exact) return exact;
    return raidSize <= 10 ? Config.RaidFloors[10] : Config.RaidFloors[25];
  },

  // One 'tank' identity group; the rest split as evenly as possible between
  // melee_dps and caster_dps (melee gets the extra when odd). Generalizes the
  // original 5-group [melee,melee,caster,caster,tank] pattern (still returned
  // unchanged for numGroups===5) to any raid size — Classic's 4-group 20-mans
  // and 8-group 40-mans included. 2-group 10-mans (TBC kara/za) keep their
  // own no-tank-group pattern; the seed pass below falls back to group 0.
  //
  // With `players` and rules.rosterShapedIdentities (TBC), the melee/caster
  // split follows the roster's physical vs caster DPS headcount instead, so
  // a caster-heavy raid gets one melee group and three caster groups rather
  // than casters and their shamans squeezed into a half-empty "melee" group.
  roleIdentitiesFor(numGroups, players) {
    if (numGroups <= 2) return ['melee_dps', 'caster_dps'].slice(0, numGroups);
    return this.dpsIdentitiesFor(numGroups - 1, players).concat('tank');
  },

  // Melee groups first, then caster groups, for `count` DPS-identity groups.
  dpsIdentitiesFor(count, players) {
    let meleeGroups = Math.ceil(count / 2);
    if (players && activeRules().rules.rosterShapedIdentities) {
      const phys = players.filter(p => p.role === 'melee_dps' || p.role === 'ranged_dps').length;
      const cast = players.filter(p => p.role === 'caster_dps').length;
      if (phys + cast > 0) {
        meleeGroups = Math.round(count * phys / (phys + cast));
        if (phys > 0) meleeGroups = Math.max(meleeGroups, 1);
        if (cast > 0) meleeGroups = Math.min(meleeGroups, count - 1);
      }
    }
    meleeGroups = Math.max(0, Math.min(meleeGroups, count));
    return Array.from({ length: count }, (_, i) => i < meleeGroups ? 'melee_dps' : 'caster_dps');
  },

  // ── PHASE 1: SEED GROUPS ─────────────────────────────────────
  seedGroups(pool, groups, numGroups, raidSize, max, mode) {
    const everyone = pool.concat(groups.flat());
    groups._roleIdentities = this.roleIdentitiesFor(numGroups, everyone);

    // Seed the healer/tank group with ONE anchor tank (reference comp: only
    // the Prot Paladin rides with the healers). Every other tank is placed
    // by the scorer like anyone else — a Feral tank is still that melee
    // group's Leader of the Pack, a spare Prot tank lands where its aura and
    // the totems it receives are worth most. tank_mit consolidates up to 3
    // tanks here so mitigation buffs cover all of them. A signed-up tank
    // anchors before an Open slot of the same rank.
    const tankIdx = groups._roleIdentities.indexOf('tank');
    const targetIdx = tankIdx >= 0 ? tankIdx : 0;
    const minTanks = mode === 'tank_mit' ? 3 : 1;
    const anchorRank = activeRules().rules.tankAnchorRank || (() => 0);
    const tanks = pool.filter(p => p.role === 'tank')
      .sort((a, b) => (anchorRank(a) - anchorRank(b)) || (!!a.openSlot - !!b.openSlot));
    groups._anchors = new Set();
    for (const t of tanks.slice(0, minTanks)) {
      if (!this.hasRoom(groups, targetIdx, max)) break;
      groups[targetIdx].push(pool.splice(pool.indexOf(t), 1)[0]);
      groups._anchors.add(t);
    }

    // Healers are NOT seeded per group. In TBC healing is cross-group — a
    // healer's party placement is purely a buff decision (reference comp:
    // both melee groups have zero healers; surplus healers ride with the
    // tanks). groupScore()'s tank-group healer pull and each healer's own
    // buff synergies (Resto Shaman → casters for Mana Tide/WoA, Resto
    // Druid → tanks for ToL) drive their placement instead.
  },

  // ── PHASE 2: GREEDY MARGINAL-GAIN PLACEMENT ──────────────────
  // Each step places the (player, group) pair with the highest marginal
  // groupScore gain. Because groupScore measures what members RECEIVE, this
  // both attracts buffers to groups that want their buffs and attracts
  // beneficiaries to groups that already have the buffs.
  // opts.eligible restricts which pool members may be placed this pass;
  // opts.limit caps how many are placed. Both are used by the role-floor
  // pass; the general pass leaves them undefined.
  greedyPlace(pool, groups, max, mode, opts) {
    const eligible = (opts && opts.eligible) || (() => true);
    const limit = (opts && opts.limit != null) ? opts.limit : Infinity;
    let placed = 0;
    while (pool.length > 0 && placed < limit) {
      let bestGain = -Infinity;
      let bestPlayerIdx = -1;
      let bestGroupIdx = -1;

      for (let gi = 0; gi < groups.length; gi++) {
        if (!this.hasRoom(groups, gi, max)) continue;
        const base = this.groupScore(groups[gi], gi, groups, mode);
        for (let pi = 0; pi < pool.length; pi++) {
          if (!eligible(pool[pi])) continue;
          groups[gi].push(pool[pi]);
          const gain = this.groupScore(groups[gi], gi, groups, mode) - base;
          groups[gi].pop();
          if (gain > bestGain) {
            bestGain = gain;
            bestPlayerIdx = pi;
            bestGroupIdx = gi;
          }
        }
      }

      // No group has space (or no eligible player left) — stop placing
      if (bestGroupIdx < 0) break;

      groups[bestGroupIdx].push(pool.splice(bestPlayerIdx, 1)[0]);
      placed++;
    }
  },

  // ── SCORING ──────────────────────────────────────────────────
  // A comp-template lock (backlog #1) pins a player absolutely, in any group.
  // Otherwise, only the seeded anchor tank(s) are pinned to the healer/tank
  // group — any other tank that drifts in during placement is a regular
  // member the refinement phases may move out again (a Feral tank belongs
  // with melee).
  isPinned(player, gi, groups) {
    if (player.locked) return true;
    if (player.role !== 'tank' || !this.isTankGroup(gi, groups)) return false;
    return groups._anchors ? groups._anchors.has(player) : true;
  },

  // Open seat in group gi: below the raid's party size.
  hasRoom(groups, gi, max) {
    return groups[gi].length < max;
  },

  isTankGroup(gi, groups) {
    const ids = groups._roleIdentities;
    if (!ids) return gi === 0;
    const t = ids.indexOf('tank');
    return t >= 0 ? gi === t : gi === 0;
  },

  // Buffs the group actually gets: passives deduped, one totem per element
  // per shaman (chosen by group value — models totem assignments/twisting),
  // one distinct aura per paladin (best available by group value). The scorer
  // only needs the ids; getGroupBuffs shows the same resolution with sources.
  resolveGroupBuffs(group, valueFn) {
    return new Set(this.resolveBuffSources(group, valueFn).keys());
  },

  // The resolution behind resolveGroupBuffs, with source tracking: a Map of
  // buffId -> the player providing it (the first to provide it, for passives).
  // `opts` is display-only: { overrideFor(player, slot) -> buffId|undefined }
  // pins a shaman's air/fire/water/earth totem or a paladin's 'aura' to a manual
  // choice (resolved first, so no auto pick duplicates it),
  // `overridden` collects the ids that came from such a choice, and
  // `preferSpecAura` lets a paladin's own aura (Retribution: Sanctity) win a tie
  // between equally valued auras. The scorer passes none, so its choices (and
  // every optimizer outcome) stay exactly as they were.
  resolveBuffSources(group, valueFn, opts) {
    const rules = activeRules();
    const shouts = rules.shouts || [];
    const overrideFor = opts && opts.overrideFor;
    const sources = new Map();
    const usedAuras = new Set();
    const pinned = new Map(); // player -> Set of slots fixed by an override
    if (overrideFor) {
      for (const p of group) {
        const slots = p.class === 'SHAMAN' ? ['air', 'fire', 'water', 'earth'] : p.class === 'PALADIN' ? ['aura'] : [];
        for (const slot of slots) {
          const id = overrideFor(p, slot);
          if (!id) continue;
          if (!pinned.has(p)) pinned.set(p, new Set());
          pinned.get(p).add(slot);
          if (slot === 'aura') usedAuras.add(id);
          if (sources.has(id)) continue;
          sources.set(id, p);
          if (opts.overridden) opts.overridden.add(id);
        }
      }
    }
    for (const p of group) {
      const fixed = pinned.get(p);
      if (p.class === 'SHAMAN') {
        const byElement = {};
        for (const [id, buff] of Object.entries(Config.Buffs)) {
          if (buff.sourceClass !== 'SHAMAN') continue;
          if (buff.sourceSpec && buff.sourceSpec !== p.spec) continue;
          const el = rules.totemElements[id];
          // Mana Tide is a short cooldown dropped over Mana Spring, not a
          // standing totem: the same shaman provides both. Scoring it as the
          // water slot made a second Resto Shaman look like it "unlocked"
          // Mana Spring, so two piled into the tank group.
          if (el && !rules.cooldownTotems.includes(id)) (byElement[el] = byElement[el] || []).push(id);
          else if (!sources.has(id)) sources.set(id, p); // shaman passives (e.g. Unleashed Rage)
        }
        for (const el of Object.keys(byElement)) {
          if (fixed && fixed.has(el)) continue;
          const open = byElement[el].filter(id => !sources.has(id)); // another shaman of this group may already drop one
          // A raid-wide totem (scope 'raid') outranks a party totem for the slot: it reaches every group, so it is
          // dropped whatever this group's own members would gain. Versions with no raid-wide totem take the plain path.
          // Display only (opts.raidTaken): a raid-wide totem another group already drops is passed over for one that
          // nobody drops yet, so two shamans in two groups give Windfury and Grace of Air; if none is left the shaman
          // repeats one rather than dropping a party totem the scorer does not credit.
          const raidWide = open.filter(id => isRaidWideBuff(id));
          const fresh = raidWide.filter(id => !(opts && opts.raidTaken && opts.raidTaken.has(id)));
          const pool = fresh.length ? fresh : raidWide.length ? raidWide : open;
          let best = null, bestV = raidWide.length ? -1 : 0;
          for (const id of pool) {
            const v = valueFn(id);
            if (v > bestV) { bestV = v; best = id; }
          }
          if (best) sources.set(best, p);
        }
      } else if (p.class === 'PALADIN') {
        if (fixed) continue;
        const specPick = opts && opts.preferSpecAura ? (rules.rules.specAura || {})[p.spec] : null;
        const open = paladinAurasFor(p).filter(id => !usedAuras.has(id));
        let best = null, bestV = -1;
        for (const id of open) {
          const v = valueFn(id);
          if (v > bestV || (v === bestV && id === specPick)) { bestV = v; best = id; }
        }
        if (best) { usedAuras.add(best); if (!sources.has(best)) sources.set(best, p); }
      } else {
        for (const [id, buff] of Object.entries(Config.Buffs)) {
          if (buff.sourceClass !== p.class) continue;
          if (buff.sourceSpec && buff.sourceSpec !== p.spec) continue;
          if (rules.totemElements[id] || rules.paladinAuras[id] || shouts.includes(id)) continue;
          if (!sources.has(id)) sources.set(id, p);
        }
        // One shout per warrior: the best-valued one nobody else in the group already
        // casts (a tie, e.g. in a caster group, keeps the first listed - Battle Shout).
        if (p.class === 'WARRIOR') {
          let best = null, bestV = -1;
          for (const id of shouts) {
            if (sources.has(id) || !Config.Buffs[id]) continue;
            const v = valueFn(id);
            if (v > bestV) { bestV = v; best = id; }
          }
          if (best) sources.set(best, p);
        }
      }
    }
    // Exclusive buff sets (Forever: Leader of the Pack / Moonkin Aura share
    // one crit-aura slot) — keep only whichever member is worth more to this
    // group, so a group with both a Feral and a Balance druid scores exactly
    // one of them instead of double-counting.
    for (const set of (rules.rules && rules.rules.exclusiveBuffs) || []) {
      const present = set.filter(id => sources.has(id));
      if (present.length < 2) continue;
      let best = present[0], bestV = valueFn(best);
      for (const id of present.slice(1)) {
        const v = valueFn(id);
        if (v > bestV) { bestV = v; best = id; }
      }
      for (const id of present) if (id !== best) sources.delete(id);
    }
    return sources;
  },

  // The value function behind every buff decision for a group: what one buff
  // is worth to THIS group in the given mode. groupScore sums it over the
  // buffs resolveGroupBuffs credits; getGroupBuffs resolves the displayed
  // buffs with the same function so display, explanations and scoring agree.
  buffValueFn(group, gi, groups, mode) {
    const rules = activeRules();
    const cfg = modeConfigFor(rules, mode);
    const roleIdentity = (groups._roleIdentities && groups._roleIdentities[gi]) || 'melee_dps';
    const isTank = this.isTankGroup(gi, groups);
    const healerCount = group.reduce((n, p) => n + (p.role === 'healer' ? 1 : 0), 0);
    const tanks = group.filter(p => p.role === 'tank');

    // Value of one buff to this group = summed received DPS value, plus
    // mitigation + healer-sustain value when it reaches the tank group.
    // Mitigation counts for a tank wherever they sit — an off-tank in a
    // melee group still takes hits, so Devotion/GoA/SoE reaching them matter.
    // Healer-sustain value is only meaningful in the healer/tank group, and
    // it is a healing-structure concern (keeping the tank healers casting),
    // not a mitigation one — so it scales with the structure weight. This is
    // what keeps a lone Resto Shaman with the tank healers instead of chasing
    // Mana Tide value in a mage group.
    return (id) => {
      let v = 0;
      for (const m of group) v += dpsValueFor(id, m) * cfg.dps;
      for (const t of tanks) v += mitValueFor(id, t) * cfg.mit;
      if (isTank && rules.sustainValue[id]) v += rules.sustainValue[id] * Math.min(healerCount, rules.rules.sustainHealers) * cfg.structure;
      // Windfury-over-other-air-totem convention (Classic/Forever only — see
      // rules.meleeGroupWindfuryBias, 0 for TBC so this is a no-op
      // there). A shaman's per-element totem choice (resolveGroupBuffs) picks
      // whichever totem scores highest via THIS function; without a
      // structural push, a melee group whose only shaman rides with several
      // hunters can have its Windfury outbid by Grace of Air on raw weight.dps
      // (hunters get more from GoA than Ret/melee gets from WF) even though
      // the melee DPS convention (any shaman drops WF for melee — see
      // tasks/lessons.md 2026-08-19) says the group's melee should get it
      // regardless. Scaled per actual melee_dps member so an empty or
      // hunter-only "melee" group doesn't invent a preference it has no one
      // to give it to.
      // 2026-10-10 user decision (TBC only, rules.enhWindfuryBonus, 0 = off in Classic and Forever): Windfury from an
      // Enhancement Shaman is worth more to melee than from an Ele/Resto (the Enh talents improve the
      // totem), so a group that holds an Enh scales its Windfury value by (1 + bonus).
      if (id === 'WINDFURY' && rules.rules.enhWindfuryBonus && v > 0 && group.some(p => p.class === 'SHAMAN' && p.spec === 'Enhancement')) {
        v *= 1 + rules.rules.enhWindfuryBonus;
      }
      if (id === 'WINDFURY') v += this.windfuryGroupBias(group, roleIdentity, cfg);
      return v;
    };
  },

  // What each raid-wide buff (scope 'raid') is worth to the whole raid: { value: { id: points }, rank: { id: n } }.
  // value is the buff's summed received value over the pool (everyone being planned inside plan(), else the board),
  // scaled by the mode like the party buffs (dpsValueFor x cfg.dps, tank mitigation x cfg.mit). rank orders the raid-wide
  // totems of one element by value: a shaman drops one totem per element, so the 2nd-ranked air totem only exists with a
  // 2nd shaman.
  raidWideValues(groups, mode, cfg) {
    const scope = this._raidScope;
    if (scope && scope.byMode[mode]) return scope.byMode[mode];
    const rules = activeRules();
    const ids = rules.raidWide || [];
    const pool = scope ? scope.pool : groups.flat();
    const value = {}, rank = {};
    for (const id of ids) {
      let v = 0;
      for (const m of pool) {
        v += dpsValueFor(id, m) * cfg.dps;
        if (m.role === 'tank') v += mitValueFor(id, m) * cfg.mit;
      }
      value[id] = v;
    }
    for (const id of ids) {
      rank[id] = 1;
      const element = rules.totemElements[id];
      if (!element) continue;
      for (const other of ids) {
        if (other === id || rules.totemElements[other] !== element) continue;
        if (value[other] > value[id] || (value[other] === value[id] && ids.indexOf(other) < ids.indexOf(id))) rank[id]++;
      }
    }
    const out = { value, rank };
    if (scope) scope.byMode[mode] = out;
    return out;
  },

  // The part of a raid-wide buff's value this group is credited with: the buff's value to the whole raid (raidWideValues)
  // split over the providers on the board, so each provider carries its share wherever it sits. The sum over all groups
  // is the same for every placement of the board's players, which is why a raid-wide buff never drives placement; it does
  // change with WHO is seated, so the bench and Open-slot suggestions still value a Marksmanship Hunter's Trueshot Aura or
  // a second shaman's second air totem. No-op where the ruleset has no raid-wide buff (Classic, TBC).
  raidWideCredit(group, groups, mode, cfg) {
    const ids = activeRules().raidWide;
    if (!ids || !ids.length) return 0;
    let credit = 0, values = null;
    for (const id of ids) {
      const buff = Config.Buffs[id];
      let mine = 0;
      for (const p of group) if (isBuffSource(buff, p)) mine++;
      if (!mine) continue;
      let total = 0;
      for (const g of groups) for (const p of g) if (isBuffSource(buff, p)) total++;
      if (!total) continue;
      values = values || this.raidWideValues(groups, mode, cfg);
      if (total < values.rank[id]) continue;
      credit += values.value[id] * Math.min(1, mine / total);
    }
    return credit;
  },

  // rules.meleeGroupWindfuryBias: points per non-shaman melee DPS (x structure) added to Windfury in a melee-identity
  // group; 0 = off. buffValueFn adds it to Windfury's value, and groupScore adds it on its own where Windfury is
  // raid-wide (a raid-wide buff is not scored per group).
  windfuryGroupBias(group, roleIdentity, cfg) {
    const bias = activeRules().rules.meleeGroupWindfuryBias;
    if (!bias || roleIdentity !== 'melee_dps') return 0;
    const meleeCount = group.reduce((n, p) => n + (p.role === 'melee_dps' && p.class !== 'SHAMAN' ? 1 : 0), 0);
    return meleeCount > 0 ? bias * meleeCount * cfg.structure : 0;
  },

  // The single objective all phases share. Higher = better group.
  groupScore(group, gi, groups, mode) {
    const rules = activeRules();
    const cfg = modeConfigFor(rules, mode);
    const roleIdentity = (groups._roleIdentities && groups._roleIdentities[gi]) || 'melee_dps';
    const isTank = this.isTankGroup(gi, groups);
    const healerCount = group.reduce((n, p) => n + (p.role === 'healer' ? 1 : 0), 0);
    const tanks = group.filter(p => p.role === 'tank');

    const buffValue = this.buffValueFn(group, gi, groups, mode);

    let score = 0;
    for (const id of this.resolveGroupBuffs(group, buffValue)) {
      // A raid-wide buff (scope 'raid') reaches every group wherever its provider sits, so it never drives placement
      // and is not scored here. Windfury keeps only its small melee-group nudge (meleeGroupWindfuryBias).
      if (isRaidWideBuff(id)) {
        if (id === 'WINDFURY') score += this.windfuryGroupBias(group, roleIdentity, cfg);
        continue;
      }
      score += buffValue(id);
    }
    score += this.raidWideCredit(group, groups, mode, cfg);

    // Ferocious Inspiration stacks multiplicatively per BM Hunter (1.03^n) —
    // the only party buff that does. resolveGroupBuffs dedupes it like any
    // passive, so credit each additional BM hunter's copy here
    // (rules.ferociousInspirationStacking of its value).
    const bmCount = group.reduce((n, p) => n + (p.class === 'HUNTER' && p.spec === 'Beast Mastery' ? 1 : 0), 0);
    if (rules.rules.ferociousInspiration && bmCount > 1) score += (bmCount - 1) * buffValue('FEROCIOUS_INSP') * rules.rules.ferociousInspirationStacking;

    // Reference comp: one hunter per melee group. A Survival Hunter adds no party
    // buff (rules.hunterSpread), so pairing it with another hunter is a duplicate
    // that spreads out; a second Beast Mastery hunter is exempt (its FI stacks, above).
    if (rules.rules.hunterSpread) {
      const hunterCount = group.reduce((n, p) => n + (p.class === 'HUNTER' ? 1 : 0), 0);
      if (hunterCount > 1) {
        // 2026-10-10 decision: with 2+ Enhancement Shamans on the board (every group,
        // stand-ins included) hunters spread one per melee group whatever their spec:
        // each hunter beyond a fair share (ceil(hunters on the board / melee groups)) pays
        // rules.hunterSpreadEnh (triangular in the excess), so a roster with more hunters than
        // melee groups is not taxed for the unavoidable doubling. With 0-1 Enh, stacking is
        // fine and only the Survival tax applies.
        const enhOnBoard = rules.rules.hunterSpreadEnh ? groups.reduce((n, g) => n + g.reduce((m, p) => m + (p.class === 'SHAMAN' && p.spec === 'Enhancement' ? 1 : 0), 0), 0) : 0;
        if (enhOnBoard >= 2) {
          const hIds = groups._roleIdentities || [];
          const meleeGroupCount = Math.max(1, groups.reduce((c, g, i) => c + ((hIds[i] || 'melee_dps') === 'melee_dps' ? 1 : 0), 0));
          const huntersOnBoard = groups.reduce((n, g) => n + g.reduce((m, p) => m + (p.class === 'HUNTER' ? 1 : 0), 0), 0);
          const fairShare = Math.max(1, Math.ceil(huntersOnBoard / meleeGroupCount));
          const excess = Math.max(0, hunterCount - fairShare);
          score -= rules.rules.hunterSpreadEnh * cfg.structure * (excess * (excess + 1) / 2); // triangular in the excess
        }
        else score -= rules.rules.hunterSpread * cfg.structure * group.reduce((n, p) => n + (p.class === 'HUNTER' && p.spec === 'Survival' ? 1 : 0), 0);
      }
    }

    // Structural placement rules (from the user's reference TBC comp):
    //  - Healers gravitate to the tank group. Healing is cross-group in TBC,
    //    so a healer in a DPS group displaces a DPS from a buffed slot for no
    //    healing gain — unless the healer's own buffs earn the spot (a Resto
    //    Shaman's Mana Tide/WoA in a caster group easily outbids this pull).
    //  - DPS guests in the tank group pay a penalty that only genuine
    //    synergy can override (an Enh Shaman + Fury Warrior Windfury pack
    //    riding with the tanks is fine; a lone Rogue receiving nothing
    //    there is not).
    if (isTank) {
      const coreHealers = rules.rules.tankGroupHealers;
      const maxHealers = rules.rules.tankGroupHealerMax;
      // Healers pulled in: rules.tankGroupHealerPull each up to the core (rules.tankGroupHealers), plus
      // rules.tankGroupExtraHealerPull at rules.tankGroupHealerMax (why: conventions in js/rules/<version>.js).
      score += (Math.min(healerCount, coreHealers) * rules.rules.tankGroupHealerPull + (healerCount >= maxHealers ? rules.rules.tankGroupExtraHealerPull : 0)) * cfg.structure;
      // Past rules.tankGroupHealerMax each further healer costs rules.tankGroupHealerOverflowCost.
      score -= Math.max(0, healerCount - maxHealers) * rules.rules.tankGroupHealerOverflowCost * cfg.structure;
      // The reference comp seats one overflow Affliction Warlock with the healers (it
      // needs none of the party buffs a DPS group offers) once the three-healer core is
      // there, so that seat is not a penalized guest. Without this the guest penalty
      // handed the seat to a 4th healer and moved the Warlock in with the mages.
      // 2026-10-10 comp rules (TBC; each is off at 0, which Classic and Forever set):
      //  - rules.loneRestoTankCost: a roster's only Resto Shaman stays with the tank-group healers, so a
      //    tank group that has fewer than rules.tankGroupHealers healers without it pays this when the
      //    Windfury pull (or anything else) has moved it out.
      //  - rules.tankGroupHealerCost: per healer missing below rules.tankGroupHealers in the tank group, so
      //    the hunter weight (hunters out of caster groups) does not displace a tank-group healer for a DPS guest.
      if (rules.rules.loneRestoTankCost && healerCount < coreHealers && !group.some(p => p.class === 'SHAMAN')) {
        let shamans = 0, loneResto = false;
        for (const g of groups) for (const q of g) if (q.class === 'SHAMAN') { shamans++; loneResto = q.role === 'healer' && q.spec === 'Restoration'; }
        if (shamans === 1 && loneResto) score -= rules.rules.loneRestoTankCost * cfg.structure;
      }
      if (rules.rules.tankGroupHealerCost && healerCount < coreHealers) {
        score -= rules.rules.tankGroupHealerCost * (coreHealers - healerCount) * cfg.structure;
      }
      let overflowSeatOpen = healerCount >= coreHealers;
      // 2026-10-10 comp rules (TBC, rules.hunterTankGuestCost, off at 0): a hunter guest pays
      // like any other DPS guest. ranged_dps was never charged here, so F01 parked a Survival hunter
      // in the tank group for free while its Demo lock sat with the hunters.
      const hunterGuestCost = rules.rules.hunterTankGuestCost;
      for (const p of group) {
        const hunterGuest = hunterGuestCost > 0 && p.role === 'ranged_dps';
        if (p.role !== 'melee_dps' && p.role !== 'caster_dps' && !hunterGuest) continue;
        if (overflowSeatOpen && rules.rules.healerGroupDps && rules.rules.healerGroupDps(p)) {
          overflowSeatOpen = false;
          // 2026-10-10 comp rules: with the Ele and Boomkin now holding the Destruction locks, the
          // leftover lock's home is this seat; a small pull (rules.healerGroupDpsPull, off at 0)
          // keeps it from drifting into a melee group as a lone caster.
          score += rules.rules.healerGroupDpsPull * cfg.structure;
          continue;
        }
        score -= (hunterGuest ? hunterGuestCost : rules.rules.tankGroupGuestCost) * cfg.structure;
      }
    }

    // Windfury coverage — a melee group without any shaman is a melee group
    // without Windfury. Each melee DPS there pays roughly what a mid-value WF
    // would have given them, so a Resto or Ele shaman is drawn to the melee
    // group that has nobody to drop it (reference comp rule 1: any shaman
    // drops WF for melee), and melee spread across shaman-covered groups
    // instead of piling into the one Enhancement group. Skipped for a
    // faction-locked Alliance roster, which can never field a shaman at all.
    // 2026-10-10 rule 1: TBC raises the per-melee cost (rules.meleeWantsWindfuryCost, 13 in TBC, 6 in Classic and
    // Forever) so a spare Ele/Resto shaman is drawn to a melee group with 2+ melee DPS and no shaman; scaled per melee DPS.
    const canHaveShaman = !rules.rules.factionLock || Faction.current() !== 'alliance';
    // A group whose melee DPS would all get nothing from Windfury (a TBC/Classic Feral: weapon imbues do not work in forms; Forever's party-wide Windfury does, see WINDFURY's weight.dps in js/rules/forever.js) is not missing a Windfury totem, so a Feral seated with hunters is no pull for a shaman; any group with a Windfury-using melee is charged as before, Feral included.
    if (rules.rules.meleeWantsWindfury && canHaveShaman && roleIdentity === 'melee_dps' && !group.some(p => p.class === 'SHAMAN')
        && group.some(p => p.role === 'melee_dps' && dpsValueFor('WINDFURY', p) > 0)) {
      for (const p of group) {
        if (p.role === 'melee_dps') score -= rules.rules.meleeWantsWindfuryCost * dpsWeightFor(p) * cfg.structure;
      }
    }

    // 2026-10-10 user decision: a Retribution Paladin sits with an Enhancement Shaman (rules.retEnhPairBonus,
    // x cfg.structure; 0 = off, as in Classic and Forever).
    if (rules.rules.retEnhPairBonus && group.some(p => p.class === 'PALADIN' && p.spec === 'Retribution') && group.some(p => p.class === 'SHAMAN' && p.spec === 'Enhancement')) {
      score += rules.rules.retEnhPairBonus * cfg.structure;
    }

    // Role cohesion — DPS members clustered with their group's identity.
    // Ranged DPS (hunters) count as full members of melee groups: they
    // bring FI/TSA to the physical party and receive LotP/GoA there
    // (reference comp rule: BM/Surv hunters ride in the melee groups).
    if (roleIdentity !== 'tank') {
      // A group labelled caster_dps only counts as a caster group for the hunter weight when its caster_dps
      // members outnumber its melee + ranged members (2-group 10-mans label a melee/hunter group 'caster_dps').
      const casterMembers = group.reduce((n, p) => n + (p.role === 'caster_dps' ? 1 : 0), 0);
      const physicalMembers = group.reduce((n, p) => n + (p.role === 'melee_dps' || p.role === 'ranged_dps' ? 1 : 0), 0);
      const casterByMembers = casterMembers > physicalMembers;
      for (const p of group) {
        if (p.role === 'healer' || p.role === 'tank') continue;
        const matches = p.role === roleIdentity || (roleIdentity === 'melee_dps' && p.role === 'ranged_dps');
        if (matches) score += rules.rules.cohesionMatch * cfg.cohesion;
        // Hunters ride with the physical groups. In a caster group they are
        // neutral rather than "compatible": Unleashed Rage (melee-only) no
        // longer holds them in a melee group, and without this a leftover
        // hunter drifted in beside the Ele Shaman and mages.
        else if (p.role === 'ranged_dps' && roleIdentity === 'caster_dps') {
          // 2026-10-10 decision: a hunter in a caster group is a heavy weight, never a
          // hard ban (rules.hunterInCasterGroup; off at 0).
          if (casterByMembers) score -= rules.rules.hunterInCasterGroup * cfg.structure;
          continue;
        }
        else if (ROLE_COMPAT[p.role] && ROLE_COMPAT[p.role].includes(roleIdentity)) score += rules.rules.cohesionCompatible * cfg.cohesion;
        else score -= rules.rules.cohesionMismatch * cfg.cohesion;
      }
      // A tank in a caster group is off-role there: rules.tankInCasterGroupCost per tank, x structure in every mode
      // (a structural rule, not a cohesion preference; why: conventions in js/rules/<version>.js).
      if (roleIdentity === 'caster_dps') score -= rules.rules.tankInCasterGroupCost * cfg.structure * tanks.length;
    }

    // Duplicate providers (rules.stackPenalty): the second shaman/Ret/Feral in
    // a group adds only leftovers, so the stack must outbid a group that has
    // none. Triangular, so a third copy costs more than the second.
    for (const { match, weight } of rules.rules.stackPenalty || []) {
      const n = group.reduce((c, p) => c + (match(p) ? 1 : 0), 0);
      if (n > 1) score -= weight * (n * (n - 1) / 2) * cfg.structure;
    }

    // 2026-10-10 duplicate stacks (comp rule 1: one shaman's Windfury per melee group): an
    // Enhancement Shaman beyond the number of melee groups adds no coverage, so one parked in a
    // tank or caster group costs rules.surplusEnhCost, which lets the bench trade (refineBench)
    // bench the redundant Enh instead of a DPS that would receive buffs. Off at 0.
    if (rules.rules.surplusEnhCost && roleIdentity !== 'melee_dps') {
      const enhHere = group.reduce((c, p) => c + (p.class === 'SHAMAN' && p.spec === 'Enhancement' ? 1 : 0), 0);
      if (enhHere > 0) {
        const ids = groups._roleIdentities || [];
        const meleeGroups = groups.reduce((c, g, i) => c + ((ids[i] || 'melee_dps') === 'melee_dps' ? 1 : 0), 0);
        const enhTotal = groups.reduce((c, g) => c + g.reduce((m, p) => m + (p.class === 'SHAMAN' && p.spec === 'Enhancement' ? 1 : 0), 0), 0);
        if (enhTotal > meleeGroups) score -= rules.rules.surplusEnhCost * enhHere * cfg.structure;
      }
    }

    // Spreading pressure — convex penalty so the marginal cost of joining a
    // fuller group is higher, nudging placement toward emptier groups when
    // synergy gains are comparable (rules.groupSizePressure).
    score -= rules.rules.groupSizePressure * group.length * group.length * cfg.structure;

    return score;
  },

  // ── PHASE 3: SWAP REFINEMENT ─────────────────────────────────
  // Hill-climbs pairwise swaps against the same groupScore() objective the
  // greedy phase used, so refinement can never "improve" toward a different
  // goal than placement optimized for.
  // opts.noIsolate rejects a swap that leaves a touched group with an isolated
  // member it did not have before. Returns true if any swap was applied.
  refineSwaps(groups, max, mode, opts) {
    const SWAP_THRESHOLD = 0.5;
    const guard = !!(opts && opts.noIsolate);
    let changedAny = false;
    const wasIso = guard ? groups.map(g => this.isolatedCount(g)) : null;
    for (let iter = 0; iter < 4; iter++) {
      let improved = false;
      for (let gi = 0; gi < groups.length; gi++) {
        for (let gj = gi + 1; gj < groups.length; gj++) {
          for (let pi = 0; pi < groups[gi].length; pi++) {
            // Never swap the anchor tank out of the tank-identity group
            if (this.isPinned(groups[gi][pi], gi, groups)) continue;
            for (let pj = 0; pj < groups[gj].length; pj++) {
              if (this.isPinned(groups[gj][pj], gj, groups)) continue;
              const currentScore = this.groupScore(groups[gi], gi, groups, mode)
                                 + this.groupScore(groups[gj], gj, groups, mode);

              // Tentatively swap
              const tmp = groups[gi][pi];
              groups[gi][pi] = groups[gj][pj];
              groups[gj][pj] = tmp;

              const newScore = this.groupScore(groups[gi], gi, groups, mode)
                             + this.groupScore(groups[gj], gj, groups, mode);

              if (newScore > currentScore + SWAP_THRESHOLD &&
                  !(guard && (this.isolatedCount(groups[gi]) > wasIso[gi] ||
                              this.isolatedCount(groups[gj]) > wasIso[gj]))) {
                improved = true;
                changedAny = true;
                if (guard) { wasIso[gi] = this.isolatedCount(groups[gi]); wasIso[gj] = this.isolatedCount(groups[gj]); }
              } else {
                // Revert swap
                groups[gj][pj] = groups[gi][pi];
                groups[gi][pi] = tmp;
              }
            }
          }
        }
      }
      if (!improved) break;
    }
    return changedAny;
  },

  // ── PHASE 3e: K-CYCLE ROTATIONS ──────────────────────────────
  // Rotates one non-pinned member through k distinct groups (a to b's seat,
  // b to c's seat, c to a's seat), both directions, scoring only the touched
  // groups like refinePairExchanges. Per iteration the best gain above 0.5 is
  // applied (ties: first found, ascending index order). Only k = 3 is used
  // (a 25-man has ~2,500 candidates); the loop is general in k. opts.noIsolate
  // rejects a candidate that newly isolates a member of a touched group.
  // Returns true if anything changed.
  refineRotations(groups, mode, opts, k = 3) {
    const THRESHOLD = 0.5;
    const guard = !!(opts && opts.noIsolate);
    const n = groups.length;
    if (n < k || !activeRules().rules.rotationSearch) return false;
    let changedAny = false;
    for (let iter = 0; iter < 10; iter++) {
      let best = null, bestGain = THRESHOLD;
      const scores = groups.map((g, gi) => this.groupScore(g, gi, groups, mode));
      const iso = guard ? groups.map(g => this.isolatedCount(g)) : null;
      const memo = new Map();
      const gs = new Array(k);
      const idx = new Array(k);
      // dir 0: member of gs[i] moves to gs[i+1]'s seat; dir 1: to gs[i-1]'s.
      const tryCycle = () => {
        const mem = gs.map((g, i) => groups[g][idx[i]]);
        for (let dir = 0; dir < 2; dir++) {
          for (let i = 0; i < k; i++) {
            const to = dir === 0 ? (i + 1) % k : (i + k - 1) % k;
            groups[gs[to]][idx[to]] = mem[i];
          }
          let gain = -gs.reduce((sum, g) => sum + scores[g], 0);
          let ok = true;
          // Each resulting group is "group g without seat idx plus the member from (g', idx')"; the
          // same composition recurs in many cycles, so its score is memoized per iteration. Valid
          // because a cycle only permutes members between groups (board-level totals do not change).
          for (let i = 0; i < k; i++) {
            const from = dir === 0 ? (i + k - 1) % k : (i + 1) % k;
            const key = ((gs[i] * 64 + idx[i]) * 64 + gs[from]) * 64 + idx[from];
            let sc = memo.get(key);
            if (sc === undefined) { sc = this.groupScore(groups[gs[i]], gs[i], groups, mode); memo.set(key, sc); }
            gain += sc;
          }
          if (guard && gain > bestGain) {
            for (let i = 0; i < k; i++) {
              if (this.isolatedCount(groups[gs[i]]) > iso[gs[i]]) { ok = false; break; }
            }
          }
          for (let i = 0; i < k; i++) groups[gs[i]][idx[i]] = mem[i];
          if (ok && gain > bestGain) {
            bestGain = gain;
            best = { gs: gs.slice(), idx: idx.slice(), dir };
          }
        }
      };
      const recurse = (depth, startG) => {
        if (depth === k) { tryCycle(); return; }
        for (let g = startG; g < n; g++) {
          gs[depth] = g;
          const seen = new Set();
          for (let p = 0; p < groups[g].length; p++) {
            const m = groups[g][p];
            if (this.isPinned(m, g, groups)) continue;
            // Same role/class/spec in one group are interchangeable: only the first is tried
            // (identical gain, and ties already resolve to the first found), cutting the candidates ~3x.
            const key = m.role + '|' + m.class + '|' + m.spec;
            if (seen.has(key)) continue;
            seen.add(key);
            idx[depth] = p;
            recurse(depth + 1, g + 1);
          }
        }
      };
      recurse(0, 0);
      if (!best) break;
      const mem = best.gs.map((g, i) => groups[g][best.idx[i]]);
      for (let i = 0; i < k; i++) {
        const to = best.dir === 0 ? (i + 1) % k : (i + k - 1) % k;
        groups[best.gs[to]][best.idx[to]] = mem[i];
      }
      changedAny = true;
    }
    return changedAny;
  },

  // ── PHASE 3d: BENCH REFINEMENT ───────────────────────────────
  // For each overflow player on the bench, try them in place of every seated
  // player and take the trade that raises the raid total the most. Seeded
  // anchor tanks stay put, and a trade never drops tanks or healers below
  // the raid's floors. The displaced player joins the overflow list so they
  // can be reconsidered. Returns true when at least one trade was made.
  refineBench(groups, overflow, raidSize, mode) {
    const BENCH_THRESHOLD = this.BENCH_TOLERANCE;
    const floors = this.floorsFor(raidSize);
    const total = () => groups.reduce((sum, g, gi) => sum + this.groupScore(g, gi, groups, mode), 0);
    const roleCount = (role) => groups.reduce((n, g) => n + g.filter(p => p.role === role).length, 0);
    // Healer cap (2026-10-10 decision): a non-healer may not be traded out for a
    // healer once seated healers already reach the cap.
    const healerCap = this.healerCapFor(raidSize);
    let traded = false;

    for (let round = 0; round < 10; round++) {
      let best = null;
      const base = total();
      // A Standby volunteer (SignupMarker) is traded in for a player who did not volunteer only when that gains the raid something it would otherwise lack: a
      // party buff, raid debuff or utility no one else seated brings (raidCoverage). The raid-total gain above the tolerance alone is not enough (wave 6).
      const covered = overflow.some(p => SignupMarker.isStandby(p)) ? this.raidCoverage(groups, mode) : null;
      for (let bi = 0; bi < overflow.length; bi++) {
        const incoming = overflow[bi];
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          for (let si = 0; si < g.length; si++) {
            const out = g[si];
            if (this.isPinned(out, gi, groups)) continue;
            if (healerCap != null && incoming.role === 'healer' && out.role !== 'healer' && roleCount('healer') + 1 > healerCap) continue;
            if (out.role !== incoming.role && (out.role === 'tank' || out.role === 'healer')) {
              if (roleCount(out.role) - 1 < (floors[out.role] || 0)) continue;
            }
            g[si] = incoming;
            const gain = total() - base;
            let needed = true;
            if (gain > BENCH_THRESHOLD && covered && SignupMarker.isStandby(incoming) && !SignupMarker.isStandby(out)) {
              needed = [...this.raidCoverage(groups, mode)].some(id => !covered.has(id));
            }
            g[si] = out;
            if (gain > BENCH_THRESHOLD && needed && (!best || gain > best.gain)) best = { bi, gi, si, gain };
          }
        }
      }
      if (!best) break;
      const g = groups[best.gi];
      const incoming = overflow[best.bi];
      const out = g[best.si];
      g[best.si] = incoming;
      overflow[best.bi] = out;
      out.groupNumber = 0;
      traded = true;
    }
    return traded;
  },

  // Everything the seated board covers, as keys 'b:<party or raid-wide buff id>', 'd:<raid debuff id>' and 'u:<utility id>': what the raid would lose if a player left.
  raidCoverage(groups, mode) {
    const covered = new Set();
    groups.forEach((g, gi) => {
      for (const id of this.resolveGroupBuffs(g, this.buffValueFn(g, gi, groups, mode))) covered.add('b:' + id);
    });
    for (const id of getRaidDebuffCoverage(groups)) covered.add('d:' + id);
    for (const u of Readiness.utilityCoverage(groups, [])) if (u.covered) covered.add('u:' + u.id);
    return covered;
  },

  // The display name of a raidCoverage key.
  coverageName(key) {
    const table = key[0] === 'b' ? Config.Buffs : key[0] === 'd' ? Config.Debuffs : Config.Utilities;
    const entry = table ? table[key.slice(2)] : null;
    return (entry && entry.name) || key.slice(2);
  },

  // ── FAIR BENCH AND STANDBY (wave 6) ──────────────────────────
  // Trades a benched player against a seated one of the same role when benching the seated one is fairer: the benched player is not a Standby volunteer
  // while the seated one is (volunteers sit out first), or has sat out more of the team's recent raids (Fairness). Every trade is a tie in value: the raid total
  // after all of them stays within BENCH_TOLERANCE of what the value-only choice reached, so fairness never costs the raid more than that. Seeded anchors
  // and comp-template locks stay, Open-slot stand-ins are never traded, and a Standby volunteer never takes the seat of someone who did not volunteer here
  // (refineBench does that, for a buff the raid would lack). Returns true when at least one trade was made.
  refineFairness(groups, overflow, mode) {
    const total = () => groups.reduce((sum, g, gi) => sum + this.groupScore(g, gi, groups, mode), 0);
    const floor = total() - this.BENCH_TOLERANCE;
    let traded = false;
    for (let round = 0; round < 10; round++) {
      let best = null;
      for (let bi = 0; bi < overflow.length; bi++) {
        const incoming = overflow[bi];
        if (incoming.openSlot) continue;
        const volunteer = SignupMarker.isStandby(incoming);
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          for (let si = 0; si < g.length; si++) {
            const out = g[si];
            if (out.openSlot || out.role !== incoming.role || this.isPinned(out, gi, groups)) continue;
            const outVolunteer = SignupMarker.isStandby(out);
            if (volunteer && !outVolunteer) continue;
            const rank = (outVolunteer && !volunteer ? 1000 : 0) + Fairness.benches(incoming) - Fairness.benches(out);
            if (rank <= 0) continue;
            g[si] = incoming;
            const after = total();
            g[si] = out;
            if (after < floor) continue;
            if (!best || rank > best.rank || (rank === best.rank && after > best.after)) best = { bi, gi, si, rank, after };
          }
        }
      }
      if (!best) break;
      const g = groups[best.gi];
      const incoming = overflow[best.bi];
      const out = g[best.si];
      g[best.si] = incoming;
      overflow[best.bi] = out;
      out.groupNumber = 0;
      traded = true;
    }
    return traded;
  },

  // 'Benched: sat out 2 of last 4' (the phrase of a fairness reason); one raid on record reads 'Benched: sat out the last raid' / 'Benched: did not sit out the last raid'.
  sitOutText(count) {
    if (Fairness.window === 1) return count ? 'Benched: sat out the last raid' : 'Benched: did not sit out the last raid';
    return 'Benched: sat out ' + count + ' of last ' + Fairness.window;
  },

  // Why each confirmed player on the bench is out, for the Bench tray: Map uid -> 'Benched: ...'. Only while a seed's sit-out history is loaded (Fairness), read from the
  // board as it stands (so a manual move never leaves a stale reason) and cached until the board, the history or the mode changes.
  //   a Standby volunteer: 'Benched: volunteered as standby'
  //   seating him would cost the raid at most the tolerance (some seated player of his role is worth the same): fairness decided, 'Benched: sat out N of last M'
  //   otherwise: 'Benched: buff plan needs <the buff, debuff or utility the raid would lose by seating him instead of the player it loses least by>', or
  //   'Benched: lowest value for the raid' when no coverage is lost.
  benchReasons() {
    const none = new Map();
    if (!Fairness.active() || !GameVersions[State.gameVersion].modeled) return none;
    const groups = State.groups || [];
    const bench = (State.bench || []).filter(p => p && p.signupStatus === 'confirmed' && !p.openSlot && p.role);
    if (!bench.length || !groups.length) return none;
    const mode = State.optimizerMode || 'max_dps';
    const key = [State.gameVersion, State.selectedRaid, Fairness.version, mode, groups.map(g => g.map(p => p.uid).join(',')).join('|'), bench.map(p => p.uid).join(',')].join('#');
    if (this._reasonCache && this._reasonCache.key === key) return this._reasonCache.map;
    const map = new Map();
    const raid = Config.Raids[State.selectedRaid];
    const floors = this.floorsFor(raid ? raid.size : 25);
    const roleCount = (role) => groups.reduce((n, g) => n + g.filter(p => p.role === role).length, 0);
    const total = () => groups.reduce((sum, g, gi) => sum + this.groupScore(g, gi, groups, mode), 0);
    const base = total();
    const before = this.raidCoverage(groups, mode);
    for (const b of bench) {
      if (SignupMarker.isStandby(b)) { map.set(b.uid, 'Benched: volunteered as standby'); continue; }
      let tie = false, closest = null;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        for (let si = 0; si < g.length; si++) {
          const s = g[si];
          if (s.openSlot || this.isPinned(s, gi, groups)) continue;
          if (s.role !== b.role && (s.role === 'tank' || s.role === 'healer') && roleCount(s.role) - 1 < (floors[s.role] || 0)) continue;
          g[si] = b;
          const gain = total() - base;
          g[si] = s;
          if (s.role === b.role && gain >= -this.BENCH_TOLERANCE) tie = true;
          if (!closest || gain > closest.gain) closest = { gi, si, gain };
        }
      }
      if (tie) { map.set(b.uid, this.sitOutText(Fairness.benches(b))); continue; }
      if (!closest) { map.set(b.uid, 'Benched: the raid is full'); continue; }
      const g = groups[closest.gi];
      const s = g[closest.si];
      g[closest.si] = b;
      const after = this.raidCoverage(groups, mode);
      g[closest.si] = s;
      const lost = [...before].filter(id => !after.has(id));
      map.set(b.uid, lost.length ? 'Benched: buff plan needs ' + this.coverageName(lost[0]) : 'Benched: lowest value for the raid');
    }
    this._reasonCache = { key, map };
    return map;
  },

  // ── PHASE 3c: 2-FOR-2 EXCHANGES ──────────────────────────────
  // Trades two players from one group for two from another. Catches
  // rebalances a single swap can't reach because each half looks worse on
  // its own (e.g. Ele Shaman out to the warlocks AND a Holy Priest in with
  // the Shadow Priest). Only the two groups involved change, so the delta
  // is just their two scores. Returns true if anything changed.
  refinePairExchanges(groups, mode) {
    const THRESHOLD = 0.5;
    let changedAny = false;
    for (let iter = 0; iter < 10; iter++) {
      let best = null, bestGain = THRESHOLD;
      for (let gi = 0; gi < groups.length; gi++) {
        for (let gj = gi + 1; gj < groups.length; gj++) {
          const A = groups[gi], B = groups[gj];
          if (A.length < 2 || B.length < 2) continue;
          const before = this.groupScore(A, gi, groups, mode) + this.groupScore(B, gj, groups, mode);
          for (let a1 = 0; a1 < A.length; a1++) {
            if (this.isPinned(A[a1], gi, groups)) continue;
            for (let a2 = a1 + 1; a2 < A.length; a2++) {
              if (this.isPinned(A[a2], gi, groups)) continue;
              for (let b1 = 0; b1 < B.length; b1++) {
                if (this.isPinned(B[b1], gj, groups)) continue;
                for (let b2 = b1 + 1; b2 < B.length; b2++) {
                  if (this.isPinned(B[b2], gj, groups)) continue;
                  const pa1 = A[a1], pa2 = A[a2], pb1 = B[b1], pb2 = B[b2];
                  A[a1] = pb1; A[a2] = pb2; B[b1] = pa1; B[b2] = pa2;
                  const gain = this.groupScore(A, gi, groups, mode) + this.groupScore(B, gj, groups, mode) - before;
                  A[a1] = pa1; A[a2] = pa2; B[b1] = pb1; B[b2] = pb2;
                  if (gain > bestGain) { bestGain = gain; best = { gi, gj, a1, a2, b1, b2 }; }
                }
              }
            }
          }
        }
      }
      if (!best) break;
      const { gi, gj, a1, a2, b1, b2 } = best;
      const A = groups[gi], B = groups[gj];
      const pa1 = A[a1], pa2 = A[a2];
      A[a1] = B[b1]; A[a2] = B[b2]; B[b1] = pa1; B[b2] = pa2;
      changedAny = true;
    }
    return changedAny;
  },

  // ── PHASE 3a: MOVE REFINEMENT ────────────────────────────────
  // Hill-climbs single-player moves into open slots against the total of
  // groupScore() over all groups. Returns true if anything moved.
  refineMoves(groups, max, mode) {
    const total = () => {
      let s = 0;
      for (let gi = 0; gi < groups.length; gi++) s += this.groupScore(groups[gi], gi, groups, mode);
      return s;
    };
    let movedAny = false;
    for (let iter = 0; iter < 25; iter++) {
      let bestGain = 0.5, bestGi = -1, bestPi = -1, bestGj = -1;
      const before = total();
      for (let gi = 0; gi < groups.length; gi++) {
        for (let pi = 0; pi < groups[gi].length; pi++) {
          const p = groups[gi][pi];
          if (this.isPinned(p, gi, groups)) continue;
          for (let gj = 0; gj < groups.length; gj++) {
            if (gj === gi || !this.hasRoom(groups, gj, max)) continue;
            groups[gi].splice(pi, 1);
            groups[gj].push(p);
            const gain = total() - before;
            groups[gj].pop();
            groups[gi].splice(pi, 0, p);
            if (gain > bestGain) { bestGain = gain; bestGi = gi; bestPi = pi; bestGj = gj; }
          }
        }
      }
      if (bestGi < 0) break;
      groups[bestGj].push(groups[bestGi].splice(bestPi, 1)[0]);
      movedAny = true;
    }
    return movedAny;
  },

  // ── PHASE 3b: TANK-GROUP GUEST OPTIMIZATION ──────────────────
  // For each DPS guest in the tank group, try swapping with every non-tank,
  // non-sole-healer member of every other group; take any strictly positive
  // improvement. Repeats until stable (bounded).
  optimizeTankGuests(groups, mode) {
    const ids = groups._roleIdentities;
    if (!ids) return;
    const tIdx = ids.indexOf('tank');
    if (tIdx < 0) return;
    for (let iter = 0; iter < 4; iter++) {
      let improved = false;
      for (let pi = 0; pi < groups[tIdx].length; pi++) {
        const guest = groups[tIdx][pi];
        if (guest.role === 'healer' || this.isPinned(guest, tIdx, groups)) continue;
        let bestGain = 0.5, bestGj = -1, bestPj = -1;
        for (let gj = 0; gj < groups.length; gj++) {
          if (gj === tIdx) continue;
          for (let pj = 0; pj < groups[gj].length; pj++) {
            const q = groups[gj][pj];
            if (q.role === 'tank' || this.isPinned(q, gj, groups)) continue;
            const before = this.groupScore(groups[tIdx], tIdx, groups, mode)
                         + this.groupScore(groups[gj], gj, groups, mode);
            groups[tIdx][pi] = q;
            groups[gj][pj] = guest;
            const after = this.groupScore(groups[tIdx], tIdx, groups, mode)
                        + this.groupScore(groups[gj], gj, groups, mode);
            groups[gj][pj] = q;
            groups[tIdx][pi] = guest;
            const gain = after - before;
            if (gain > bestGain) { bestGain = gain; bestGj = gj; bestPj = pj; }
          }
        }
        if (bestGj >= 0) {
          const q = groups[bestGj][bestPj];
          groups[bestGj][bestPj] = guest;
          groups[tIdx][pi] = q;
          improved = true;
        }
      }
      if (!improved) break;
    }
  },

  // Shared by deIsolate and spreadProviders' wouldIsolate() guard so the two
  // phases can never disagree about what "isolated" means — a role belongs to
  // the 'melee' family (tank/melee_dps/ranged_dps), the 'caster' family
  // (caster_dps/healer), or neither (null).
  roleFamily(role) {
    return (role === 'melee_dps' || role === 'tank' || role === 'ranged_dps') ? 'melee' :
      (role === 'caster_dps' || role === 'healer') ? 'caster' : null;
  },

  // Number of isolated members (same definition as wouldIsolate); the refine guards compare counts so a
  // candidate that isolates a SECOND member of an already-isolated group is rejected too.
  isolatedCount(group) {
    let n = 0;
    for (let xi = 0; xi < group.length; xi++) {
      const x = group[xi];
      if (x.role !== 'melee_dps' && x.role !== 'caster_dps') continue;
      const fam = this.roleFamily(x.role);
      if (!group.some((y, yi) => yi !== xi && this.roleFamily(y.role) === fam)) n++;
    }
    return n;
  },

  // Would removing the player at `removeIdx` from `group` (optionally
  // replacing them with `insertPlayer`, for a swap) leave some OTHER
  // melee_dps/caster_dps member without a same-family peer? Same isolation
  // definition deIsolate uses, run as a lookahead before spreadProviders
  // commits to a source group — see spreadProviders' Phase 5 comment for why
  // this guard exists: nothing runs after Phase 5 to undo a fresh isolation.
  wouldIsolate(group, removeIdx, insertPlayer) {
    const next = group.filter((_, i) => i !== removeIdx);
    if (insertPlayer) next.push(insertPlayer);
    return next.some((x, xi) => {
      if (x.role !== 'melee_dps' && x.role !== 'caster_dps') return false;
      const fam = this.roleFamily(x.role);
      return !next.some((y, yi) => yi !== xi && this.roleFamily(y.role) === fam);
    });
  },

  // ── PHASE 4: DE-ISOLATION ─────────────────────────────────────
  // Finds any melee_dps/caster_dps player with zero role-compatible peers in
  // their own group and fixes it with whichever swap or open-seat move costs
  // the least groupScore. Candidates that don't strand someone else win
  // first; among those, the score decides — an unscored pick used to trade a
  // caster group's only Resto Shaman for a lone mage, wrecking both groups.
  deIsolate(groups, mode, max = 5) {
    const family = role => this.roleFamily(role);
    const score = (gi) => this.groupScore(groups[gi], gi, groups, mode);
    const isolated = (group) => group.some((x, xi) =>
      (x.role === 'melee_dps' || x.role === 'caster_dps') &&
      !group.some((y, yi) => yi !== xi && family(y.role) === family(x.role)));
    // Apply a change, measure it, undo it. Returns { clean, delta }.
    const trial = (gi, gj, apply, undo) => {
      const before = score(gi) + score(gj);
      apply();
      const res = { clean: !isolated(groups[gi]) && !isolated(groups[gj]), delta: score(gi) + score(gj) - before };
      undo();
      return res;
    };
    const better = (a, b) => !b || (a.clean !== b.clean ? a.clean : a.delta > b.delta);

    // A single pass can fix one isolated player by pulling their swap
    // partner out of ITS group — which can leave a different player newly
    // isolated (or not notice one uncovered earlier in the same pass, since
    // groups already scanned aren't revisited). Iterate to a fixed point,
    // same as refineSwaps, capped so a pathological roster can't loop forever.
    for (let iter = 0; iter < 6; iter++) {
      let swapped = false;

      for (let gi = 0; gi < groups.length; gi++) {
        for (let pi = 0; pi < groups[gi].length; pi++) {
          const p = groups[gi][pi];
          if (p.role !== 'melee_dps' && p.role !== 'caster_dps') continue;
          const pFam = family(p.role);
          const hasPeer = groups[gi].some((x, xi) => xi !== pi && family(x.role) === pFam);
          if (hasPeer) continue;

          if (this.isPinned(p, gi, groups)) continue;
          let best = null;
          const consider = (cand) => { if (better(cand, best)) best = cand; };
          for (let gj = 0; gj < groups.length; gj++) {
            if (gj === gi) continue;
            const G = groups[gi], H = groups[gj];

            // Move p into an open seat beside a same-family peer.
            if (this.hasRoom(groups, gj, max) && H.some(x => family(x.role) === pFam)) {
              const r = trial(gi, gj, () => { G.splice(pi, 1); H.push(p); }, () => { H.pop(); G.splice(pi, 0, p); });
              consider({ ...r, apply: () => { G.splice(pi, 1); H.push(p); } });
            }

            for (let pj = 0; pj < H.length; pj++) {
              const q = H[pj];
              // Invariant outranks fixing DPS isolation: never pull a tank
              // out of the tank-identity group.
              if (this.isPinned(q, gj, groups)) continue;

              // Move a same-family peer q into p's open seat.
              if (this.hasRoom(groups, gi, max) && family(q.role) === pFam) {
                const r = trial(gi, gj, () => { H.splice(pj, 1); G.push(q); }, () => { G.pop(); H.splice(pj, 0, q); });
                consider({ ...r, apply: () => { H.splice(pj, 1); G.push(q); } });
              }

              // Swap p with q: p only needs gj to keep OTHER pFam members
              // once q leaves — q's own family is irrelevant to fixing p.
              const pHasPeerAfter = H.some((x, xj) => xj !== pj && family(x.role) === pFam);
              if (!pHasPeerAfter) continue;
              const swap = () => { G[pi] = q; H[pj] = p; };
              const r = trial(gi, gj, swap, () => { G[pi] = p; H[pj] = q; });
              consider({ ...r, apply: swap });
            }
          }

          if (best) {
            best.apply();
            swapped = true;
          }
        }
      }

      if (!swapped) break;
    }
  },
};

// ── OPEN SLOT SUGGESTIONS ───────────────────────────────────────
// Who a school debuff helps: the specs that mostly cast that school. A debuff's compiled `value.who` names the school
// (its targetSchool in js/rules/<version>.js); OpenSlots._raidValue looks the players up here. Every school the data
// may name needs an entry (a school without one is priced as if it helped every DPS); rules-data-tests.js checks it.
const SCHOOL_CASTERS = {
  shadow: p => p.class === 'WARLOCK' || (p.class === 'PRIEST' && p.spec === 'Shadow'),
  fire: p => p.class === 'MAGE' && p.spec === 'Fire',
  frost: p => p.class === 'MAGE' && p.spec === 'Frost',
  nature: p => p.class === 'SHAMAN' && p.spec === 'Elemental' || (p.class === 'DRUID' && p.spec === 'Balance'),
  arcane: p => p.class === 'MAGE' && p.spec === 'Arcane',
};

// When fewer players are seated than the raid holds, Optimize gives every
// empty seat an Open preferred slot for the class/spec that adds the most.
// Missing tanks and healers (Optimizer.floorsFor) come first; every other
// seat goes to the DPS spec with the best marginal groupScore plus raid value
// under the current mode, one seat at a time so each pick sees the last.
// Suggestions carry `auto: true`: replaced on every Optimize and become
// manual once edited. Every Open slot, manual or auto, is then seated by the
// full layout like a real player (Optimizer._optimizeSeats).
const OpenSlots = {
  ALTS_MAX: 2,

  // Classes the raid can bring: under a faction lock (Classic) no Paladin for
  // Horde or Shaman for Alliance, same as the Random roster's list.
  candidates() {
    const faction = activeRules().rules?.factionLock ? Faction.current() : null;
    return Object.values(RandomRoster._buildSpecsByRole(faction)).flat();
  },

  // Raid-level worth of a suggested spec on top of its party buffs: it covers
  // a raid debuff or utility nobody brings yet (Expose Weakness, Power
  // Infusion, ...), and it costs a little for every copy of its spec already
  // in the raid and for piling onto a class the raid already has plenty of.
  // groupScore alone only sees party buffs, so a Resto Shaman (Windfury for
  // one Arms Warrior) beat a Disc Priest and a second Ret beat a Survival Hunter.
  // A raid debuff is worth what a party buff of the same value would be to every raid member it actually helps: its
  // compiled `value` ({ tier, who }, from the debuff's weight, targetRoles and targetSchool in js/rules/<version>.js).
  // The scalars (utilityBonus, specRepeat, classCrowd, classCrowdFree, tankDebuffScale) are the ruleset's `openSlots`; a
  // tank debuff is priced at tier x tank count x the mode's mit x tankDebuffScale, so mit also reprices it.
  // Hunter's Mark counts as fully covered by any hunter: every TBC raid hunter build (Beast Mastery 41/20/0, Survival 0/20/41)
  // takes Improved Hunter's Mark on its way through the Marksmanship tree, so it is no reason to suggest a Marksmanship hunter
  // (user decision 2026-10-10; the half credit that existed here made an MM pick beat a Feral for a hunter group).
  _raidValue(candidate, raid, mode) {
    const rules = activeRules();
    const cfg = modeConfigFor(rules, mode);
    const { utilityBonus, specRepeat, classCrowd, classCrowdFree, tankDebuffScale } = rules.openSlots;
    const withCandidate = raid.concat(candidate);
    const helps = {
      physical: p => p.role === 'melee_dps' || p.role === 'ranged_dps',
      ranged: p => p.role === 'ranged_dps',
      caster: p => p.role === 'caster_dps',
      all: p => p.role !== 'tank' && p.role !== 'healer',
      ...SCHOOL_CASTERS,
    };
    const weightOf = (who) => who === 'tank'
      ? withCandidate.filter(p => p.role === 'tank').length * cfg.mit * tankDebuffScale
      : withCandidate.filter(helps[who] || helps.all).reduce((sum, p) => sum + dpsWeightFor(p), 0) * cfg.dps;
    let v = 0;
    const covered = getRaidDebuffCoverage([raid]);
    for (const [id, d] of Object.entries(Config.Debuffs || {})) {
      if (!canProvideBuff(d, candidate)) continue;
      if (covered.has(id)) continue;
      if (d.supersededBy && covered.has(d.supersededBy)) continue;
      if ((d.competesWith || []).some(other => covered.has(other))) continue;
      const { tier, who } = d.value;
      v += tier * weightOf(who);
    }
    for (const u of Readiness.utilityCoverage([raid], [])) {
      if (u.covered) continue;
      if ((Config.Utilities[u.id].providers || []).some(prov => Readiness._providerMatches(prov, candidate))) v += utilityBonus;
    }
    // 2026-10-10 comp rules (2 and 3): an Elemental Shaman earns its keep beside the Boomkin and
    // the Destruction locks, so a suggested Ele beyond one per Boomkin has no group to amplify.
    // Off at extraEleNeedsBoomkin 0 (Classic and Forever).
    const eleCost = rules.rules.extraEleNeedsBoomkin;
    if (eleCost && candidate.class === 'SHAMAN' && candidate.spec === 'Elemental') {
      const eles = raid.filter(p => p.class === 'SHAMAN' && p.spec === 'Elemental').length;
      const boomkins = raid.filter(p => p.class === 'DRUID' && p.spec === 'Balance').length;
      if (eles >= Math.max(1, boomkins)) v -= eleCost;
    }
    v -= specRepeat * raid.filter(p => p.class === candidate.class && p.spec === candidate.spec).length;
    v -= classCrowd * Math.max(0, raid.filter(p => p.class === candidate.class).length - classCrowdFree + 1);
    return v;
  },

  // An Open slot as a board member, for pricing and for the layout.
  standIn(slot) {
    return { class: slot.class, spec: slot.spec, role: RosterEdit.RoleForSpec(slot.class, slot.spec), uid: 'open', name: '', openSlot: true };
  },

  // Where a member is priced without breaking group conventions: the tank
  // group takes healers, and tanks only as suggestions (a real Feral tank
  // stays with melee); spare tanks and physical DPS go to melee groups;
  // casters and healers to caster groups.
  _fits(member, identity, suggested) {
    if (identity === 'tank') return member.role === 'healer' || (member.role === 'tank' && suggested);
    if (identity === 'caster_dps') return member.role === 'caster_dps' || member.role === 'healer';
    return member.role === 'melee_dps' || member.role === 'ranged_dps' || member.role === 'tank';
  },

  // The next ALTS_MAX distinct class+spec picks behind the winner of one seat, from the same pool and the same
  // gain choose() ranked it on. gap = how far below the winner, in whole percent of the winner's gain (6 = "-6%").
  // A winner whose gain is <= 0 has no sensible percentage, so gap is null and the UI shows no number.
  _runnerUps(best) {
    const key = c => c.class + '|' + c.spec;
    const seen = new Set([key(best.candidate)]);
    const alts = [];
    for (const { candidate, gain } of best.ranked) {
      if (alts.length >= this.ALTS_MAX) break;
      if (seen.has(key(candidate))) continue;
      seen.add(key(candidate));
      alts.push({ class: candidate.class, spec: candidate.spec, gap: best.gain > 0 ? Math.max(0, Math.round((best.gain - gain) / best.gain * 100)) : null });
    }
    return alts;
  },

  // The specs to suggest for the raid's empty seats: tank/healer floors first,
  // then whatever adds the most (party-buff gain in its group + _raidValue),
  // one at a time so each pick sees the last. A pick is priced in a group
  // with a seat, or in a full one after moving its cheapest real player to a
  // seat elsewhere, on a scratch board that never grows past the party size.
  // That only prices the spec: where the slot sits is decided by the full
  // layout optimize() runs next. A seat no spec fits by convention still
  // gets the best spec regardless. Returns picks as { class, spec, alts } (alts: see _runnerUps).
  choose() {
    if (!GameVersions[State.gameVersion].modeled) return [];
    const raid = Config.Raids[State.selectedRaid];
    if (!raid || !State.groups.length) return [];
    const max = RosterEdit.MAX_GROUP_SIZE;
    const mode = State.optimizerMode || 'max_dps';
    // Scratch board: seated players plus the leader's own requests, so the
    // suggestions build on what's already planned. Never touches State.groups.
    const board = State.groups.map((g, gi) => g.concat(PreferredSlots.forGroup(gi).map(this.standIn)));
    board._roleIdentities = State.groups._roleIdentities;
    board._anchors = State.groups._anchors;
    const open = Math.min(raid.size, board.length * max) - board.flat().length;
    const score = (gi, group = board[gi]) => Optimizer.groupScore(group, gi, board, mode);
    // Score a hypothetical group on a board that actually contains it, so board-level terms (the 2+ Enh
    // hunter-spread flip, the surplus-Enh count) see a candidate Enh Shaman before it is picked.
    const scoreWith = (gi, group) => {
      const hypo = board.map((g, i) => i === gi ? group : g);
      hypo._roleIdentities = board._roleIdentities;
      hypo._anchors = board._anchors;
      return Optimizer.groupScore(group, gi, hypo, mode);
    };
    const fits = (m, gi) => this._fits(m, (board._roleIdentities || [])[gi], !board.flat().includes(m));
    // Cheapest way to free a seat in full group gi: move one real, unpinned
    // player to a group with room. cost = score lost.
    const roomIn = (gi) => {
      let best = null;
      for (const m of board[gi]) {
        if (m.openSlot || Optimizer.isPinned(m, gi, board)) continue;
        const without = board[gi].filter(p => p !== m);
        for (let gj = 0; gj < board.length; gj++) {
          if (gj === gi || board[gj].length >= max || !fits(m, gj)) continue;
          const cost = score(gi) + score(gj) - score(gi, without) - score(gj, [...board[gj], m]);
          if (!best || cost < best.cost) best = { m, gj, without, cost };
        }
      }
      return best;
    };
    const floors = Optimizer.floorsFor(raid.size);
    const roleCount = (role) => board.flat().filter(p => p.role === role).length;
    const candidates = this.candidates();
    const picks = [];
    while (picks.length < open) {
      const role = roleCount('tank') < floors.tank ? 'tank'
        : roleCount('healer') < floors.healer ? 'healer' : null;
      const pool = candidates.filter(c => role ? c.role === role : (c.role !== 'tank' && c.role !== 'healer'));
      const rooms = board.map((g, gi) => g.length >= max ? roomIn(gi) : null);
      const bestPick = (conventional) => {
        let best = null;
        const ranked = [];
        for (const candidate of pool) {
          const raidValue = this._raidValue(candidate, board.flat(), mode);
          let own = null; // this candidate at its best group: what the runner-ups are ranked on
          for (let gi = 0; gi < board.length; gi++) {
            if (conventional && !fits(candidate, gi)) continue;
            const room = board[gi].length >= max ? rooms[gi] : null;
            if (board[gi].length >= max && !room) continue;
            const base = room ? room.without : board[gi];
            const gain = scoreWith(gi, [...base, candidate]) - scoreWith(gi, base) - (room ? room.cost : 0) + raidValue;
            if (!best || gain > best.gain) best = { candidate, gi, room, gain };
            if (!own || gain > own.gain) own = { candidate, gain };
          }
          if (own) ranked.push(own);
        }
        // Stable sort: on a tie the earlier candidate stays first, as the winner above does.
        if (best) best.ranked = ranked.sort((a, b) => b.gain - a.gain);
        return best;
      };
      const best = bestPick(true) || bestPick(false);
      if (!best) break;
      const { candidate, gi, room } = best;
      if (room) {
        board[gi].splice(board[gi].indexOf(room.m), 1);
        board[room.gj].push(room.m);
      }
      board[gi].push(this.standIn(candidate));
      picks.push({ class: candidate.class, spec: candidate.spec, alts: this._runnerUps(best) });
    }
    return picks;
  },
};

