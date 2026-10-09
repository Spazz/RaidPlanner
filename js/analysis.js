// ── BUFF CALCULATOR ─────────────────────────────────────────────
// The buffs a group displays are the buffs the optimizer scores: both come from
// Optimizer.resolveBuffSources valued by Optimizer.buffValueFn, so the badges,
// the "why here" explanations and groupScore() can never disagree (two shamans
// give two different totems, not the same one twice). Only the manual totem/aura
// overrides are display state the scorer never sees.
//
// A totem worth nothing to anyone in the group is credited by no one, so it is
// not shown either (a lone shaman with nobody to buff shows no totem).
function getGroupBuffs(players, groupIndex, groups = State.groups, mode = State.optimizerMode) {
  if (!GameVersions[State.gameVersion].modeled) return [];

  // Determine dominant role
  const roleCounts = {};
  for (const p of players) roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
  let dominantRole = 'melee_dps', maxCount = 0;
  for (const [role, count] of Object.entries(roleCounts)) {
    if (count > maxCount) { maxCount = count; dominantRole = role; }
  }

  const priorityOf = (id) => getBuffPriority(Config.Buffs[id], dominantRole);
  const value = Optimizer.buffValueFn(players, groupIndex, groups, mode);
  const overrideFor = groupIndex === undefined ? null : (player, slot) => {
    const ov = State.buffOverrides[`${groupIndex}:${player.uid}:${slot}`];
    return ov && Config.Buffs[ov.buffId] ? ov.buffId : undefined;
  };
  const overridden = new Set();
  const sources = Optimizer.resolveBuffSources(players, value, { overrideFor, overridden, preferSpecAura: true });

  // The scorer credits a Restoration shaman with both Mana Spring and Mana Tide,
  // but the badge row shows one water totem per shaman: the cooldown replaces
  // the standing totem it is dropped over.
  const rules = activeRules();
  for (const [id, player] of sources) {
    if (!COOLDOWN_TOTEMS.has(id)) continue;
    for (const [other, otherPlayer] of sources) {
      if (otherPlayer === player && other !== id && rules.totemElements[other] === rules.totemElements[id]) sources.delete(other);
    }
  }

  const buffList = [];
  for (const [id, player] of sources) {
    buffList.push({ id, buff: Config.Buffs[id], sourceUid: player.uid, sourceName: player.name, sourceClass: player.class, sourceSpec: player.spec, isOverride: overridden.has(id) });
  }
  buffList.sort((a, b) => priorityOf(b.id) - priorityOf(a.id));
  return buffList;
}

// ── RAID COVERAGE + MISSING-BUFF INSIGHTS ──────────────────────
// Debuffs aren't part of getGroupBuffs (they're applied to the enemy, not the
// raid) — a class/spec anywhere in an assigned group is enough to "cover" one.
function getRaidDebuffCoverage(groups) {
  const players = groups.flat();
  const covered = new Set();
  for (const id of Object.keys(Config.Debuffs)) {
    const d = Config.Debuffs[id];
    const has = players.some(p => p.class === d.sourceClass && (!d.sourceSpec || p.spec === d.sourceSpec));
    if (has) covered.add(id);
  }
  return covered;
}

// TBC-only Drums coverage (feature-backlog-3 #5). Kept as its own aggregate
// rather than a Config.Buffs entry — Drums are tagged per-player independent
// of class/spec (any player can carry Leatherworking), which doesn't fit
// getGroupBuffs'/DPS_VALUE's sourceClass-driven model without disturbing
// optimizer scoring for every other buff. `covered`/`total` count only
// non-empty groups, so a still-filling roster's untouched groups don't read
// as "missing" coverage. Callers gate on State.gameVersion === 'tbc'.
function getDrumsCoverage(groups) {
  const nonEmpty = (groups || []).filter(g => (g || []).length > 0);
  const covered = nonEmpty.filter(g => g.some(p => Drummers.isDrummer(p.name))).length;
  return { covered, total: nonEmpty.length };
}

function getRaidBuffCoverage(groups) {
  const covered = new Set();
  groups.forEach((g, gi) => getGroupBuffs(g, gi, groups).forEach(b => covered.add(b.id)));
  return covered;
}

function canProvideBuff(entry, player) {
  if (!entry || !player) return false;
  if (player.class !== entry.sourceClass) return false;
  if (entry.sourceSpec && player.spec !== entry.sourceSpec) return false;
  return true;
}

// The totem element or 'aura' a buff occupies, or null for passives.
function buffSlotCategory(buffId) {
  const rules = activeRules();
  if (rules.totemElements[buffId]) return rules.totemElements[buffId];
  if (rules.paladinAuras[buffId]) return 'aura';
  return null;
}

// For every buff and debuff the raid is NOT getting, say what would fix it:
//   { kind:'switch', player, groupIdx, currentBuffId } — a seated shaman/paladin
//       can give it by running a different totem/aura (one click, no roster change)
//   { kind:'bench',  player }                          — someone on the bench provides it
//   { kind:'none' }                                    — nobody in the roster can
// Keyed by buff/debuff id. Covered entries are absent.
function getMissingBuffInsights() {
  const groups = State.groups || [];
  const bench = State.bench || [];
  const coveredBuffs = getRaidBuffCoverage(groups);
  const coveredDebuffs = getRaidDebuffCoverage(groups);
  const insights = {};

  const consider = (id, entry, covered, isBuff) => {
    if (covered.has(id)) return;
    const category = isBuff ? buffSlotCategory(id) : null;
    if (category) {
      for (let gi = 0; gi < groups.length; gi++) {
        const provider = groups[gi].find(p => canProvideBuff(entry, p));
        if (!provider) continue;
        const current = getGroupBuffs(groups[gi], gi)
          .find(b => b.sourceUid === provider.uid && buffSlotCategory(b.id) === category);
        insights[id] = { kind:'switch', player:provider, groupIdx:gi, currentBuffId: current ? current.id : null };
        return;
      }
    }
    const benched = bench.find(p => canProvideBuff(entry, p));
    if (benched) { insights[id] = { kind:'bench', player:benched }; return; }
    insights[id] = { kind:'none' };
  };

  for (const [id, entry] of Object.entries(factionRelevantBuffs())) consider(id, entry, coveredBuffs, true);
  for (const [id, entry] of Object.entries(Config.Debuffs)) consider(id, entry, coveredDebuffs, false);
  return insights;
}

// ── UTILITY & BALANCE READINESS (backlog #2, #3) ────────────────
// Two pure, DOM-free checks over State that extend the tank/healer floor
// check already in renderReadiness(): a class-presence checklist for one-off
// utility abilities (Config.Utilities — Battle Rez, cleanses, Bloodlust,
// etc.), and soft composition warnings (melee/ranged skew, class stacking,
// healer ratio). Both read State ambiently, same convention as
// getMissingBuffInsights() above, so tests can drive them by setting
// State.groups/State.bench directly.
const Readiness = {
  // provider.spec of null/undefined means "any spec of that class".
  _providerMatches(provider, player) {
    if (!player || !provider || player.class !== provider.class) return false;
    if (provider.spec && player.spec !== provider.spec) return false;
    return true;
  },

  // Drops providers a faction-locked ruleset's current roster could never
  // field (Shaman for a detected Alliance roster, Paladin for Horde) before
  // counting — mirrors factionRelevantBuffs()'s reasoning so a structurally
  // impossible provider never shows up as a permanent, unfixable warning.
  _factionFilteredProviders(providers) {
    const rules = activeRules();
    if (!rules.rules || !rules.rules.factionLock) return providers;
    const faction = Faction.current();
    if (faction !== 'horde' && faction !== 'alliance') return providers;
    return providers.filter(p =>
      !(faction === 'alliance' && p.class === 'SHAMAN') &&
      !(faction === 'horde' && p.class === 'PALADIN'));
  },

  // [{id, name, desc, covered, seatedCount, seatedProviders, benchCount, benchProviders}]
  // A utility whose every provider was faction-filtered away is left out
  // entirely rather than shown as an unfixable "0 providers" warning.
  // groups/bench default to the live State; the Ideal Comp view passes its
  // own static groups (and no bench) instead.
  utilityCoverage(groups = State.groups, benchList = State.bench) {
    const table = Config.Utilities || {};
    const seated = (groups || []).flat();
    const bench = benchList || [];
    const out = [];
    for (const [id, entry] of Object.entries(table)) {
      const providers = this._factionFilteredProviders(entry.providers || []);
      if (!providers.length) continue;
      const matches = (p) => providers.some(prov => this._providerMatches(prov, p));
      const seatedProviders = seated.filter(matches);
      const benchProviders = bench.filter(matches);
      out.push({
        id, name: entry.name, desc: entry.desc || '',
        seatedCount: seatedProviders.length, seatedProviders,
        benchCount: benchProviders.length, benchProviders,
        covered: seatedProviders.length > 0,
      });
    }
    return out;
  },

  // Tunable thresholds, kept together rather than as magic numbers below —
  // raid-leader convention, not a game rule (see feature-backlog.md #2).
  BALANCE_THRESHOLDS: {
    meleeSkewPct: 0.70,     // one melee/ranged+caster side at/above this share of DPS+tanks warns
    classStackPct: 0.35,    // one class at/above this share of the seated raid warns
    healerRatioSlack: 1.8,  // healers beyond floor * this warns "more than the raid needs"
    minRosterForSkew: 8,    // skip skew/stacking noise on tiny/partial rosters
  },

  // [{id, text}] — short, soft warnings; informational only, never blocks anything.
  balanceWarnings() {
    const T = this.BALANCE_THRESHOLDS;
    const seated = (State.groups || []).flat();
    const out = [];
    // Constraint violations (backlog #3) are reported at any roster size —
    // recomputed live every render, not just right after Optimize, so a
    // manual drag that breaks one is caught too. Kept ahead of the
    // minRosterForSkew gate below, which only applies to the soft skew/
    // stacking heuristics.
    for (const v of Constraints.violations(State.groups || [])) {
      out.push({ id: 'CONSTRAINT_' + v.type.toUpperCase() + '_' + v.a + '_' + v.b, text: v.text });
    }
    // TBC Drums coverage (feature-backlog-3 #5) — same "any roster size,
    // informational only" treatment as constraints above. Only shown once at
    // least one drummer is tagged (nothing to report otherwise), and only
    // while coverage is incomplete — a fully-covered raid needs no nudge.
    if (State.gameVersion === 'tbc' && (State.drummers || []).length) {
      const drumCoverage = getDrumsCoverage(State.groups || []);
      if (drumCoverage.total > 0 && drumCoverage.covered < drumCoverage.total) {
        out.push({ id: 'DRUMS_COVERAGE', text: `Drums: ${drumCoverage.covered} of ${drumCoverage.total} groups covered; spread drummers one per party first` });
      }
    }
    if (seated.length < T.minRosterForSkew) return out;

    const meleeSide = seated.filter(p => p.role === 'tank' || p.role === 'melee_dps').length;
    const rangedSide = seated.filter(p => p.role === 'ranged_dps' || p.role === 'caster_dps').length;
    const sideTotal = meleeSide + rangedSide;
    if (sideTotal > 0) {
      const meleePct = meleeSide / sideTotal;
      if (meleePct >= T.meleeSkewPct) {
        out.push({ id:'SKEW_MELEE', text:`${Math.round(meleePct * 100)}% melee/tank vs ${Math.round((1 - meleePct) * 100)}% ranged/caster` });
      } else if ((1 - meleePct) >= T.meleeSkewPct) {
        out.push({ id:'SKEW_RANGED', text:`${Math.round((1 - meleePct) * 100)}% ranged/caster vs ${Math.round(meleePct * 100)}% melee/tank` });
      }
    }

    const byClass = {};
    for (const p of seated) byClass[p.class] = (byClass[p.class] || 0) + 1;
    for (const [cls, count] of Object.entries(byClass)) {
      if (count / seated.length >= T.classStackPct) {
        const label = cls.charAt(0) + cls.slice(1).toLowerCase();
        out.push({ id:'STACK_' + cls, text:`${count} ${label}s — ${Math.round(count / seated.length * 100)}% of the raid` });
      }
    }

    const size = Config.Raids[State.selectedRaid]?.size || seated.length || 25;
    const floors = Optimizer.floorsFor(size);
    const healers = seated.filter(p => p.role === 'healer').length;
    const softMax = Math.ceil(floors.healer * T.healerRatioSlack);
    if (floors.healer > 0 && healers > softMax) {
      out.push({ id:'HEALER_SURPLUS', text:`${healers} healers seated, raid floor is ${floors.healer} — consider a DPS swap` });
    }

    return out;
  },
};

// ── PLACEMENT EXPLANATION (backlog #4: "Why is this player here?") ──
// Pure function: re-derives WHY a seated player is in THIS specific group
// from the same data the optimizer's own scoring reads — getGroupBuffs() for
// what the group actually resolves, DPS_VALUE/MIT_VALUE (via dpsValueFor/
// mitValueFor) for what's worth anything to this player, and
// Optimizer.groupScore() itself for the "vs their best alternative"
// comparison — rather than tracking a parallel reason log during
// optimization. Read-only; never mutates State. `allGroups`/`mode` are
// optional context for the alternative-group comparison; omit them (or pass
// a `group` that isn't a member of `allGroups`) to get just the buff/
// convention/constraint reasons.
function explainPlacement(player, group, groupIndex, allGroups, mode) {
  const reasons = [];
  if (!player || !Array.isArray(group)) return reasons;
  const nick = (n) => String(n || '').split('-')[0];

  const buffList = GameVersions[State.gameVersion].modeled ? getGroupBuffs(group, groupIndex, allGroups || State.groups, mode || State.optimizerMode) : [];
  const rules = activeRules();

  // What this player personally provides to the group.
  for (const b of buffList) {
    if (b.sourceUid !== player.uid) continue;
    const recipients = group.filter(p => p.uid !== player.uid && (b.buff.benefitsRoles || []).includes(p.role));
    reasons.push({ kind:'provides', text: recipients.length
      ? `Provides ${b.buff.name} to ${recipients.length} other group member${recipients.length === 1 ? '' : 's'}`
      : `Provides ${b.buff.name}` });
  }

  // What this player receives from OTHER members — only buffs that actually
  // carry nonzero value for this player's class/spec/role, so a Feral druid
  // doesn't get credited with "receiving" Windfury (0 value, no imbues in form).
  for (const b of buffList) {
    if (b.sourceUid === player.uid) continue;
    const value = (player.role === 'tank' ? mitValueFor(b.id, player) : 0) + dpsValueFor(b.id, player);
    if (value > 0) reasons.push({ kind:'receives', text:`Receives ${b.buff.name} from ${nick(b.sourceName)}` });
  }

  // Structural conventions (reference-comp rules — see tasks/lessons.md).
  const counts = {};
  for (const p of group) counts[p.role] = (counts[p.role] || 0) + 1;
  let identity = 'melee_dps', bestN = 0;
  for (const [r, n] of Object.entries(counts)) if (n > bestN) { bestN = n; identity = r; }
  const looksLikeTankGroup = counts.tank > 0 && counts.healer > 0;

  if (rules.rules && rules.rules.meleeWantsWindfury && player.class === 'SHAMAN' && identity === 'melee_dps') {
    reasons.push({ kind:'convention', text:'Keeps Windfury coverage in this melee group' });
  }
  if (player.role === 'healer' && looksLikeTankGroup) {
    reasons.push({ kind:'convention', text:'Healing is cross-group, so healers ride with the tank group by convention' });
  }
  if (player.role === 'tank' && looksLikeTankGroup && identity !== 'melee_dps' && identity !== 'caster_dps') {
    reasons.push({ kind:'convention', text:'Seeded as this raid’s anchor tank alongside the healers' });
  }

  // Locks and constraints.
  if (player.locked) reasons.push({ kind:'lock', text:'Locked here by your comp template — unlock to let Optimize move them' });
  for (const c of Constraints.forPlayer(player.name)) {
    const otherName = Constraints.otherName(c, player.name);
    const otherHere = group.some(p => p !== player && (p.name || '').toLowerCase() === otherName.toLowerCase());
    if (c.type === 'together' && otherHere) reasons.push({ kind:'constraint', text:`Kept with ${nick(otherName)} per your Keep-Together constraint` });
    else if (c.type === 'apart' && !otherHere) reasons.push({ kind:'constraint', text:`Kept apart from ${nick(otherName)} per your Keep-Apart constraint` });
  }
  const preferred = (State.preferredSlots || []).find(p => p.group === groupIndex && p.class === player.class && p.spec === player.spec);
  if (preferred) reasons.push({ kind:'preference', text:'Fills a preferred slot requested for this group' });

  // Best-alternative comparison — only meaningful when the whole board (and
  // the mode it was scored under) is known, i.e. `group` really is one of
  // `allGroups`' own arrays. Silently skipped otherwise rather than guessing.
  if (Array.isArray(allGroups) && allGroups[groupIndex] === group && GameVersions[State.gameVersion].modeled && !Optimizer.isPinned(player, groupIndex, allGroups)) {
    const usedMode = mode || State.optimizerMode || 'max_dps';
    const without = group.filter(p => p !== player);
    const hereGain = Optimizer.groupScore(group, groupIndex, allGroups, usedMode) - Optimizer.groupScore(without, groupIndex, allGroups, usedMode);
    // Same 0.5 swap-significance margin refineSwaps() itself requires before
    // taking a swap, so this doesn't nag about noise-level score deltas.
    let bestGi = -1, bestGain = hereGain + 0.5;
    for (let gi = 0; gi < allGroups.length; gi++) {
      if (gi === groupIndex || allGroups[gi].length >= 5) continue;
      const there = allGroups[gi].concat([player]);
      const thereGain = Optimizer.groupScore(there, gi, allGroups, usedMode) - Optimizer.groupScore(allGroups[gi], gi, allGroups, usedMode);
      if (thereGain > bestGain) { bestGain = thereGain; bestGi = gi; }
    }
    reasons.push(bestGi < 0
      ? { kind:'score', text:'This is their best-scoring group among the current groups' }
      : { kind:'score', text:`Group ${bestGi + 1} would score slightly higher for them, but locks or constraints keep them here` });
  }

  return reasons;
}

// ── ROSTER EDITING ─────────────────────────────────
// Manual edits to the plan: change a player's class/spec, add a player to a group,
// bench a player, bring one back, or delete a benched player for good.
//
// Two invariants hold after every operation here:
//   - State.roster is exactly the assigned players (State.groups flattened). The bench
//     is deliberately NOT part of it, because Optimizer.optimize() overwrites roster
//     with groups.flat() and would otherwise erase the bench on every optimize run.
//   - A player's role is always derived from their spec, never set by hand, so the
//     optimizer can never score a player against a role their spec doesn't have.
const RosterEdit = {
  MAX_GROUP_SIZE: 5,

  MovePlayer(uid, groupIdx, swapUid) {
    const found = this.FindPlayer(uid);
    const group = State.groups[groupIdx];
    if (!found || !group || found.groupIdx === groupIdx) return {success:false,error:'Choose another group'};
    const swapIndex = swapUid ? group.findIndex(p => p.uid === swapUid) : -1;
    if (group.length >= 5 && swapIndex < 0) return {success:false,error:'Group is full; choose a player to swap with'};
    const origin = found.benched ? State.bench : State.groups[found.groupIdx];
    if (swapIndex >= 0) {
      const other = group[swapIndex];
      origin[found.slot] = other;
      other.groupNumber = found.benched ? 0 : found.groupIdx + 1;
      group[swapIndex] = found.player;
      this.ClearOverridesForUid(other.uid);
    } else {
      origin.splice(found.slot, 1);
      group.push(found.player);
    }
    found.player.groupNumber = groupIdx + 1;
    this.ClearOverridesForUid(uid);
    this.syncRoster();
    return {success:true};
  },

  // Display order for the class dropdown.
  get ClassList() { return activeRules().classList || Rulesets.tbc.classList; },

  ClassLabel(classFile) {
    if (!classFile) return '';
    return classFile.charAt(0) + classFile.slice(1).toLowerCase();
  },

  // [{ name, role }] for a class, in Config.Specs order.
  SpecsForClass(classFile) {
    const specs = Config.Specs[classFile];
    if (!specs) return [];
    return Object.keys(specs)
      .sort((a,b) => Number(a) - Number(b))
      .map(k => ({ name: specs[k].name, role: specs[k].role }));
  },

  RoleForSpec(classFile, specName) {
    const specs = Config.Specs[classFile];
    if (!specs) return null;
    for (const k of Object.keys(specs)) {
      if (specs[k].name === specName) return specs[k].role;
    }
    return null;
  },

  // State.roster mirrors the group assignments; the bench is tracked separately.
  syncRoster() {
    State.roster = (State.groups || []).flat();
    return State.roster;
  },

  FindPlayer(uid) {
    if (!uid) return null;
    for (let gi = 0; gi < (State.groups || []).length; gi++) {
      const slot = (State.groups[gi] || []).findIndex(p => p.uid === uid);
      if (slot !== -1) return { player: State.groups[gi][slot], groupIdx: gi, slot, benched: false };
    }
    const bi = (State.bench || []).findIndex(p => p.uid === uid);
    if (bi !== -1) return { player: State.bench[bi], groupIdx: null, slot: bi, benched: true };
    return null;
  },

  // A buff override is keyed "groupIdx:playerName:element|aura". Changing a player's
  // spec or class can invalidate the totem/aura they were overridden to provide, so
  // drop their overrides rather than leave a stale one pointing at a buff they no
  // longer have. Name-keyed, matching the existing override scheme.
  ClearOverridesFor(playerName) {
    if (!playerName || !State.buffOverrides) return 0;
    let cleared = 0;
    for (const key of Object.keys(State.buffOverrides)) {
      const parts = key.split(':');
      if (parts[1] === playerName) { delete State.buffOverrides[key]; cleared++; }
    }
    return cleared;
  },

  // Change name/class/spec on an existing player. Role follows the new spec.
  UpdatePlayer(uid, changes) {
    if (!uid || !changes) return { success:false, error:'Nothing to update' };
    const found = this.FindPlayer(uid);
    if (!found) return { success:false, error:'Player not found' };

    const player = found.player;
    const classFile = changes.class || player.class;
    const specName = changes.spec || player.spec;
    const role = this.RoleForSpec(classFile, specName);
    if (!role) return { success:false, error:'Unknown spec "' + specName + '" for ' + this.ClassLabel(classFile) };

    const name = (changes.name != null ? String(changes.name).trim() : player.name);
    if (!name) return { success:false, error:'Name cannot be empty' };

    const specChanged = (player.class !== classFile) || (player.spec !== specName);
    const oldName = player.name;

    player.name = name;
    player.class = classFile;
    player.spec = specName;
    player.role = role;
    // A leader picking an explicit class/spec here is exactly how a
    // Raid-Helper class-only sign-up's defaulted guess (backlog #2) gets
    // resolved — clear the flag the moment they touch it, same as the
    // plain-text importer's needsReview never survives a manual edit.
    if (specChanged) { delete player.needsReview; delete player.reviewReason; }

    if (specChanged || name !== oldName) this.ClearOverridesFor(oldName);
    // Backups, player constraints and drum tags are name-keyed too; a rename
    // breaks the link on whichever side it was (a spec/class change alone
    // doesn't — same person, same seat).
    if (name !== oldName) { Backups.clearForName(oldName); Constraints.clearForName(oldName); Drummers.clearForName(oldName); }
    this.syncRoster();
    return { success:true, player };
  },

  AddPlayer(groupIdx, spec) {
    if (!spec) return { success:false, error:'No player details given' };
    const groups = State.groups || [];
    if (!(groupIdx >= 0 && groupIdx < groups.length)) return { success:false, error:'Invalid group' };
    if (!groups[groupIdx]) groups[groupIdx] = [];
    if (groups[groupIdx].length >= this.MAX_GROUP_SIZE) return { success:false, error:'Group ' + (groupIdx+1) + ' is full' };

    const name = String(spec.name || '').trim();
    if (!name) return { success:false, error:'Name cannot be empty' };
    const role = this.RoleForSpec(spec.class, spec.spec);
    if (!role) return { success:false, error:'Unknown spec "' + spec.spec + '" for ' + this.ClassLabel(spec.class) };

    const player = {
      uid: nextUid(),
      name,
      class: spec.class,
      spec: spec.spec,
      role,
      groupNumber: groupIdx + 1,
      imported: false,
    };
    groups[groupIdx].push(player);
    this.syncRoster();
    return { success:true, player };
  },

  // Group -> bench. Non-destructive: the player stays in State.bench and can be dragged back.
  BenchPlayer(uid) {
    const found = this.FindPlayer(uid);
    if (!found) return { success:false, error:'Player not found' };
    if (found.benched) return { success:false, error:'Player is already benched' };

    State.groups[found.groupIdx].splice(found.slot, 1);
    found.player.groupNumber = 0;
    if (!State.bench) State.bench = [];
    State.bench.push(found.player);
    this.ClearOverridesFor(found.player.name);
    // No longer seated, so "backup for them" no longer applies.
    Backups.unlink(found.player.name);
    this.syncRoster();
    return { success:true, player: found.player };
  },

  // Bench -> group.
  UnbenchPlayer(uid, groupIdx) {
    const found = this.FindPlayer(uid);
    if (!found) return { success:false, error:'Player not found' };
    if (!found.benched) return { success:false, error:'Player is not benched' };
    const groups = State.groups || [];
    if (!(groupIdx >= 0 && groupIdx < groups.length)) return { success:false, error:'Invalid group' };
    if (!groups[groupIdx]) groups[groupIdx] = [];
    if (groups[groupIdx].length >= this.MAX_GROUP_SIZE) return { success:false, error:'Group ' + (groupIdx+1) + ' is full' };

    State.bench.splice(found.slot, 1);
    found.player.groupNumber = groupIdx + 1;
    groups[groupIdx].push(found.player);
    // They just took their own seat, so they're no longer available as
    // someone else's designated backup.
    Backups.clearBackup(found.player.name);
    this.syncRoster();
    return { success:true, player: found.player };
  },

  // Unplaced sign-up (Absent, or no class) -> group. The leader has confirmed
  // it and, when Raid-Helper sent no class, picked one (`pick`). The person
  // keeps their Raid-Helper status, so their card still reads Absent.
  PlaceUnplaced(uid, groupIdx, pick = {}) {
    const list = State.unplaced || [];
    const i = list.findIndex(p => p.uid === uid);
    if (i < 0) return { success:false, error:'Sign-up not found' };
    const entry = list[i];
    const classFile = pick.class || entry.class;
    const specName = pick.spec || entry.spec;
    const role = classFile && specName ? this.RoleForSpec(classFile, specName) : null;
    if (!role) return { success:false, error:'Pick a class and spec first' };
    const groups = State.groups || [];
    if (!(groupIdx >= 0 && groupIdx < groups.length)) return { success:false, error:'Invalid group' };
    if (groups[groupIdx].length >= this.MAX_GROUP_SIZE) return { success:false, error:'Group ' + (groupIdx+1) + ' is full' };

    list.splice(i, 1);
    const player = { uid: entry.uid, name: entry.name, class: classFile, spec: specName, role,
      groupNumber: groupIdx + 1, imported: true };
    if (entry.signupStatus) player.signupStatus = entry.signupStatus;
    groups[groupIdx].push(player);
    this.syncRoster();
    return { success:true, player };
  },

  // Overrides are keyed "groupIdx:uid:category"; drop every one for a uid.
  ClearOverridesForUid(uid) {
    if (!uid || !State.buffOverrides) return 0;
    let cleared = 0;
    for (const key of Object.keys(State.buffOverrides)) {
      if (key.split(':')[1] === uid) { delete State.buffOverrides[key]; cleared++; }
    }
    return cleared;
  },

  // Make a seated shaman/paladin run a specific totem/aura. Removes the
  // override when the default already produces the buff, so the icon only
  // shows as "overridden" when it really is.
  SwitchBuff(groupIdx, uid, buffId) {
    const buff = Config.Buffs[buffId];
    if (!buff) return { success:false, error:'Unknown buff' };
    const category = buffSlotCategory(buffId);
    if (!category) return { success:false, error:'Only totems and auras can be switched' };
    const groups = State.groups || [];
    const group = groups[groupIdx];
    if (!group) return { success:false, error:'Invalid group' };
    const player = group.find(p => p.uid === uid);
    if (!player) return { success:false, error:'Player not found in that group' };
    if (!canProvideBuff(buff, player)) return { success:false, error:player.name + ' cannot provide ' + buff.name };

    const key = groupIdx + ':' + uid + ':' + category;
    const existing = State.buffOverrides[key];
    delete State.buffOverrides[key];
    const byDefault = getGroupBuffs(group, groupIdx).some(b => b.sourceUid === uid && b.id === buffId);
    if (!byDefault) {
      const currentDefault = getGroupBuffs(group, groupIdx).find(b => b.sourceUid === uid && buffSlotCategory(b.id) === category);
      const original = (existing && existing.originalBuffId) || (currentDefault ? currentDefault.id : buffId);
      State.buffOverrides[key] = { buffId, originalBuffId: original };
    }
    return { success:true, player, buffId };
  },

  // Seat a benched player. With no open seat, the same-role raider whose
  // removal costs the raid the least is benched in exchange. The incoming
  // player lands in whichever open seat adds the most.
  SwapIn(benchUid) {
    const found = this.FindPlayer(benchUid);
    if (!found) return { success:false, error:'Player not found' };
    if (!found.benched) return { success:false, error:'Player is not benched' };
    const incoming = found.player;
    const groups = State.groups || [];
    const mode = State.optimizerMode || 'max_dps';
    const max = this.MAX_GROUP_SIZE;
    let benched = null;

    if (!groups.some(g => g.length < max)) {
      // Exact role first; a DPS may also displace any other DPS role. Tanks
      // and healers are never auto-benched to make room for a DPS.
      const DPS_ROLES = ['melee_dps', 'ranged_dps', 'caster_dps'];
      const isDps = DPS_ROLES.includes(incoming.role);
      const cheapest = (accept) => {
        let worst = null;
        groups.forEach((g, gi) => {
          const base = Optimizer.groupScore(g, gi, groups, mode);
          g.forEach((p, si) => {
            if (!accept(p)) return;
            const loss = base - Optimizer.groupScore(g.filter(x => x !== p), gi, groups, mode);
            if (!worst || loss < worst.loss) worst = { p, gi, si, loss };
          });
        });
        return worst;
      };
      let worst = cheapest(p => p.role === incoming.role);
      if (!worst && isDps) worst = cheapest(p => DPS_ROLES.includes(p.role));
      if (!worst) return { success:false, error:'The raid is full and has no ' + (incoming.role || '').replace('_', ' ') + ' to swap out' };
      groups[worst.gi].splice(worst.si, 1);
      worst.p.groupNumber = 0;
      State.bench.push(worst.p);
      this.ClearOverridesForUid(worst.p.uid);
      benched = worst.p;
    }

    State.bench.splice(State.bench.indexOf(incoming), 1);
    let best = null;
    groups.forEach((g, gi) => {
      if (g.length >= max) return;
      const base = Optimizer.groupScore(g, gi, groups, mode);
      g.push(incoming);
      const gain = Optimizer.groupScore(g, gi, groups, mode) - base;
      g.pop();
      if (!best || gain > best.gain) best = { gi, gain };
    });
    groups[best.gi].push(incoming);
    incoming.groupNumber = best.gi + 1;
    this.syncRoster();
    return { success:true, player: incoming, groupIdx: best.gi, benched };
  },

  // Permanent removal, from wherever the player currently sits.
  DeletePlayer(uid) {
    const found = this.FindPlayer(uid);
    if (!found) return { success:false, error:'Player not found' };
    if (found.benched) State.bench.splice(found.slot, 1);
    else State.groups[found.groupIdx].splice(found.slot, 1);
    this.ClearOverridesFor(found.player.name);
    Backups.clearForName(found.player.name);
    Constraints.clearForName(found.player.name);
    Drummers.clearForName(found.player.name);
    this.syncRoster();
    return { success:true, player: found.player };
  },
};

// Camping catalog: Wowhead Forever item tooltips reviewed 2026-09-25.
// Numeric scaling is intentionally unresolved. These effects do not enter the optimizer.
const Campfires = {
  tiers: {3:{name:'Basic',skill:1},5:{name:'Journeyman',skill:140},10:{name:'Expert',skill:220}},
  catalog: [],
  key(name) { return String(name).trim().toLowerCase(); },
  members() { return [...State.roster, ...State.bench]; },
  empty() { return {professions:[], fires:[]}; },
  clean(raw) {
    const out = this.empty();
    if (!raw || typeof raw !== 'object') return out;
    const names = new Set(this.members().map(p=>this.key(p.name)));
    for (const p of Array.isArray(raw.professions) ? raw.professions : []) {
      if (!p || !names.has(this.key(p.player)) || !this.professionNames.includes(p.profession) || !Number.isInteger(p.skill) || p.skill<1 || p.skill>300) continue;
      if (!out.professions.some(x=>this.key(x.player)===this.key(p.player) && x.profession===p.profession)) out.professions.push({player:String(p.player),profession:p.profession,skill:p.skill});
    }
    const used=new Set();
    for (const f of Array.isArray(raw.fires) ? raw.fires : []) {
      if (!f || ![3,5,10].includes(f.capacity)) continue;
      const fire={name:String(f.name || 'Campfire').slice(0,60),capacity:f.capacity,assets:[]};
      const families=new Set();
      for (const a of Array.isArray(f.assets) ? f.assets : []) {
        const item=this.catalog.find(x=>x.id===a?.asset);
        const key=this.key(a?.player);
        if (!item || used.has(key) || families.has(item.family) || fire.assets.length>=fire.capacity || !out.professions.some(p=>this.key(p.player)===key && p.profession===item.profession && p.skill>=item.skill)) continue;
        used.add(key); families.add(item.family); fire.assets.push({player:String(a.player),asset:item.id});
      }
      out.fires.push(fire);
    }
    return out;
  },
  eligible(fireIndex) {
    const fire=State.campfires.fires[fireIndex];
    if (!fire || fire.assets.length>=fire.capacity) return [];
    const used=new Set(State.campfires.fires.flatMap(f=>f.assets.map(a=>this.key(a.player))));
    const families=new Set(fire.assets.map(a=>this.catalog.find(x=>x.id===a.asset)?.family));
    return this.members().flatMap(p=> used.has(this.key(p.name)) ? [] : this.catalog.filter(a=>!families.has(a.family) && State.campfires.professions.some(s=>this.key(s.player)===this.key(p.name) && s.profession===a.profession && s.skill>=a.skill)).map(a=>({player:p.name,asset:a.id})));
  },
  assign(index, assignment) {
    if (!assignment || !this.eligible(index).some(a=>a.player===assignment.player && a.asset===assignment.asset)) return false;
    State.campfires.fires[index].assets.push({...assignment}); return true;
  },
};
// Each higher tier lists its own utility; inheritance is only from the base buff.
for (const [profession, family, effect, conflict, rows] of [
  ['Alchemy','wisdom','Mana regeneration (amount scales)','Blessing of Wisdom',[[279956,'Mana Well',''],[279970,'Fermenter','Reagent creation'],[279990,'Alchemy Laboratory','Alchemy Lab recipes']]],
  ['Blacksmithing','strength','Strength (amount scales)','Strength of Earth Totem',[[279944,'Sharpening Wheel',''],[279988,'Anvil','Usable anvil'],[279955,'Master Forge','Forge recipes']]],
  ['Enchanting','wild','Armor, stats and resistances (amounts scale)','Mark of the Wild',[[279976,'Enchanted Lute',''],[279985,'Arcane Salvager','Improved disenchanting'],[279987,'Arcane Forge','Arcane Forge recipes']]],
  ['Engineering','engineering','', '',[[279950,'Reagent Bot','Reagent vendor'],[279949,'Repair Bot','Reagent vendor and repairs'],[279989,"Anarchist’s Workbench",'Workbench recipes; vendor/repairs not confirmed']]],
  ['Herbalism','intellect','Intellect (amount scales)','Arcane Intellect',[[279962,'Incense Candle',''],[279964,'Greenhouse','Grow herbs from seeds'],[279947,'Seed Hybridizer','Multiply or combine seeds']]],
  ['Leatherworking','rested','', '',[[279978,'Camp Tent','Rested XP up to 5% of a level'],[279941,'Tanning Rack','Reagent creation; rested XP up to 5%'],[279945,'Sewing Machine','Sewing recipes; rested XP up to 5%']]],
  ['Mining','might','Melee attack power (amount scales)','Blessing of Might',[[279960,'Lodestone',''],[279948,'Rock Garden','Common mining node over time'],[279952,'Molten Foundry','Foundry recipes']]],
  ['Skinning','crit','2% spell and attack crit','Moonkin Aura',[[279979,'Camp Chair',''],[279969,'Field Guide','Track Beasts'],[279938,"Trapper’s Workbench",'One trap']]],
  ['Tailoring','spirit','Spirit (amount scales; linked base tooltip specifies Horde)','Divine Spirit',[[279972,'Faction Banner',''],[279943,'Spinning Wheel','Reagent creation'],[279959,'Loom','Loom recipes']]],
  ['First Aid','fortitude','Stamina (amount scales)','Power Word: Fortitude',[[279968,'First Aid Kit',''],[279940,'Toxin Study','Healing potions and anti-venom'],[279951,"Plague Doctor’s Laboratory",'Healing potions and poultices']]],
  ['Fishing','kings','8% increased stats','Blessing of Kings',[[279967,'Fish Bowl',''],[279965,'Fishing Rack','Uncommon fish for 1h; fishing lures'],[279966,'Fishing Hut','Rare fish for 1h; fishing lures']]],
]) rows.forEach(([id,name,utility],i)=>Campfires.catalog.push({id,name,profession,family: id===279989 ? 'engineering-workbench' : family,skill:[20,140,300][i],effect,conflict,utility}));
Campfires.catalog.push({id:279957,name:"Cookie’s Feast",profession:'Cooking',family:'food',skill:140,effect:'Stamina food (amount unknown)',conflict:'',utility:''});
Campfires.professionNames=[...new Set(Campfires.catalog.map(a=>a.profession))].sort();

// ── ASSIGNMENTS (Healer→Tank, Paladin Blessings, boss Debuff casters) ──
// Pure suggest/validate/serialize/text logic for the Assignments panel, kept
// above the UI split (like Optimizer/Campfires) so assignments-tests.js can
// load it exactly the way classic-tests.js loads the ruleset logic.
//
// Only MANUAL edits ever live in State.assignments (name-keyed, the same
// convention State.buffOverrides already uses so identity survives
// exportRoster/loadRoster and share links, which drop player uid but keep
// name). Every suggested value is recomputed live from the current seated
// roster and merged with the manual overrides at render/serialize time, so
// "re-suggest only empty slots" falls out for free — there is no separate
// suggest-then-freeze step to get stale.
const Assignments = {
  // Default Greater Blessing catalog — tasks/research-classic-buffs.md
  // confirms Classic Era Alliance fields the same five Blessings as TBC
  // (Kings/Might/Wisdom/Salvation/Light), so one static table covers both.
  // A future ruleset can still override it via activeRules().blessings.
  DEFAULT_BLESSINGS: {
    KINGS:     { name:'Blessing of Kings',     desc:'Increases all stats by 10%.' },
    MIGHT:     { name:'Blessing of Might',     desc:'Increases attack power.' },
    WISDOM:    { name:'Blessing of Wisdom',    desc:'Restores mana over time.' },
    SALVATION: { name:'Blessing of Salvation', desc:'Reduces threat generated by 30%.' },
    LIGHT:     { name:'Blessing of Light',     desc:'Increases healing received and armor.' },
  },
  // Priority order when there are fewer Paladins than relevant Blessings —
  // Kings is never dropped, Light drops first. Per feature spec order.
  BLESSING_ORDER: ['KINGS','MIGHT','WISDOM','SALVATION','LIGHT'],
  blessingCatalog() { return activeRules().blessings || this.DEFAULT_BLESSINGS; },

  // Which Blessing(s) a role receives. Every per-class example in the spec
  // (Warrior tank → Kings/Might/Light; Warrior Fury → Kings/Might/Salvation;
  // Rogue → Kings/Might/Salvation; Mage/Warlock → Kings/Wisdom/Salvation;
  // Priest/Druid/Shaman/Paladin healers → Kings/Wisdom/Salvation) reduces to
  // a function of ROLE, not class, so one small table is correct for every
  // class without needing per-class special cases.
  ROLE_BLESSINGS: {
    tank: ['KINGS','MIGHT','LIGHT'],
    melee_dps: ['KINGS','MIGHT','SALVATION'],
    ranged_dps: ['KINGS','MIGHT','SALVATION'],
    caster_dps: ['KINGS','WISDOM','SALVATION'],
    healer: ['KINGS','WISDOM','SALVATION'],
  },
  blessingsForRole(role) { return this.ROLE_BLESSINGS[role] || ['KINGS']; },

  // ── Healer → Tank ──────────────────────────────────────────────
  // Seated tanks (role 'tank' — includes a Feral druid whose role was set to
  // tank) split seated healers between them; the main tank (first tank)
  // leans toward 3, others toward 2, and anyone left over heals the raid.
  // Healers already in a tank's own group are preferred for that tank.
  suggestHealerTanks(players) {
    const tanks = (players || []).filter(p => p.role === 'tank');
    const healers = (players || []).filter(p => p.role === 'healer');
    const result = {};
    if (!tanks.length) { healers.forEach(h => { result[h.name] = 'RAID'; }); return result; }

    // Fair round-robin to 2 each first, then the main tank leans toward a
    // 3rd, then any further leftovers spread up to 3/tank before Raid.
    const targets = tanks.map(() => 0);
    let remaining = healers.length;
    for (let round = 0; round < 2 && remaining > 0; round++) {
      for (let i = 0; i < tanks.length && remaining > 0; i++) {
        if (targets[i] < 2) { targets[i]++; remaining--; }
      }
    }
    if (remaining > 0 && targets[0] < 3) { targets[0]++; remaining--; }
    let ti = 1;
    while (remaining > 0 && targets.some(t => t < 3)) {
      if (targets[ti % tanks.length] < 3) { targets[ti % tanks.length]++; remaining--; }
      ti++;
    }

    // Two full passes across every tank (not one tank fully resolved before
    // the next starts) so an earlier tank's fallback fill can never steal a
    // healer that belongs in a later tank's own group.
    const unassigned = healers.slice();
    const counts = tanks.map(() => 0);
    tanks.forEach((tank, i) => {
      for (let j = 0; j < unassigned.length && counts[i] < targets[i]; j++) {
        const h = unassigned[j];
        if (h && h.groupNumber === tank.groupNumber) { result[h.name] = tank.name; unassigned[j] = null; counts[i]++; }
      }
    });
    tanks.forEach((tank, i) => {
      for (let j = 0; j < unassigned.length && counts[i] < targets[i]; j++) {
        const h = unassigned[j];
        if (h) { result[h.name] = tank.name; unassigned[j] = null; counts[i]++; }
      }
    });
    unassigned.forEach(h => { if (h) result[h.name] = 'RAID'; });
    return result;
  },

  // ── Paladin Blessings ──────────────────────────────────────────
  // One Blessing per seated Paladin, highest priority first. Drops the
  // lowest-priority Blessing (and skips any Blessing with no relevant role
  // seated at all) when there are fewer Paladins than candidates.
  suggestBlessings(players) {
    const paladins = (players || []).filter(p => p.class === 'PALADIN');
    if (!paladins.length) return {};
    const roles = new Set((players || []).map(p => p.role));
    const catalog = this.blessingCatalog();
    const relevant = id => {
      if (id === 'KINGS') return true;
      if (id === 'MIGHT') return roles.has('melee_dps') || roles.has('ranged_dps');
      if (id === 'WISDOM') return roles.has('caster_dps') || roles.has('healer');
      if (id === 'SALVATION') return roles.has('melee_dps') || roles.has('ranged_dps') || roles.has('caster_dps') || roles.has('healer');
      if (id === 'LIGHT') return roles.has('tank');
      return !!catalog[id];
    };
    const candidates = this.BLESSING_ORDER.filter(id => catalog[id] && relevant(id));
    const result = {};
    candidates.slice(0, paladins.length).forEach((id, i) => { result[id] = paladins[i].name; });
    return result;
  },

  // For the UI's per-class matrix: classes present → the Blessing(s) their
  // members receive and which seated Paladin (if any) actually gives each.
  blessingMatrix(players, blessingAssignments) {
    const presentClasses = [...new Set((players || []).map(p => p.class))];
    return presentClasses.map(cls => {
      const rolesForClass = new Set(players.filter(p => p.class === cls).map(p => p.role));
      const ids = [...new Set([...rolesForClass].flatMap(r => this.blessingsForRole(r)))];
      const cells = ids
        .map(id => ({ id, name: (this.blessingCatalog()[id] || {}).name || id, paladin: (blessingAssignments || {})[id] || null }))
        .filter(c => c.paladin);
      return { class: cls, cells };
    }).filter(r => r.cells.length);
  },

  // ── Boss debuff assignments ──────────────────────────────────────
  // One eligible caster per debuff id defined by the active ruleset. Skips a
  // lesser version (e.g. Faerie Fire (Feral)) when its supersededBy source is
  // available, and spreads distinct debuffs of the same class across
  // different casters before ever reusing one — "one warlock per curse type
  // present", extra warlocks stay free.
  suggestDebuffs(players) {
    const debuffs = activeRules().debuffs || {};
    const usedPerClass = {};
    const result = {};
    for (const id of Object.keys(debuffs)) {
      const def = debuffs[id];
      if (def.supersededBy && debuffs[def.supersededBy]) {
        const superior = debuffs[def.supersededBy];
        const superiorEligible = (players || []).some(p => p.class === superior.sourceClass && (!superior.sourceSpec || p.spec === superior.sourceSpec));
        if (superiorEligible) continue;
      }
      const eligible = (players || []).filter(p => p.class === def.sourceClass && (!def.sourceSpec || p.spec === def.sourceSpec));
      if (!eligible.length) continue;
      usedPerClass[def.sourceClass] ||= new Set();
      let pick = eligible.find(p => !usedPerClass[def.sourceClass].has(p.name));
      if (!pick) pick = eligible[0];
      result[id] = pick.name;
      usedPerClass[def.sourceClass].add(pick.name);
    }
    return result;
  },

  // Flags pairs of ASSIGNED debuffs that share a competesWith slot — only one
  // of the pair can actually land on the boss (e.g. Sunder vs Expose Armor).
  getDebuffConflicts(debuffAssignments) {
    const debuffs = activeRules().debuffs || {};
    const conflicts = [];
    const seen = new Set();
    for (const id of Object.keys(debuffAssignments || {})) {
      const def = debuffs[id];
      if (!def || !def.competesWith) continue;
      for (const otherId of def.competesWith) {
        if (!debuffAssignments[otherId]) continue;
        const key = [id, otherId].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ a:id, b:otherId });
      }
    }
    return conflicts;
  },

  // ── Effective values: manual override when it still resolves, else the
  // live suggestion. Stale manual entries (referencing a player who is no
  // longer eligible) are ignored here and pruned properly by reconcileRoster.
  effectiveHealerTanks(players = State.roster) {
    const result = this.suggestHealerTanks(players);
    const manual = State.assignments.tankHealers || {};
    const healerNames = new Set((players || []).filter(p => p.role === 'healer').map(p => p.name));
    const tankNames = new Set((players || []).filter(p => p.role === 'tank').map(p => p.name));
    for (const [healer, tank] of Object.entries(manual)) {
      if (!healerNames.has(healer)) continue;
      if (tank !== 'RAID' && !tankNames.has(tank)) continue;
      result[healer] = tank;
    }
    return result;
  },
  effectiveBlessings(players = State.roster) {
    const result = this.suggestBlessings(players);
    const manual = State.assignments.blessings || {};
    const paladinNames = new Set((players || []).filter(p => p.class === 'PALADIN').map(p => p.name));
    const catalog = this.blessingCatalog();
    for (const [id, name] of Object.entries(manual)) {
      if (!catalog[id]) continue;
      if (name === this.NONE) { delete result[id]; continue; }
      if (!paladinNames.has(name)) continue;
      result[id] = name;
    }
    return result;
  },
  effectiveDebuffs(players = State.roster) {
    const result = this.suggestDebuffs(players);
    const manual = State.assignments.debuffs || {};
    const debuffs = activeRules().debuffs || {};
    const byName = new Map((players || []).map(p => [p.name, p]));
    for (const [id, name] of Object.entries(manual)) {
      const def = debuffs[id];
      if (!def) continue;
      if (name === this.NONE) { delete result[id]; continue; }
      const p = byName.get(name);
      if (!p || p.class !== def.sourceClass || (def.sourceSpec && p.spec !== def.sourceSpec)) continue;
      result[id] = name;
    }
    return result;
  },

  // ── Manual edits ──────────────────────────────────────────────
  // Choosing "none" for a blessing/debuff is itself a manual choice: it is stored
  // as NONE so the live suggestion doesn't refill the slot on the next render.
  NONE: '',
  setHealerTank(healerName, tankKey) {
    if (tankKey) State.assignments.tankHealers[healerName] = tankKey;
    else delete State.assignments.tankHealers[healerName];
  },
  setBlessing(blessingId, paladinName) {
    State.assignments.blessings[blessingId] = paladinName || this.NONE;
  },
  setDebuff(debuffId, playerName) {
    State.assignments.debuffs[debuffId] = playerName || this.NONE;
  },

  // ── Custom rows (interrupts, cube clickers, kiters, ...) ─────────────
  // State.assignments.custom = [{ id, label, players:[name], mark }] in the
  // user's order. The key exists only while at least one row does, so a plan
  // with none serializes exactly as it did before rows existed. `mark` is a
  // raid-target number (1 Star ... 8 Skull) or 0 for none.
  CUSTOM_MAX_ROWS: 20,
  CUSTOM_LABEL_MAX: 40,
  CUSTOM_MAX_PLAYERS: 40,
  RAID_MARKS: ['Star', 'Circle', 'Diamond', 'Triangle', 'Moon', 'Square', 'Cross', 'Skull'],
  customRows() { return State.assignments.custom || []; },
  findCustom(id) { return this.customRows().find(r => r.id === id) || null; },
  // Control characters and runs of whitespace collapse to one space; the label stays free text.
  cleanLabel(raw) {
    return String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, this.CUSTOM_LABEL_MAX).trim();
  },
  cleanMark(raw) { return Number.isInteger(raw) && raw >= 1 && raw <= this.RAID_MARKS.length ? raw : 0; },
  // Defensive read of untrusted rows (saved plan, share tail, template, hand-edited backup).
  cleanCustom(items) {
    if (!Array.isArray(items)) return [];
    const out = [], ids = new Set();
    for (const r of items) {
      if (out.length >= this.CUSTOM_MAX_ROWS) break;
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const label = this.cleanLabel(r.label);
      if (!label) continue;
      let id = typeof r.id === 'string' && /^c\d+$/.test(r.id) && !ids.has(r.id) ? r.id : null;
      if (!id) { let n = 1; while (ids.has('c' + n)) n++; id = 'c' + n; }
      ids.add(id);
      const players = [...new Set((Array.isArray(r.players) ? r.players : []).filter(n => typeof n === 'string' && n))].slice(0, this.CUSTOM_MAX_PLAYERS);
      out.push({ id, label, players, mark: this.cleanMark(r.mark) });
    }
    return out;
  },
  _storeCustom(rows) {
    if (rows.length) State.assignments.custom = rows;
    else delete State.assignments.custom;
  },
  addCustom(label, mark = 0) {
    const clean = this.cleanLabel(label);
    if (!clean) return { success:false, error:'Enter a label for the assignment' };
    const rows = this.customRows();
    if (rows.length >= this.CUSTOM_MAX_ROWS) return { success:false, error:'At most ' + this.CUSTOM_MAX_ROWS + ' custom assignments' };
    const taken = new Set(rows.map(r => r.id));
    let n = 1; while (taken.has('c' + n)) n++;
    const row = { id: 'c' + n, label: clean, players: [], mark: this.cleanMark(mark) };
    this._storeCustom([...rows, row]);
    return { success:true, row };
  },
  renameCustom(id, label) {
    const row = this.findCustom(id);
    if (!row) return { success:false, error:'Assignment not found' };
    const clean = this.cleanLabel(label);
    if (!clean) return { success:false, error:'Label cannot be empty' };
    row.label = clean;
    return { success:true, row };
  },
  setCustomMark(id, mark) {
    const row = this.findCustom(id);
    if (!row) return { success:false, error:'Assignment not found' };
    row.mark = this.cleanMark(Number(mark));
    return { success:true, row };
  },
  // Only a player seated right now can be assigned, so a row never starts out with a dangling name.
  addCustomPlayer(id, name) {
    const row = this.findCustom(id);
    if (!row) return { success:false, error:'Assignment not found' };
    if (!(State.roster || []).some(p => p.name === name)) return { success:false, error:'Player is not seated' };
    if (row.players.includes(name)) return { success:true, row };
    if (row.players.length >= this.CUSTOM_MAX_PLAYERS) return { success:false, error:'Too many players on one assignment' };
    row.players.push(name);
    return { success:true, row };
  },
  removeCustomPlayer(id, name) {
    const row = this.findCustom(id);
    if (!row) return { success:false, error:'Assignment not found' };
    row.players = row.players.filter(n => n !== name);
    return { success:true, row };
  },
  moveCustom(id, delta) {
    const rows = this.customRows().slice();
    const from = rows.findIndex(r => r.id === id);
    if (from < 0) return { success:false, error:'Assignment not found' };
    const to = Math.max(0, Math.min(rows.length - 1, from + delta));
    if (to === from) return { success:true, moved:false };
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    this._storeCustom(rows);
    return { success:true, moved:true };
  },
  removeCustom(id) {
    const rows = this.customRows();
    if (!rows.some(r => r.id === id)) return { success:false, error:'Assignment not found' };
    this._storeCustom(rows.filter(r => r.id !== id));
    return { success:true };
  },

  // Drops manual choices that reference a player (or, for healer->tank, a
  // tank) no longer seated. Never touches an entry that still resolves —
  // silently discarding a choice that is still valid would violate "never
  // overwrite a user's manual choice silently".
  reconcileRoster(players = State.roster) {
    const names = new Set((players || []).map(p => p.name));
    const tankNames = new Set((players || []).filter(p => p.role === 'tank').map(p => p.name));
    const paladinNames = new Set((players || []).filter(p => p.class === 'PALADIN').map(p => p.name));
    for (const healer of Object.keys(State.assignments.tankHealers)) {
      const tank = State.assignments.tankHealers[healer];
      if (!names.has(healer) || (tank !== 'RAID' && !tankNames.has(tank))) delete State.assignments.tankHealers[healer];
    }
    for (const id of Object.keys(State.assignments.blessings)) {
      const name = State.assignments.blessings[id];
      if (name !== this.NONE && !paladinNames.has(name)) delete State.assignments.blessings[id];
    }
    for (const id of Object.keys(State.assignments.debuffs)) {
      const name = State.assignments.debuffs[id];
      if (name !== this.NONE && !names.has(name)) delete State.assignments.debuffs[id];
    }
    // A custom row outlives its players (it is the user's own label); only the names go.
    for (const row of this.customRows()) row.players = row.players.filter(n => names.has(n));
  },

  hasManualEdits() {
    return !!(Object.keys(State.assignments.tankHealers).length || Object.keys(State.assignments.blessings).length || Object.keys(State.assignments.debuffs).length || this.customRows().length);
  },
  // Deep-cloned snapshot for persistence (PlanStore / exportRoster / share tail).
  serialize() {
    return JSON.parse(JSON.stringify(State.assignments));
  },
  restore(data) {
    const clean = obj => (obj && typeof obj === 'object' && !Array.isArray(obj)) ? { ...obj } : {};
    State.assignments = {
      tankHealers: clean(data && data.tankHealers),
      blessings: clean(data && data.blessings),
      debuffs: clean(data && data.debuffs),
    };
    this._storeCustom(this.cleanCustom(data && data.custom));
    this.reconcileRoster();
  },

  // ── chat-safe, raid-chat friendly text (<=255 UTF-8 bytes per line) ──
  // Uses the shared chatSafe()/clipUtf8Bytes() helpers (see UTILITIES) so
  // accented player names survive and the byte cap never splits one in half.
  _packLines(label, segments, maxBytes = 255) {
    const utf8Len = (s) => new TextEncoder().encode(s).length;
    const lines = [];
    let current = '';
    for (const seg of segments) {
      const candidate = current ? current + ' | ' + seg : seg;
      if (utf8Len(`${label}: ${candidate}`) > maxBytes && current) {
        lines.push(`${label}: ${current}`);
        current = seg;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(`${label}: ${current}`);
    return lines.map(l => clipUtf8Bytes(chatSafe(l), maxBytes));
  },
  toChatText(players = State.roster) {
    const lines = [];
    const healerTanks = this.effectiveHealerTanks(players);
    const tanks = (players || []).filter(p => p.role === 'tank');
    if (tanks.length) {
      const segs = tanks.map((t, i) => {
        const label = i === 0 ? 'MT' : i === 1 ? 'OT' : 'OT' + i;
        const healers = Object.entries(healerTanks).filter(([, tk]) => tk === t.name).map(([h]) => h);
        return `${label} ${t.name} <- ${healers.length ? healers.join(', ') : '(none)'}`;
      });
      const raidHealers = Object.entries(healerTanks).filter(([, tk]) => tk === 'RAID').map(([h]) => h);
      if (raidHealers.length) segs.push('Raid: ' + raidHealers.join(', '));
      lines.push(...this._packLines('Healers', segs));
    }

    const blessings = this.effectiveBlessings(players);
    const paladins = (players || []).filter(p => p.class === 'PALADIN');
    if (paladins.length && Object.keys(blessings).length) {
      const catalog = this.blessingCatalog();
      const segs = Object.entries(blessings).map(([id, paladinName]) => {
        const rolesGranting = [...new Set((players || []).filter(p => this.blessingsForRole(p.role).includes(id)).map(p => p.class))];
        const label = ((catalog[id] || {}).name || id).replace('Blessing of ', '');
        return `${paladinName}: ${label}${rolesGranting.length ? ' (' + rolesGranting.map(c => RosterEdit.ClassLabel(c)).join(', ') + ')' : ''}`;
      });
      lines.push(...this._packLines('Blessings', segs));
    }

    const debuffAssignments = this.effectiveDebuffs(players);
    if (Object.keys(debuffAssignments).length) {
      const segs = Object.entries(debuffAssignments).map(([id, name]) => `${Config.DebuffAbbreviations[id] || id}: ${name}`);
      lines.push(...this._packLines('Debuffs', segs));
    }

    const seated = new Set((players || []).map(p => p.name));
    for (const row of this.customRows()) {
      const names = row.players.filter(n => seated.has(n));
      if (names.length) lines.push(...this._packLines((row.mark ? '{rt' + row.mark + '} ' : '') + row.label, [names.join(', ')]));
    }
    return lines.join('\n');
  },

  // ── MRT (Method Raid Tools) note ──
  // Plain note text for MRT's Note module (paste into a note, then send to the
  // raid): a heading per section, one line per assignment, names wrapped in
  // their class colour. Every assignment is included - the live Healer->Tank,
  // Blessing and Debuff values plus the custom rows. A "|" would start a WoW
  // escape sequence, so it is doubled in every user-supplied piece of text.
  _mrtText(str) { return chatSafe(str).replace(/\|/g, '||'); },
  _mrtName(name, byName) {
    const color = Config.ClassColors[(byName.get(name) || {}).class];
    const text = this._mrtText(name);
    return color ? '|cff' + color.slice(1).toUpperCase() + text + '|r' : text;
  },
  toMrtNote(players = State.roster) {
    const byName = new Map((players || []).map(p => [p.name, p]));
    const names = list => list.map(n => this._mrtName(n, byName)).join(', ');
    const sections = [];

    const healerTanks = this.effectiveHealerTanks(players);
    const tanks = (players || []).filter(p => p.role === 'tank');
    if (tanks.length) {
      const lines = ['Healers'];
      tanks.forEach((t, i) => {
        const healers = Object.entries(healerTanks).filter(([, tk]) => tk === t.name).map(([h]) => h);
        lines.push((i === 0 ? 'MT' : i === 1 ? 'OT' : 'OT' + i) + ' ' + this._mrtName(t.name, byName) + ': ' + (healers.length ? names(healers) : '(none)'));
      });
      const raidHealers = Object.entries(healerTanks).filter(([, tk]) => tk === 'RAID').map(([h]) => h);
      if (raidHealers.length) lines.push('Raid: ' + names(raidHealers));
      sections.push(lines);
    }

    const blessings = this.effectiveBlessings(players);
    const catalog = this.blessingCatalog();
    const blessingIds = this.BLESSING_ORDER.filter(id => blessings[id]);
    if (blessingIds.length) {
      sections.push(['Blessings', ...blessingIds.map(id => this._mrtText(((catalog[id] || {}).name || id).replace('Blessing of ', '')) + ': ' + names([blessings[id]]))]);
    }

    const debuffAssignments = this.effectiveDebuffs(players);
    const debuffEntries = Object.entries(debuffAssignments);
    if (debuffEntries.length) {
      sections.push(['Debuffs', ...debuffEntries.map(([id, name]) => this._mrtText(Config.DebuffAbbreviations[id] || id) + ': ' + names([name]))]);
    }

    const custom = this.customRows().map(row => ({ row, who: row.players.filter(n => byName.has(n)) })).filter(c => c.who.length);
    if (custom.length) {
      sections.push(['Custom', ...custom.map(({ row, who }) => (row.mark ? '{rt' + row.mark + '} ' : '') + this._mrtText(row.label) + ': ' + names(who))]);
    }
    return sections.map(lines => lines.join('\n')).join('\n\n');
  },
};

// ── PLANNED BENCH BACKUPS ──────────────────────────────────────
// Pre-wire "if X no-shows, Y takes the seat" before a raid even starts,
// instead of reacting live once a buff/debuff already went missing (the
// existing renderInsightLine 'bench' case). Name-keyed like buffOverrides
// and Assignments (State.backups: { primaryName -> backupName }) so the
// pairing survives exportRoster/loadRoster and share links, which drop a
// player's uid but keep their name. One seated player has at most one
// designated backup, and one benched player backs up at most one seat.
const Backups = {
  backupNameFor(primaryName) { return (State.backups || {})[primaryName] || null; },
  primaryNameFor(backupName) {
    for (const [primary, backup] of Object.entries(State.backups || {})) if (backup === backupName) return primary;
    return null;
  },

  // Pins `backupName` (must currently be on the bench) as the backup for
  // `primaryName` (must currently be seated). Replaces any prior link either
  // name was already part of, to keep the one-to-one invariant.
  link(primaryName, backupName) {
    if (!primaryName || !backupName || primaryName === backupName) return { success:false, error:'Choose a different player' };
    if (!(State.roster || []).some(p => p.name === primaryName)) return { success:false, error:'Backup target must be seated' };
    if (!(State.bench || []).some(p => p.name === backupName)) return { success:false, error:'Backup must be on the bench' };
    State.backups = State.backups || {};
    this.unlink(primaryName);
    this.clearBackup(backupName);
    State.backups[primaryName] = backupName;
    return { success:true };
  },
  unlink(primaryName) { if (State.backups) delete State.backups[primaryName]; },
  // Drops any link where `backupName` is the designated backup — used before
  // that player backs up someone else, and when they leave the bench/roster.
  clearBackup(backupName) {
    for (const primary of Object.keys(State.backups || {})) if (State.backups[primary] === backupName) delete State.backups[primary];
  },
  // Either side of a link leaving the roster for good invalidates it.
  clearForName(name) { this.unlink(name); this.clearBackup(name); },

  hasManualEdits() { return Object.keys(State.backups || {}).length > 0; },
  // Deep-cloned snapshot for persistence (PlanStore / exportRoster / share tail).
  serialize() { return JSON.parse(JSON.stringify(State.backups || {})); },
  restore(data) {
    const clean = {};
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) if (typeof k === 'string' && typeof v === 'string') clean[k] = v;
    }
    State.backups = clean;
  },
  // Drops stale links: primary no longer anywhere in the roster, or backup
  // no longer sitting on the bench (seated elsewhere, or gone entirely).
  // Run on every commit (reconcilePlan), like PreferredSlots.reconcile()/Assignments.reconcileRoster().
  reconcile() {
    if (!State.backups) return;
    const names = new Set([...(State.roster || []), ...(State.bench || [])].map(p => p.name));
    const benchNames = new Set((State.bench || []).map(p => p.name));
    for (const [primary, backup] of Object.entries(State.backups)) {
      if (!names.has(primary) || !benchNames.has(backup)) delete State.backups[primary];
    }
  },

  // Seats `backupName` (the designated backup for `primaryName`) in place of
  // the primary. When the primary is STILL seated (the manual "Swap in
  // backup" action, used ahead of any actual absence) this is a true swap:
  // the primary is benched and the backup takes their exact seat. When the
  // primary has already left that seat — Raid-Helper already withdrew or
  // demoted them before this runs — `groupIdx` (the seat they vacated, from
  // applyRaidHelperSync's backupSwapReady) is used instead, falling back to
  // the first open seat if that group is no longer available.
  swapIn(primaryName, groupIdx) {
    const backupName = this.backupNameFor(primaryName);
    if (!backupName) return { success:false, error:'No backup designated' };
    const bi = (State.bench || []).findIndex(p => p.name === backupName);
    if (bi < 0) return { success:false, error: backupName + ' is no longer on the bench' };
    const groups = State.groups || [];

    let gi = -1;
    for (let g = 0; g < groups.length; g++) {
      const pi = (groups[g] || []).findIndex(p => p.name === primaryName);
      if (pi < 0) continue;
      const primary = groups[g][pi];
      groups[g].splice(pi, 1);
      primary.groupNumber = 0;
      State.bench.push(primary);
      RosterEdit.ClearOverridesFor(primary.name);
      gi = g;
      break;
    }
    if (gi < 0) {
      gi = Number.isInteger(groupIdx) && groups[groupIdx] && groups[groupIdx].length < RosterEdit.MAX_GROUP_SIZE
        ? groupIdx
        : groups.findIndex(g2 => g2.length < RosterEdit.MAX_GROUP_SIZE);
    }
    if (gi < 0 || gi == null) return { success:false, error:'The raid is full; no open seat for ' + backupName };

    const backup = State.bench[bi];
    State.bench.splice(bi, 1);
    backup.groupNumber = gi + 1;
    groups[gi].push(backup);
    this.unlink(primaryName);
    RosterEdit.syncRoster();
    return { success:true, player:backup, groupIdx:gi };
  },
};

// ── SPLIT SIGN-UPS INTO TWO RAIDS ────────────────────────────────
// When far more people sign up than one raid holds (a guild running two
// clears the same night, a 55-person Naxx signup), RaidSplit.split()
// partitions every sign-up — seated and benched — into two same-size
// rosters instead of leaving the overflow to rot on one long bench.
// Pure: reads only Config.Raids and the named ruleset's DPS-weight tables,
// never ambient State, so the same function drives both the UI (the live
// roster) and rosters-tests.js directly.
const RaidSplit = {
  // Sign-up volume that makes offering a split worthwhile, by raid size —
  // see feature-backlog.md #8: 45+ for a 25/40-man, 30+ for a 20-man
  // (Classic ZG/AQ20/Hyjal), 20+ for a 10-man (Kara/ZA/Barrow Deeps).
  suggestThreshold(size) {
    if (size <= 10) return 20;
    if (size <= 20) return 30;
    return 45;
  },
  shouldOffer(totalSignUps, raidKey) {
    const raid = Config.Raids[raidKey];
    if (!raid) return false;
    return totalSignUps >= this.suggestThreshold(raid.size);
  },

  // Same lookup as dpsWeightFor(), but pinned to an explicit ruleset instead
  // of ambient State.gameVersion, so the split stays pure regardless of what
  // version happens to be active when it runs.
  _weight(player, version) {
    const rules = Rulesets[version] || {};
    const w = (rules.dpsWeight || {})[player.class + ':' + player.spec];
    if (w != null) return w;
    const r = (rules.dpsWeightByRole || {})[player.role];
    return r != null ? r : 0.8;
  },

  // Partitions every sign-up into two rosters, { a, b }, each
  // { seated:[...], bench:[...] } capped at the raid's size. Tanks and
  // healers are placed first (alternating so both raids reach
  // Config.RaidFloors before either gets a second of either role), then
  // every other role is placed class-by-class — spreading buff providers
  // (shamans/paladins/druids/hunters) across both raids — while greedily
  // keeping the two rosters' total dpsWeight balanced. A currently-seated
  // sign-up is ordered ahead of a benched one within its role/class group,
  // so a tie in the running balance favors "keep the leader's existing seats
  // in raid A". Splitting never changes which classes are present, so a
  // faction-locked (Classic) roster's faction carries over unchanged.
  split(players, raidKey, version) {
    const raid = Config.Raids[raidKey];
    if (!raid) return null;
    const list = (players || []).filter(p => p && p.name);

    const isLocked = p => Number.isInteger(p.groupNumber) && p.groupNumber >= 1;
    const canon = p => p.role + '|' + p.class + '|' + p.spec + '|' + (p.name || '');
    const sorted = list.slice().sort((x, y) => {
      const lx = isLocked(x) ? 0 : 1, ly = isLocked(y) ? 0 : 1;
      if (lx !== ly) return lx - ly;
      const kx = canon(x), ky = canon(y);
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });

    const a = [], b = [];
    let weightA = 0, weightB = 0;
    const assign = (p) => {
      const target = weightA <= weightB ? a : b;
      target.push(p);
      const w = this._weight(p, version);
      if (target === a) weightA += w; else weightB += w;
    };

    const roleOrder = ['tank', 'healer', 'melee_dps', 'ranged_dps', 'caster_dps'];
    for (const role of roleOrder) {
      const byClass = new Map();
      for (const p of sorted) {
        if (p.role !== role) continue;
        if (!byClass.has(p.class)) byClass.set(p.class, []);
        byClass.get(p.class).push(p);
      }
      for (const cls of [...byClass.keys()].sort()) {
        for (const p of byClass.get(cls)) assign(p);
      }
    }

    const size = raid.size;
    const cap = (arr) => ({ seated: arr.slice(0, size), bench: arr.slice(size) });
    return { raidKey, size, groups: raid.groups, a: cap(a), b: cap(b) };
  },
};

// ── RAID PREP (backlog #9 + #10) ───────────────────────────────────
// Static, sourced encounter-prep notes and a consumables/world-buff checklist
// per raid. Every entry carries a `source` URL — see tasks/research-wave3.md.
// Facts that research pass flagged UNCONFIRMED (a specific number, an exact
// itemization) were left out entirely rather than guessed; where a note's
// general point was sourced but a number wasn't, only the qualitative point
// is kept. An `utility` id (when present) cross-references
// Readiness.utilityCoverage()/Config.Utilities so the panel can show whether
// the current roster has that provider seated. Real raids only — the
// classicN/foreverN planning templates have no encounters, by design (no
// boss list exists for a template), so they're simply absent from `data`.
const RaidPrep = {
  data: {
    // ── Classic Era ──
    mc: {
      encounters: [
        { boss:'Magmadar', note:'Frenzy must be stripped with a tight Tranquilizing Shot rotation (shorter than his berserk interval) — keep at least one Hunter available.', utility:'TRANQ_SHOT', source:'https://eu.forums.blizzard.com/en/wow/t/how-to-prepare-for-molten-core-and-onyxia/458879' },
        { boss:'Gehennas', note:'Applies a curse that must be dispelled quickly; keep decurse coverage on hand.', utility:'REMOVE_CURSE', source:'https://www.warcrafttavern.com/wow-classic/guides/bwl/' },
        { boss:'Raid-wide', note:'Fire resistance gear recommended for the fire-elemental trash and several bosses.', source:'https://www.icy-veins.com/wow-classic/season-of-discovery-fire-resistance-gear-sets' },
        { boss:'Composition', note:'Convention is roughly 3 tanks, 10 healers, with at least one Warlock (banish), Priest (purge/dispel) and Hunter (tranq) seated.', source:'https://www.mmoprovider.com/blog/how-to-run-bwl' },
      ],
      consumables: [
        { item:'Rallying Cry of the Dragonslayer', note:'+10% spell crit, +5% melee/ranged crit, +140 Attack Power, 120 min — Onyxia kill/turn-in world buff.', source:'https://www.method.gg/wow-classic/list-of-all-wow-classic-consumables-enchants-and-world-buffs' },
        { item:'Songflower Serenade', note:'+5% crit, +15 all stats — Felwood Songflower node.', source:'https://www.method.gg/wow-classic/list-of-all-wow-classic-consumables-enchants-and-world-buffs' },
        { item:'Greater Fire Protection Potion', note:'+50 Fire Resistance for ~2 hours; layers with gear for the raid-wide Fire Resist check.', source:'https://umelfahemgallery.org/wow-raid-consumables-best-buffs-and-potions/' },
        { item:'Flask of Supreme Power', note:'Long-duration caster damage flask.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
      ],
    },
    ony: {
      encounters: [
        { boss:'Onyxia (Phase 3)', note:'Bellowing Roar fears everyone nearby every ~10s; the main tank should be fear-immune (Fear Ward, Berserker Rage, or a nearby Tremor Totem) so she is never repositioned.', utility:'FEAR_BREAK', source:'https://www.icy-veins.com/wow-classic/onyxia-guide-strategy-abilities-loot' },
        { boss:'Onyxia (Phase 2)', note:'Deep Breath: the raid must track her facing and move out of the frontal fire-breath line — no resistance gear substitutes for positioning.', source:'https://www.icy-veins.com/wow-classic/onyxia-guide-strategy-abilities-loot' },
      ],
      consumables: [
        { item:'Rallying Cry of the Dragonslayer', note:'+10% spell crit, +5% melee/ranged crit, +140 Attack Power, 120 min.', source:'https://www.method.gg/wow-classic/list-of-all-wow-classic-consumables-enchants-and-world-buffs' },
        { item:"Sayge's Dark Fortune", note:'Darkmoon Faire fortune-teller buff; grants one of several possible boons.', source:'https://www.warcrafttavern.com/wow-classic/guides/world-buffs/' },
      ],
    },
    bwl: {
      encounters: [
        { boss:'Nefarian', note:"Opening Shadow Flame hits the whole raid — everyone should wear the Onyxia Scale Cloak (crafted, requires Onyxia's head) for the Shadow Resist it grants.", source:'https://www.warcrafttavern.com/wow-classic/guides/bwl/' },
        { boss:'Chromaggus', note:'Hunters use Tranquilizing Shot to strip his Frenzy buff.', utility:'TRANQ_SHOT', source:'https://www.warcrafttavern.com/wow-classic/guides/bwl/' },
        { boss:'Firemaw / Ebonroc', note:'Fire resistance gear recommended, plus spreading out to reduce Shadow Flame/fire AoE clustering.', source:'https://www.warcrafttavern.com/wow-classic/guides/bwl/' },
      ],
      consumables: [
        { item:'Elixir of the Mongoose', note:'Best melee DPS potion in the game (Agility/crit).', source:'https://umelfahemgallery.org/wow-raid-consumables-best-buffs-and-potions/' },
        { item:'Elemental Sharpening Stone', note:'Melee weapon damage buff.', source:'https://umelfahemgallery.org/wow-raid-consumables-best-buffs-and-potions/' },
        { item:'Greater Fire Protection Potion', note:'+50 Fire Resistance for ~2 hours, for the Firemaw/Ebonroc/Nefarian fire damage.', source:'https://umelfahemgallery.org/wow-raid-consumables-best-buffs-and-potions/' },
      ],
    },
    zg: {
      encounters: [
        { boss:'Bloodlord Mandokir', note:'Run 3 tanks — one on Mandokir, two sharing his mounted raptor add away from the raid. Decapitate one-shots a random player and stacks a raid-wide damage buff on him, so minimizing raid exposure to his line of sight helps.', source:'https://www.icy-veins.com/wow-classic/bloodlord-mandokir-guide-strategy-abilities-loot' },
        { boss:'Hakkar', note:'Periodic Blood Siphon stuns and drains the whole raid to heal him — the raid must be pre-stacked with the Poisonous Blood debuff (from an earlier trash mechanic) so the drain damages him instead.', source:'https://www.icy-veins.com/wow-classic/hakkar-guide-strategy-abilities-loot' },
      ],
      consumables: [
        { item:'Restorative Potions', note:'Poison cleansing consumable for the poison-heavy trash and Hakkar mechanics.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
        { item:'Major Mana Potion', note:'Standard caster/healer mana consumable.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
      ],
    },
    aq20: {
      encounters: [
        { boss:'Ayamiss the Hunter', note:'Nature resistance helps whichever tank/off-tank is expected to eat Poison Stinger stacks. Two-phase fight — pause DPS at 70% until the tank re-secures aggro after she lands.', source:'https://www.warcrafttavern.com/wow-classic/guides/ruins-of-ahnqiraj-aq20/' },
        { boss:'Buru the Gorger', note:'DPS race in phase 2 against stacking Creeping Plague damage — no taunt possible.', source:'https://www.warcrafttavern.com/wow-classic/guides/ruins-of-ahnqiraj-aq20/' },
        { boss:'Ossirian the Unscarred', note:'Immune to taunt; Free Action Potions recommended. Dragging him across elemental crystals removes his buff and opens a 45s magic-vulnerability window.', source:'https://www.warcrafttavern.com/wow-classic/guides/ruins-of-ahnqiraj-aq20/' },
      ],
      consumables: [
        { item:'Free Action Potion', note:'Movement-impair immunity, useful for Ossirian.', source:'https://www.warcrafttavern.com/wow-classic/guides/ruins-of-ahnqiraj-aq20/' },
        { item:'Restorative Potions', note:'Poison cleansing for Ayamiss stacks.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
      ],
    },
    aq40: {
      encounters: [
        { boss:'Princess Huhuran', note:'Convention is roughly 150 Nature Resistance from gear (before any Hunter Aspect of the Wild, which adds +50 NR) to reach ~200 NR ahead of her 30%-health Poison Bolt volley; at least ~12 raiders need to hit the threshold.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
        { boss:'Viscidus', note:'Nature resistance gear plus Greater Nature Protection Potions for the raid; melee use Frost Oil since he is Frost-vulnerable (used to shatter him at low HP).', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
        { boss:'Twin Emperors', note:'No raid-wide Nature Resistance requirement; instead needs 2 Warlock "tanks" with high Shadow Resistance and health pools for one Emperor\'s mechanic.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
      ],
      consumables: [
        { item:'Greater Nature Protection Potion', note:'Raid-wide Nature Resist check for Huhuran/Viscidus.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
        { item:'Flask of Supreme Power', note:'Caster damage flask.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
        { item:'Elixir of Greater Agility', note:'Melee agility elixir.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
        { item:'Major Mana Potion', note:'Standard caster/healer mana consumable.', source:'https://www.icy-veins.com/wow-classic/viscidus-guide-strategy-abilities-loot' },
      ],
    },
    naxx: {
      encounters: [
        { boss:'Sapphiron', note:'Heavy Frost Resistance convention against his periodic Frost Aura/chill nova (exact Classic-Era target unconfirmed — bring a dedicated FR set).', source:'https://www.warcrafttavern.com/wotlk/guides/sapphiron-25/' },
        { boss:'Grobbulus', note:'Nature-damage-heavy encounter — Shaman Nature Resistance Totem + Poison Cleansing Totem and Hunter Aspect of the Wild recommended.', utility:'CURE_POISON', source:'https://www.warcrafttavern.com/wow-classic/guides/naxxramas/' },
        { boss:'Loatheb', note:"Shadow-damage-based encounter; his spore mechanic also suppresses healing received.", source:'https://www.warcrafttavern.com/wow-classic/guides/naxxramas/' },
        { boss:'Raid-wide', note:'Tanks are advised to carry backup resist sets for Nature, Frost and Shadow across the different wings.', source:'https://www.warcrafttavern.com/wow-classic/guides/naxxramas/' },
      ],
      consumables: [
        { item:'Flask of Distilled Wisdom', note:'Recommended for long fights (Four Horsemen/KT-tier) — bigger mana pool for extended healing.', source:'https://dotesports.com/streaming/news/world-of-warcraft-classic-naxxramas-raid-consume-checklist' },
        { item:'Greater Frost Protection Potion', note:'Sapphiron\'s Frost Aura/chill damage check.', source:'https://umelfahemgallery.org/wow-raid-consumables-best-buffs-and-potions/' },
        { item:'Greater Shadow Protection Potion', note:'Loatheb/Kel\'Thuzad Shadow damage check.', source:'https://umelfahemgallery.org/wow-raid-consumables-best-buffs-and-potions/' },
      ],
    },

    // ── TBC ──
    kara: {
      encounters: [
        { boss:'Netherspite', note:'Alternates Portal Phase (3 fixed-position colored beams, colors rotate) and Banish Phase (move to the back of the room to avoid Nether Burn/Void Zones); the assigned tank must re-acquire him immediately after each Banish Phase since aggro resets.', source:'https://www.warcrafttavern.com/tbc/guides/karazhan/' },
        { boss:'Prince Malchezaar', note:'Infernals drop and constrain space — avoid standing near them and dodge Shadow Nova; the classic wipe cause is Enfeeble (drops a player to 1 HP) immediately followed by Shadow Nova.', source:'https://www.warcrafttavern.com/tbc/guides/karazhan/' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once — drinking a separate Battle/Guardian elixir on top does nothing until the flask expires.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
        { item:'Drums (Leatherworking)', note:'Drums of Battle/War etc. are party-scoped, not raid-wide — want at least one Leatherworker per party, rotated to cover more of the raid.', source:'https://www.mmo-champion.com/threads/2563633-TBC-Raiding-Drums-of-Battle' },
      ],
    },
    gruul: {
      encounters: [
        { boss:'Gruul / Maulgar', note:'A council-style tank/control plan is needed for every one of Maulgar\'s adds, plus a clear spread rule for Gruul\'s Shatter/Growth mechanics.', source:'https://www.mmogah.com/news/tbc-classic-anniversary/tbc-classic-tier-4-guide-for-beginners-karazhan-gruul-magtheridon' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
        { item:'Drums (Leatherworking)', note:'Party-scoped haste/stat drums — one Leatherworker per party, rotated.', source:'https://www.mmo-champion.com/threads/2563633-TBC-Raiding-Drums-of-Battle' },
      ],
    },
    mag: {
      encounters: [
        { boss:'Magtheridon', note:'Needs assigned Channeler tanks, interrupt groups, Burning Abyssal control, and 5 primary cube-clickers with named backups to interrupt his Shadow Cage channel.', source:'https://www.mmogah.com/news/tbc-classic-anniversary/tbc-classic-tier-4-guide-for-beginners-karazhan-gruul-magtheridon' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
        { item:'Drums (Leatherworking)', note:'Party-scoped haste/stat drums — one Leatherworker per party, rotated.', source:'https://www.mmo-champion.com/threads/2563633-TBC-Raiding-Drums-of-Battle' },
      ],
    },
    ssc: {
      encounters: [
        { boss:'Hydross the Unstable', note:'Two-phase elemental — conventional target is 365 Frost Resistance for the Water Form tank and 365 Nature Resistance for the (typically different) Poison Form tank; each phase transition wipes threat and spawns 4 adds that must be cleared first.', source:'https://www.icy-veins.com/tbc-classic/hydross-the-unstable-guide-strategy-abilities-loot' },
        { boss:'Hydross gear note', note:'A Frost Resist gear set (built around Iceguard pieces) gets a plate tank to roughly 170 FR from gear alone; combined with Frost Resistance Aura/Totem this reaches the 365 target.', source:'https://noobtoboss.com/tbc-classic-serpentshrine-cavern-resistance-gear/' },
      ],
      consumables: [
        { item:'Flask of Relentless Assault', note:'Standard 2-hour physical-DPS flask, persists through death.', source:'https://www.icy-veins.com/tbc-classic/fury-warrior-dps-pve-enchants-consumables' },
        { item:'Elixir of Demonslaying', note:'+2% damage vs. Demons — situational vs. a flask on demon-heavy pulls.', source:'https://www.icy-veins.com/tbc-classic/fury-warrior-dps-pve-enchants-consumables' },
      ],
    },
    tk: {
      encounters: [
        { boss:"Al'ar / Void Reaver / Solarian / Kael'thas", note:'None of the four bosses require resist gear — normal progression gear is sufficient, unlike SSC.', source:'https://www.warcrafttavern.com/tbc/guides/tempest-keep-the-eye-raid-guide/' },
        { boss:"Al'ar", note:'One tank per platform plus an off-tank for Ember of Al\'ar adds.', source:'https://www.warcrafttavern.com/tbc/guides/tempest-keep-the-eye-raid-guide/' },
        { boss:'Void Reaver', note:'Needs 3+ tanks holding high threat since Knock Away repeatedly changes his target.', source:'https://www.warcrafttavern.com/tbc/guides/tempest-keep-the-eye-raid-guide/' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
      ],
    },
    za: {
      encounters: [
        { boss:'Gong / timer', note:'Not a resistance encounter — a timed run. Banging the entrance gong starts a 20-minute timer; Nalorakk (Bear) adds 15 minutes and Akil\'zon (Eagle) adds 10 minutes, giving up to 45 minutes to down all 4 bosses for the Amani War Bear mount.', source:'https://timesaver.gg/blog/tbc-anniversary-zulaman-release-date-amani-war-bear' },
        { boss:'Nalorakk', note:'Bear boss mechanics contribute to the timed-run bonus minutes.', source:'https://www.lootxphub.com/nalorakk-guide-zulaman-boss-strategy-for-tbc-classic/' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
      ],
    },
    hyjal: {
      encounters: [
        { boss:'Rage Winterchill', note:'Single-tank fight, no DPS check; Shaman Frost Resistance Totem / Paladin Frost Resistance Aura recommended if the raid can spare the slot.', source:'https://www.warcrafttavern.com/tbc/guides/rage-winterchill/' },
        { boss:'Anetheron', note:'Healers must stand spread out to avoid a single Carrion Swarm cone hitting multiple healers at once (it also suppresses healing received).', source:'https://www.warcrafttavern.com/tbc/guides/rage-winterchill/' },
        { boss:'Archimonde', note:'Raid carries Tears of the Goddess to survive Air Burst; dedicated decursers strip Grip of the Legion instantly; raid kites Doomfire; avoiding any raid death is critical since each death feeds him a raid-wide Soul Charge nuke.', utility:'REMOVE_CURSE', source:'https://www.warcrafttavern.com/tbc/guides/rage-winterchill/' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
        { item:'Drums (Leatherworking)', note:'Party-scoped haste/stat drums — one Leatherworker per party, rotated.', source:'https://www.mmo-champion.com/threads/2563633-TBC-Raiding-Drums-of-Battle' },
      ],
    },
    bt: {
      encounters: [
        { boss:'Mother Shahraz', note:'Fatal Attraction is a non-binary Shadow debuff (1st tick 1000, 2nd 2000, 3rd+ 3000/9000 per second) — a commonly cited planning benchmark is ~244 total Shadow Resistance for non-tanks, though many guilds target only ~100-150 SR from gear and stack the rest from raid buffs.', source:'https://www.method.gg/wow-classic/shadow-resistance-guide-for-mother-shahraz-in-black-temple' },
        { boss:'Mother Shahraz buff stack', note:'Medallion of Karabor (+40 SR trinket) plus Priest Prayer of Shadow Protection or Paladin Shadow Resistance Aura (+70 SR each, only one active at a time) reduce the gear requirement to roughly 134 SR from items.', source:'https://www.method.gg/wow-classic/shadow-resistance-guide-for-mother-shahraz-in-black-temple' },
      ],
      consumables: [
        { item:'Shadow Resist crafted gear', note:'Best Shadow Resist crafted items require 375 Blacksmithing/Leatherworking/Tailoring and recipes sold by Okuno inside Black Temple, gated behind Ashtongue Deathsworn reputation.', source:'https://www.method.gg/wow-classic/shadow-resistance-guide-for-mother-shahraz-in-black-temple' },
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
      ],
    },
    swp: {
      encounters: [
        { boss:'Kalecgos', note:'Some guilds bring Arcane Resistance; the fight splits the raid between a normal-realm and spectral-realm encounter simultaneously.', source:'https://wowtbc.gg/boss-guides/sunwell-plateau/' },
        { boss:'Brutallus', note:'Pure gear/consumable check — full flask/elixir/food/oil usage expected; very high healing throughput required, extra healer(s) recommended for early attempts.', source:'https://wowtbc.gg/boss-guides/sunwell-plateau/' },
        { boss:"M'uru (Entropius phase)", note:'Needs 1 dedicated tank on Entropius plus 1 tank on adds.', source:'https://wowtbc.gg/boss-guides/sunwell-plateau/' },
      ],
      consumables: [
        { item:'Flask (Battle or Guardian)', note:'A Flask fills both the Battle Elixir and Guardian Elixir slots at once — full consumable usage is expected for Brutallus in particular.', source:'https://noobtoboss.com/tbc-classic-elixir-master-guide/' },
      ],
    },

    // ── Forever (beta) — raids open December 9, 2026; Wowhead's own source
    // lists boss lists, attunement and tier drops as "TBD" (research-wave3.md
    // §1, per tasks/research-forever.md §4). No boss-specific mechanics exist
    // to cite yet, so every Forever raid gets the same placeholder note
    // pointing to the Camping/Campfire system as today's closest analog.
    f_barrow: {
      encounters: [],
      consumables: [
        { item:'No confirmed raid prep data yet', note:'Raids open December 9, 2026. See the Campfires panel for the closest thing to a consumables system today.', source:'https://www.wowhead.com/forever/guide/raids-overview-hub-dates-locations' },
      ],
    },
    f_hyjal: {
      encounters: [],
      consumables: [
        { item:'No confirmed raid prep data yet', note:'Raids open December 9, 2026. See the Campfires panel for the closest thing to a consumables system today.', source:'https://www.wowhead.com/forever/guide/raids-overview-hub-dates-locations' },
      ],
    },
    f_ony: {
      encounters: [],
      consumables: [
        { item:'No confirmed raid prep data yet', note:'Raids open December 9, 2026. See the Campfires panel for the closest thing to a consumables system today.', source:'https://www.wowhead.com/forever/guide/raids-overview-hub-dates-locations' },
      ],
    },
  },

  forRaid(raidKey) { return this.data[raidKey] || null; },

  // Every encounter/consumable item for a raid, each augmented with a
  // `coverage` field (from Readiness.utilityCoverage()) when the item names a
  // `utility` id — lets the UI show whether a provider is actually seated.
  itemsWithCoverage(raidKey, groups, bench) {
    const prep = this.forRaid(raidKey);
    if (!prep) return null;
    const coverage = Readiness.utilityCoverage(groups, bench);
    const covById = {};
    coverage.forEach(c => { covById[c.id] = c; });
    const annotate = (list) => (list || []).map(item => Object.assign({}, item, {
      coverage: item.utility && covById[item.utility] ? covById[item.utility] : null,
    }));
    return { encounters: annotate(prep.encounters), consumables: annotate(prep.consumables) };
  },

  // Chat-safe raid-chat text, <=255 UTF-8 bytes/line — same convention as
  // Import.exportChatText's compact mode. Uses the shared chatSafe()/
  // clipUtf8Bytes() helpers (see UTILITIES): source notes are prose lifted
  // from research docs and use em/en dashes as clause separators (e.g.
  // "...interval) — keep a Hunter available."); chatSafe() normalizes those
  // to a plain '-' in place rather than deleting them (which used to leave a
  // double space behind).
  toChatText(raidKey) {
    const prep = this.forRaid(raidKey);
    if (!prep) return '';
    const clip = (line) => clipUtf8Bytes(chatSafe(line), 255);
    const lines = [];
    const raidName = chatSafe((Config.Raids[raidKey] || {}).name || raidKey);
    lines.push(clip(`${raidName} - Raid Prep`));
    (prep.encounters || []).forEach(e => lines.push(clip(`${e.boss ? e.boss + ': ' : ''}${e.note}`)));
    if ((prep.consumables || []).length) {
      lines.push(clip('Consumables:'));
      prep.consumables.forEach(c => lines.push(clip(`- ${c.item}${c.note ? ' - ' + c.note : ''}`)));
    }
    return lines.join('\n');
  },
};

// ── RAID-HELPER VERSION DETECTION (backlog #13) ────────────────────
// Pure function: a Raid-Helper event's templateId -> a GameVersions key, or
// null when unrecognized. Only 'wowtbc' is confirmed (research-wave3.md §3 —
// a live, unauthenticated fetch of a real TBC event). The classic/forever
// heuristics below are an UNCONFIRMED guess at Raid-Helper's naming
// convention (no other templateId has ever been observed) — kept only as a
// last-resort, suggestion-only signal per the feature spec, never treated as
// authoritative or applied automatically.
function detectVersionFromTemplateId(templateId) {
  if (!templateId || typeof templateId !== 'string') return null;
  const id = templateId.toLowerCase();
  if (id === 'wowtbc') return 'tbc';
  // UNCONFIRMED heuristic fallback — see comment above.
  if (id.includes('forever')) return 'forever';
  if (id.includes('classic') || id.includes('era')) return 'classic';
  return null;
}

// ── PRINTABLE RAID SHEET (backlog #12) ─────────────────────────────
// Pure builder: turns the current State/Config into a static HTML string for
// the print-only #print-sheet container. No DOM reads, same shape as
// Import.exportChatText — kept above the UI-RENDERING split so it's covered
// by the node test suites. Colors are intentionally omitted (fixed black text
// in the @media print CSS) so the sheet stays legible on a printed page.
const PrintSheet = {
  // Local, DOM-free HTML escaper (the global esc() needs document.createElement,
  // which would make this module untestable under Node) — same escaping rules,
  // just implemented with a regex instead of a throwaway element.
  _esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  },
  build() {
    const esc = this._esc;
    const raidInfo = Config.Raids[State.selectedRaid] || {};
    const versionLabel = (GameVersions[State.gameVersion] || {}).name || State.gameVersion;
    const dateStr = PlanStore.dayLabel();
    const rosterLabel = State.rosterName && State.rosterName !== NO_ROSTER_NAME ? State.rosterName : 'Unnamed Roster';
    const modeled = !!(GameVersions[State.gameVersion] || {}).modeled;

    const playerLabel = (p) => `${esc(p.name)} (${esc(p.spec || '')} ${esc(RosterEdit.ClassLabel(p.class))})`;

    const groupsHTML = (State.groups || []).map((group, gi) => {
      if (!group || !group.length) return '';
      const buffList = modeled ? getGroupBuffs(group, gi) : [];
      const buffNames = buffList.map(b => Config.BuffAbbreviations[b.id] || b.buff.name).join(', ');
      const playersHTML = group.map(p => `<li>${playerLabel(p)}</li>`).join('');
      return `<div class="ps-group"><h4>Group ${gi + 1}</h4><ul>${playersHTML}</ul>${buffNames ? `<div class="ps-buffs">Buffs: ${esc(buffNames)}</div>` : ''}</div>`;
    }).join('');

    const bench = State.bench || [];
    const benchHTML = bench.length
      ? `<div class="ps-bench"><h4>Bench</h4><ul>${bench.map(p => `<li>${playerLabel(p)}</li>`).join('')}</ul></div>`
      : '';

    const players = State.roster || [];
    const healerTanks = Assignments.effectiveHealerTanks(players);
    const healerRows = Object.entries(healerTanks).map(([h, t]) => `<li>${esc(h)} &rarr; ${esc(t)}</li>`).join('');

    const blessings = Assignments.effectiveBlessings(players);
    const blessingCatalog = Assignments.blessingCatalog();
    const blessingRows = Object.entries(blessings).map(([id, name]) => `<li>${esc((blessingCatalog[id] || {}).name || id)}: ${esc(name)}</li>`).join('');

    const debuffAssignments = Assignments.effectiveDebuffs(players);
    const debuffDefs = activeRules().debuffs || {};
    const debuffRows = Object.entries(debuffAssignments).map(([id, name]) => `<li>${esc((debuffDefs[id] || {}).name || id)}: ${esc(name)}</li>`).join('');

    const customRows = Assignments.customRows().map(row => ({ row, who: row.players.filter(n => players.some(p => p.name === n)) })).filter(c => c.who.length);
    const customItems = customRows.map(({ row, who }) => `<li>${row.mark ? esc(Assignments.RAID_MARKS[row.mark - 1]) + ' ' : ''}${esc(row.label)}: ${who.map(esc).join(', ')}</li>`).join('');

    const notes = (State.notes || '').trim();

    return `
      <div class="ps-header">
        <h1>${esc(raidInfo.name || 'Raid')}</h1>
        <div class="ps-meta">${esc(versionLabel)} &middot; ${esc(dateStr)} &middot; ${esc(rosterLabel)}</div>
      </div>
      <div class="ps-groups">${groupsHTML}</div>
      ${benchHTML}
      <div class="ps-assignments">
        ${healerRows ? `<div class="ps-assign-col"><h4>Healer &rarr; Tank</h4><ul>${healerRows}</ul></div>` : ''}
        ${blessingRows ? `<div class="ps-assign-col"><h4>Blessings</h4><ul>${blessingRows}</ul></div>` : ''}
        ${debuffRows ? `<div class="ps-assign-col"><h4>Boss Debuffs</h4><ul>${debuffRows}</ul></div>` : ''}
        ${customItems ? `<div class="ps-assign-col"><h4>Custom</h4><ul>${customItems}</ul></div>` : ''}
      </div>
      ${notes ? `<div class="ps-notes"><h4>Notes</h4><p>${esc(notes)}</p></div>` : ''}
    `;
  },
};

// ── ATTENDANCE HISTORY (feature-backlog-2.md #2) ──────────────────
// Pure aggregator over named saved rosters (pp_rosters), keyed by
// gameVersion. Deliberately reads only intentional "Save" entries, not
// pp_import_history's unnamed auto-snapshots: a raid leader who named and
// saved a roster is a clean, curated record, while import history is a
// superset of the same shape (Import.exportRoster()) that would double
// count drafts nobody chose to keep. No new persisted state — this is a
// read-only report over storage that already exists.
//
// Algorithm (per version): collect the set of every player name that ever
// appears (seated or benched) across that version's saved entries, then for
// every entry classify every known name as seated / benched / absent —
// "absent" meaning the entry exists but that name appears in neither its
// players nor its bench list. This intentionally also counts a name as
// "absent" for entries recorded before that player ever joined the roster;
// there is no join-date concept to distinguish "not in this raid" from
// "hadn't recruited them yet" with the data saved rosters carry today.
function computeAttendance(savedRosters) {
  const entries = Object.values(savedRosters || {})
    .filter(r => r && Array.isArray(r.players) && Number.isFinite(r.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const namesByVersion = {};
  for (const entry of entries) {
    const version = entry.gameVersion || 'tbc';
    const set = namesByVersion[version] || (namesByVersion[version] = new Set());
    for (const p of entry.players) { if (p && p.name) set.add(p.name); }
    for (const p of (entry.bench || [])) { if (p && p.name) set.add(p.name); }
  }

  const rowsByVersion = {};
  for (const entry of entries) {
    const version = entry.gameVersion || 'tbc';
    const rows = rowsByVersion[version] || (rowsByVersion[version] = {});
    const seatedNames = new Set(entry.players.filter(p => p && p.name).map(p => p.name));
    const benchedNames = new Set((entry.bench || []).filter(p => p && p.name).map(p => p.name));
    for (const name of namesByVersion[version]) {
      const row = rows[name] || (rows[name] = { name, seated: 0, benched: 0, absent: 0, entries: 0, lastSeen: null });
      row.entries++;
      if (seatedNames.has(name)) { row.seated++; row.lastSeen = entry.timestamp; }
      else if (benchedNames.has(name)) { row.benched++; row.lastSeen = entry.timestamp; }
      else row.absent++;
    }
  }

  const result = {};
  for (const version of Object.keys(rowsByVersion)) {
    result[version] = Object.values(rowsByVersion[version]).sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

// ── COMPARE OPTIMIZER MODES (feature-backlog-2.md #5) ─────────────
// Runs the real Optimizer once per MODE_CONFIG key against a snapshot of the
// currently seated roster, entirely off to the side of the live board: every
// State field the optimizer reads or writes is saved up front and restored
// (to the exact original reference where possible) once all four runs are
// done, so the live groups/bench, undo stack and autosave are never touched.
// Preferred-slot requests are cleared for the comparison runs only (they
// would otherwise make every mode look identical) and restored afterward.
function compareOptimizerModes() {
  if (!GameVersions[State.gameVersion].modeled) return null;
  if (!(State.groups || []).some(g => g.length) && !(State.bench || []).length) return null;

  const savedGroups = State.groups;
  const savedBench = State.bench;
  const savedRoster = State.roster;
  const savedMode = State.optimizerMode;
  const savedPreferredSlots = State.preferredSlots;

  const baseGroups = JSON.parse(JSON.stringify(savedGroups || []));
  const baseBench = JSON.parse(JSON.stringify(savedBench || []));

  const results = {};
  // try/finally: an exception from the optimizer or the summary must not leave
  // the live board holding a comparison run's layout.
  try {
    for (const mode of Object.keys(MODE_CONFIG)) {
      State.groups = JSON.parse(JSON.stringify(baseGroups));
      State.bench = JSON.parse(JSON.stringify(baseBench));
      State.preferredSlots = [];
      State.optimizerMode = mode;
      Optimizer.optimize();
      results[mode] = summarizeCandidateLayout(State.groups, State.bench);
      // Exposed for tests (and any future debug UI) to verify byte-for-byte
      // that Compare's candidate layout matches a direct Optimizer.optimize()
      // call with the same inputs/mode — these are already local clones made
      // above, not references into the live board.
      results[mode].groups = State.groups;
      results[mode].bench = State.bench;
    }
  } finally {
    State.groups = savedGroups;
    State.bench = savedBench;
    State.roster = savedRoster;
    State.optimizerMode = savedMode;
    State.preferredSlots = savedPreferredSlots;
  }
  return results;
}

// Buff/debuff coverage + a few headline structural facts for one candidate
// layout. Read-only over the groups/bench it is given — never touches State
// beyond the ambient reads getGroupBuffs/getRaidBuffCoverage already do.
function summarizeCandidateLayout(groups, bench) {
  const buffCoverage = getRaidBuffCoverage(groups);
  const debuffCoverage = getRaidDebuffCoverage(groups);
  const allBuffIds = Object.keys(Config.Buffs || {});
  const allDebuffIds = Object.keys(Config.Debuffs || {});
  const missingBuffs = allBuffIds.filter(id => !buffCoverage.has(id)).map(id => Config.Buffs[id].name);
  const missingDebuffs = allDebuffIds.filter(id => !debuffCoverage.has(id)).map(id => Config.Debuffs[id].name);

  const hasWindfury = !!Config.Buffs.WINDFURY;
  const meleeGroups = hasWindfury ? groups.filter(g => g.some(p => p.role === 'melee_dps')) : [];
  const meleeGroupsWithWindfury = hasWindfury
    ? groups.reduce((count, g, gi) => count + (g.some(p => p.role === 'melee_dps') &&
        getGroupBuffs(g, gi).some(b => b.id === 'WINDFURY') ? 1 : 0), 0)
    : null;

  const mitBuffIds = new Set(Object.keys((activeRules().mitValue) || {}));
  const tankMitigation = groups.map((g, gi) => ({ groupIndex: gi + 1, group: g, gi }))
    .filter(({group}) => group.some(p => p.role === 'tank'))
    .map(({groupIndex, group, gi}) => ({
      groupIndex,
      buffs: [...new Set(getGroupBuffs(group, gi).filter(b => mitBuffIds.has(b.id)).map(b => Config.Buffs[b.id]?.name || b.id))],
    }));

  return {
    seatedCount: groups.flat().length,
    benchedCount: bench.length,
    groupCount: groups.filter(g => g.length).length,
    buffsCoveredCount: buffCoverage.size,
    buffsTotal: allBuffIds.length,
    missingBuffs,
    missingDebuffs,
    meleeGroupsWithWindfury,
    meleeGroupsTotal: hasWindfury ? meleeGroups.length : null,
    tankMitigation,
  };
}

