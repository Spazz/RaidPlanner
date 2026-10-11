/* ================================================================
   PARTY PLANNER WEB — Full TBC Raid Group Builder
   Ported from the WoW addon Lua codebase
   ================================================================ */

// ── UTILITIES ───────────────────────────────────────────────────
// Regex-based (not DOM-round-trip) so it also escapes the characters that
// matter in HTML ATTRIBUTE position, not just text-node position: the old
// document.createElement/textContent trick only produced &amp;/&lt;/&gt;,
// which left every `attr="${esc(name)}"` call site open to attribute-
// injection from a raw " or ' in a player/template/roster name. Also keeps
// esc() DOM-free so it can be unit-tested under Node and used by PrintSheet.
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
let _uid = 0;
function nextUid() { return 'p' + (++_uid); }

// ── CHAT-SAFE TEXT (shared by every raid-chat/Discord text exporter) ──
// WoW's client fonts and chat parser render printable ASCII plus the accented
// Latin letters that real WoW character names commonly use (Latin-1
// Supplement / Latin Extended-A/B — e.g. "Thràll", "Jaïna", "Äsh"), but not
// emoji, CJK, symbols, or box-drawing glyphs. Deleting those accented letters
// outright (the old per-exporter behavior) corrupted player names
// ("Thràll" -> "Thrll"). This normalizes common "smart" punctuation to plain
// ASCII first (so meaning survives), strips everything else outside the safe
// ranges, and collapses whitespace runs the stripping leaves behind.
function chatSafe(str) {
  let s = String(str == null ? '' : str)
    .replace(/[‐-―−]/g, '-')        // hyphen/dash variants, minus sign
    .replace(/[‘’‚‛]/g, "'")   // curly single quotes
    .replace(/[“”„‟]/g, '"')   // curly double quotes
    .replace(/…/g, '...')                      // ellipsis
    .replace(/[•‣◦⁃∙·]/g, '-') // bullets / middle dot
    .replace(/[←→↔⇐⇒⇔]/g, '->'); // arrows
  // Keep printable ASCII plus Latin-1 Supplement / Latin Extended-A/B letters
  // (U+00C0-U+024F), excluding the multiplication (U+00D7) and division
  // (U+00F7) signs that live in that block but aren't letters. Everything
  // else (emoji, CJK, symbols, box drawing, control chars) is dropped.
  s = s.replace(/[^\x20-\x7EÀ-ÖØ-öø-ɏ]/g, '');
  return s.replace(/ {2,}/g, ' ');
}
// Truncates `str` to at most `maxBytes` UTF-8 bytes without splitting a
// multi-byte character in half, appending '.' when truncation happens
// (mirrors the old char-count cap's truncation marker). WoW's /raid chat
// 255-character limit is actually a 255-BYTE limit, and an accented letter
// kept by chatSafe() can take 2 bytes.
function clipUtf8Bytes(str, maxBytes = 255) {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length <= maxBytes) return str;
  let end = maxBytes - 1; // reserve a byte for the trailing '.'
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--; // don't split a UTF-8 continuation byte
  return new TextDecoder().decode(bytes.slice(0, end)) + '.';
}
// Shared by the global keyboard-shortcut dispatcher (past the UI split
// marker) and input-tests.js. True when the given target is actively
// capturing text input, so a shortcut keystroke must not be hijacked from
// a player-name field, a raid-notes textarea, the JSON-paste box, etc.
// Duck-typed on purpose so it can be unit-tested with plain mock objects.
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return !!el.isContentEditable;
}

// ── CONFIG ──────────────────────────────────────────────────────
// The lookup maps (class colours, roles, Raid-Helper maps, icon slugs, badge abbreviations and CSS classes) are the
// shared catalog, js/rules/catalog.js (RulesData.catalog). What a game version owns (buffs, debuffs, raids, weights,
// utilities) is in js/rules/<version>.js and reaches the app compiled, through Rulesets below. The accessors (Specs,
// Buffs, Debuffs, RaidOrder, RaidHelperSpecMap, Utilities) read the version in play; Raids is filled in once the
// rulesets are compiled.
const Config = {
  ClassColors: RulesData.catalog.classColors,

  Roles: RulesData.catalog.roles,

  // Specs and the Raid-Helper spec map come with every compiled ruleset (from the catalog); a version without a
  // ruleset falls back to the TBC copy.
  get Specs() { return activeRules().specs || Rulesets.tbc.specs; },

  get Buffs() { return activeRules().buffs || {}; },

  BuffAbbreviations: RulesData.catalog.buffAbbreviations,

  BuffCSSClass: RulesData.catalog.buffCSSClass,

  // Icon files are self-hosted in icons/ (one <name>.jpg per slug, fetched once from the
  // Wowhead CDN); every spec/class/role/buff/debuff icon goes through this one URL builder.
  IconURL(name) {
    return name ? `/icons/${name}.jpg` : '';
  },

  BuffIcons: RulesData.catalog.buffIcons,
  BuffIconURL(id) {
    return this.IconURL(this.BuffIcons[id]);
  },

  get Debuffs() { return activeRules().debuffs || {}; },

  DebuffAbbreviations: RulesData.catalog.debuffAbbreviations,

  DebuffIcons: RulesData.catalog.debuffIcons,
  DebuffIconURL(id) {
    return this.IconURL(this.DebuffIcons[id]);
  },

  // The flat merge of every version's raids, so any raid id resolves whichever version is active. Filled in below,
  // once the rulesets are compiled.
  Raids: {},
  get RaidOrder() { return GameVersions[State.gameVersion].raids; },
  TierOrder: ['Tier 4', 'Tier 5', 'Tier 6'],

  // Minimum tanks and healers a raid of this size must seat before DPS
  // compete for the remaining seats (when more signed up than the raid
  // holds), and the roles OpenSlots suggests first for empty seats. Readiness
  // reports "N healers short" against them. These are planning floors chosen
  // for this tool, not a game rule — 20/40 are Classic Era raid sizes.
  RaidFloors: {
    10: { tank: 2, healer: 3 },
    20: { tank: 2, healer: 4 },
    25: { tank: 2, healer: 5 },
    40: { tank: 4, healer: 10 },
  },

  RaidHelperClassMap: RulesData.catalog.raidHelperClassMap,

  // Least-wrong per-class default role for a Raid-Helper sign-up that only
  // chose a class, no spec (backlog #2, 2026-09-26) — this class's single
  // most common raid role. Every one of these is a guess the leader should
  // confirm, hybrids (Shaman/Druid) no more so than any other entry here —
  // Import._resolveRaidHelperEntry always pairs this with needsReview so the
  // guess is never mistaken for a confidently-resolved sign-up.
  DefaultRoleForClass: RulesData.catalog.defaultRoleForClass,

  get RaidHelperSpecMap() { return activeRules().raidHelperSpecMap || Rulesets.tbc.raidHelperSpecMap; },

  // Utility checklist (Battle Rez, cleanses, Bloodlust, ...) of the version in play: its own `utilities` in
  // js/rules/<version>.js. No version borrows another's list (Forever's started as a copy of Classic's).
  get Utilities() { return activeRules().utilities || {}; },
};

// ── RULESET REGISTRY ────────────────────────────────────────────
// Every piece of version-specific game-rules data (buffs, debuffs, specs, raids, the optimizer's value tables and
// scoring hooks) is looked up through here, one key per GameVersion. Each ruleset is compiled once at load from the
// version's data file (js/rules/<version>.js, edited by hand) and the shared catalog (js/rules/catalog.js);
// activeRules() picks the one for the version in play.
const Rulesets = {};

// ── CONVENTIONS SCHEMA ──────────────────────────────────────────
// The closed list of the keys of a version file's `conventions` block: the optimizer's tuning numbers and flags (the
// scorer reads them as rules.rules.<key>), each with its type: 'number', 'boolean' or 'number|null' (healerCapOverFloor
// only: null means no cap, the one off state that has no number). `modeConfig` (the objective weights of the four
// optimizer modes) and `openSlots` (the Open-slot pricing scalars) are nested blocks of numbers. Every version file lists
// every key (0, false and null are how a version switches a rule off) and Rulesets.compile throws on a missing, an
// unknown or a mistyped key, so a misspelled knob fails at load instead of being ignored. rules-data-tests.js checks
// the data files, this list and the keys js/*.js reads against each other. Non-enumerable on purpose, like compile:
// Rulesets is iterated as the registry of versions (Object.keys / Object.entries).
Object.defineProperty(Rulesets, 'CONVENTIONS', {
  enumerable: false,
  value: (function () {
    const modeWeights = Object.freeze({ dps: 'number', mit: 'number', structure: 'number', cohesion: 'number' });
    return Object.freeze({
      meleeWantsWindfury: 'boolean',
      ferociousInspiration: 'boolean',
      rosterShapedIdentities: 'boolean',
      rotationSearch: 'boolean',
      meleeWantsWindfuryCost: 'number',
      enhWindfuryBonus: 'number',
      meleeGroupWindfuryBias: 'number',
      retEnhPairBonus: 'number',
      surplusEnhCost: 'number',
      ferociousInspirationStacking: 'number',
      hunterSpread: 'number',
      hunterSpreadEnh: 'number',
      hunterInCasterGroup: 'number',
      hunterTankGuestCost: 'number',
      tankGroupHealers: 'number',
      tankGroupHealerCost: 'number',
      loneRestoTankCost: 'number',
      tankGroupGuestCost: 'number',
      healerGroupDpsPull: 'number',
      cohesionMatch: 'number',
      cohesionCompatible: 'number',
      cohesionMismatch: 'number',
      groupSizePressure: 'number',
      healerCapOverFloor: 'number|null',
      extraEleNeedsBoomkin: 'number',
      modeConfig: Object.freeze({ max_dps: modeWeights, tank_mit: modeWeights, balanced: modeWeights, relaxed: modeWeights }),
      openSlots: Object.freeze({ utilityBonus: 'number', specRepeat: 'number', classCrowd: 'number', classCrowdFree: 'number' }),
    });
  })(),
});

// ── RULES DATA COMPILER ─────────────────────────────────────────
// Rulesets.compile(data, catalog) turns one version's data file (RulesData.tbc / .classic / .forever, js/rules/*.js)
// plus the shared catalog (RulesData.catalog, js/rules/catalog.js) back into the ruleset shape the app reads from
// Rulesets.<version>: buffs and debuffs under the field names the code reads (benefitsRoles, value: { tier, who }), the
// slot tables derived from buffType (totemElements, paladinAuras, shouts, cooldownTotems), the optimizer's value tables
// rebuilt from each buff's `weight` (dpsValue, mitValue, sustainValue) next to dpsWeight / dpsWeightByRole, `rules`
// (conventions, specAura, spreadProviders, factionLock, exclusiveBuffs as a list of sets, and tankAnchorRank /
// healerGroupDps / stackPenalty[].match rebuilt as functions from the matcher data), utilities, raids, modeConfig and
// openSlots; specs, raidHelperSpecMap, classList and specIcons come from the catalog. Pure: the inputs are copied,
// never changed, and nothing outside the returned object is touched. It throws on data it cannot read faithfully (an
// unknown buffType, debuffType or scope, a totem without a totemElement, a `conventions` block that is not exactly
// Rulesets.CONVENTIONS, ...), so a bad edit fails at load and in rules-data-tests.js. (The Ideal-comp builders,
// js/app.js, and the blessing catalog, js/analysis.js, are code and not part of the data.) Non-enumerable on purpose:
// Rulesets is iterated as the registry of versions (Object.keys / Object.entries), and compile is not one.
Object.defineProperty(Rulesets, 'compile', {
  enumerable: false,
  value: (function () {
    const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const problem = message => new Error(`Rulesets.compile: ${message}`);
    // The closed vocabularies of the data files (tasks/rules-data-refactor.md); rules-data-tests.js pins the same lists.
    // debuffType is descriptive only, but a typo in it still fails loudly here instead of staying unnoticed.
    const BUFF_TYPES = ['totem', 'paladinAura', 'warriorShout', 'passive'];
    const BUFF_SCOPES = ['party', 'raid'];
    const DEBUFF_TYPES = [
      'armor', 'attackPower', 'magicVulnerability', 'physicalVulnerability', 'attackSpeed', 'hitChance',
      'holyVulnerability', 'healOnHit', 'manaOnHit', 'other',
    ];
    // The Open-slot `who` of a debuff by the roles it helps (roles sorted and comma-joined).
    const DEBUFF_WHO_BY_ROLES = {
      'melee_dps,ranged_dps': 'physical', ranged_dps: 'ranged', caster_dps: 'caster', tank: 'tank',
      'caster_dps,melee_dps,ranged_dps': 'all',
    };

    // weight.dps is one flat map; the optimizer's tables keep three: exact 'CLASS:Spec' keys, bare class names, role
    // names. Every compiled entry carries a role map (empty for a buff that is worth nothing to any recipient).
    function dpsValueFrom(id, flat, catalog) {
      const value = { role: {} };
      for (const [name, weight] of Object.entries(flat)) {
        const isKey = name.includes(':') && catalog.classes.includes(name.split(':')[0]);
        const part = isKey ? 'key' : catalog.classes.includes(name) ? 'class' : Object.values(catalog.roles).includes(name) ? 'role' : null;
        if (!part) throw problem(`${id} weight.dps names "${name}", which is no CLASS:Spec key, class or role`);
        (value[part] = value[part] || {})[name] = weight;
      }
      return value;
    }

    function compileBuffs(data, catalog) {
      const out = { buffs: {}, totemElements: {}, paladinAuras: {}, shouts: [], cooldownTotems: [], dpsValue: {}, mitValue: {}, sustainValue: {} };
      for (const [id, entry] of Object.entries(data.buffs || {})) {
        if (!Array.isArray(entry.targetRoles)) throw problem(`${id} has no targetRoles list`);
        if (!BUFF_TYPES.includes(entry.buffType)) throw problem(`${id} has unknown buffType "${entry.buffType}"`);
        if (!BUFF_SCOPES.includes(entry.scope)) throw problem(`${id} has unknown scope "${entry.scope}"`);
        const buff = { name: entry.name, sourceClass: entry.sourceClass };
        if (entry.sourceSpec) buff.sourceSpec = entry.sourceSpec;
        if (entry.preferSpec) buff.preferSpec = entry.preferSpec;
        buff.benefitsRoles = [...entry.targetRoles];
        buff.priority = copy(entry.priority);
        buff.desc = entry.desc;
        out.buffs[id] = buff;

        if (entry.buffType === 'totem') {
          if (!entry.totemElement) throw problem(`totem ${id} has no totemElement`);
          out.totemElements[id] = entry.totemElement;
          if (entry.cooldownTotem) out.cooldownTotems.push(id);
        } else if (entry.buffType === 'paladinAura') {
          out.paladinAuras[id] = true;
        } else if (entry.buffType === 'warriorShout') {
          out.shouts.push(id);
        }

        const weight = entry.weight || {};
        if (weight.dps) out.dpsValue[id] = dpsValueFrom(id, weight.dps, catalog);
        if (weight.mitigation) out.mitValue[id] = copy(weight.mitigation);
        if (weight.sustain !== undefined) out.sustainValue[id] = weight.sustain;
      }
      return out;
    }

    // Buffs that share one slot per party are listed on every member of the set. Rebuild each set once, starting from
    // its first member in buff order (a tie in value keeps the first member), and check that all members agree.
    function exclusiveSetsFrom(buffs) {
      const sets = [];
      const placed = new Set();
      for (const [id, entry] of Object.entries(buffs)) {
        if (placed.has(id) || !entry.exclusiveBuffs || !entry.exclusiveBuffs.length) continue;
        const set = [id, ...entry.exclusiveBuffs];
        for (const member of set) {
          const listed = (buffs[member] && buffs[member].exclusiveBuffs) || [];
          const others = set.filter(other => other !== member);
          if (listed.length !== others.length || !others.every(other => listed.includes(other))) {
            throw problem(`exclusiveBuffs of ${id} and ${member} do not list each other`);
          }
          placed.add(member);
        }
        sets.push(set);
      }
      return sets;
    }

    function debuffWho(id, entry) {
      if (!Array.isArray(entry.targetRoles)) throw problem(`${id} has no targetRoles list`);
      const roles = [...entry.targetRoles].sort().join();
      if (entry.targetSchool) {
        if (roles !== 'caster_dps') throw problem(`${id} has a targetSchool but targets ${roles}; a school narrows casters only`);
        return entry.targetSchool;
      }
      const who = DEBUFF_WHO_BY_ROLES[roles];
      if (!who) throw problem(`${id} targets ${roles}, which the Open-slot pricing has no group for`);
      return who;
    }

    function compileDebuffs(debuffs) {
      const out = {};
      for (const [id, entry] of Object.entries(debuffs || {})) {
        if (!DEBUFF_TYPES.includes(entry.debuffType)) throw problem(`${id} has unknown debuffType "${entry.debuffType}"`);
        const debuff = { name: entry.name, sourceClass: entry.sourceClass };
        if (entry.sourceSpec) debuff.sourceSpec = entry.sourceSpec;
        debuff.desc = entry.desc;
        if (entry.competesWith) debuff.competesWith = [...entry.competesWith];
        if (entry.supersededBy) debuff.supersededBy = entry.supersededBy;
        debuff.value = { tier: entry.weight, who: debuffWho(id, entry) };
        out[id] = debuff;
      }
      return out;
    }

    // { class, spec? } -> predicate over a player; no spec = every spec of the class.
    const matcherFor = ({ class: className, spec }) => (spec === undefined
      ? p => p.class === className
      : p => p.class === className && p.spec === spec);

    // `conventions` must be exactly Rulesets.CONVENTIONS: every key present, none unknown, each of its type (the nested
    // modeConfig and openSlots blocks key by key). All problems come back together, so a misspelled key shows both the
    // unknown name and the missing one.
    const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
    const CONVENTION_TYPES = {
      number: { accepts: isFiniteNumber, label: 'a number' },
      boolean: { accepts: value => typeof value === 'boolean', label: 'a boolean' },
      'number|null': { accepts: value => value === null || isFiniteNumber(value), label: 'a number or null' },
    };
    const shown = value => (typeof value === 'string' ? JSON.stringify(value) : String(value));
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    function conventionProblems(schema, block, where) {
      if (!isPlainObject(block)) return [`${where} must be an object, not ${shown(block)}`];
      const found = [];
      for (const key of Object.keys(block)) {
        if (!hasOwn(schema, key)) found.push(`${where}.${key} is not a known key (the keys are Rulesets.CONVENTIONS)`);
      }
      for (const [key, rule] of Object.entries(schema)) {
        if (!hasOwn(block, key)) found.push(`${where}.${key} is missing (every version file lists every key)`);
        else if (typeof rule === 'object') found.push(...conventionProblems(rule, block[key], `${where}.${key}`));
        else if (!CONVENTION_TYPES[rule].accepts(block[key])) found.push(`${where}.${key} must be ${CONVENTION_TYPES[rule].label}, not ${shown(block[key])}`);
      }
      return found;
    }

    function compileRules(data, exclusiveBuffs) {
      const problems = conventionProblems(Rulesets.CONVENTIONS, data.conventions, 'conventions');
      if (problems.length) throw problem(problems.join('; '));
      const conventions = copy(data.conventions);
      const { modeConfig, openSlots } = conventions;
      delete conventions.modeConfig;
      delete conventions.openSlots;

      const rules = {};
      if (data.tankAnchorOrder) {
        const order = [...data.tankAnchorOrder];
        rules.tankAnchorRank = p => { const at = order.indexOf(p.class); return at < 0 ? order.length : at; };
      }
      Object.assign(rules, conventions);
      if (data.specAura) rules.specAura = copy(data.specAura);
      if (data.spreadProviders) rules.spreadProviders = copy(data.spreadProviders);
      if (data.factionLock !== undefined) rules.factionLock = data.factionLock;
      if (exclusiveBuffs.length) rules.exclusiveBuffs = exclusiveBuffs;
      if (data.healerGroupDps) {
        const matchers = data.healerGroupDps.map(matcherFor);
        rules.healerGroupDps = p => matchers.some(match => match(p));
      }
      if (data.stackPenalty) {
        rules.stackPenalty = data.stackPenalty.map(entry => ({ match: matcherFor(entry), weight: entry.weight }));
      }
      return { rules, modeConfig, openSlots };
    }

    return function compile(data, catalog) {
      if (!data || typeof data !== 'object') throw new TypeError('Rulesets.compile: the version data is required');
      if (!catalog || typeof catalog !== 'object') throw new TypeError('Rulesets.compile: the catalog is required');
      const buffs = compileBuffs(data, catalog);
      const { rules, modeConfig, openSlots } = compileRules(data, exclusiveSetsFrom(data.buffs || {}));

      const ruleset = {
        buffs: buffs.buffs,
        debuffs: compileDebuffs(data.debuffs),
        specs: copy(catalog.specs),
        raidHelperSpecMap: copy(catalog.raidHelperSpecMap),
        classList: copy(catalog.classes),
        specIcons: copy(catalog.specIcons),
        totemElements: buffs.totemElements,
        paladinAuras: buffs.paladinAuras,
      };
      if (buffs.shouts.length) ruleset.shouts = buffs.shouts;
      ruleset.bestAirTotem = copy(data.bestAirTotem || {});
      ruleset.bestPaladinAura = copy(data.bestPaladinAura || {});
      ruleset.rules = rules;
      if (data.utilities) ruleset.utilities = copy(data.utilities);
      ruleset.dpsValue = buffs.dpsValue;
      ruleset.mitValue = buffs.mitValue;
      ruleset.sustainValue = buffs.sustainValue;
      ruleset.dpsWeight = copy(data.specDpsWeight || {});
      ruleset.dpsWeightByRole = copy(data.roleDpsWeight || {});
      ruleset.cooldownTotems = buffs.cooldownTotems;
      ruleset.raids = copy(data.raids || {});
      // Re-create the id-keyed tables as fresh objects. They were filled by keyed stores (out[id] = ...), and V8 turns an
      // object filled that way into a slow dictionary-mode one once it passes roughly 16-20 keys; Object.entries(Config.Buffs)
      // in Optimizer.resolveBuffSources (the optimizer's hot loop) then runs about 2.6x slower and Optimize about 1.5x. A
      // spread copy is a fast-properties object whatever its size, so a hand edit that adds entries cannot bring it back.
      // `rules` (about 30 keys now that every convention is written out; the scorer reads it on every groupScore call)
      // gets the same treatment.
      for (const key of ['buffs', 'debuffs', 'dpsValue', 'mitValue', 'sustainValue', 'totemElements', 'paladinAuras', 'rules']) {
        ruleset[key] = { ...ruleset[key] };
      }
      ruleset.modeConfig = modeConfig;
      ruleset.openSlots = openSlots;
      return ruleset;
    };
  })(),
});

// The rulesets, compiled once at load (registry order: tbc, classic, forever).
Rulesets.tbc = Rulesets.compile(RulesData.tbc, RulesData.catalog);
Rulesets.classic = Rulesets.compile(RulesData.classic, RulesData.catalog);
Rulesets.forever = Rulesets.compile(RulesData.forever, RulesData.catalog);

// Version profiles: what the version picker shows and where a plan starts. A version's raids are the keys of its
// ruleset's `raids` (its data file), in picker order. `modeled` is derived below from Rulesets - a version is modeled
// iff it has one.
const GameVersions = {
  tbc: { name:'WoW TBC', defaultRaid:'bt', raids:Object.keys(Rulesets.tbc.raids), note:'TBC party buffs and optimization rules.' },
  classic: { name:'WoW Classic', defaultRaid:'mc', raids:Object.keys(Rulesets.classic.raids), note:'WoW Classic Era party buffs, composition and optimizer rules. Faction-aware: Horde shamans, Alliance paladins.' },
  forever: { name:'WoW Forever (Beta)', defaultRaid:'f_ony', raids:Object.keys(Rulesets.forever.raids), note:'Rules follow WoW Forever beta data as of 2026-10-10 (build 1.60.1.70338): Paladin and Shaman on both factions (no faction lock), Trueshot Aura a Marksmanship talent, one Faerie Fire for every Druid, Leader of the Pack/Moonkin Aura one exclusive crit buff, one air totem per party, Sanctity Aura removed, and the confirmed Barrow Deeps/Hyjal Summit/Onyxia\'s Lair raids.' },
};
// Raid ids are unique across versions (Classic's Onyxia is `ony`, Forever's `f_ony`; rules-data-tests.js checks it).
Object.assign(Config.Raids, Rulesets.tbc.raids, Rulesets.classic.raids, Rulesets.forever.raids);

const EMPTY_RULESET = {
  buffs: {}, debuffs: {}, totemElements: {}, paladinAuras: {}, bestAirTotem: {}, bestPaladinAura: {},
  dpsValue: {}, mitValue: {}, sustainValue: {}, dpsWeight: {}, dpsWeightByRole: {}, rules: {}, idealComp: null,
};
// The inputs Optimizer.plan() was given, while it runs. The layout algorithm leans
// on lookups that read State ambiently (the active ruleset, the roster's faction,
// the keep-together/apart pairs, the tagged drummers); inside a plan they read this
// instead, so a plan never touches State. Null outside a plan.
const LayoutScope = {
  current: null,
  run(inputs, fn) {
    const previous = this.current;
    this.current = inputs;
    try { return fn(); } finally { this.current = previous; }
  },
};

function activeVersion() {
  return LayoutScope.current ? LayoutScope.current.gameVersion : State.gameVersion;
}
function activeRules() {
  return Rulesets[activeVersion()] || EMPTY_RULESET;
}
// A version is modeled iff it has a ruleset.
for (const version of Object.keys(GameVersions)) {
  Object.defineProperty(GameVersions[version], 'modeled', { get: () => !!Rulesets[version] });
}

function versionForRaid(raid) {
  return Object.keys(GameVersions).find(v => GameVersions[v].raids.includes(raid));
}
function validVersionRaid(version, raid) {
  return !!GameVersions[version] && GameVersions[version].raids.includes(raid);
}
// What the planner calls a raid since the nav slim-down hid the specific
// instance: its size ("25-man"), or 'Raid' for an unknown key.
function raidSizeLabel(raidKey) {
  const raid = Config.Raids[raidKey];
  return raid ? `${raid.size}-man` : 'Raid';
}
// The raid sizes the Raid size control offers for a version: the sizes of its
// real raids (planning templates left out), smallest first. A plan saved on a
// template whose size no real raid has (classic10) adds that size, so the
// control still shows what the plan is.
function raidSizesFor(version, currentRaid) {
  const profile = GameVersions[version];
  if (!profile) return [];
  const sizes = new Set(profile.raids.map(key => Config.Raids[key])
    .filter(raid => raid && raid.tier !== 'Planning templates').map(raid => raid.size));
  if (profile.raids.includes(currentRaid) && Config.Raids[currentRaid]) sizes.add(Config.Raids[currentRaid].size);
  return [...sizes].sort((a, b) => a - b);
}
// The raid a size pick lands on: the current raid when it already has that
// size, else the version's default raid when it has that size (so BT -> 10 ->
// 25 comes back to Black Temple), else the version's first real raid of that
// size in catalog order (planning templates left out), or null when there is none.
function raidForSize(version, size, currentRaid) {
  const profile = GameVersions[version];
  if (!profile) return null;
  const hasSize = key => profile.raids.includes(key) && !!Config.Raids[key] && Config.Raids[key].size === size;
  if (hasSize(currentRaid)) return currentRaid;
  if (hasSize(profile.defaultRaid)) return profile.defaultRaid;
  return profile.raids.find(key => hasSize(key) && Config.Raids[key].tier !== 'Planning templates') || null;
}

// TBC baseline aliases — plain bindings for code (and tests) that always want
// the TBC tables directly. Version-aware call sites use activeRules() instead.
const TOTEM_ELEMENTS = Rulesets.tbc.totemElements;
const PALADIN_AURAS = Rulesets.tbc.paladinAuras;
const BEST_AIR_TOTEM = Rulesets.tbc.bestAirTotem;
const BEST_PALADIN_AURA = Rulesets.tbc.bestPaladinAura;

// Auras a given paladin can actually run (Sanctity Aura is Retribution-only).
function paladinAurasFor(player) {
  return Object.keys(activeRules().paladinAuras || {}).filter(id => {
    const b = Config.Buffs[id];
    return !b || !b.sourceSpec || b.sourceSpec === player.spec;
  });
}

function getBuffPriority(buff, role) {
  if (!buff) return 0;
  if (typeof buff.priority === 'number') return buff.priority;
  if (typeof buff.priority === 'object') {
    if (role && buff.priority[role] != null) return buff.priority[role];
    return Math.max(...Object.values(buff.priority));
  }
  return 0;
}

