// ── IMPORT ──────────────────────────────────────────────────────
const Import = {
  importRaidHelper(jsonStr) {
    let data;
    try { data = JSON.parse(jsonStr); } catch(e) { return { success:false, error:'Invalid JSON: '+e.message }; }
    if (PreferredSlots.hasManual() && (Array.isArray(data.signUps) || Array.isArray(data.slots))) {
      if (!this.parseRaidHelperSignUps({signUps:data.signUps || data.slots}).entries.length)
        return {success:false, error:'No valid players found in sign-ups'};
      const diff = this.diffRaidHelperSignUps(JSON.stringify({signUps:data.signUps || data.slots}));
      if (!diff.success) return diff;
      // Import into a planned layout: keep people already placed by the user.
      diff.removed = [];
      const counts = this.applyRaidHelperSync(diff);
      return {success:true, playerCount:State.roster.length, groupCount:State.groups.length,
        preferredImport:true, filledCount:counts.filled, benchCount:State.bench.length, unplacedCount:State.unplaced.length};
    }
    if (Array.isArray(data.slots)) { const result = this._importRaidHelperSlots(data); if (result.success) State.campfires = Campfires.empty(); return result; }
    if (Array.isArray(data.signUps)) { const result = this._importRaidHelperSignUps(data); if (result.success) State.campfires = Campfires.empty(); return result; }
    return { success:false, error:"No 'slots' or 'signUps' array found in JSON" };
  },

  // One Raid-Helper entry -> everything the importers need: its sign-up
  // status, resolved class/spec/role, and where it lands (see
  // SignupStatus.categoryFor). Class/spec/role are null when unresolved.
  _readRaidHelperEntry(entry, fallbackName) {
    const status = SignupStatus.fromRaidHelper(entry && entry.className);
    const { classFile, specName, role, needsReview, reviewReason } = this._resolveRaidHelperEntry(entry);
    return {
      name: entry.name || fallbackName, status,
      class: classFile || null, spec: classFile ? specName : null, role: classFile ? role : null,
      category: SignupStatus.categoryFor(status, classFile),
      needsReview: !!classFile && needsReview, reviewReason,
    };
  },

  _makeUnplaced(entry) {
    return { uid: nextUid(), name: entry.name, signupStatus: entry.status, class: entry.class, spec: entry.spec, role: entry.role };
  },

  // Resolve a Raid-Helper slot/signup entry (className + specName) to a class/spec/role.
  // Shared by both export shapes below — they use the same field names per entry.
  // Returns { classFile, specName, role, needsReview, reviewReason }: needsReview
  // mirrors the plain-text importer's status/reason shape (parsePlainRoster's
  // addEntry) so both import paths surface a defaulted guess identically.
  _resolveRaidHelperEntry(entry) {
    const specInfo = Config.RaidHelperSpecMap[entry.specName];
    let classFile = null, specName = entry.specName || 'Unknown', role = 'melee_dps';
    let needsReview = false, reviewReason = null;

    if (specInfo) {
      classFile = specInfo.class;
      specName = specInfo.spec;
      role = specInfo.role;
    } else {
      classFile = Config.RaidHelperClassMap[entry.className] || null;
      // A real class Raid-Helper resolved (entry.className is a playable
      // class, not the Tank/Bench/Tentative/Absence meta-values, which all
      // map to null here) but with no spec this map recognizes — signed up
      // class-only, or a spec name it doesn't know. This used to fall
      // straight through to the blanket `role = 'melee_dps'` default above
      // regardless of class (backlog #2, 2026-09-26), silently corrupting
      // tank/healer floor math (Optimizer.floorsFor) for e.g. a class-only
      // Priest. Guess the class's single most common role instead, and flag
      // it exactly like parsePlainRoster flags its own defaulted spec — never
      // let a guess look like a confidently-resolved sign-up.
      if (classFile) {
        role = Config.DefaultRoleForClass[classFile] || 'melee_dps';
        const specTable = Object.values(Config.Specs[classFile] || {});
        const defaultSpec = specTable.find(sp => sp.role === role) || specTable[0];
        specName = defaultSpec ? defaultSpec.name : 'Unknown';
        needsReview = true;
        reviewReason = entry.specName
          ? `Raid-Helper spec "${entry.specName}" not recognized — defaulted to ${specName} (${role.replace('_', ' ')})`
          : `No spec chosen on Raid-Helper — defaulted to ${specName} (${role.replace('_', ' ')})`;
      }
    }

    if (entry.className === 'Tank') {
      role = 'tank';
      if (specInfo) classFile = specInfo.class;
    }
    if (entry.className === 'Bench' && specInfo) {
      classFile = specInfo.class;
    }

    return { classFile, specName, role, needsReview, reviewReason };
  },

  // Format 1: a "slots" export that already carries per-player groupNumber
  // (e.g. an exported raid composition).
  _importRaidHelperSlots(data) {
    let maxGroup = 0;
    for (const slot of data.slots) {
      if (slot.groupNumber && slot.groupNumber > maxGroup) maxGroup = slot.groupNumber;
    }
    if (maxGroup === 0) return { success:false, error:'No groups found in data' };

    const roster = [];
    const bench = [];
    const unplaced = [];
    const groups = [];
    for (let i = 0; i < maxGroup; i++) groups.push([]);

    for (const slot of data.slots) {
      const entry = this._readRaidHelperEntry(slot, 'Unknown-' + (slot.slotNumber || 0));
      if (entry.category === 'unplaced') { unplaced.push(this._makeUnplaced(entry)); continue; }

      const player = {
        uid: nextUid(),
        name: entry.name,
        class: entry.class,
        spec: entry.spec,
        role: entry.role,
        groupNumber: entry.category === 'bench' ? 0 : slot.groupNumber,
        imported: true,
        signupStatus: entry.status,
      };
      if (entry.needsReview) { player.needsReview = true; player.reviewReason = entry.reviewReason; }

      if (entry.category === 'bench') { bench.push(player); continue; }

      roster.push(player);
      const g = slot.groupNumber;
      if (g >= 1 && g <= maxGroup) groups[g-1].push(player);
    }

    // Auto-detect raid — small sign-up lists default to the smallest raid
    // size for the active version (TBC: 10-man; Classic: 20-man).
    if (State.gameVersion === 'tbc' && roster.length <= 10) {
      for (const key of Config.RaidOrder) {
        if (Config.Raids[key].size === 10) { State.selectedRaid = key; break; }
      }
    } else if (State.gameVersion === 'classic' && roster.length <= 20) {
      for (const key of Config.RaidOrder) {
        if (Config.Raids[key].size === 20) { State.selectedRaid = key; break; }
      }
    }

    // Keep the plan's own group layout here; initGroups() folds it into the
    // selected raid's template and benches anyone who no longer fits.
    const overflow = enforceRaidCapacity(groups, bench, groups.length);

    State.roster = groups.flat();
    State.groups = groups;
    State.bench = bench;
    State.unplaced = unplaced;
    return { success:true, playerCount:State.roster.length, groupCount:maxGroup,
             benchCount:bench.length, unplacedCount:unplaced.length, overflowCount:overflow };
  },

  // Format 2: the raid-helper.dev/api/raidplan/{id} "signUps" export — the
  // event sign-up roster, with no group placement at all (players haven't
  // been put into parties yet). Seed groups round-robin, then hand off to
  // the Optimizer to place everyone properly.
  // Reduce a "signUps" export to entries: { name, status, class, spec, role, category }
  // where category is 'raider', 'bench' or 'unplaced' (Absent, or no class).
  // Every sign-up is kept. Shared by the first import and by Refresh.
  parseRaidHelperSignUps(data) {
    const entries = data.signUps.filter(Boolean).map((signUp, i) =>
      this._readRaidHelperEntry(signUp, 'Unknown-' + (signUp.id || i)));
    return { entries };
  },

  _importRaidHelperSignUps(data) {
    const roster = [];
    const bench = [];
    const unplaced = [];
    const { entries } = this.parseRaidHelperSignUps(data);
    for (const entry of entries) {
      if (entry.category === 'unplaced') { unplaced.push(this._makeUnplaced(entry)); continue; }
      const player = {
        uid: nextUid(),
        name: entry.name, class: entry.class, spec: entry.spec, role: entry.role,
        imported: true, signupStatus: entry.status,
      };
      if (entry.needsReview) { player.needsReview = true; player.reviewReason = entry.reviewReason; }
      if (entry.category === 'bench') { player.groupNumber = 0; bench.push(player); }
      else roster.push(player);
    }
    if (roster.length === 0 && bench.length === 0) return { success:false, error:'No valid players found in sign-ups' };
    State.unplaced = unplaced;

    // Auto-detect raid. An all-Tentative list still sizes the raid by how many
    // people signed, so they land on a bench that matches the event.
    const raiders = roster.length || bench.length;
    if (State.gameVersion === 'tbc' && raiders <= 10) {
      for (const key of Config.RaidOrder) {
        if (Config.Raids[key].size === 10) { State.selectedRaid = key; break; }
      }
    } else if (State.gameVersion === 'classic' && raiders <= 20) {
      for (const key of Config.RaidOrder) {
        if (Config.Raids[key].size === 20) { State.selectedRaid = key; break; }
      }
    }

    const raidInfo = Config.Raids[State.selectedRaid];
    const numGroups = raidInfo ? raidInfo.groups : 5;
    // Every primary sign-up goes to the optimizer, even past capacity: it
    // seats the raid's tank/healer floors first and then whoever adds the
    // most, benching the rest. Sign-up order never decides who sits.
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);
    roster.forEach((p, i) => {
      const gi = i % numGroups;
      p.groupNumber = gi + 1;
      groups[gi].push(p);
    });

    State.roster = roster;
    State.groups = groups;
    State.bench = bench;
    const benchBefore = bench.length;
    Optimizer.optimize();
    const overflow = State.bench.length - benchBefore;

    return { success:true, playerCount:State.roster.length, groupCount:numGroups, wasUnassigned:true,
             benchCount:State.bench.length, unplacedCount:State.unplaced.length, overflowCount:overflow };
  },

  // ── Raid-Helper re-sync ───────────────────────────────────────
  // Compare a fresh "signUps" export against the loaded plan without
  // touching State. Players are matched by name (case-insensitive) across the
  // groups, the bench and the unplaced list, since saved rosters carry no
  // Raid-Helper IDs.
  //   added:    sign-ups not in the plan            -> bench / unplaced by status
  //   removed:  plan members no longer signed up    -> will be dropped
  //   changed:  same person, new class/spec/role    -> updated in place
  //   restatus: same person, new sign-up status     -> {player, status, backfill};
  //             people off the raid move to the matching tray tab
  //   demoted:  seated player newly marked Bench/Tentative/Late/Absent -> unseated
  //   promoted: benched player now confirmed        -> reported, left on the bench
  // A status on a player saved before statuses existed is a silent `backfill`,
  // never reported as a change by itself.
  diffRaidHelperSignUps(jsonStr) {
    let data;
    try { data = JSON.parse(jsonStr); } catch (e) { return { success:false, error:'Invalid JSON: ' + e.message }; }
    if (!Array.isArray(data.signUps)) return { success:false, error:"No 'signUps' array found in JSON" };

    const { entries } = this.parseRaidHelperSignUps(data);
    const key = (name) => (name || '').trim().toLowerCase();
    const seated = new Set(State.roster.map(p => p.uid));
    const current = new Map();
    for (const p of [...State.roster, ...(State.bench || []), ...(State.unplaced || [])]) {
      if (!current.has(key(p.name))) current.set(key(p.name), p);
    }

    const diff = { success:true, added:[], removed:[], changed:[], restatus:[], demoted:[], promoted:[] };
    // A rescheduled event moves the date exports show; absent from the response, the stored one stays.
    const eventStartTime = PlanStore.eventStart(data);
    if (eventStartTime) diff.eventStartTime = eventStartTime;
    const seen = new Set();
    for (const entry of entries) {
      const k = key(entry.name);
      if (seen.has(k)) continue; // duplicate sign-up names: first one wins
      seen.add(k);
      const player = current.get(k);
      if (!player) { diff.added.push(entry); continue; }
      // An entry without a class (an Absence, usually) says nothing about spec.
      if (entry.class && (player.class !== entry.class || player.spec !== entry.spec || player.role !== entry.role)) {
        diff.changed.push({ player, class:entry.class, spec:entry.spec, role:entry.role, needsReview:entry.needsReview, reviewReason:entry.reviewReason });
      }
      const statusChanged = player.signupStatus !== entry.status;
      const isSeated = seated.has(player.uid);
      if (isSeated && entry.status !== 'confirmed' && statusChanged) diff.demoted.push(player);
      else if (!isSeated && entry.category === 'raider') diff.promoted.push(player);
      if (statusChanged) diff.restatus.push({ player, status: entry.status, backfill: player.signupStatus === undefined });
    }
    for (const [k, player] of current) if (!seen.has(k)) diff.removed.push(player);
    return diff;
  },

  hasRaidHelperChanges(diff) {
    return !!diff && diff.success &&
      ((diff.added.length + diff.removed.length + diff.changed.length + diff.demoted.length) > 0 ||
        (diff.restatus || []).some(r => !r.backfill) ||
        diff.promoted.some(p => PreferredSlots.match(p)));
  },

  // Fold a diff into State, keeping every untouched seat where it is.
  // Returns the counts applied. Callers re-render.
  applyRaidHelperSync(diff) {
    if (!diff || !diff.success) return null;
    State.bench = State.bench || [];
    State.unplaced = State.unplaced || [];
    State.backups = State.backups || {};

    const unseat = (player) => {
      for (const group of State.groups) {
        const i = group.indexOf(player);
        if (i >= 0) group.splice(i, 1);
      }
      const r = State.roster.indexOf(player);
      if (r >= 0) State.roster.splice(r, 1);
    };
    const clearOverrides = (player) => {
      for (const k of Object.keys(State.buffOverrides)) {
        if (k.split(':')[1] === player.uid) delete State.buffOverrides[k];
      }
    };

    // A player who was seated and just lost that seat (withdrew, or went
    // Tentative) is a candidate for the "Backup ready — swap in?" prompt
    // below, so their seat is captured before unseat() clears groupNumber.
    const vacated = [];
    for (const player of diff.removed) {
      if (player.groupNumber >= 1) vacated.push({ name: player.name, groupNumber: player.groupNumber, gone: true });
      unseat(player);
      const b = State.bench.indexOf(player);
      if (b >= 0) State.bench.splice(b, 1);
      const u = State.unplaced.indexOf(player);
      if (u >= 0) State.unplaced.splice(u, 1);
      clearOverrides(player);
    }
    for (const change of diff.changed) {
      change.player.class = change.class;
      change.player.spec = change.spec;
      change.player.role = change.role;
      if (change.needsReview) { change.player.needsReview = true; change.player.reviewReason = change.reviewReason; }
      else { delete change.player.needsReview; delete change.player.reviewReason; }
      clearOverrides(change.player); // an override for the old spec's buff no longer applies
    }
    for (const { player, status } of (diff.restatus || [])) player.signupStatus = status;
    for (const player of diff.demoted) {
      if (player.groupNumber >= 1) vacated.push({ name: player.name, groupNumber: player.groupNumber, gone: false });
      unseat(player);
      player.groupNumber = 0;
      clearOverrides(player);
      this._fileOffRaid(player);
    }
    // Anyone off the raid whose status or class changed moves between the
    // bench and the unplaced list (an Absence, or a class finally chosen).
    const seated = new Set(State.roster);
    for (const { player } of [...(diff.restatus || []), ...diff.changed]) {
      if (!seated.has(player)) this._fileOffRaid(player);
    }
    let filled = 0;
    for (const player of diff.promoted) if (PreferredSlots.seat(player)) filled++;
    for (const entry of diff.added) {
      if (entry.category === 'unplaced') { State.unplaced.push(this._makeUnplaced(entry)); continue; }
      const player = {
        uid: nextUid(), name:entry.name, class:entry.class, spec:entry.spec, role:entry.role,
        groupNumber: 0, imported: true, signupStatus: entry.status,
      };
      if (entry.needsReview) { player.needsReview = true; player.reviewReason = entry.reviewReason; }
      if (entry.category !== 'bench' && PreferredSlots.seat(player)) filled++;
      else State.bench.push(player);
    }

    // A designated backup still sitting on the bench is offered as a
    // one-click promotion into the exact seat/group its primary vacated,
    // instead of falling through to the optimizer's generic Swap In. A fully
    // withdrawn primary's link can never resolve later, so it's dropped now;
    // a merely-demoted primary keeps theirs in case they get re-seated.
    const backupSwapReady = [];
    for (const v of vacated) {
      const backupName = Backups.backupNameFor(v.name);
      if (backupName && State.bench.some(p => p.name === backupName)) {
        backupSwapReady.push({ primaryName: v.name, backupName, groupNumber: v.groupNumber });
      }
      // A fully-withdrawn primary can never resolve again under this name, so
      // every name-keyed feature drops them here — mirrors the rename/delete
      // call sites (RosterEdit.UpdatePlayer/DeletePlayer) and RandomRoster's
      // "start fresh" cleanup. Left dangling, a stale constraint/drum-tag is
      // invisible until a later sign-up happens to reuse the same name, at
      // which point it silently applies to the wrong (new) person.
      if (v.gone) { Backups.clearForName(v.name); Constraints.clearForName(v.name); Drummers.clearForName(v.name); }
    }

    return {
      added: diff.added.length, removed: diff.removed.length,
      changed: diff.changed.length, demoted: diff.demoted, promoted: diff.promoted.length, filled,
      moved: this.statusMoves(diff), backupSwapReady,
    };
  },

  // One line for the banner/toast. Accepts a diff (arrays) or
  // applyRaidHelperSync's counts (numbers, plus the demoted players and
  // `moved` status changes, which are told by their new status).
  describeRaidHelperChanges(diff) {
    const n = (v) => Array.isArray(v) ? v.length : (v || 0);
    const moved = diff.moved || Import.statusMoves(diff);
    const newStatus = new Map((diff.restatus || moved).map(r => [r.player, r.status]));
    const byStatus = (players) => {
      const tally = {};
      for (const p of players) { const s = newStatus.get(p) || p.signupStatus; tally[s] = (tally[s] || 0) + 1; }
      return Object.entries(tally);
    };
    const parts = [];
    if (n(diff.added)) parts.push(`${n(diff.added)} new sign-up${n(diff.added) === 1 ? '' : 's'}`);
    if (n(diff.removed)) parts.push(`${n(diff.removed)} withdrew`);
    if (n(diff.changed)) parts.push(`${n(diff.changed)} changed spec`);
    for (const [s, k] of byStatus(diff.demoted || [])) parts.push(`${k} seated now ${SignupStatus.label(s)}`);
    for (const [s, k] of byStatus(moved.map(r => r.player))) parts.push(`${k} now ${SignupStatus.label(s)}`);
    if (n(diff.promoted)) parts.push(`${n(diff.promoted)} on the bench now confirmed`);
    if (n(diff.filled)) parts.push(`${n(diff.filled)} preferred slots filled`);
    return parts.join(', ');
  },

  // Status changes worth reporting on their own: not a silent backfill, and
  // not already told as a seat change (demoted) or a confirmation (promoted).
  statusMoves(diff) {
    const told = new Set([...diff.demoted, ...diff.promoted]);
    return (diff.restatus || []).filter(r => !r.backfill && !told.has(r.player));
  },

  // Put a player who isn't seated in the list their status calls for: the
  // unplaced list when Absent or classless, otherwise the bench.
  _fileOffRaid(player) {
    const target = (player.signupStatus === 'absent' || !player.class) ? State.unplaced : State.bench;
    if (target.includes(player)) return; // already filed; keep its place in line
    const other = target === State.bench ? State.unplaced : State.bench;
    const i = other.indexOf(player);
    if (i >= 0) other.splice(i, 1);
    if (target === State.bench) { player.groupNumber = 0; player.imported = true; }
    target.push(player);
  },

  // Compact addon-friendly export string
  // Format: PP:1:raid:G1name.class.spec.role,name.class.spec.role:G2...:G3...
  // Class/spec/role use short codes to keep the string small.
  classCode: {
    WARRIOR:'WR', PALADIN:'PA', HUNTER:'HU', ROGUE:'RO',
    PRIEST:'PR', SHAMAN:'SH', MAGE:'MA', WARLOCK:'WL', DRUID:'DR',
  },
  specCode: {
    Protection:'Prot', Retribution:'Ret', Holy:'Holy',
    Arms:'Arms', Fury:'Fury',
    'Beast Mastery':'BM', Marksmanship:'MM', Survival:'SV',
    Combat:'Com', Assassination:'Ass', Subtlety:'Sub',
    Shadow:'Shad', Discipline:'Disc',
    Enhancement:'Enh', Elemental:'Ele', Restoration:'Rest',
    Arcane:'Arc', Fire:'Fire', Frost:'Fro',
    Destruction:'Dest', Affliction:'Aff', Demonology:'Demo',
    Balance:'Bal', Feral:'Fer',
  },
  roleCode: { tank:'T', healer:'H', melee_dps:'M', ranged_dps:'R', caster_dps:'C' },

  exportAddonString() {
    const cc = this.classCode;
    const sc = this.specCode;
    const rc = this.roleCode;
    const parts = ['PP', '1', State.selectedRaid];
    for (const g of State.groups) {
      const players = g.map(p => {
        const c = cc[p.class] || p.class;
        const s = sc[p.spec] || p.spec;
        const r = rc[p.role] || p.role;
        return `${p.name}.${c}.${s}.${r}`;
      });
      parts.push(players.join(','));
    }
    return parts.join(':');
  },

  // ── MRT (Method Raid Tools) Raid Groups export ──
  // MRT > Raid Groups > Import > "From ExRT export string" accepts:
  //   "MRTRGR" + "0" (plain) | "1" (deflated) + encodeForPrint(payload)
  // where payload is "0," followed by MRT's own table-text serialisation of a
  // 40-slot array: slot = (group-1)*5 + position, value = character name.
  // We always emit the plain "0" variant so no Deflate port is needed; MRT's
  // TextToTable parses explicit [n]="name" entries, so empty slots are skipped.
  MRT_PRINT_ALPHABET: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()',

  // Port of LibDeflate:EncodeForPrint (the WeakAuras 6-bit printable codec).
  // Three input bytes become four alphabet characters, little-endian, LSB first.
  encodeForPrint(str) {
    const bytes = new TextEncoder().encode(str);
    const alpha = this.MRT_PRINT_ALPHABET;
    const out = [];
    let i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
      let cache = bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536;
      for (let k = 0; k < 4; k++) { out.push(alpha[cache % 64]); cache = Math.floor(cache / 64); }
    }
    let cache = 0, bits = 0;
    for (; i < bytes.length; i++) { cache += bytes[i] * Math.pow(2, bits); bits += 8; }
    while (bits > 0) { out.push(alpha[cache % 64]); cache = Math.floor(cache / 64); bits -= 6; }
    return out.join('');
  },

  exportMrtString() {
    const entries = [];
    State.groups.forEach((group, gi) => {
      group.slice(0, 5).forEach((p, pi) => {
        if (!p || !p.name) return;
        const name = String(p.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        entries.push(`[${gi * 5 + pi + 1}]="${name}"`);
      });
    });
    const payload = '0,{' + entries.join(',') + '}';
    return 'MRTRGR0' + this.encodeForPrint(payload);
  },

  // ── CHAT TEXT EXPORT (backlog #1) ──
  // Plain, paste-ready text for Discord/raid chat — pure formatting over
  // State.groups/State.bench + getGroupBuffs, no DOM. Every variant runs
  // through the shared chatSafe() helper (see UTILITIES) so accented player
  // names (e.g. "Thràll") survive instead of being deleted.
  _classLabel(cls) {
    return cls ? cls.charAt(0) + cls.slice(1).toLowerCase() : '';
  },
  // opts.compact: true caps every line at 255 UTF-8 bytes (the WoW /raid chat
  // limit) and swaps '|' (WoW's color-code/hyperlink escape char) for '/' —
  // meant to be pasted line-by-line into in-game chat. Full text is meant for
  // Discord.
  exportChatText(opts = {}) {
    const compact = !!opts.compact;
    const raidInfo = Config.Raids[State.selectedRaid];
    const versionLabel = chatSafe((GameVersions[State.gameVersion] || {}).name || State.gameVersion);
    const rosterLabel = chatSafe(State.rosterName && State.rosterName !== NO_ROSTER_NAME ? State.rosterName : 'Unnamed Roster');
    const dateStr = PlanStore.dayLabel();

    const playerLabel = (p) => `${chatSafe(p.name)} (${chatSafe(p.spec)} ${chatSafe(this._classLabel(p.class))})`;
    const playerList = (list) => list.map(playerLabel).join(', ');

    const finishLine = (line) => {
      line = chatSafe(line);
      if (!compact) return line;
      line = line.replace(/\|/g, '/');
      return clipUtf8Bytes(line, 255);
    };

    const lines = [];
    lines.push(finishLine(`${raidInfo ? raidInfo.name : 'Raid'} (${versionLabel}) - ${dateStr} - ${rosterLabel}`));

    (State.groups || []).forEach((group, gi) => {
      if (!group || !group.length) return;
      const buffNames = getGroupBuffs(group, gi).map(b => Config.BuffAbbreviations[b.id] || b.buff.name);
      const buffTail = buffNames.length ? ` - buffs: ${buffNames.join(', ')}` : '';
      lines.push(finishLine(`G${gi + 1}: ${playerList(group)}${buffTail}`));
    });

    const bench = State.bench || [];
    if (bench.length) lines.push(finishLine(`Bench: ${playerList(bench)}`));

    if (!compact && State.notes && State.notes.trim()) {
      lines.push('');
      lines.push(chatSafe('Notes: ' + State.notes.trim()));
    }

    return lines.join('\n');
  },

  // v2 adds the two things the addon string drops: roster name and bench.
  // Layout: PP:2:<raid>:<encodedName>:<bench>:<group1>:<group2>:...
  // An optional encoded JSON tail after all raid groups preserves open requests
  // and the requested group order. Older v2 readers ignore that extra tail.
  // The addon still reads v1, so exportAddonString() is left alone.
  // Names are written raw (every link made before this existed is raw) unless
  // one contains a delimiter (. , :): then EVERY name is percent-encoded and
  // the tail carries encodedNames so the reader knows to decode them.
  exportShareString() {
    const cc = this.classCode, sc = this.specCode, rc = this.roleCode;
    const encodeNames = [...State.groups.flat(), ...(State.bench || [])].some(p => /[.,:]/.test(String(p.name)));
    const nameCode = n => encodeNames ? encodeURIComponent(n).replace(/\./g, '%2E') : n;
    const encode = list => list.map(p =>
      `${nameCode(p.name)}.${cc[p.class] || p.class}.${sc[p.spec] || p.spec}.${rc[p.role] || p.role}`
    ).join(',');

    const name = State.rosterName === NO_ROSTER_NAME ? '' : (State.rosterName || '');
    const notes = (State.notes || '').trim();
    const hasAssignments = Assignments.hasManualEdits();
    const hasBackups = Backups.hasManualEdits();
    const constraints = Constraints.clean(State.playerConstraints);
    const drummers = Drummers.clean(State.drummers);
    const statuses = this._shareStatuses();
    const unplaced = (State.unplaced || []).map(p => ({ name:p.name, class:p.class, spec:p.spec, role:p.role, signupStatus:p.signupStatus }));
    const parts = ['PP', '2', State.selectedRaid, encodeURIComponent(name), encode(State.bench || [])];
    for (const g of State.groups) parts.push(encode(g));
    // Notes and manual assignment/backup/constraint/drummer edits only ride
    // along when present, so a plain TBC share link (the common case) stays
    // byte-for-byte as compact as before — byte-identical when unused.
    const eventStartTime = PlanStore.cleanEventStart(State.eventStartTime);
    if (State.gameVersion !== 'tbc' || State.preferredSlots.length || State.preserveGroupOrder || notes || hasAssignments || hasBackups || constraints.length || drummers.length || statuses || unplaced.length || encodeNames || eventStartTime) {
      while (parts.length < 5 + Config.Raids[State.selectedRaid].groups) parts.push('');
      const tail = {gameVersion:State.gameVersion, campfires:State.campfires, preferredSlots:State.preferredSlots, preserveGroupOrder:State.preserveGroupOrder};
      if (encodeNames) tail.encodedNames = true;
      if (notes) tail.notes = notes;
      if (hasAssignments) tail.assignments = Assignments.serialize();
      if (hasBackups) tail.backups = Backups.serialize();
      if (constraints.length) tail.playerConstraints = constraints;
      if (drummers.length) tail.drummers = drummers;
      if (statuses) tail.signupStatuses = statuses;
      if (unplaced.length) tail.unplaced = unplaced;
      if (eventStartTime) tail.eventStartTime = eventStartTime;
      parts.push(encodeURIComponent(JSON.stringify(tail)));
    }
    return parts.join(':');
  },

  // name -> sign-up status for the share tail, or null when every status is
  // a plain confirmed sign-up, so the common link stays as compact as before.
  _shareStatuses() {
    const all = [...State.roster, ...(State.bench || [])].filter(p => p.signupStatus);
    if (!all.some(p => p.signupStatus !== 'confirmed')) return null;
    const map = {};
    for (const p of all) map[p.name] = p.signupStatus;
    return map;
  },

  // Base64url so the payload survives a URL fragment untouched (no +, / or =).
  encodeSharePayload(str) {
    if (!str) return '';
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  decodeSharePayload(code) {
    if (!code) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
    try {
      const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
      return decodeURIComponent(escape(atob(b64)));
    } catch (e) {
      return null;
    }
  },

  // Shared by the v1 and v2 readers: "Name.CC.SS.R,Name.CC.SS.R" -> player objects.
  // Entries with a class/spec/role the ruleset does not know are dropped.
  // namesEncoded: the names are percent-encoded (see exportShareString);
  // a malformed escape throws URIError for the caller to report.
  _parsePlayerList(listStr, groupNumber, namesEncoded = false) {
    const ccRev = {}; for (const [k,v] of Object.entries(this.classCode)) ccRev[v] = k;
    const scRev = {}; for (const [k,v] of Object.entries(this.specCode)) scRev[v] = k;
    const rcRev = {}; for (const [k,v] of Object.entries(this.roleCode)) rcRev[v] = k;

    const players = [];
    if (!listStr) return players;
    for (const ps of listStr.split(',')) {
      const [rawName, cCode, sCode, rCode] = ps.split('.');
      if (!rawName) continue;
      const player = {
        name: namesEncoded ? decodeURIComponent(rawName) : rawName,
        class: ccRev[cCode] || cCode,
        spec: scRev[sCode] || sCode,
        role: rcRev[rCode] || rCode,
        groupNumber,
      };
      if (PlayerIdentity.isValid(player)) players.push(player);
    }
    return players;
  },

  // Reads a v2 share string into the shape loadRoster() already understands.
  // Parsing never touches State, so a damaged link cannot wreck a live layout.
  _parseShareString(parts) {
    if (parts.length < 6) return { success:false, error:'Share link is incomplete' };
    const raid = parts[2];
    if (!Config.Raids[raid]) return { success:false, error:'Unknown raid: ' + raid };

    let name = '';
    try { name = decodeURIComponent(parts[3] || ''); }
    catch (e) { return { success:false, error:'Share link is damaged' }; }

    // The tail goes first: its encodedNames flag says how to read the names.
    const numGroups = Config.Raids[raid].groups;
    let planning;
    try { planning = JSON.parse(decodeURIComponent(parts[5 + numGroups] || '%7B%7D')); }
    catch { return {success:false, error:'Share link has damaged preferred slots'}; }

    const namesEncoded = !!planning && planning.encodedNames === true;
    let bench;
    const players = [];
    try {
      bench = this._parsePlayerList(parts[4], 0, namesEncoded);
      for (let gi = 0; gi < numGroups && (gi + 5) < parts.length; gi++) {
        players.push(...this._parsePlayerList(parts[gi + 5], gi + 1, namesEncoded));
      }
    }
    catch { return {success:false, error:'Share link is damaged'}; }
    let campfires;
    let gameVersion = versionForRaid(raid);
    let preferredSlots = [];
    let preserveGroupOrder = false;
    let notes = '';
    let assignments = null;
    let backups = null;
    let playerConstraints = [];
    let drummers = [];
    let unplaced = [];
    let eventStartTime = null;
    try {
      campfires = planning.campfires;
      gameVersion = planning.gameVersion || gameVersion;
      if (!validVersionRaid(gameVersion, raid)) return {success:false, error:'Game version does not match raid'};
      preferredSlots = PreferredSlots.clean(planning.preferredSlots, raid);
      preserveGroupOrder = planning.preserveGroupOrder === true || PreferredSlots.hasManual(preferredSlots);
      notes = typeof planning.notes === 'string' ? planning.notes.slice(0, NOTES_MAX_LENGTH) : '';
      assignments = planning.assignments || null;
      backups = planning.backups || null;
      playerConstraints = Constraints.clean(planning.playerConstraints);
      drummers = Drummers.clean(planning.drummers);
      const statuses = planning.signupStatuses && typeof planning.signupStatuses === 'object' ? planning.signupStatuses : {};
      for (const p of [...players, ...bench]) {
        if (SignupStatus.clean(statuses[p.name])) p.signupStatus = statuses[p.name];
      }
      unplaced = SignupStatus.cleanUnplaced(planning.unplaced);
      eventStartTime = PlanStore.cleanEventStart(planning.eventStartTime);
    }
    catch { return {success:false, error:'Share link has damaged preferred slots'}; }
    if (players.length === 0 && bench.length === 0 && preferredSlots.length === 0 && !(Array.isArray(campfires?.fires) && campfires.fires.some(f => f && [3,5,10].includes(f.capacity)))) {
      return { success:false, error:'Share link contains no players' };
    }

    return {
      success: true,
      name: name || 'Shared Roster',
      playerCount: players.length,
      groupCount: numGroups,
      data: { name: name || 'Shared Roster', campfires, gameVersion, raid, players, bench, unplaced, preferredSlots, preserveGroupOrder, notes, assignments, backups, playerConstraints, drummers, eventStartTime },
    };
  },

  // What does this link hold? Answers without loading it, so the user can be
  // asked before their current layout is replaced.
  previewShareString(str) {
    const parts = String(str || '').trim().split(':');
    if (parts[0] !== 'PP') return { success:false, error:'Not a Party Planner share link' };
    if (parts[1] !== '2') return { success:false, error:'Unknown share version: ' + parts[1] };
    const parsed = this._parseShareString(parts);
    if (!parsed.success) return parsed;
    return { success:true, name:parsed.name, playerCount:parsed.playerCount };
  },

  _importShareString(parts) {
    const parsed = this._parseShareString(parts);
    if (!parsed.success) return parsed;
    this.loadRoster(parsed.data);
    return { success:true, playerCount:parsed.playerCount, groupCount:parsed.groupCount, name:State.rosterName };
  },

  importAddonString(str) {
    // Reverse lookup maps
    const ccRev = {}; for (const [k,v] of Object.entries(this.classCode)) ccRev[v] = k;
    const scRev = {}; for (const [k,v] of Object.entries(this.specCode)) scRev[v] = k;
    const rcRev = {}; for (const [k,v] of Object.entries(this.roleCode)) rcRev[v] = k;

    const parts = String(str || '').trim().split(':');
    if (parts[0] !== 'PP') return { success:false, error:'Not a Party Planner export string' };
    const version = parts[1];
    if (version === '2') return this._importShareString(parts);
    if (version !== '1') return { success:false, error:'Unknown export version: ' + version };
    const raid = parts[2];
    if (!Config.Raids[raid]) return { success:false, error:'Unknown raid: ' + raid };

    // A PP:1 string holds only the seated groups, so nothing of the open plan
    // (bench, notes, assignments, backups, overrides) may carry over into it.
    PlanStore.startFresh();
    State.gameVersion = versionForRaid(raid);
    State.selectedRaid = raid;
    State.campfires = Campfires.empty();
    State.preferredSlots = [];
    State.preserveGroupOrder = false;
    const raidInfo = Config.Raids[raid];
    const numGroups = raidInfo.groups;
    const roster = [];
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);

    for (let gi = 0; gi < numGroups && (gi + 3) < parts.length; gi++) {
      const groupStr = parts[gi + 3];
      if (!groupStr) continue;
      const playerStrs = groupStr.split(',');
      for (const ps of playerStrs) {
        const [name, cCode, sCode, rCode] = ps.split('.');
        if (!name) continue;
        const player = {
          uid: nextUid(),
          name,
          class: ccRev[cCode] || cCode,
          spec: scRev[sCode] || sCode,
          role: rcRev[rCode] || rCode,
          groupNumber: gi + 1,
          imported: true,
        };
        if (!PlayerIdentity.isValid(player)) continue;
        roster.push(player);
        groups[gi].push(player);
      }
    }

    State.roster = roster;
    State.groups = groups;
    State.unplaced = [];
    State.sourceEventId = null;
    return { success:true, playerCount:roster.length, groupCount:numGroups };
  },

  exportRoster(name) {
    return {
      name: name || State.rosterName || 'Unnamed',
      campfires: JSON.parse(JSON.stringify(State.campfires)),
      gameVersion: State.gameVersion,
      raid: State.selectedRaid,
      timestamp: Date.now(),
      sourceEventId: State.sourceEventId || null,
      eventStartTime: State.eventStartTime || null,
      preferredSlots: State.preferredSlots.map(p => ({...p})),
      preserveGroupOrder: State.preserveGroupOrder,
      notes: State.notes || '',
      assignments: Assignments.serialize(),
      backups: Backups.serialize(),
      playerConstraints: Constraints.clean(State.playerConstraints),
      drummers: Drummers.clean(State.drummers),
      players: State.roster.map(p => ({
        name:p.name, class:p.class, spec:p.spec, role:p.role, groupNumber:p.groupNumber,
        ...(p.signupStatus ? { signupStatus:p.signupStatus } : {}),
      })),
      bench: (State.bench || []).map(p => ({
        name:p.name, class:p.class, spec:p.spec, role:p.role, groupNumber:0,
        ...(p.signupStatus ? { signupStatus:p.signupStatus } : {}),
      })),
      unplaced: (State.unplaced || []).map(p => ({
        name:p.name, class:p.class, spec:p.spec, role:p.role, signupStatus:p.signupStatus,
      })),
    };
  },

  loadRoster(data) {
    if (!data || !Array.isArray(data.players)) return false;
    const version = data.gameVersion || versionForRaid(data.raid) || 'tbc';
    const raid = data.raid || GameVersions[version]?.defaultRaid;
    if (!validVersionRaid(version, raid)) return false;
    State.gameVersion = version;
    State.selectedRaid = raid;
    State.buffOverrides = {};
    State.planId = null;
    if (data.raid) State.selectedRaid = data.raid;
    State.preferredSlots = PreferredSlots.clean(data.preferredSlots);
    State.preserveGroupOrder = data.preserveGroupOrder === true || PreferredSlots.hasManual();

    const raidInfo = Config.Raids[State.selectedRaid];
    const numGroups = raidInfo ? raidInfo.groups : 5;

    const roster = [];
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);

    // A player whose group does not exist in this raid (a saved roster for a
    // bigger raid, a damaged number) waits on the bench rather than being
    // counted this session and dropped on the next reload.
    const misplaced = [];
    for (const p of PlayerIdentity.cleanList(data.players)) {
      const player = { uid: p.uid || nextUid(), name:p.name, class:p.class, spec:p.spec, role:p.role, groupNumber:p.groupNumber, imported:true };
      if (SignupStatus.clean(p.signupStatus)) player.signupStatus = p.signupStatus;
      const g = player.groupNumber;
      if (Number.isInteger(g) && g >= 1 && g <= numGroups) { roster.push(player); groups[g-1].push(player); }
      else { player.groupNumber = 0; misplaced.push(player); }
    }
    State.bench = PlayerIdentity.cleanList(data.bench).map(p => ({
      uid: p.uid || nextUid(), name:p.name, class:p.class, spec:p.spec, role:p.role,
      groupNumber: 0, imported: true,
      ...(SignupStatus.clean(p.signupStatus) ? { signupStatus:p.signupStatus } : {}),
    })).concat(misplaced);
    State.unplaced = SignupStatus.cleanUnplaced(data.unplaced);
    State.roster = roster;
    State.groups = groups;
    State.campfires = Campfires.clean(data.campfires);
    State.rosterName = data.name || 'Loaded Roster';
    State.sourceEventId = data.sourceEventId || null;
    State.eventStartTime = PlanStore.cleanEventStart(data.eventStartTime);
    State.notes = typeof data.notes === 'string' ? data.notes.slice(0, NOTES_MAX_LENGTH) : '';
    Assignments.restore(data.assignments);
    Backups.restore(data.backups);
    State.playerConstraints = Constraints.clean(data.playerConstraints);
    State.drummers = Drummers.clean(data.drummers);
    return true;
  },

  // ── PLAIN-TEXT ROSTER IMPORT (feature-backlog-2.md #6) ───────────
  // Fallback for pastes that are not JSON, a PP: string or a Raid-Helper
  // URL (see normalizeImportSource/importFromText past the UI split
  // marker). Tolerant of one-player-per-line lists in either name/class/
  // spec order, comma-separated CSV with an optional header row, Discord-
  // style "@Name (Spec Class)", and a WoW /who-style "Name Level 60 Race
  // Class" line (no spec at all — defaulted and flagged for review).
  // Pure: takes an explicit `version` so a preview can be built before
  // anything touches State. Returns
  //   { entries: [{name,class,spec,role,status,reason}], unparsed:[rawLine], hasHeader }
  // status is 'ok' or 'needsReview' — nothing is ever rejected outright,
  // per the backlog note ("Classic: ...just flag").
  parsePlainRoster(text, version) {
    const ruleset = (typeof Rulesets !== 'undefined' && Rulesets[version]) || Rulesets.tbc;
    const specsTable = ruleset.specs || Config.Specs;
    const factionLocked = !!(ruleset.rules && ruleset.rules.factionLock);
    const classNames = Object.keys(specsTable);

    const classAlias = {};
    for (const c of classNames) classAlias[c.toLowerCase()] = c;
    // A few shorthands raid leaders actually type; only applied when the
    // full class name they abbreviate exists in this ruleset's spec table.
    const CLASS_SHORTHAND = { warr:'WARRIOR', pally:'PALADIN', pal:'PALADIN', hunt:'HUNTER', lock:'WARLOCK', warlok:'WARLOCK', sham:'SHAMAN', shammy:'SHAMAN' };
    for (const [k, v] of Object.entries(CLASS_SHORTHAND)) if (classAlias[v.toLowerCase()]) classAlias[k] = v;

    const specAlias = {}; // lowercase spec name -> [{class, spec, role}] (some names, e.g. "Holy", span classes)
    for (const c of classNames) {
      for (const key of Object.keys(specsTable[c])) {
        const sp = specsTable[c][key];
        const low = sp.name.toLowerCase();
        (specAlias[low] = specAlias[low] || []).push({ class:c, spec:sp.name, role:sp.role });
      }
    }

    const RACE_WORDS = new Set(['human','dwarf','nightelf','night','elf','gnome','draenei','orc','troll','tauren','undead','forsaken','bloodelf','blood']);
    const FILLER_WORDS = new Set(['level','lvl','lv','the','of']);
    const ROLE_WORDS = new Set(['tank','healer','melee_dps','ranged_dps','caster_dps','dps','melee','ranged','heals','healing']);

    const stripEmoji = (s) => (s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '');
    const cleanName = (s) => (s || '').replace(/^[@*\-\s]+/, '').replace(/[,:;\s]+$/, '').trim();
    const resolveClass = (tok) => classAlias[(tok || '').toLowerCase()] || null;

    // Look for a class name anywhere in the tokens, then a spec name
    // (checking 2-word phrases like "Beast Mastery" before single words),
    // preferring whichever spec option belongs to the class already found.
    // Order-independent, so "Fury Warrior" and "Warrior Fury" both resolve.
    const findClassAndSpec = (tokens) => {
      let foundClass = null;
      for (const t of tokens) { const c = resolveClass(t); if (c) { foundClass = c; break; } }
      let foundSpec = null, foundRole = null;
      for (let w = 2; w >= 1 && !foundSpec; w--) {
        for (let i = 0; i + w <= tokens.length; i++) {
          const phrase = tokens.slice(i, i + w).join(' ').toLowerCase();
          const opts = specAlias[phrase];
          if (!opts) continue;
          const match = foundClass ? opts.find(o => o.class === foundClass) : opts[0];
          if (match) { foundSpec = match.spec; foundRole = match.role; foundClass = foundClass || match.class; break; }
        }
      }
      return { class: foundClass, spec: foundSpec, role: foundRole };
    };

    const entries = [];
    const unparsed = [];
    const seenNames = new Set();
    let hasHeader = false;

    const addEntry = (name, cls, spec, role, reason) => {
      if (!name || !cls) return false;
      let status = 'ok', finalReason = reason || null;
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        status = 'needsReview';
        finalReason = finalReason ? finalReason + '; duplicate name in this paste' : 'Duplicate name in this paste';
      } else {
        seenNames.add(key);
      }
      if (!spec) {
        const def = Object.values(specsTable[cls])[0];
        spec = def.name; role = role || def.role;
        status = 'needsReview';
        finalReason = finalReason || ('Spec not specified — defaulted to ' + def.name);
      }
      entries.push({ name, class:cls, spec, role: role || 'melee_dps', status, reason: finalReason });
      return true;
    };

    const lines = stripEmoji(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    for (const rawLine of lines) {
      const line = rawLine.replace(/[|•·]+/g, ' ').trim();
      if (!line) continue;

      // CSV row: "Name,Class,Spec[,Role]" (optional header row, first line only).
      if (line.includes(',')) {
        const fields = line.split(',').map(f => f.trim());
        if (!entries.length && !unparsed.length && !hasHeader && /^name$/i.test(fields[0])) { hasHeader = true; continue; }
        const name = cleanName(fields[0]);
        const cls = resolveClass(fields[1]);
        if (!name || !cls) { unparsed.push(rawLine); continue; }
        let spec = null, role = null, reason = null;
        if (fields[2]) {
          const opts = specAlias[fields[2].toLowerCase()];
          const match = opts && opts.find(o => o.class === cls);
          if (match) { spec = match.spec; role = match.role; }
          else reason = `Unrecognized spec "${fields[2]}" for ${cls}`;
        }
        if (fields[3]) {
          const rl = fields[3].toLowerCase().replace(/\s+/g, '_');
          if (['tank','healer','melee_dps','ranged_dps','caster_dps'].includes(rl)) role = rl;
        }
        addEntry(name, cls, spec, role, reason);
        continue;
      }

      // Discord-style: "@Name (Spec Class)" or "@Name (Class Spec)".
      const discordMatch = line.match(/^@?([^()]+?)\s*\(([^)]+)\)/);
      if (discordMatch) {
        const name = cleanName(discordMatch[1]);
        const inner = discordMatch[2].replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
        const { class:cls, spec, role } = findClassAndSpec(inner);
        if (!name || !cls) { unparsed.push(rawLine); continue; }
        addEntry(name, cls, spec, role);
        continue;
      }

      // Dash-separated: "Name - Spec Class" or "Name - Class Spec".
      const dashMatch = line.match(/^(.+?)\s+-\s+(.+)$/);
      if (dashMatch) {
        const name = cleanName(dashMatch[1]);
        const rest = dashMatch[2].replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
        const { class:cls, spec, role } = findClassAndSpec(rest);
        if (!name || !cls) { unparsed.push(rawLine); continue; }
        addEntry(name, cls, spec, role);
        continue;
      }

      // Space-separated: "Name Class Spec", "Name Spec Class", or a WoW
      // /who-style "Name Level 60 Race Class" line (class only — the
      // race/level/filler words are stripped before searching for a spec).
      const tokens = line.replace(/[^\w\s@'-]/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (tokens.length < 2) { unparsed.push(rawLine); continue; }
      const name = cleanName(tokens[0]);
      const rest = tokens.slice(1).filter(t => !RACE_WORDS.has(t.toLowerCase()) && !FILLER_WORDS.has(t.toLowerCase()) && !ROLE_WORDS.has(t.toLowerCase()) && !/^\d+$/.test(t));
      const { class:cls, spec, role } = findClassAndSpec(rest);
      if (!name || !cls) { unparsed.push(rawLine); continue; }
      addEntry(name, cls, spec, role);
    }

    // Faction-lock flag pass (Classic-style rulesets): never reject, just
    // flag when a paste can't possibly belong to one faction as a whole.
    if (factionLocked) {
      const hasShaman = entries.some(e => e.class === 'SHAMAN');
      const hasPaladin = entries.some(e => e.class === 'PALADIN');
      if (hasShaman && hasPaladin) {
        for (const e of entries) {
          if (e.class !== 'SHAMAN' && e.class !== 'PALADIN') continue;
          e.status = 'needsReview';
          e.reason = (e.reason ? e.reason + '; ' : '') + 'Faction lock: Shaman is Horde-only and Paladin is Alliance-only in this ruleset, and this paste has both';
        }
      }
    }

    return { entries, unparsed, hasHeader };
  },

  // Commits parsePlainRoster()'s entries into State the same way a Raid-
  // Helper sign-ups export does: seed round-robin groups sized to the
  // active raid, then let the Optimizer place everyone (see
  // _importRaidHelperSignUps, the format-2 sibling of this path).
  importPlainRoster(entries) {
    if (!Array.isArray(entries) || !entries.length) return { success:false, error:'No players to import' };
    const roster = entries.map(e => ({
      uid: nextUid(), name:e.name, class:e.class, spec:e.spec, role:e.role, imported:true,
    }));

    const raiders = roster.length;
    if (State.gameVersion === 'tbc' && raiders <= 10) {
      for (const key of Config.RaidOrder) { if (Config.Raids[key].size === 10) { State.selectedRaid = key; break; } }
    } else if (State.gameVersion === 'classic' && raiders <= 20) {
      for (const key of Config.RaidOrder) { if (Config.Raids[key].size === 20) { State.selectedRaid = key; break; } }
    }

    const raidInfo = Config.Raids[State.selectedRaid];
    const numGroups = raidInfo ? raidInfo.groups : 5;
    const groups = [];
    for (let i = 0; i < numGroups; i++) groups.push([]);
    roster.forEach((p, i) => { const gi = i % numGroups; p.groupNumber = gi + 1; groups[gi].push(p); });

    State.roster = roster;
    State.groups = groups;
    State.bench = [];
    State.unplaced = [];
    Optimizer.optimize();

    return { success:true, playerCount:State.roster.length, groupCount:numGroups, wasUnassigned:true,
             benchCount:State.bench.length, overflowCount:State.bench.length };
  },
};

