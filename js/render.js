// ── UI RENDERING ────────────────────────────────────────────────
// The planner header's version button shows the short name; its aria-label spells the era out.
const VERSION_BUTTON_TEXT = {
  classic: { text: 'Classic', label: 'WoW Classic' },
  tbc: { text: 'TBC', label: 'TBC Anniversary' },
  forever: { text: 'Forever', label: 'WoW Forever Beta' },
};
// The shell's trail (Guild / Planner / plan name) ends in the plan's name: tell it when the name changes (a rename, another plan opening).
let announcedPlanName = null;
function announcePlanName() {
  if (announcedPlanName === State.rosterName) return;
  announcedPlanName = State.rosterName;
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('planner:plan-name', { detail: { name: State.rosterName } }));
}

function syncVersionControls() {
  const profile = GameVersions[State.gameVersion];
  // Scoped to the real switcher tabs only — the landing page's informational
  // "What's New" version-comparison cards (renderVersionComparison) reuse the
  // same [data-version] attribute/values for styling and would otherwise get
  // a live click handler wired onto them too, silently switching the whole
  // app's game version (and re-fitting the roster) when someone clicks what
  // looks like a plain text panel on the landing page.
  document.querySelectorAll('.game-version-tab[data-version]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.version === State.gameVersion));
    button.onclick = () => switchGameVersion(button.dataset.version);
  });
  // The Raid settings dialog's version segments (the era band is hidden while the planner shows).
  document.querySelectorAll('#raid-version-control [data-version]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.version === State.gameVersion));
  });
  document.getElementById('btn-landing-random').textContent = `Generate a random ${Config.Raids[State.selectedRaid].size}-player roster`;
  // An unmodeled version cannot be optimized: the button is disabled and the reason stands beside it.
  const optimize = document.getElementById('btn-optimize');
  const reason = document.getElementById('optimize-reason');
  optimize.disabled = !profile.modeled;
  if (reason) {
    reason.hidden = profile.modeled;
    reason.textContent = profile.modeled ? '' : 'Optimize needs rules for this version';
  }
  if (profile.modeled) optimize.removeAttribute('aria-describedby');
  else optimize.setAttribute('aria-describedby', 'optimize-reason');
  renderRaidSizeControl();
}
// Switching version refits the plan to the new version's default raid, so with a plan
// loaded it asks first, and afterwards says how many players the smaller raid benched.
async function switchGameVersion(version) {
  if (!Object.prototype.hasOwnProperty.call(GameVersions, version) || version === State.gameVersion) return false;
  // A raid plan saved to the guild's database stays with the raid: switching leaves it.
  const inRaid = typeof RaidContext !== 'undefined' && RaidContext.inDatabase();
  const carried = `This becomes a new plan in ${GameVersions[version].name}: your players carry over to its default raid, totem and aura picks reset, and anyone who doesn't fit moves to the bench.`;
  if ((inRaid || hasLoadedWork()) && !await Modal.confirm({
    title: `Switch to ${GameVersions[version].name}?`,
    message: `${carried} ${inRaid ? 'This leaves the raid plan; the raid keeps it.' : 'Your current plan stays in Your plans.'}`,
    confirmLabel: `Switch to ${GameVersions[version].name}`,
  })) return false;
  if (inRaid) await RaidContext.detach(); // what is waiting goes to the raid before the plan is rebuilt
  State.planId = null;
  ChangeLog.clear();
  State.gameVersion = version;
  State.selectedRaid = GameVersions[version].defaultRaid;
  State.buffOverrides = {};
  const benched = initGroups();
  State.preferredSlots = PreferredSlots.clean(State.preferredSlots);
  switchTab('plan');
  if (State.view === 'landing') renderLanding(); // its resume banner names the plan just replaced
  const size = Config.Raids[State.selectedRaid] ? Config.Raids[State.selectedRaid].size : 25;
  showToast((benched > 0 ? `${benched} player${benched === 1 ? '' : 's'} benched: the ${size}-man raid is full. ` : '') + (GameVersions[version].toastNote || GameVersions[version].note));
  return true;
}

// Raid size segmented control (replaced the raid dropdown in the nav slim-down).
// The sizes come from the version's raid catalog (raidSizesFor); the specific
// raid stays in State.selectedRaid, so old plans and share links that name one
// still load and show their size. Buttons are rebuilt only when the size list
// changes, so a render never steals focus from them.
function renderRaidSizeControl() {
  const group = document.getElementById('raid-size-control');
  if (!group) return;
  const sizes = raidSizesFor(State.gameVersion, State.selectedRaid);
  const key = sizes.join(',');
  const current = Config.Raids[State.selectedRaid];
  if (group.dataset.sizes !== key) {
    // Rebuilding drops focus; give it back to the button for the current size.
    const hadFocus = group.contains(document.activeElement);
    group.dataset.sizes = key;
    group.innerHTML = sizes.map(size => `<button type="button" class="gs-fg-seg" data-raid-size="${size}" aria-pressed="false" title="${size}-man raid">${size}</button>`).join('');
    if (hadFocus && current) {
      const button = group.querySelector(`[data-raid-size="${current.size}"]`);
      if (button) button.focus();
    }
  }
  group.querySelectorAll('[data-raid-size]').forEach(button => {
    button.setAttribute('aria-pressed', String(!!current && Number(button.dataset.raidSize) === current.size));
  });
}
// Picking size N keeps the current raid when it already has N seats, else moves to
// the version's default or first raid of that size, then refits the board. A shrink
// remembers whom it benched (SizeBench); a later grow seats them again.
function selectRaidSize(size) {
  const raid = raidForSize(State.gameVersion, size, State.selectedRaid);
  if (!raid || raid === State.selectedRaid) return;
  const fromSize = Config.Raids[State.selectedRaid] ? Config.Raids[State.selectedRaid].size : null;
  State.selectedRaid = raid;
  renderRaidSizeControl();
  if (State.activeTab === 'ideal') {
    renderIdealComp();
  } else {
    let benched = 0, reseated = 0;
    // Whoever the new size benches or seats again is logged under Changes.
    ChangeLog.track('size', fromSize ? `Raid size ${fromSize} to ${size}` : `Raid size ${size}`, () => {
      const before = new Set((State.bench || []).map(p => p.uid));
      benched = initGroups();
      if (benched > 0) SizeBench.remember(State.bench.filter(p => !before.has(p.uid)).map(p => p.uid));
      reseated = SizeBench.reseat();
      commit();
    });
    const raidInfo = Config.Raids[State.selectedRaid];
    if (benched > 0) showToast(`${benched} player${benched === 1 ? '' : 's'} benched — the ${raidInfo ? raidInfo.size : 25}-man raid is full`);
    else if (reseated > 0) showToast(`${reseated} player${reseated === 1 ? '' : 's'} back in the raid from the bench`);
  }
}
(function initRaidSizeControl() {
  const group = document.getElementById('raid-size-control');
  if (!group) return;
  group.addEventListener('click', e => {
    const button = e.target.closest('[data-raid-size]');
    if (button) selectRaidSize(Number(button.dataset.raidSize));
  });
})();

// Fits State.groups to the selected raid's template. Extra groups are folded
// into open seats; whoever still does not fit is benched, never dropped.
// Returns how many players were benched.
function initGroups() {
  const raidInfo = Config.Raids[State.selectedRaid];
  const numGroups = raidInfo ? raidInfo.groups : 5;
  if (!State.bench) State.bench = [];
  if (!State.unplaced) State.unplaced = [];
  let benched = 0;
  if (State.groups.length > numGroups) {
    benched = enforceRaidCapacity(State.groups, State.bench, numGroups);
    State.roster = State.groups.flat();
  }
  while (State.groups.length < numGroups) State.groups.push([]);
  return benched;
}

// Role markers use in-game spell icons from the same self-hosted icons/ set as the buff
// icons. Player rows use one shared DPS marker for melee / ranged / caster;
// the summary bar asks for 'melee' and 'ranged' explicitly to split its counts.
const ROLE_ICONS = {
  tank:   { cls: 'role-tank',   icon: 'ability_warrior_defensivestance', label: 'Tank' },
  healer: { cls: 'role-healer', icon: 'spell_holy_renew',                label: 'Healer' },
  dps:    { cls: 'role-dps',    icon: 'ability_warrior_offensivestance', label: 'DPS' },
  melee:  { cls: 'role-dps',    icon: 'ability_warrior_offensivestance', label: 'Melee DPS' },
  ranged: { cls: 'role-dps',    icon: 'inv_weapon_bow_07',               label: 'Ranged DPS' },
};
function getRoleIcon(role) {
  const r = Object.prototype.hasOwnProperty.call(ROLE_ICONS, role) ? ROLE_ICONS[role] : ROLE_ICONS.dps;
  const src = Config.IconURL(r.icon);
  return `<span class="role-icon ${r.cls}" title="${esc(r.label)}"><img src="${esc(src)}" alt="${esc(r.label)}" loading="lazy"></span>`;
}

// Role words for the spec icon's hover title (a role the table does not know adds no word).
const SPEC_TITLE_ROLES = { tank: 'tank', healer: 'healer', melee_dps: 'melee', ranged_dps: 'ranged', caster_dps: 'caster' };

// Player rows show the ruleset's talent-tree icon for the player's spec,
// falling back to the class crest when the spec/ruleset has none. Icon data
// lives in Rulesets[version].specIcons (TBC baseline: Rulesets.tbc.specIcons).
function getSpecIcon(p) {
  const specIcons = activeRules().specIcons || Rulesets.tbc.specIcons;
  const cls = (p.class || '').toUpperCase();
  const icon = (specIcons[cls] && specIcons[cls][p.spec]) || (cls ? 'classicon_' + cls.toLowerCase() : null);
  if (!icon) return getRoleIcon(p.role);
  const roleCls = p.role === 'tank' ? 'role-tank' : p.role === 'healer' ? 'role-healer' : 'role-dps';
  const label = p.spec ? `${p.spec} ${cls.charAt(0) + cls.slice(1).toLowerCase()}` : cls;
  const roleWord = Object.prototype.hasOwnProperty.call(SPEC_TITLE_ROLES, p.role) ? SPEC_TITLE_ROLES[p.role] : '';
  const title = roleWord ? `${label}, ${roleWord}` : label;
  const src = Config.IconURL(icon);
  // Spec art that fails to load falls back to the class crest (see handleIconError).
  const fallback = cls ? ` data-fallback="${esc(Config.IconURL('classicon_' + cls.toLowerCase()))}"` : '';
  return `<span class="role-icon spec-icon ${roleCls}" title="${esc(title)}"><img src="${esc(src)}" alt="${esc(label)}" loading="lazy"${fallback}></span>`;
}

// Class colours reach the DOM as classes (cc-<class> / pref-<class> in app.css, fed by
// the --class-* tokens), never as inline style, so the CSP can forbid style attributes.
// An unknown class gets a neutral tone: 'primary' (default), 'secondary' or 'muted'.
function isKnownClass(cls) {
  return Object.prototype.hasOwnProperty.call(Config.ClassColors, cls);
}
function classColorClass(cls, fallback = 'primary') {
  return isKnownClass(cls) ? 'cc-' + cls.toLowerCase() : 'cc-unknown-' + fallback;
}
// Leading-space class for a preferred slot's --preferred-color (none when the class is unknown).
function preferredColorClass(cls) {
  return isKnownClass(cls) ? ' pref-' + cls.toLowerCase() : '';
}

// ONE capture-phase listener (image errors do not bubble) covers every icon the
// page renders, so no <img> needs its own handler or an inline onerror. A spec
// icon retries with its class crest (data-fallback); anything else degrades to
// the alt text it was already carrying, or to nothing where the name is printed
// next to the icon anyway. Returns what it did, for the tests.
function handleIconError(img) {
  if (!img || !img.tagName || img.tagName.toUpperCase() !== 'IMG') return 'ignored';
  const fallback = img.getAttribute('data-fallback');
  if (fallback) {
    img.removeAttribute('data-fallback');
    if (img.getAttribute('src') !== fallback) {
      img.setAttribute('src', fallback);
      return 'fallback';
    }
  }
  const parent = img.parentElement;
  if (parent && parent.classList.contains('buff-icon')) {
    parent.classList.remove('has-icon');
    img.remove();
    return 'removed';
  }
  if (parent && (parent.classList.contains('buff-row-icon') || parent.classList.contains('role-icon') || parent.classList.contains('gs-pb-drum'))) {
    const text = document.createElement('span');
    text.textContent = img.getAttribute('alt') || '';
    img.replaceWith(text);
    return 'text';
  }
  img.remove();
  return 'removed';
}

// Raid-Helper sign-up status as a small colored tag (see SignupStatus).
function getStatusTag(status) {
  const label = SignupStatus.label(status);
  if (!label) return '';
  return `<span class="status-tag status-${esc(status)}" title="Marked ${esc(label)} on Raid-Helper">${esc(label)}</span>`;
}

// The guild's note on a sign-up (SignupMarker: away, also in another raid, late, leaving, standby) as a small tag: a short
// label with the text as its tooltip, or the text itself for Late and Leaving (their time; long texts end in an ellipsis).
function getMarkerTag(p) {
  const shown = SignupMarker.tagText(p && p.marker);
  if (!shown) return '';
  return `<span class="marker-tag marker-${esc(p.marker.kind)}" title="${esc(p.marker.text)}">${esc(shown)}</span>`;
}

// A player slot is a role="button" (Enter/Space opens the editor), so the icon
// and badges inside would be read out piecemeal; this is the one spoken label.
function playerSlotLabel(p, where) {
  const name = (p.name || 'Unknown').split('-')[0];
  const cls = p.class ? p.class.charAt(0) + p.class.slice(1).toLowerCase() : '';
  const status = p.signupStatus && p.signupStatus !== 'confirmed' && p.signupStatus !== 'bench' ? SignupStatus.label(p.signupStatus) : '';
  const change = ChangeLog.highlightFor(p);
  return [name, [p.spec, cls].filter(Boolean).join(' '), where, status, p.marker ? p.marker.text : '', p.needsReview ? 'needs review' : '',
    change ? 'changed: ' + change.word.toLowerCase() : '']
    .filter(Boolean).join(', ');
}

// A player the latest unseen change touched (see ChangeLog.highlightFor): a
// leading-space slot class, and the small tag that names the change.
function changedSlotClass(p) {
  const change = ChangeLog.highlightFor(p);
  return change ? ' changed changed-' + change.kind : '';
}
function changedTag(p) {
  const change = ChangeLog.highlightFor(p);
  return change ? `<span class="changed-tag" title="Changed: ${esc(change.word)}">${esc(change.word)}</span>` : '';
}

// Re-rendering rebuilds every slot, so a keyboard user's focus would drop to
// <body>. Remember which player's slot had focus (or, for an empty slot, which
// seat) and refocus the equivalent slot afterwards.
function capturePlayerSlotFocus() {
  const el = document.activeElement;
  const slot = el && typeof el.closest === 'function' ? el.closest('.player-slot') : null;
  if (!slot) return null;
  const { uid, unplacedUid, group, slot: seat } = slot.dataset;
  return { uid, unplacedUid, group, seat };
}
function restorePlayerSlotFocus(key) {
  if (!key) return;
  const slots = [...document.querySelectorAll('.player-slot')];
  const is = (a, b) => a != null && a === b;
  // An unplaced sign-up keeps its uid when seated, so match it against seated slots too.
  const target = slots.find(s => is(key.uid, s.dataset.uid) || is(key.unplacedUid, s.dataset.uid))
    || slots.find(s => is(key.unplacedUid, s.dataset.unplacedUid))
    || slots.find(s => is(key.group, s.dataset.group) && is(key.seat, s.dataset.slot));
  // A suggestion stack is a drop-target wrapper around real buttons: focus its first one.
  const focusable = target && target.matches?.('.preferred-stack') ? target.querySelector('button') : target;
  if (focusable) focusable.focus({ preventScroll: true });
}

// A swapped buff icon is rebuilt by the re-render too. The picker remembers which
// icon it came from (group + buff id before and after the pick) so focus can
// return to it; the buff id changes when the pick replaces the default.
let pendingBuffIconFocus = null;
function rememberBuffIconFocus(group, uid, buffIds) {
  pendingBuffIconFocus = { group: String(group), uid, buffIds };
}
function restoreBuffIconFocus() {
  const key = pendingBuffIconFocus;
  pendingBuffIconFocus = null;
  if (!key) return;
  const icons = [...document.querySelectorAll('.buff-icon.swappable')]
    .filter(i => i.dataset.group === key.group && key.buffIds.includes(i.dataset.buffId));
  const target = icons.find(i => i.dataset.uid === key.uid) || icons[0];
  // A suggestion stack is a drop-target wrapper around real buttons: focus its first one.
  const focusable = target && target.matches?.('.preferred-stack') ? target.querySelector('button') : target;
  if (focusable) focusable.focus({ preventScroll: true });
}

function seatedSlotHTML(p, gi, si) {
  const displayName = (p.name || 'Unknown').split('-')[0];
  const specClass = p.spec ? (p.spec + ' ' + (p.class ? p.class.charAt(0) + p.class.slice(1).toLowerCase() : '')) : '';
  const backupName = Backups.backupNameFor(p.name);
  // Compact indicator — the full pairing is in the title tooltip so the
  // card stays narrow enough not to crowd out the player's own name.
  const backupBadge = backupName ? `<span class="backup-badge" role="img" title="Standby: ${esc(backupName.split('-')[0])}" aria-label="Standby: ${esc(backupName.split('-')[0])}">S</span>` : '';
  // Constraint badges (backlog #3) reuse the buff-icon tooltip portal
  // (data-tt-*) rather than a new hover mechanism — see the player-slot
  // "why here" editor section for the full explanation.
  const constraintsHere = Constraints.forPlayer(p.name);
  const togetherNames = constraintsHere.filter(c => c.type === 'together').map(c => Constraints.otherName(c, p.name).split('-')[0]);
  const apartNames = constraintsHere.filter(c => c.type === 'apart').map(c => Constraints.otherName(c, p.name).split('-')[0]);
  const constraintDesc = [
    togetherNames.length ? 'With: ' + togetherNames.join(', ') : '',
    apartNames.length ? 'Apart from: ' + apartNames.join(', ') : '',
  ].filter(Boolean).join(' &middot; ');
  const constraintBadge = constraintDesc
    ? `<span class="constraint-badge" data-tt-name="Constraints" data-tt-desc="${esc(constraintDesc)}">${togetherNames.length ? '&#128279;' : ''}${apartNames.length ? '&#9940;' : ''}</span>`
    : '';
  const lockBadge = p.locked ? `<span class="lock-badge" title="Locked by comp template">&#128274;</span>` : '';
  // Class-only Raid-Helper sign-ups (backlog #2) land with a guessed
  // spec/role — same "Needs review" treatment the plain-text importer's
  // preview already uses, but persisted on the card itself since this
  // import path has no confirmation dialog to show it in first.
  const reviewBadge = p.needsReview ? `<span class="review-badge" title="${esc(p.reviewReason || 'Needs review — spec was defaulted')}">Needs review</span>` : '';
  return `<div class="player-slot${p.needsReview ? ' needs-review' : ''}${changedSlotClass(p)}" draggable="true" role="button" tabindex="0" aria-label="${esc(playerSlotLabel(p, 'group ' + (gi + 1)))}" data-uid="${esc(p.uid)}" data-group="${gi}" data-slot="${si}">
    ${getSpecIcon(p)}
    <div class="player-info">
      <span class="player-name ${classColorClass(p.class)}">${esc(displayName)}</span>
      <span class="player-spec">${esc(specClass)}</span>
    </div>
    ${changedTag(p)}
    ${reviewBadge}
    ${p.signupStatus && p.signupStatus !== 'confirmed' ? getStatusTag(p.signupStatus) : ''}
    ${getMarkerTag(p)}
    ${lockBadge}
    ${constraintBadge}
    ${backupBadge}
  </div>`;
}

function getDominantRoleLabel(players) {
  const roleCounts = {};
  for (const p of players) roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
  let best = '', max = 0;
  for (const [role, count] of Object.entries(roleCounts)) {
    if (count > max) { max = count; best = role; }
  }
  const labels = { tank:'TANK', healer:'HEALER', melee_dps:'MELEE', ranged_dps:'RANGED', caster_dps:'CASTER' };
  return labels[best] || '';
}

function sortTankGroupFirst() {
  if (PreferredSlots.hasManual() || State.preserveGroupOrder) return;
  if (State.groups.length <= 1) return;
  // Prefer the optimizer's structural identity (authoritative, tie-proof);
  // fall back to dominant-role detection for imported/manual rosters.
  let tankIdx = -1;
  const ids = State.groups._roleIdentities;
  if (ids) tankIdx = ids.indexOf('tank');
  if (tankIdx < 0) {
    for (let i = 0; i < State.groups.length; i++) {
      if (getDominantRoleLabel(State.groups[i] || []) === 'TANK') { tankIdx = i; break; }
    }
  }
  if (tankIdx > 0) {
    // Move tank group to index 0, shift others down
    const tankGroup = State.groups.splice(tankIdx, 1)[0];
    State.groups.unshift(tankGroup);
    // Keep the identity list aligned with the new order (splice() on the
    // array doesn't move the custom _roleIdentities property's entries)
    if (ids) {
      ids.splice(tankIdx, 1);
      ids.unshift('tank');
    }
    // Update groupNumber on all players
    for (let i = 0; i < State.groups.length; i++) {
      for (const p of (State.groups[i] || [])) p.groupNumber = i + 1;
    }
    // Suggested Open slots (the only kind present here) move with their group.
    for (const slot of State.preferredSlots) {
      if (slot.group === tankIdx) slot.group = 0;
      else if (slot.group < tankIdx) slot.group += 1;
    }
    // Remap any buff overrides that reference the old indices
    const newOverrides = {};
    for (const [key, val] of Object.entries(State.buffOverrides)) {
      const parts = key.split(':');
      let gi = parseInt(parts[0]);
      const rest = parts.slice(1).join(':');
      if (gi === tankIdx) gi = 0;
      else if (gi < tankIdx) gi = gi + 1;
      newOverrides[`${gi}:${rest}`] = val;
    }
    State.buffOverrides = newOverrides;
  }
}

function renderCampfires() {
  const panel=document.getElementById('campfire-panel');
  panel.hidden=State.gameVersion!=='forever' || State.activeTab!=='plan';
  if (panel.hidden) return;
  const data=State.campfires, members=Campfires.members();
  const open=panel.querySelector('details')?.open || false;
  panel.innerHTML=`<div class="camp-heading"><div><span class="gs-fg-lbl camp-kicker">Forever · Pre-raid preparation</span><h2>Campfires</h2></div><button type="button" class="gs-btn gs-btn-sm" id="camp-add">+ Add campfire</button></div>
    <p class="camp-rules">1 minute sitting or crafting → 1 hour of buffs. Your last fire replaces your entire previous campfire buff package. Stronger class buffs take precedence.</p>
    <details ${open?'open':''}><summary>Raid professions <span>${data.professions.length} recorded</span></summary><p>Record profession skills to unlock eligible assets. Each member can contribute one asset across all fires. Benched members are labeled.</p>
    <div class="camp-professions">${data.professions.map((p,i)=>`<div><strong>${esc(p.player)}</strong><span>${esc(p.profession)} · ${p.skill}</span><button type="button" class="gs-btn gs-btn-sm gs-btn-ghost" data-prof-remove="${i}" aria-label="Remove ${esc(p.player)} ${esc(p.profession)}">Remove</button></div>`).join('')}</div>
    ${members.length?`<form id="camp-prof-form" class="camp-form"><label>Member<select name="player">${members.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}${State.bench.includes(p)?' (bench)':''}</option>`).join('')}</select></label><label>Profession<select name="profession">${Campfires.professionNames.map(p=>`<option>${p}</option>`).join('')}</select></label><label>Skill<input name="skill" type="number" min="1" max="300" step="1" value="300" required></label><button class="gs-btn gs-btn-sm" type="submit">Set profession</button></form>`:'<p>Add or import raid members first to assign professions and assets.</p>'}</details>
    <div class="camp-grid">${data.fires.map((f,i)=>{
      const candidates=Campfires.eligible(i), tier=Campfires.tiers[f.capacity];
      const cook=data.professions.some(p=>p.profession==='Cooking' && p.skill>=tier.skill);
      return `<article class="camp-card"><div class="camp-card-heading"><label>Campfire name<input data-fire-name="${i}" maxlength="60" value="${esc(f.name)}"></label><button type="button" class="gs-btn gs-btn-sm gs-btn-ghost" data-fire-remove="${i}">Remove fire</button></div><div class="camp-capacity"><label>Campfire tier<select data-fire-capacity="${i}">${[3,5,10].map(n=>`<option value="${n}" ${n===f.capacity?'selected':''}>${Campfires.tiers[n].name} · ${n} assets</option>`).join('')}</select></label><strong>${f.assets.length} / ${f.capacity}</strong></div><p class="camp-note">Cooking ${tier.skill} required to build this fire${cook?' · Eligible cook recorded': ' · No eligible cook recorded'}.</p>
      <ul class="camp-assets">${f.assets.map((a,j)=>{const item=Campfires.catalog.find(x=>x.id===a.asset);return `<li><div><a href="https://www.wowhead.com/forever/item=${item.id}" target="_blank" rel="noopener noreferrer">${esc(item.name)}</a><span class="camp-owner">${esc(a.player)} · ${item.profession} ${item.skill}${State.bench.some(p=>Campfires.key(p.name)===Campfires.key(a.player))?' · Bench':''}</span><p>${esc(item.effect||'Utility asset')}${item.utility?' · '+esc(item.utility):''}</p>${item.conflict?`<small>Does not stack with ${esc(item.conflict)}</small>`:''}</div><button type="button" class="gs-btn gs-btn-sm gs-btn-ghost" data-asset-remove="${i}:${j}" aria-label="Remove ${esc(item.name)}">×</button></li>`;}).join('')||'<li class="camp-empty">No assets assigned. Choose contributors below.</li>'}</ul>
      ${f.assets.length<f.capacity?`<label class="camp-assign">Assign an asset<select data-fire-assign="${i}"><option value="">${candidates.length?'Choose member and asset…':'No eligible unassigned contributors'}</option>${candidates.map((a,j)=>{const item=Campfires.catalog.find(x=>x.id===a.asset);return `<option value="${j}">${esc(a.player)} — ${esc(item.name)} (${item.profession} ${item.skill})</option>`;}).join('')}</select></label>`:'<p class="camp-note">This fire is full.</p>'}</article>`;
    }).join('')}</div>${data.fires.length?'':'<p class="camp-empty">Plan your first fire, or create separate fires for buffs and services.</p>'}<p class="camp-note">Effects are tracked per fire, never combined. Numeric scaling is pending; campfires do not change group optimization. Assets share a 1-hour placement cooldown.</p>`;
  const commitFire=()=>{const before=data.fires.reduce((n,f)=>n+f.assets.length,0);commit();const after=State.campfires.fires.reduce((n,f)=>n+f.assets.length,0);if(after<before)showToast('Ineligible campfire assignments removed after profession changes. Undo is available.');};
  panel.querySelector('#camp-add').onclick=()=>{data.fires.push({name:`Campfire ${data.fires.length+1}`,capacity:3,assets:[]});commitFire();};
  const form=panel.querySelector('#camp-prof-form');
  if(form) form.onsubmit=e=>{e.preventDefault();const values=new FormData(form);const p={player:values.get('player'),profession:values.get('profession'),skill:Number(values.get('skill'))};const old=data.professions.find(x=>Campfires.key(x.player)===Campfires.key(p.player)&&x.profession===p.profession);if(old)Object.assign(old,p);else data.professions.push(p);commitFire();};
  panel.querySelectorAll('[data-prof-remove]').forEach(b=>b.onclick=()=>{data.professions.splice(Number(b.dataset.profRemove),1);commitFire();});
  panel.querySelectorAll('[data-fire-remove]').forEach(b=>b.onclick=()=>{data.fires.splice(Number(b.dataset.fireRemove),1);commitFire();});
  panel.querySelectorAll('[data-fire-name]').forEach(input=>input.onchange=()=>{data.fires[Number(input.dataset.fireName)].name=input.value.trim()||'Campfire';commitFire();});
  panel.querySelectorAll('[data-fire-capacity]').forEach(select=>select.onchange=()=>{const f=data.fires[Number(select.dataset.fireCapacity)], n=Number(select.value);if(f.assets.length>n){select.value=f.capacity;showToast('Remove assets before choosing a smaller fire');return;}f.capacity=n;commitFire();});
  panel.querySelectorAll('[data-fire-assign]').forEach(select=>select.onchange=()=>{if(select.value==='')return;const i=Number(select.dataset.fireAssign);Campfires.assign(i,Campfires.eligible(i)[Number(select.value)]);commitFire();});
  panel.querySelectorAll('[data-asset-remove]').forEach(b=>b.onclick=()=>{const [i,j]=b.dataset.assetRemove.split(':').map(Number);data.fires[i].assets.splice(j,1);commitFire();});
}

// Assignments tab: Healer→Tank, Paladin Blessings, boss Debuffs. Self-managed
// visibility (like renderCampfires) — only builds DOM when it's the active tab.
function renderAssignments() {
  const panel = document.getElementById('assignments-panel');
  panel.hidden = State.activeTab !== 'assignments';
  if (panel.hidden) return;

  if (!GameVersions[State.gameVersion].modeled) {
    panel.innerHTML = `<div class="assign-heading"><div><h2>Assignments</h2></div></div><p class="assign-empty">${esc(GameVersions[State.gameVersion].note || 'Rules are not configured for this version yet.')}</p>`;
    return;
  }

  const players = State.roster;
  const tanks = players.filter(p => p.role === 'tank');
  const healers = players.filter(p => p.role === 'healer');
  const paladins = players.filter(p => p.class === 'PALADIN');

  const healerTanks = Assignments.effectiveHealerTanks(players);
  const blessings = Assignments.effectiveBlessings(players);
  const debuffAssignments = Assignments.effectiveDebuffs(players);
  const conflicts = Assignments.getDebuffConflicts(debuffAssignments);
  const conflictIds = new Set(conflicts.flatMap(c => [c.a, c.b]));

  // ── Healer -> Tank ──
  let healerRowsHTML;
  if (!tanks.length) healerRowsHTML = '<p class="assign-empty">No tanks seated — nothing to assign.</p>';
  else if (!healers.length) healerRowsHTML = '<p class="assign-empty">No healers seated — nothing to assign.</p>';
  else {
    healerRowsHTML = healers.map(h => {
      const current = healerTanks[h.name] || 'RAID';
      const options = ['<option value="RAID"' + (current === 'RAID' ? ' selected' : '') + '>Raid (no tank)</option>']
        .concat(tanks.map((t, i) => `<option value="${esc(t.name)}"${current === t.name ? ' selected' : ''}>${i === 0 ? 'MT' : i === 1 ? 'OT' : 'OT' + i} — ${esc(t.name)}</option>`));
      return `<div class="assign-row">
        <span class="assign-row-name ${classColorClass(h.class)}">${esc(h.name)}</span>
        <span class="assign-row-meta">${esc(h.spec || '')} ${esc(RosterEdit.ClassLabel(h.class))}</span>
        <select class="assign-select" data-healer="${esc(h.name)}">${options.join('')}</select>
      </div>`;
    }).join('');
  }

  // ── Paladin Blessings (only when Paladins are seated) ──
  let blessingsHTML = '';
  if (paladins.length) {
    const catalog = Assignments.blessingCatalog();
    const order = Assignments.BLESSING_ORDER.filter(id => catalog[id]);
    const rows = order.map(id => {
      const current = blessings[id] || '';
      const options = ['<option value="">— none —</option>']
        .concat(paladins.map(p => `<option value="${esc(p.name)}"${current === p.name ? ' selected' : ''}>${esc(p.name)}</option>`));
      return `<div class="assign-row">
        <span class="assign-row-name">${esc(catalog[id].name)}</span>
        <span class="assign-row-meta">${esc(catalog[id].desc || '')}</span>
        <select class="assign-select" data-blessing="${esc(id)}">${options.join('')}</select>
      </div>`;
    }).join('');
    const matrix = Assignments.blessingMatrix(players, blessings);
    const matrixHTML = matrix.length ? `<table class="assign-matrix"><thead><tr><th>Class</th><th>Blessings received</th></tr></thead><tbody>${
      matrix.map(r => `<tr><td class="${classColorClass(r.class)}">${esc(RosterEdit.ClassLabel(r.class))}</td><td>${r.cells.map(c => esc(c.name) + ' (' + esc(c.paladin) + ')').join(', ')}</td></tr>`).join('')
    }</tbody></table>` : '';
    blessingsHTML = `<section class="assign-section"><h3>Paladin Blessings</h3>${rows}${matrixHTML}</section>`;
  }

  // ── Boss debuffs ──
  const debuffDefs = activeRules().debuffs || {};
  const debuffIds = Object.keys(debuffDefs).filter(id => debuffAssignments[id] ||
    players.some(p => p.class === debuffDefs[id].sourceClass && (!debuffDefs[id].sourceSpec || p.spec === debuffDefs[id].sourceSpec)));
  let debuffsHTML = '<p class="assign-empty">No assignable boss debuffs for this roster.</p>';
  if (debuffIds.length) {
    debuffsHTML = debuffIds.map(id => {
      const def = debuffDefs[id];
      const eligible = players.filter(p => p.class === def.sourceClass && (!def.sourceSpec || p.spec === def.sourceSpec));
      const current = debuffAssignments[id] || '';
      const options = ['<option value="">— unassigned —</option>']
        .concat(eligible.map(p => `<option value="${esc(p.name)}"${current === p.name ? ' selected' : ''}>${esc(p.name)}</option>`));
      const isConflict = conflictIds.has(id);
      const hint = eligible.length > 1 && !current ? `<span class="assign-hint">${eligible.length} could — pick one</span>` : '';
      return `<div class="assign-row${isConflict ? ' assign-conflict' : ''}">
        <span class="assign-row-name">${esc(def.name)}</span>
        <span class="assign-row-meta">${esc(RosterEdit.ClassLabel(def.sourceClass))}${def.sourceSpec ? ' · ' + esc(def.sourceSpec) : ''}</span>
        <select class="assign-select" data-debuff="${esc(id)}">${options.join('')}</select>
        ${hint}
      </div>`;
    }).join('');
    if (conflicts.length) {
      debuffsHTML += `<p class="assign-warning">Conflict: ${conflicts.map(c => esc((debuffDefs[c.a]||{}).name || c.a) + ' vs ' + esc((debuffDefs[c.b]||{}).name || c.b)).join('; ')} — only one will land on the boss.</p>`;
    }
  }

  // ── Custom assignments (user-defined rows: interrupts, cube clickers, kiters...) ──
  const customRows = Assignments.customRows();
  const markOptions = current => ['<option value="0"' + (!current ? ' selected' : '') + '>No mark</option>']
    .concat(Assignments.RAID_MARKS.map((m, i) => `<option value="${i + 1}"${current === i + 1 ? ' selected' : ''}>${esc(m)}</option>`)).join('');
  const customHTML = customRows.map((row, i) => {
    const addable = players.filter(p => !row.players.includes(p.name));
    const chips = row.players.map(name => {
      const cls = (players.find(p => p.name === name) || {}).class;
      return `<span class="assign-chip${Config.ClassColors[cls] ? ' cc-' + esc(cls.toLowerCase()) : ''}">${esc(name)}<button type="button" class="assign-chip-remove" data-custom-unassign="${esc(row.id)}" data-player="${esc(name)}" aria-label="Remove ${esc(name)} from ${esc(row.label)}">&times;</button></span>`;
    }).join('');
    const addSelect = addable.length
      ? `<select class="assign-select" data-custom-assign="${esc(row.id)}" aria-label="Add a player to ${esc(row.label)}"><option value="">Add player...</option>${addable.map(p => `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.spec || '')} ${esc(RosterEdit.ClassLabel(p.class))})</option>`).join('')}</select>`
      : '';
    return `<div class="assign-row assign-custom-row" data-custom-row="${esc(row.id)}">
      <div class="assign-custom-head">
        <select class="assign-select assign-mark-select" data-custom-mark="${esc(row.id)}" aria-label="Raid mark for ${esc(row.label)}">${markOptions(row.mark)}</select>
        <input type="text" class="assign-label-input" maxlength="${Assignments.CUSTOM_LABEL_MAX}" value="${esc(row.label)}" data-custom-label="${esc(row.id)}" aria-label="Assignment label">
        <span class="assign-custom-actions">
          <button type="button" class="btn btn-quiet" data-custom-move="${esc(row.id)}" data-delta="-1"${i === 0 ? ' disabled' : ''} aria-label="Move ${esc(row.label)} up">Up</button>
          <button type="button" class="btn btn-quiet" data-custom-move="${esc(row.id)}" data-delta="1"${i === customRows.length - 1 ? ' disabled' : ''} aria-label="Move ${esc(row.label)} down">Down</button>
          <button type="button" class="btn btn-quiet" data-custom-delete="${esc(row.id)}" aria-label="Delete ${esc(row.label)}">Delete</button>
        </span>
      </div>
      <div class="assign-custom-players">${chips}${addSelect}${!chips && !addSelect ? '<span class="assign-empty">No players seated.</span>' : ''}</div>
    </div>`;
  }).join('');
  const customSectionHTML = `<section class="assign-section">
      <div class="assign-heading assign-heading-flush"><h3>Custom Assignments</h3></div>
      ${customHTML || '<p class="assign-empty">Nothing yet. Add a row for interrupts, cube clickers, kiters or anything else the encounter needs.</p>'}
      ${customRows.length < Assignments.CUSTOM_MAX_ROWS
        ? `<div class="assign-custom-add"><input type="text" class="assign-label-input" id="custom-new-label" maxlength="${Assignments.CUSTOM_LABEL_MAX}" placeholder="New assignment, e.g. Interrupts" aria-label="New assignment label"><button type="button" class="btn btn-secondary" id="btn-add-custom">Add</button></div>`
        : `<p class="assign-empty">At most ${Assignments.CUSTOM_MAX_ROWS} custom assignments.</p>`}
    </section>`;

  // ── Raid Prep (backlog #9 + #10) ──
  const prep = RaidPrep.itemsWithCoverage(State.selectedRaid, State.groups, State.bench);
  let prepHTML = '<p class="assign-empty">No raid prep notes yet for this raid.</p>';
  let hasPrepContent = false;
  if (prep) {
    const prepRow = (item, showBoss) => {
      const coverageHTML = item.coverage
        ? `<span class="prep-coverage ${item.coverage.covered ? 'covered' : 'missing'}">${esc(item.coverage.name)}: ${item.coverage.covered ? `covered (${item.coverage.seatedCount})` : 'nobody seated'}</span>`
        : '';
      return `<div class="prep-row">
        <div class="prep-row-main">
          ${showBoss && item.boss ? `<span class="prep-boss">${esc(item.boss)}</span>` : ''}
          ${item.item ? `<span class="prep-boss">${esc(item.item)}</span>` : ''}
          ${item.note ? `<span class="prep-note">${esc(item.note)}</span>` : ''}
          ${coverageHTML}
        </div>
        <a class="prep-source" href="${esc(item.source)}" target="_blank" rel="noopener noreferrer">source</a>
      </div>`;
    };
    const encounterRows = (prep.encounters || []).map(e => prepRow(e, true)).join('');
    const consumableRows = (prep.consumables || []).map(c => prepRow(c, false)).join('');
    hasPrepContent = !!(encounterRows || consumableRows);
    if (hasPrepContent) {
      prepHTML = (encounterRows ? `<h4 class="prep-subhead">Encounter Notes</h4>${encounterRows}` : '')
        + (consumableRows ? `<h4 class="prep-subhead">Consumables &amp; World Buffs</h4>${consumableRows}` : '');
    }
  }

  panel.innerHTML = `
    <div class="assign-heading">
      <div><span class="assign-kicker">${esc((Config.Raids[State.selectedRaid] || {}).name || '')}</span><h2>Assignments</h2></div>
      <div class="assign-heading-actions">
        <button type="button" class="btn btn-secondary" id="btn-copy-assignments">Copy assignments</button>
        <button type="button" class="btn btn-secondary" id="btn-copy-mrt-note-panel">Copy MRT note</button>
      </div>
    </div>
    <section class="assign-section"><h3>Healer &rarr; Tank</h3>${healerRowsHTML}</section>
    ${blessingsHTML}
    <section class="assign-section"><h3>Boss Debuffs</h3>${debuffsHTML}</section>
    ${customSectionHTML}
    <section class="assign-section">
      <div class="assign-heading assign-heading-flush"><h3>Raid Prep</h3>${hasPrepContent ? '<button type="button" class="btn btn-secondary" id="btn-copy-prep">Copy prep</button>' : ''}</div>
      ${prepHTML}
    </section>
  `;

  panel.querySelectorAll('[data-healer]').forEach(sel => sel.onchange = () => {
    Assignments.setHealerTank(sel.dataset.healer, sel.value);
    renderAssignments();
    persistWorkingPlan();
  });
  panel.querySelectorAll('[data-blessing]').forEach(sel => sel.onchange = () => {
    Assignments.setBlessing(sel.dataset.blessing, sel.value);
    renderAssignments();
    persistWorkingPlan();
  });
  panel.querySelectorAll('[data-debuff]').forEach(sel => sel.onchange = () => {
    Assignments.setDebuff(sel.dataset.debuff, sel.value);
    renderAssignments();
    persistWorkingPlan();
  });
  // Custom rows change through commit() like every other plan edit. The panel is
  // rebuilt by it, so focus goes back to the first of `focusSelectors` that exists.
  const editCustom = (mutate, ...focusSelectors) => {
    const result = commit(mutate);
    if (result && result.error) showToast(result.error);
    for (const selector of focusSelectors) {
      const target = panel.querySelector(selector);
      if (target && !target.disabled) { target.focus(); break; }
    }
  };
  const addCustomRow = () => {
    const input = document.getElementById('custom-new-label');
    if (!input) return;
    if (!Assignments.cleanLabel(input.value)) { showToast('Enter a label for the assignment'); input.focus(); return; }
    let newId = null;
    editCustom(() => { const r = Assignments.addCustom(input.value); if (r.success) newId = r.row.id; return r; });
    panel.querySelector(newId ? `[data-custom-assign="${newId}"]` : '#custom-new-label')?.focus();
  };
  const addCustomBtn = document.getElementById('btn-add-custom');
  if (addCustomBtn) addCustomBtn.onclick = addCustomRow;
  const newLabelInput = document.getElementById('custom-new-label');
  if (newLabelInput) newLabelInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addCustomRow(); } };
  panel.querySelectorAll('[data-custom-label]').forEach(input => input.onchange = () => {
    const id = input.dataset.customLabel;
    if (!Assignments.cleanLabel(input.value)) { showToast('Label cannot be empty'); renderAssignments(); return; }
    editCustom(() => Assignments.renameCustom(id, input.value));
  });
  panel.querySelectorAll('[data-custom-mark]').forEach(sel => sel.onchange = () => {
    const id = sel.dataset.customMark;
    editCustom(() => Assignments.setCustomMark(id, sel.value), `[data-custom-mark="${id}"]`);
  });
  panel.querySelectorAll('[data-custom-assign]').forEach(sel => sel.onchange = () => {
    if (!sel.value) return;
    const id = sel.dataset.customAssign, name = sel.value;
    editCustom(() => Assignments.addCustomPlayer(id, name), `[data-custom-assign="${id}"]`, `[data-custom-row="${id}"] input`);
  });
  panel.querySelectorAll('[data-custom-unassign]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.customUnassign, name = btn.dataset.player;
    editCustom(() => Assignments.removeCustomPlayer(id, name), `[data-custom-assign="${id}"]`, `[data-custom-row="${id}"] input`);
  });
  panel.querySelectorAll('[data-custom-move]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.customMove, delta = btn.dataset.delta;
    editCustom(() => Assignments.moveCustom(id, Number(delta)), `[data-custom-move="${id}"][data-delta="${delta}"]`, `[data-custom-move="${id}"]`);
  });
  panel.querySelectorAll('[data-custom-delete]').forEach(btn => btn.onclick = () => {
    editCustom(() => Assignments.removeCustom(btn.dataset.customDelete), '#custom-new-label');
    showToast('Assignment deleted. Undo is available.');
  });
  const copyMrtBtn = document.getElementById('btn-copy-mrt-note-panel');
  if (copyMrtBtn) copyMrtBtn.onclick = copyMrtNote;
  const copyPrepBtn = document.getElementById('btn-copy-prep');
  if (copyPrepBtn) copyPrepBtn.onclick = () => {
    const text = RaidPrep.toChatText(State.selectedRaid);
    if (!text) { showToast('No prep notes to copy'); return; }
    copyText(text, 'Raid prep copied to clipboard');
  };
  const copyBtn = document.getElementById('btn-copy-assignments');
  if (copyBtn) copyBtn.onclick = () => {
    const text = Assignments.toChatText(players);
    if (!text) { showToast('Nothing to copy yet'); return; }
    copyText(text, 'Assignments copied to clipboard');
  };
}


// Shared by the Assignments panel, the Share menu and the share dialog.
function copyMrtNote() {
  const text = Assignments.toMrtNote();
  if (!text) { showToast('No assignments to export'); return; }
  copyText(text, 'MRT note copied. In MRT: Note > paste into a note');
}

// ── STATE CHANGE PIPELINE ───────────────────────────────────────
// A change to the plan reaches storage and the screen one way: commit(mutator)
// applies the change (the mutator is optional, for callers that already made it),
// reconciles the state derived from it, persists the result, then renders it.
// renderGroups() only draws; a pure re-render can call it directly.
function reconcilePlan() {
  PreferredSlots.reconcile();
  State.roster = State.groups.flat();
  SizeBench.prune();
  Assignments.reconcileRoster();
  Backups.reconcile();
  Constraints.reconcile();
  Drummers.reconcile();
  // Ensure the tank group is always Group 1
  sortTankGroupFirst();
  cleanupOverrides();
  // Campfires drop assets whose owner lost the profession, while their panel is showing.
  if (State.gameVersion === 'forever' && State.activeTab === 'plan') State.campfires = Campfires.clean(State.campfires);
}

function commit(mutator) {
  const result = mutator ? mutator() : undefined;
  reconcilePlan();
  persistWorkingPlan();
  renderGroups();
  return result;
}

// ── SUGGESTION STACKS ───────────────────────────────────────────
// A suggested Open slot that carries runner-ups (PreferredSlots alts, set by OpenSlots.choose) draws as a stack: the
// top pick in front, the runner-ups peeking out behind it. Clicking the stack fans it out in place into the top pick
// and its runner-ups; a runner-up becomes the leader's own request, the top pick folds the fan, "Other spec..." opens
// the Open-slot editor. Only one stack is open at a time (UI-only: folds and opens go through commit(), the one renderGroups caller). The wrapper stays a `.player-slot` so it is still a drop target.
const SuggestionStack = {
  open: null, // { group, slot } of the fanned stack, or null
  isOpen(gi, si) { return !!this.open && this.open.group === gi && this.open.slot === si; },
  set(gi, si) { this.open = gi == null ? null : { group: gi, slot: si }; commit(); },
};
// "-6%", "Best" for the top pick; no number when the gap could not be expressed (top gain <= 0), "-<1%" under a point.
function suggestionGapLabel(gap) {
  if (gap === 0) return '-<1%';
  return Number.isFinite(gap) ? '-' + gap + '%' : '';
}
function suggestionStackHTML(preference, gi, si, isOpen) {
  const alts = preference.alts;
  const label = p => p.spec + ' ' + RosterEdit.ClassLabel(p.class);
  const more = 'Open slot - ' + alts.length + (alts.length === 1 ? ' close option' : ' close options');
  const attrs = `data-group="${gi}" data-slot="${si}"`;
  if (!isOpen) {
    return `<div class="player-slot preferred-slot preferred-stack${preferredColorClass(preference.class)}" ${attrs}>
      ${alts.map((a, i) => `<span class="stack-peek stack-peek-${alts.length - i}${preferredColorClass(a.class)}" aria-hidden="true"></span>`).join('')}
      <button type="button" class="stack-card stack-front" data-stack-open aria-expanded="false" aria-label="Suggested ${esc(label(preference))}, ${alts.length} more option${alts.length === 1 ? '' : 's'}">
        ${getSpecIcon(preference)}<div class="player-info"><span class="player-name">${esc(label(preference))}</span><span class="player-spec" title="${more}">${more}</span></div><span class="preferred-badge gs-hd-chip is-open">Suggested</span></button></div>`;
  }
  const card = (p, gapText, attr, aria) => `<button type="button" class="stack-card${preferredColorClass(p.class)}" ${attr} aria-label="${esc(aria)}">
      ${getSpecIcon(p)}<div class="player-info"><span class="player-name">${esc(label(p))}</span></div><span class="stack-gap">${gapText}</span></button>`;
  return `<div class="player-slot preferred-slot preferred-stack preferred-fan${preferredColorClass(preference.class)}" ${attrs}>
    ${card(preference, 'Best', 'data-stack-close aria-expanded="true"', 'Suggested ' + label(preference) + ', best pick. Fold the options')}
    ${alts.map((a, i) => card(a, suggestionGapLabel(a.gap), `data-stack-pick="${i}"`, 'Use ' + label(a) + (suggestionGapLabel(a.gap) ? ', ' + suggestionGapLabel(a.gap) + ' behind the best pick' : ''))).join('')}
    <button type="button" class="stack-other" data-stack-other>Other spec...</button></div>`;
}

function renderGroups() {
  ChangeLog.forPlan(State.planId); // before any card reads a highlight: another plan's log never paints this one
  const focusedSlot = capturePlayerSlotFocus();
  const container = document.getElementById('groups-container');
  container.innerHTML = '';

  const raidInfo = Config.Raids[State.selectedRaid];
  const numGroups = raidInfo ? raidInfo.groups : 5;

  // Apply grid layout class based on group count
  container.className = 'groups-container gs-pb-board';
  if (numGroups === 5) container.classList.add('groups-5');
  else if (numGroups === 2 || numGroups === 4 || numGroups === 8) container.classList.add('groups-' + numGroups);

  const coveredBuffIds = new Set();
  const cards = [];

  for (let gi = 0; gi < numGroups; gi++) {
    const players = State.groups[gi] || [];
    const buffList = getGroupBuffs(players, gi);
    buffList.forEach(b => coveredBuffIds.add(b.id));

    let slotsHTML = '';
    for (let si = 0; si < 5; si++) {
      if (si < players.length) {
        slotsHTML += seatedSlotHTML(players[si], gi, si);
      } else if (PreferredSlots.forGroup(gi)[si - players.length]) {
        const preference = PreferredSlots.forGroup(gi)[si - players.length];
        if (preference.auto && preference.alts?.length) {
          slotsHTML += suggestionStackHTML(preference, gi, si, SuggestionStack.isOpen(gi, si));
          continue;
        }
        const specLine = preference.auto ? 'Suggested by Optimize' : 'Requested, awaiting sign-up';
        slotsHTML += `<div class="player-slot preferred-slot${preferredColorClass(preference.class)}" role="button" tabindex="0" data-group="${gi}" data-slot="${si}">
          ${getSpecIcon(preference)}<div class="player-info"><span class="player-name">${esc(preference.spec + ' ' + RosterEdit.ClassLabel(preference.class))}</span><span class="player-spec" title="${specLine}">${specLine}</span></div><span class="preferred-badge gs-hd-chip is-open">${preference.auto ? 'Suggested' : 'Requested'}</span></div>`;
      } else {
        slotsHTML += `<div class="player-slot empty-slot" role="button" tabindex="0" data-group="${gi}" data-slot="${si}" aria-label="Group ${gi+1}, empty slot: add player or preferred spec">
          <span class="role-icon role-icon-empty">&#8226;</span>
          <div class="player-info"><span class="player-name">Empty Slot</span></div>
        </div>`;
      }
    }

    // TBC Drums (feature-backlog-3 #5) are not part of buffList/getGroupBuffs (see getDrumsCoverage for why): a tagged drummer
    // shows as the drum icon button beside the group name, not as a buff icon.
    const groupDrummers = State.gameVersion === 'tbc' ? players.filter(p => Drummers.isDrummer(p.name)) : [];

    let buffsHTML = '';
    if (buffList.length === 0) {
      buffsHTML += `<span class="no-buffs">${GameVersions[State.gameVersion].modeled ? 'No buffs' : 'Rules pending'}</span>`;
    } else {
      for (const b of buffList) buffsHTML += groupBuffIconHTML(b, gi, true);
    }
    cards.push(groupCardHTML(gi, players, slotsHTML, buffsHTML, groupDrummers));
  }
  container.innerHTML = cards.join('');

  const coveredDebuffIds = getRaidDebuffCoverage(State.groups);
  renderBuffCatalog(coveredBuffIds, coveredDebuffIds);
  renderUtilityCatalog();
  renderBalanceWarnings();

  renderSummaryBar();
  SignupTray.render();
  restorePlayerSlotFocus(focusedSlot);
  restoreBuffIconFocus();
  renderManualChanges();
  ChangesPanel.render();

  // Update version and raid controls after imports, restores and undo.
  syncVersionControls();
  document.getElementById('roster-name-text').textContent = State.rosterName;
  if (typeof announcePlanName === 'function') announcePlanName();
  syncRaidNotesUI();
  RaidHelperSync.updateControls();
  renderCampfires();
  renderAssignments();
  renderReadiness();
}

// ── GROUP PANELS (Planner board on Forge, T6) ───────────────────
// One group = one Forge panel: a head (gold "Group N", the muted dominant role word, the drum icon when a drummer sits
// here, the seated count), the player rows, a foot with the buff icons. Shared by the live board and the Reference comp.
const GROUP_CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';
const DRUMS_TOOLTIP = 'Party-scoped haste/stat buff from a Leatherworker\'s drums. One effect active at a time per party — rotate multiple drummers for continuous uptime.';

// "Melee" for the muted word after the group name (getDominantRoleLabel keeps its capitals for the tank-group lookup).
function groupRoleWord(players) {
  const label = getDominantRoleLabel(players);
  return label ? label.charAt(0) + label.slice(1).toLowerCase() : '';
}

// The drum icon button beside the group name: one button naming every drummer in the group, tooltip through the shared portal.
function drumButtonHTML(drummers) {
  if (!drummers.length) return '';
  const names = drummers.map(p => (p.name || '').split('-')[0]).join(', ');
  const drumIconUrl = Config.BuffIconURL('DRUMS');
  const inner = drumIconUrl ? `<img src="${esc(drumIconUrl)}" alt="" loading="lazy" class="buff-img">` : esc(Config.BuffAbbreviations.DRUMS);
  return `<button type="button" class="gs-pb-drum" aria-label="${drummers.length === 1 ? 'Drummer' : 'Drummers'}: ${esc(names)}" data-tt-name="Drums" data-tt-desc="${esc(DRUMS_TOOLTIP)}" data-tt-source="${esc(names)}">${inner}</button>`;
}

function groupCardHTML(gi, players, slotsHTML, buffsHTML, drummers) {
  const role = groupRoleWord(players);
  return `<div class="group-card gs-hd-panel gs-pb-group" role="listitem" data-group="${gi}">
      <div class="gs-pb-head">
        <h3 class="gs-fg-gh"><span class="gs-fg-ght">Group ${gi + 1}</span>${role ? `<span class="gs-fg-ghn gs-pb-role">${role}</span>` : ''}</h3>
        ${drumButtonHTML(drummers)}
        <span class="gs-pb-fill">${players.length}/5</span>
      </div>
      <div class="player-list">${slotsHTML}</div>
      <div class="gs-pb-foot"><span class="gs-fg-lbl gs-pb-buffs-label">Buffs</span>${buffsHTML}</div>
    </div>`;
}

// One buff icon in a group's foot. A swappable one (totem / aura choice) is a button with a small chevron and opens the picker;
// the Reference comp passes allowSwap false (its icons are read-only).
function groupBuffIconHTML(b, gi, allowSwap) {
  const abbr = Config.BuffAbbreviations[b.id] || b.id;
  const css = Config.BuffCSSClass[b.id] || '';
  const from = b.sourceName ? b.sourceName.split('-')[0] : '';
  const sourceColor = b.sourceClass ? (Config.ClassColors[b.sourceClass] || 'var(--text-secondary)') : 'var(--text-secondary)';
  const iconUrl = Config.BuffIconURL(b.id);
  const hasIcon = iconUrl ? ' has-icon' : '';
  const imgTag = iconUrl ? `<img src="${iconUrl}" alt="${esc(abbr)}" loading="lazy" class="buff-img">` : '';
  const isSwappable = allowSwap && !!buffSlotCategory(b.id);
  const swapClass = isSwappable ? ' swappable' : '';
  const overrideClass = b.isOverride ? ' overridden' : '';
  const dataAttrs = isSwappable ? ` data-buff-id="${esc(b.id)}" data-group="${gi}" data-uid="${esc(b.sourceUid)}" data-source="${esc(b.sourceName)}" data-class="${esc(b.sourceClass)}" data-spec="${esc(b.sourceSpec || '')}"` : '';
  const ttAttrs = ` data-tt-name="${esc(b.buff.name)}" data-tt-desc="${esc(b.buff.desc || '')}" data-tt-source="${esc(from)}" data-tt-source-color="${sourceColor}"`;
  const iconTag = isSwappable ? 'button' : 'div';
  const iconAttrs = isSwappable
    ? ` type="button" aria-label="${esc(swappableBuffLabel(b, from))}"`
    : ` role="img" tabindex="0" aria-label="${esc(b.buff.name)}"`;
  const chevron = isSwappable ? `<span class="gs-pb-chev" aria-hidden="true">${GROUP_CHEVRON}</span>` : '';
  return `<${iconTag} class="buff-icon ${css}${hasIcon}${swapClass}${overrideClass}"${iconAttrs}${dataAttrs}${ttAttrs}>${imgTag}<span class="buff-label">${abbr}</span>${chevron}</${iconTag}>`;
}
// ── end GROUP PANELS ────────────────────────────────────────────

// ── RAID CHECK STRIP + COVERAGE DIALOG ──────────────────────────
// ONE model of what the raid is missing feeds both: the strip shows each missing buff or debuff as an icon button, the
// Coverage dialog lists the same items as rows. Missing items are grouped by what fixes them: Fix now (one click: a Switch
// or a Swap In, or two warriors to group together), Needs a recruit (nobody in the roster can). The reference comp has no
// live-plan fixes, so it gets one Missing group of plain rows.
let lastCatalogCoverage = null;
let lastGapCount = 0; // missing buffs and debuffs the last catalog render found (the head chip adds the role floors)
function buildCoverageModel(coveredBuffIds, coveredDebuffIds) {
  // The reference comp is a static board: the live plan's Switch / Swap In fixes do not belong on it.
  const insights = State.activeTab === 'ideal' ? null : getMissingBuffInsights();
  // Faction-locked rosters (Classic) never show a buff the detected faction could never field (Windfury for Alliance, Devotion Aura for Horde).
  const lists = [
    { dataset: factionRelevantBuffs(), abbr: Config.BuffAbbreviations, iconUrl: id => Config.BuffIconURL(id), covered: coveredBuffIds, debuff: false },
    { dataset: Config.Debuffs, abbr: Config.DebuffAbbreviations, iconUrl: id => Config.DebuffIconURL(id), covered: coveredDebuffIds, debuff: true },
  ];
  const missing = [];
  const covered = [];
  for (const list of lists) {
    for (const id of Object.keys(list.dataset)) (list.covered.has(id) ? covered : missing).push({ id, ...list });
  }
  const oneClick = (m) => {
    const i = insights && insights[m.id];
    return !!i && (i.kind === 'switch' || i.kind === 'bench' || (i.kind === 'shared' && i.casters >= 2));
  };
  return {
    insights, missing, covered,
    fixNow: insights ? missing.filter(oneClick) : [],
    recruit: insights ? missing.filter(m => !oneClick(m)) : [],
  };
}

const firstName = (p) => ((p && p.name) || 'Unknown').split('-')[0];
// What fixes a Fix now gap, as a phrase ("swap in Arimyr").
function fixPhrase(insight) {
  if (insight.kind === 'switch') return `switch ${firstName(insight.player)} to it`;
  if (insight.kind === 'bench') return `swap in ${firstName(insight.player)}`;
  return 'group two warriors together';
}
// Who to recruit for a gap, as a phrase ("Shadow Priest", "a second Warrior").
function recruitPhrase(m, insight) {
  const entry = m.dataset[m.id];
  if (insight && insight.kind === 'shared' && entry.sourceClass) return `a second ${entry.sourceClass.charAt(0) + entry.sourceClass.slice(1).toLowerCase()}`;
  return buffSourceInfo(entry).label || 'a new player';
}

// One missing item as an icon button in the strip. The name shows through the shared tooltip portal (hover, focus, tap).
function gapIconHTML(m, status) {
  const entry = m.dataset[m.id];
  const url = m.iconUrl(m.id) || (entry.sourceClass ? Config.IconURL('classicon_' + entry.sourceClass.toLowerCase()) : '');
  const inner = url ? `<img src="${esc(url)}" alt="" loading="lazy" class="buff-img">` : esc(m.abbr[m.id] || m.id);
  return `<button type="button" class="gs-pb-gap" aria-label="${esc(entry.name)}. ${esc(status)}" data-tt-name="${esc(entry.name)}" data-tt-desc="${esc(entry.desc || '')}" data-tt-source="${esc(status)}" data-tt-source-color="var(--text-secondary)">${inner}</button>`;
}
function gapGroupHTML(label, icons) {
  if (!icons.length) return '';
  return `<div class="gs-pb-gapgroup" role="group" aria-label="${label} ${icons.length}"><span class="gs-fg-lbl">${label} ${icons.length}</span><div class="gs-pb-icons">${icons.join('')}</div></div>`;
}

function renderBuffCatalog(coveredBuffIds, coveredDebuffIds) {
  lastCatalogCoverage = [coveredBuffIds, coveredDebuffIds];
  lastGapCount = 0;
  const gapsEl = document.getElementById('raid-check-gaps');
  const coveredBtn = document.getElementById('btn-coverage');
  const summaryEl = document.getElementById('coverage-summary');
  const dialogGaps = document.getElementById('buff-catalog-gaps');
  const coveredEl = document.getElementById('buff-catalog-covered');
  if (!GameVersions[State.gameVersion].modeled) {
    if (gapsEl) gapsEl.innerHTML = '<span class="gs-pb-quiet">Rules pending</span>';
    if (coveredBtn) coveredBtn.hidden = true;
    if (summaryEl) summaryEl.textContent = '';
    if (dialogGaps) dialogGaps.innerHTML = '<p class="gs-pb-quiet">Coverage rules are not configured for this version yet.</p>';
    if (coveredEl) coveredEl.innerHTML = '';
    return;
  }
  const { insights, missing, covered, fixNow, recruit } = buildCoverageModel(coveredBuffIds, coveredDebuffIds);
  lastGapCount = missing.length;
  const rows = (items) => items.map(m => renderBuffRowList(m.id, m.dataset, m.abbr, m.iconUrl, m.covered.has(m.id), insights ? insights[m.id] : null, m.debuff)).join('');
  const group = (title, count, body) => `<h3 class="gs-fg-gh"><span class="gs-fg-ght">${title}</span><span class="gs-fg-ghn">${count}</span></h3>${body}`;

  // The strip: icon groups and the covered count.
  let stripHTML = '';
  if (!missing.length) stripHTML = '<span class="gs-pb-quiet">No gaps</span>';
  else if (!insights) stripHTML = gapGroupHTML('Missing', missing.map(m => gapIconHTML(m, 'Missing')));
  else {
    stripHTML = gapGroupHTML('Fix now', fixNow.map(m => gapIconHTML(m, `Fix now: ${fixPhrase(insights[m.id])}`)))
      + gapGroupHTML('Needs a recruit', recruit.map(m => gapIconHTML(m, `Needs a recruit: ${recruitPhrase(m, insights[m.id])}`)));
  }
  if (gapsEl) gapsEl.innerHTML = stripHTML;
  if (coveredBtn) { coveredBtn.hidden = false; coveredBtn.textContent = `${covered.length} covered`; }
  if (summaryEl) summaryEl.textContent = `${covered.length} of ${missing.length + covered.length} covered`;

  // The dialog: the same items as rows.
  let gaps = '';
  if (!insights) {
    if (missing.length) gaps = group('Missing', missing.length, `<div class="buff-row-list">${rows(missing)}</div>`);
  } else {
    // One line per source spec; the shared-shout entry with one warrior seated keeps its insight line under it.
    const lines = new Map();
    for (const m of recruit) {
      const entry = m.dataset[m.id];
      const key = buffSourceInfo(entry).label || 'Other';
      if (!lines.has(key)) lines.set(key, { label: key, names: [], notes: [] });
      const line = lines.get(key);
      line.names.push(`<span class="rec-name">${esc(entry.name)}${m.debuff ? ' <span class="tag-deb">Debuff</span>' : ''}</span>`);
      if (insights[m.id] && insights[m.id].kind === 'shared') line.notes.push(renderInsightLine(m.id, insights[m.id]));
    }
    if (fixNow.length) gaps += group('Fix now', fixNow.length, `<div class="buff-row-list">${rows(fixNow)}</div>`);
    if (lines.size) {
      const body = [...lines.values()].map(l => `<div class="rec-item"><div class="rec-line"><span class="rec-spec">${esc(l.label)}</span>: ${l.names.join(', ')}</div>${l.notes.join('')}</div>`).join('');
      gaps += group('Needs a recruit', recruit.length, `<div class="rec-list">${body}</div>`);
    }
  }
  if (dialogGaps) dialogGaps.innerHTML = gaps;
  if (coveredEl) coveredEl.innerHTML = covered.length ? group('Covered', covered.length, `<div class="buff-row-list">${rows(covered)}</div>`) : '';
}

// The strip's role tiles: Tanks and Healers show "have/floor" with the muted floor, Melee and Ranged just the figure.
// players = the seated roster (live plan) or every player of the reference comp; floors = Optimizer.floorsFor(size) or null.
function renderRaidCheckTiles(players, floors) {
  const el = document.getElementById('raid-check-tiles');
  if (!el) return;
  const counts = { tank: 0, healer: 0, melee_dps: 0, ranged: 0 };
  for (const p of players) {
    if (p.role === 'tank') counts.tank++;
    else if (p.role === 'healer') counts.healer++;
    else if (p.role === 'melee_dps') counts.melee_dps++;
    else counts.ranged++;
  }
  const tile = (label, n, floor) => {
    const short = floor && n < floor;
    const figure = floor && n <= floor ? `${n}/${floor}` : `${n}`;
    return `<div class="gs-pb-tile"><span class="gs-fg-lbl">${label}</span><span class="gs-pb-fig"><b>${figure}</b>${floor ? `<span class="gs-pb-floor">floor ${floor}</span>` : ''}${short ? `<span class="sr-only">, ${floor - n} short</span>` : ''}</span></div>`;
  };
  el.innerHTML = tile('Tanks', counts.tank, floors && floors.tank) + tile('Healers', counts.healer, floors && floors.healer)
    + tile('Melee', counts.melee_dps, 0) + tile('Ranged', counts.ranged, 0);
}

// One line under a missing row saying what would fix it, with the button
// that does it. Mirrors getMissingBuffInsights(): switch / bench / shared / none.
function renderInsightLine(id, insight) {
  if (!insight) return '';
  const short = (p) => esc((p.name || 'Unknown').split('-')[0]);
  const color = (p) => classColorClass(p.class, 'secondary');
  if (insight.kind === 'switch') {
    const p = insight.player;
    return `<div class="buff-row-insight switch">
      <span class="insight-text" title="In raid: ${short(p)}">In raid: <span class="insight-who ${color(p)}">${short(p)}</span></span>
      <button type="button" class="insight-btn gs-btn" data-insight-switch="${esc(id)}" data-group="${insight.groupIdx}" data-uid="${esc(p.uid)}" title="Make ${short(p)} run ${esc(Config.Buffs[id].name)}">Switch</button>
    </div>`;
  }
  if (insight.kind === 'bench') {
    const p = insight.player;
    const specLabel = p.spec ? `${esc(p.spec)}` : '';
    return `<div class="buff-row-insight bench">
      <span class="insight-text" title="Benched: ${short(p)}${specLabel ? ' (' + specLabel + ')' : ''}">Benched: <span class="insight-who ${color(p)}">${short(p)}</span>${specLabel ? ' (' + specLabel + ')' : ''}</span>
      <button type="button" class="insight-btn gs-btn" data-insight-swap="${esc(p.uid)}" title="Put ${short(p)} in a group; bench the lowest-value player in the same role if the raid is full">Swap In</button>
    </div>`;
  }
  if (insight.kind === 'shared') {
    const lead = insight.casters > 1 ? 'Group two warriors together' : 'Needs a 2nd warrior';
    return `<div class="buff-row-insight none"><span class="insight-text" title="${lead}: ${short(insight.player)} casts the other shout">${lead}: <span class="insight-who ${color(insight.player)}">${short(insight.player)}</span> casts the other shout</span></div>`;
  }
  return `<div class="buff-row-insight none"><span class="insight-text" title="Nobody in roster">Nobody in roster</span></div>`;
}

// One buff or debuff row, followed by its insight line when it is missing and the live plan has one.
function renderBuffRowList(id, dataset, abbrMap, iconUrlFn, isCovered, insight, isDebuff) {
  const entry = dataset[id];
  const iconUrl = iconUrlFn(id);
  const abbr = abbrMap[id] || id;
  const imgTag = iconUrl
    ? `<img src="${iconUrl}" alt="${esc(abbr)}" loading="lazy">`
    : esc(abbr);
  const { label: sourceLabel, color: sourceColor } = buffSourceInfo(entry);

  let tooltip = entry.desc || '';
  let warnBadge = '';
  if (entry.supersededBy) {
    const winner = dataset[entry.supersededBy];
    const winnerName = winner ? winner.name : entry.supersededBy;
    tooltip += ` Shares a debuff slot with ${winnerName}, which is strictly better.`;
    warnBadge = ` <span class="buff-row-warn" title="Superseded by ${esc(winnerName)}">&#9888;</span>`;
  } else if (entry.competesWith && entry.competesWith.length) {
    const names = entry.competesWith.map(cid => (dataset[cid] ? dataset[cid].name : cid)).join(', ');
    tooltip += ` Mutually exclusive with: ${names}.`;
  }

  const statusLabel = isCovered ? 'Covered by this raid' : 'Not covered';
  const sourceLine = sourceLabel ? `${sourceLabel} - ${statusLabel}` : statusLabel;
  const ttAttrs = ` data-tt-name="${esc(entry.name)}" data-tt-desc="${esc(tooltip.trim())}"`
    + ` data-tt-source="${esc(sourceLine)}" data-tt-source-color="${sourceColor}"`;

  return `<div class="buff-row${isCovered ? ' covered' : ''}${isDebuff ? ' tagged' : ''}">
    <div class="buff-row-icon"${ttAttrs}>${imgTag}</div>
    <span class="buff-row-name" title="${esc(entry.name)}">${esc(entry.name)}</span>${isDebuff ? '<span class="tag-deb">Debuff</span>' : ''}${warnBadge}
    <span class="buff-row-source" title="${esc(sourceLabel)}">${esc(sourceLabel)}</span>
  </div>` + (!isCovered && insight ? renderInsightLine(id, insight) : '');
}

// What a row's source label says: "Shadow Priest", or just the class when the entry names no spec.
function buffSourceInfo(entry) {
  const sourceClassLabel = entry.sourceClass
    ? entry.sourceClass.charAt(0) + entry.sourceClass.slice(1).toLowerCase()
    : '';
  const sourceSpec = entry.sourceSpec || entry.preferSpec || '';
  return {
    label: sourceSpec ? `${sourceSpec} ${sourceClassLabel}` : sourceClassLabel,
    color: entry.sourceClass ? (Config.ClassColors[entry.sourceClass] || 'var(--text-secondary)') : 'var(--text-secondary)',
  };
}

// One line under a missing utility row saying what would fix it. Mirrors
// renderInsightLine(), but utility abilities have no totem/aura slot to
// switch into, so only the bench/none cases apply.
function renderUtilityInsightLine(item) {
  if (item.benchCount > 0) {
    const p = item.benchProviders[0];
    const short = esc((p.name || 'Unknown').split('-')[0]);
    const color = classColorClass(p.class, 'secondary');
    const specLabel = p.spec ? ` (${esc(p.spec)})` : '';
    return `<div class="buff-row-insight bench">
      <span class="insight-text" title="Benched: ${short}${specLabel}">Benched: <span class="insight-who ${color}">${short}</span>${specLabel}</span>
      <button type="button" class="insight-btn gs-btn" data-insight-swap="${esc(p.uid)}" title="Put ${short} in a group; bench the lowest-value player in the same role if the raid is full">Swap In</button>
    </div>`;
  }
  return `<div class="buff-row-insight none"><span class="insight-text" title="Nobody in roster">Nobody in roster</span></div>`;
}

// Class-presence utility checklist (Battle Rez, cleanses, Bloodlust, ...) —
// same missing-first/covered-below layout as renderBuffRowList, but driven by
// Readiness.utilityCoverage() since utility entries can have several possible
// provider classes instead of one sourceClass/sourceSpec pair.
function renderUtilityCatalog(groups, bench) {
  const container = document.getElementById('buff-catalog-utility');
  const countEl = document.getElementById('buff-count-utility');
  if (!container) return;
  if (!GameVersions[State.gameVersion].modeled) {
    container.innerHTML = '';
    if (countEl) countEl.textContent = '';
    return;
  }
  const items = Readiness.utilityCoverage(groups, bench);
  const missing = items.filter(i => !i.covered);
  const covered = items.filter(i => i.covered);
  if (countEl) countEl.textContent = `${covered.length} / ${items.length}`;

  let html = '';
  if (missing.length) html += `<div class="gs-fg-lbl gs-pb-sub missing">Missing &middot; ${missing.length}</div>`;
  const ordered = [...missing, ...(covered.length ? ['__covered__'] : []), ...covered];
  for (const item of ordered) {
    if (item === '__covered__') { html += `<div class="gs-fg-lbl gs-pb-sub">Covered &middot; ${covered.length}</div>`; continue; }
    const seatedNames = item.seatedProviders.map(p => esc((p.name || 'Unknown').split('-')[0])).join(', ');
    const sourceText = item.covered ? seatedNames : 'Not covered';
    const ttAttrs = ` data-tt-name="${esc(item.name)}" data-tt-desc="${esc(item.desc)}"`
      + ` data-tt-source="${item.covered ? esc(seatedNames) + ' - Covered by this raid' : 'Not covered'}"`;
    html += `<div class="buff-row${item.covered ? ' covered' : ''}"${ttAttrs}>
      <span class="buff-row-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <span class="buff-row-source" title="${esc(sourceText)}">${esc(sourceText)}</span>
    </div>`;
    if (!item.covered) html += renderUtilityInsightLine(item);
  }
  container.innerHTML = html;
}

// Soft composition warnings (melee/ranged skew, class stacking, healer
// ratio) shown in the Coverage dialog below the Utility section.
function renderBalanceWarnings() {
  const el = document.getElementById('balance-warnings');
  if (!el) return;
  if (!GameVersions[State.gameVersion].modeled) { el.innerHTML = ''; return; }
  const warnings = Readiness.balanceWarnings();
  el.innerHTML = warnings.length
    ? `<h3 class="gs-fg-gh"><span class="gs-fg-ght">Balance</span><span class="gs-fg-ghn">${warnings.length}</span></h3>` + warnings.map(w => `<div class="balance-warning-row">${esc(w.text)}</div>`).join('')
    : '';
}

// ── Coverage dialog: the fix buttons on its rows (delegated, attached once) ──
(function initCoverageActions() {
  const dialog = document.getElementById('coverage-dialog');
  if (!dialog) return;
  // A fix re-renders the dialog and the clicked button goes with it: focus moves to the heading so the modal keeps it.
  const afterFix = () => {
    commit();
    if (!dialog.contains(document.activeElement)) document.getElementById('coverage-heading')?.focus();
  };
  dialog.addEventListener('click', (e) => {
    const swapBtn = e.target.closest('[data-insight-swap]');
    if (swapBtn) {
      const res = RosterEdit.SwapIn(swapBtn.dataset.insightSwap);
      if (!res.success) { showToast(res.error); return; }
      afterFix();
      const who = (res.player.name || '').split('-')[0];
      showToast(res.benched
        ? `${who} seated in Group ${res.groupIdx + 1}; ${(res.benched.name || '').split('-')[0]} benched`
        : `${who} seated in Group ${res.groupIdx + 1}`);
      return;
    }
    const switchBtn = e.target.closest('[data-insight-switch]');
    if (switchBtn) {
      const res = RosterEdit.SwitchBuff(parseInt(switchBtn.dataset.group), switchBtn.dataset.uid, switchBtn.dataset.insightSwitch);
      if (!res.success) { showToast(res.error); return; }
      afterFix();
      showToast(`${(res.player.name || '').split('-')[0]} now runs ${Config.Buffs[res.buffId].name}`);
    }
  });
})();

// ── Raid summary (Groups line + screen-reader sentence) ──
// The sentence the screen-reader region announces for the Groups line; the line itself is
// not a live region (it is rebuilt on every render, which would re-read all of it).
function describeRaidSummary({ seated, capacity, counts, benched }) {
  const n = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${seated} of ${capacity} in raid: ${n(counts.tank, 'tank')}, ${n(counts.healer, 'healer')}, ${counts.melee_dps} melee, ${counts.ranged} ranged. ${benched} benched.`;
}

// One polite, atomic sr-only region for every announcement the page makes by itself.
// Repeating the last message is skipped, so re-rendering an unchanged plan stays silent.
let lastAnnouncement = '';
let lastRaidSummary = ''; // the composition sentence renderSummaryBar last built
function announce(message) {
  const region = document.getElementById('sr-status');
  if (!region || !message || message === lastAnnouncement) return;
  lastAnnouncement = message;
  region.textContent = message;
}

// ── CHANGES PANEL ──
// The "Changes" button at the end of the action row (in the More sheet on phones)
// and the "Recent changes" panel below the banners. Both follow ChangeLog: the
// button shows while the log has entries, its badge counts unseen changes, and
// every render redraws the panel, so card highlights and the list never disagree.
const ChangesPanel = {
  COLLAPSE_AT: 7, // entries with more items than this list counts per kind until shown
  expanded: new Set(), // entry ids whose full list is open

  el(id) { return document.getElementById(id); },
  isOpen() { const panel = this.el('changes-log-panel'); return !!panel && !panel.hidden; },

  setOpen(open) {
    const panel = this.el('changes-log-panel');
    const button = this.el('btn-changes');
    if (!panel || !button) return;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      this.render();
      if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'nearest' });
    }
  },

  itemHTML(it) {
    const name = (it.name || 'Unknown').split('-')[0];
    return `<li class="changes-log-item"><span class="changes-log-kind changes-log-kind-${esc(it.kind)}">${esc(ChangeLog.WORDS[it.kind] || it.kind)}</span> <strong>${esc(name)}</strong>${it.detail ? ` <span class="changes-log-detail">- ${esc(it.detail)}</span>` : ''}</li>`;
  },

  entryHTML(entry, now) {
    const long = entry.items.length > this.COLLAPSE_AT;
    const open = !long || this.expanded.has(entry.id);
    const lines = open
      ? entry.items.map(it => this.itemHTML(it)).join('')
      : ChangeLog.kindCounts(entry).map(k => `<li class="changes-log-item"><span class="changes-log-kind changes-log-kind-${k.kind}">${esc(k.word)}</span> ${k.count} player${k.count === 1 ? '' : 's'}</li>`).join('');
    const toggle = long
      ? `<button type="button" class="link-btn changes-log-more" data-changes-expand="${entry.id}" aria-expanded="${open}">${open ? 'Hide the list' : `Show all ${entry.items.length}`}</button>`
      : '';
    const unseen = !entry.seen && ChangeLog.loudItems(entry).length > 0;
    return `<div class="changes-log-entry${unseen ? ' is-unseen' : ''}">
      <h4 class="changes-log-meta">${esc(entry.label)} <span class="changes-log-time">- ${esc(ChangeLog.ago(entry.time, now))}</span>${unseen ? '<span class="sr-only">, not seen yet</span>' : ''}</h4>
      <ul class="changes-log-items">${lines}</ul>${toggle}
    </div>`;
  },

  render() {
    const button = this.el('btn-changes');
    if (!button) return;
    ChangeLog.forPlan(State.planId); // another plan open: its log starts empty
    const entries = ChangeLog.entries;
    const unseen = ChangeLog.unseenCount();
    button.hidden = !entries.length;
    button.setAttribute('aria-label', unseen ? `Changes, ${unseen} unseen` : 'Changes');
    for (const id of ['changes-count', 'more-changes-count', 'phone-more-changes-count']) {
      const badge = this.el(id);
      if (!badge) continue;
      badge.hidden = !unseen;
      badge.textContent = unseen ? String(unseen) : '';
    }
    for (const id of ['btn-settings-menu', 'btn-phone-more']) {
      const more = this.el(id);
      if (!more) continue;
      if (unseen) more.setAttribute('aria-label', `More, ${unseen} unseen change${unseen === 1 ? '' : 's'}`);
      else if (id === 'btn-phone-more') more.removeAttribute('aria-label');
      else more.setAttribute('aria-label', 'More');
    }
    for (const id of this.expanded) if (!entries.some(entry => entry.id === id)) this.expanded.delete(id);
    if (!entries.length) {
      if (this.isOpen()) this.setOpen(false);
      return;
    }
    const list = this.el('changes-log-list');
    if (!list || !this.isOpen()) return;
    const now = Date.now();
    list.innerHTML = entries.map(entry => this.entryHTML(entry, now)).join('');
  },

  // Highlights live in the slot markup, so the board is redrawn (through commit, the one render path).
  markAllSeen() {
    ChangeLog.markAllSeen();
    commit();
  },
};
// A recorded change redraws the board (highlights, badge, panel) and is announced once.
// The tracked action has already committed; this commit only redraws.
ChangeLog.onRecord = entry => {
  commit();
  // An Optimize that only moved players has nothing to announce beyond the composition the tracked commit spoke.
  if (!ChangeLog.loudItems(entry).length) return;
  // A size change or a seat change also changed the composition the tracked commit
  // just announced; the region holds one message, so the summary carries both.
  const reshaped = entry.kind === 'size' || entry.items.some(it => it.kind !== 'status' && it.kind !== 'moved');
  const summary = ChangeLog.summary(entry);
  lastAnnouncement = ''; // every entry is news, even one that reads like the last
  announce(reshaped && lastRaidSummary ? `${summary}. ${lastRaidSummary}` : summary);
};
(function initChangesPanel() {
  const button = ChangesPanel.el('btn-changes');
  const list = ChangesPanel.el('changes-log-list');
  if (!button || !list) return;
  // On phones the button sits in the More sheet, which closes on the click and hands
  // focus back to More; move focus to the panel after that so it is not opened silently.
  const inSheet = () => !!button.closest('#mobile-more-sheet');
  button.addEventListener('click', () => {
    const open = !ChangesPanel.isOpen();
    ChangesPanel.setOpen(open);
    const heading = ChangesPanel.el('changes-log-heading');
    if (open && heading && inSheet()) setTimeout(() => heading.focus(), 0);
  });
  const seen = ChangesPanel.el('btn-changes-seen');
  if (seen) seen.addEventListener('click', () => ChangesPanel.markAllSeen());
  const close = ChangesPanel.el('btn-changes-close');
  if (close) close.addEventListener('click', () => {
    ChangesPanel.setOpen(false);
    const opener = inSheet() ? ChangesPanel.el('btn-phone-more') : button;
    if (opener) opener.focus();
  });
  list.addEventListener('click', e => {
    const toggle = e.target.closest('[data-changes-expand]');
    if (!toggle) return;
    const id = Number(toggle.dataset.changesExpand);
    if (ChangesPanel.expanded.has(id)) ChangesPanel.expanded.delete(id); else ChangesPanel.expanded.add(id);
    ChangesPanel.render();
    const again = list.querySelector(`[data-changes-expand="${id}"]`);
    if (again) again.focus();
  });
  // Keeps "N min ago" current while the panel is open.
  setInterval(() => { if (ChangesPanel.isOpen()) ChangesPanel.render(); }, 60000);
})();

// The Groups line above the board: "24 of 25 seated" (plus the open slots), and the sentence the screen-reader region announces.
function renderSummaryBar() {
  const raidInfo = Config.Raids[State.selectedRaid];
  const capacity = raidInfo ? raidInfo.size : 25;
  const seated = State.roster.length;
  const counts = { tank: 0, healer: 0, melee_dps: 0, ranged: 0 };
  for (const p of State.roster) {
    if (p.role === 'tank') counts.tank++;
    else if (p.role === 'healer') counts.healer++;
    else if (p.role === 'melee_dps') counts.melee_dps++;
    else counts.ranged++;
  }
  const benched = (State.bench || []).length;
  const open = State.preferredSlots.length;
  const seatedEl = document.getElementById('seated-count');
  if (seatedEl) {
    seatedEl.textContent = `${seated} of ${capacity} seated${open ? ` · ${open} open slot${open === 1 ? '' : 's'}` : ''}`;
    seatedEl.classList.toggle('is-over', seated > capacity);
  }
  lastRaidSummary = describeRaidSummary({ seated, capacity, counts, benched });
  announce(lastRaidSummary);
}

// ── PLAN HEAD (Planner board on Forge, T6) ───────────────────────
// The head's ONE chip and its muted context line, drawn from real state. Gaps = the buffs and debuffs the raid is missing
// (the Raid check strip's model) plus every role floor not met. An unmodeled version has no rules to count against.
function planGapCount() {
  const floors = Optimizer.floorsFor(Config.Raids[State.selectedRaid]?.size || 25);
  const have = { tank: 0, healer: 0 };
  for (const p of State.roster) if (p.role in have) have[p.role]++;
  const unmet = (floors ? ['tank', 'healer'].filter(role => floors[role] && have[role] < floors[role]) : []).length;
  return lastGapCount + unmet;
}
// "Live link off", or a short phrase for each state LiveSync.statusText reports (it owns the wording of the long sentence).
function liveLinkWord() {
  const text = LiveSync.statusText('');
  if (!text) return 'off';
  if (/^Live link not saved/.test(text)) return 'not saved';
  if (/^Saving/.test(text)) return 'saving';
  return 'on';
}
// The context line's save phrase: where the raid's copy stands while a raid plan saves to the database, else the live link.
function planSaveWord() {
  if (typeof PlanDb !== 'undefined' && PlanDb.active()) {
    const key = PlanDb.statusKey();
    return key === 'saved' ? 'Saved to the raid' : key === 'saving' ? 'Saving to the raid' : 'Not saved to the raid';
  }
  return `Live link ${liveLinkWord()}`;
}
// Where the roster came from and how many people it holds, for the context line and the Raid settings dialog.
function signupsSummary() {
  const count = State.roster.length + (State.bench || []).length;
  const source = State.sourceEventId ? 'Raid-Helper' : String(State.planId || '').startsWith('raid:') ? 'Guild raid' : '';
  if (!count) return source;
  const noun = source ? `${count} sign-up${count === 1 ? '' : 's'}` : `${count} player${count === 1 ? '' : 's'}`;
  return source ? `${source}, ${noun}` : noun;
}
function renderPlanHead() {
  const chip = document.getElementById('plan-chip');
  const context = document.getElementById('plan-context');
  if (!chip || !context) return;
  const profile = GameVersions[State.gameVersion];
  const raid = Config.Raids[State.selectedRaid];
  const signups = signupsSummary();
  const parts = [VERSION_BUTTON_TEXT[State.gameVersion]?.text || profile.name, raid ? raid.name : '', raid ? `${raid.size}-man` : '', signups, planSaveWord()].filter(Boolean);
  context.innerHTML = parts.map(part => `<span>${esc(part)}</span>`).join('<span aria-hidden="true">-</span>');
  if (!hasLoadedWork()) {
    chip.hidden = true;
  } else if (!profile.modeled) {
    chip.hidden = false;
    chip.className = 'gs-hd-chip is-grey plan-only';
    chip.textContent = 'Rules pending';
  } else {
    const gaps = planGapCount();
    chip.hidden = false;
    chip.className = `gs-hd-chip ${gaps ? 'is-short' : 'is-ready'} plan-only`;
    chip.textContent = gaps ? `${gaps} gap${gaps === 1 ? '' : 's'}` : 'Ready';
  }
  const signupsEl = document.getElementById('raid-settings-signups');
  if (signupsEl) signupsEl.textContent = signups || 'No sign-ups loaded';
  const liveEl = document.getElementById('raid-settings-live');
  if (liveEl) liveEl.textContent = typeof PlanDb !== 'undefined' ? PlanDb.statusText(LiveSync.statusText('Off')) : LiveSync.statusText('Off');
}

// ── DRAG & DROP (event delegation — attached once) ──────────────
let dragData = null;

// Moves the player at (srcG, srcS) onto slot (tgtG, tgtS): into an open seat,
// or swapping with whoever sits there. Shared by mouse and touch drag; a manual move also
// pins the group order.
function moveGroupPlayer(srcG, srcS, tgtG, tgtS) {
  const srcPlayer = (State.groups[srcG] || [])[srcS] || null;
  const tgtPlayer = (State.groups[tgtG] || [])[tgtS] || null;
  if (!srcPlayer) return false;
  if (!tgtPlayer) {
    State.groups[srcG].splice(srcS, 1);
    if (tgtS >= State.groups[tgtG].length) State.groups[tgtG].push(srcPlayer);
    else State.groups[tgtG].splice(tgtS, 0, srcPlayer);
    srcPlayer.groupNumber = tgtG + 1;
  } else {
    State.groups[srcG][srcS] = tgtPlayer;
    State.groups[tgtG][tgtS] = srcPlayer;
    srcPlayer.groupNumber = tgtG + 1;
    tgtPlayer.groupNumber = srcG + 1;
  }
  // The leader arranged this by hand: sortTankGroupFirst() must not reshuffle the group order afterwards.
  State.preserveGroupOrder = true;
  return true;
}

// The drag ghost follows the pointer through a transform (left/top would re-layout on every
// move) and at most one move is applied per animation frame.
const DragGhost = {
  x: 0, y: 0, frame: 0,
  move(x, y) {
    this.x = x;
    this.y = y;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.place(); });
  },
  place() {
    document.getElementById('drag-ghost').style.transform = `translate(${this.x + 12}px, ${this.y - 10}px)`;
  },
  // Show it already under the pointer, not where the last drag left it.
  start(x, y) {
    this.stop();
    this.x = x;
    this.y = y;
    this.place();
  },
  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  },
};

(function initDragDrop() {
  const container = document.getElementById('groups-container');
  const ghost = document.getElementById('drag-ghost');

  container.addEventListener('dragstart', e => {
    const slot = e.target.closest('.player-slot[draggable="true"]');
    if (!slot) return;
    const gi = parseInt(slot.dataset.group);
    const si = parseInt(slot.dataset.slot);
    dragData = { group: gi, slot: si };
    slot.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    const img = new Image(); img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    e.dataTransfer.setDragImage(img, 0, 0);
    const p = State.groups[gi][si];
    if (p) {
      ghost.textContent = p.name.split('-')[0];
      ghost.style.color = Config.ClassColors[p.class] || 'var(--text-primary)';
      ghost.style.display = 'block';
      DragGhost.start(e.clientX, e.clientY);
    }
  });

  container.addEventListener('drag', e => {
    if (e.clientX > 0) DragGhost.move(e.clientX, e.clientY);
  });

  container.addEventListener('dragend', e => {
    const slot = e.target.closest('.player-slot');
    if (slot) slot.classList.remove('dragging');
    ghost.style.display = 'none';
    dragData = null;
    container.querySelectorAll('.drag-target').forEach(s => s.classList.remove('drag-target'));
    container.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', e => {
    const slot = e.target.closest('.player-slot');
    if (!slot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    slot.classList.add('drag-target');
    const card = slot.closest('.group-card');
    if (card) card.classList.add('drag-over');
  });

  container.addEventListener('dragleave', e => {
    const slot = e.target.closest('.player-slot');
    if (!slot) return;
    slot.classList.remove('drag-target');
    const card = slot.closest('.group-card');
    if (card && !card.querySelector('.drag-target')) card.classList.remove('drag-over');
  });

  container.addEventListener('drop', e => {
    const slot = e.target.closest('.player-slot');
    if (!slot || !dragData) return;
    e.preventDefault();

    const tgtGroupIdx = parseInt(slot.dataset.group);

    // An unplaced sign-up is only seated after the leader confirms.
    if (dragData.group === 'unplaced') {
      const uid = dragData.uid;
      ghost.style.display = 'none';
      dragData = null;
      container.querySelectorAll('.drag-target').forEach(s => s.classList.remove('drag-target'));
      container.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
      UnplacedDialog.open(uid, tgtGroupIdx);
      return;
    }

    // Dragged off the bench and into a group.
    if (dragData.group === 'bench') {
      const uid = dragData.uid;
      ghost.style.display = 'none';
      dragData = null;
      const result = RosterEdit.UnbenchPlayer(uid, tgtGroupIdx);
      if (!result.success) { showToast(result.error); return; }
      commit();
      showToast(`${result.player.name} joined group ${tgtGroupIdx + 1}`);
      return;
    }

    const srcG = dragData.group, srcS = dragData.slot;
    const tgtG = tgtGroupIdx, tgtS = parseInt(slot.dataset.slot);

    if (srcG === tgtG && srcS === tgtS) return;

    moveGroupPlayer(srcG, srcS, tgtG, tgtS);

    // commit() below rebuilds groups-container, which destroys the
    // dragged element before the browser can dispatch 'dragend' on it — so
    // it never bubbles up to the container's dragend listener and the ghost
    // is left stuck on screen. Clean up here instead of relying on that.
    ghost.style.display = 'none';
    dragData = null;

    commit();
  });

})();

// ── TOUCH DRAG (long-press) ─────────────────────────────────────
// A plain touch on a slot must still scroll the page and a tap must still open
// the editor, so a drag only starts after the finger rests on a slot for
// LONG_PRESS_MS without moving. Once it starts, the page stops scrolling and
// the finger carries the player between group slots and the bench.
(function initTouchDrag() {
  const LONG_PRESS_MS = 320;
  const MOVE_TOLERANCE = 10;   // px of finger travel that turns a press into a scroll
  const EDGE_ZONE = 56;        // px from the viewport edge where auto-scroll kicks in
  const groups = document.getElementById('groups-container');
  const bench = document.getElementById('bench-section');
  const ghost = document.getElementById('drag-ghost');
  if (!groups || !bench || !ghost) return;

  let pending = null;   // finger down on a slot, waiting for the long-press timer
  let active = null;    // drag in progress
  let suppressClickUntil = 0;
  let autoScrollDir = 0;
  let autoScrollFrame = null;

  function sourceFromSlot(slot) {
    if (slot.dataset.unplacedUid) {
      const p = (State.unplaced || []).find(u => u.uid === slot.dataset.unplacedUid);
      return p ? { group: 'unplaced', player: p } : null;
    }
    if (slot.classList.contains('bench-slot')) {
      const bi = parseInt(slot.dataset.benchSlot);
      const p = (State.bench || [])[bi];
      return p ? { group: 'bench', slot: bi, player: p } : null;
    }
    const gi = parseInt(slot.dataset.group), si = parseInt(slot.dataset.slot);
    const p = State.groups[gi]?.[si];
    return p ? { group: gi, slot: si, player: p } : null;
  }

  function clearHighlights() {
    document.querySelectorAll('.drag-target').forEach(s => s.classList.remove('drag-target'));
    document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  }

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  }

  function stopAutoScroll() {
    autoScrollDir = 0;
    if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = null;
  }

  function autoScrollStep() {
    if (!active || !autoScrollDir) { autoScrollFrame = null; return; }
    window.scrollBy(0, autoScrollDir * 10);
    autoScrollFrame = requestAnimationFrame(autoScrollStep);
  }

  function beginDrag(src, slot, x, y) {
    pending = null;
    active = { ...src, el: slot };
    slot.classList.add('dragging');
    ghost.textContent = src.player.name.split('-')[0];
    ghost.style.color = Config.ClassColors[src.player.class] || 'var(--text-primary)';
    ghost.style.display = 'block';
    DragGhost.start(x, y);
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function endDrag() {
    if (active && active.el) active.el.classList.remove('dragging');
    ghost.style.display = 'none';
    if (highlightFrame) cancelAnimationFrame(highlightFrame);
    highlightFrame = 0;
    highlighted = null;
    DragGhost.stop();
    clearHighlights();
    stopAutoScroll();
    active = null;
  }

  function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const slot = el.closest('.player-slot');
    if (slot && groups.contains(slot)) return { kind: 'slot', el: slot };
    if (bench.contains(el) && bench.style.display !== 'none') return { kind: 'bench', el: bench };
    return null;
  }

  // elementFromPoint and the highlight classes are applied once per frame, from the
  // newest finger position, however many touchmoves arrived since.
  let highlightFrame = 0;
  let highlightPoint = null;
  function queueHighlight(x, y) {
    highlightPoint = { x, y };
    if (highlightFrame) return;
    highlightFrame = requestAnimationFrame(() => {
      highlightFrame = 0;
      if (active && highlightPoint) highlight(targetAt(highlightPoint.x, highlightPoint.y));
    });
  }

  let highlighted = null; // the element currently carrying the drop highlight
  function highlight(target) {
    const el = target ? target.el : null;
    if (el === highlighted) return;
    highlighted = el;
    clearHighlights();
    if (!target) return;
    if (target.kind === 'slot') {
      target.el.classList.add('drag-target');
      const card = target.el.closest('.group-card');
      if (card) card.classList.add('drag-over');
    } else if (active.group !== 'bench' && active.group !== 'unplaced') {
      bench.classList.add('drag-over');
    }
  }

  function drop(target) {
    if (!target) return;
    if (target.kind === 'bench') {
      if (active.group === 'bench' || active.group === 'unplaced') return;
      const result = RosterEdit.BenchPlayer(active.player.uid);
      if (!result.success) { showToast(result.error); return; }
      commit();
      showToast(`Benched ${result.player.name}`);
      return;
    }
    const tgtG = parseInt(target.el.dataset.group), tgtS = parseInt(target.el.dataset.slot);
    if (active.group === 'unplaced') { UnplacedDialog.open(active.player.uid, tgtG); return; }
    if (active.group === 'bench') {
      const result = RosterEdit.UnbenchPlayer(active.player.uid, tgtG);
      if (!result.success) { showToast(result.error); return; }
      commit();
      showToast(`${result.player.name} joined group ${tgtG + 1}`);
      return;
    }
    if (active.group === tgtG && active.slot === tgtS) return;
    if (moveGroupPlayer(active.group, active.slot, tgtG, tgtS)) commit();
  }

  document.addEventListener('touchstart', e => {
    if (active || e.touches.length !== 1) return;
    const slot = e.target.closest('.player-slot[draggable="true"]');
    if (!slot) return;
    const src = sourceFromSlot(slot);
    if (!src) return;
    const t = e.touches[0];
    cancelPending();
    pending = {
      x: t.clientX, y: t.clientY,
      timer: setTimeout(() => beginDrag(src, slot, t.clientX, t.clientY), LONG_PRESS_MS),
    };
  }, { passive: true });

  function onTouchMove(e) {
    if (pending) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > MOVE_TOLERANCE) cancelPending();
      return;
    }
    if (!active) return;
    e.preventDefault();
    const t = e.touches[0];
    DragGhost.move(t.clientX, t.clientY);
    queueHighlight(t.clientX, t.clientY);

    const h = window.innerHeight;
    const dir = t.clientY < EDGE_ZONE ? -1 : (t.clientY > h - EDGE_ZONE ? 1 : 0);
    if (dir !== autoScrollDir) {
      autoScrollDir = dir;
      if (dir && !autoScrollFrame) autoScrollFrame = requestAnimationFrame(autoScrollStep);
    }
  }

  // The only non-passive listeners the page needs (they must preventDefault to stop the page
  // scrolling under a drag). Browsers decide at touchstart whether a touch sequence can be
  // cancelled, so these are permanent and scoped to the drag containers (touchmove goes to
  // the element where the touch started): scrolls that start elsewhere stay passive, and
  // onTouchMove returns early unless a press or drag is in progress.
  groups.addEventListener('touchmove', onTouchMove, { passive: false });
  bench.addEventListener('touchmove', onTouchMove, { passive: false });

  document.addEventListener('touchend', e => {
    cancelPending();
    if (!active) return;
    const t = e.changedTouches[0];
    drop(targetAt(t.clientX, t.clientY));
    endDrag();
    suppressClickUntil = Date.now() + 400;
  });

  document.addEventListener('touchcancel', () => { cancelPending(); endDrag(); });

  // Android raises a context menu on long-press; the tap that follows a drop
  // would otherwise open the player editor.
  document.addEventListener('contextmenu', e => {
    if ((pending || active) && e.target.closest('.player-slot')) e.preventDefault();
  });
  document.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

// ── BUFF OVERRIDE SYSTEM ────────────────────────────────────────
function cleanupOverrides() {
  for (const key of Object.keys(State.buffOverrides)) {
    const parts = key.split(':');
    const gi = parseInt(parts[0]);
    const uid = parts[1];
    const group = State.groups[gi] || [];
    if (!group.find(p => p.uid === uid)) {
      delete State.buffOverrides[key];
    }
  }
}

function getSwappableBuffs(buffId, playerClass, playerSpec) {
  const rules = activeRules();
  const element = rules.totemElements[buffId];
  const isAura = rules.paladinAuras[buffId];
  if (!element && !isAura) return [];

  const alternatives = [];
  if (element) {
    for (const [id, el] of Object.entries(rules.totemElements)) {
      if (el !== element) continue;
      const buff = Config.Buffs[id];
      if (!buff) continue;
      if (buff.sourceClass !== playerClass) continue;
      if (buff.sourceSpec && buff.sourceSpec !== playerSpec) continue;
      alternatives.push({ id, buff });
    }
  } else if (isAura) {
    for (const id of Object.keys(rules.paladinAuras)) {
      const buff = Config.Buffs[id];
      if (!buff) continue;
      alternatives.push({ id, buff });
    }
  }
  return alternatives;
}

// Accessible name of a swappable buff icon: "<buff> from <player>", plus ": choose another buff" only
// when showBuffPicker would offer more than one choice.
function swappableBuffLabel(b, from) {
  const name = from ? `${b.buff.name} from ${from}` : b.buff.name;
  return getSwappableBuffs(b.id, b.sourceClass, b.sourceSpec || '').length > 1 ? `${name}: choose another buff` : name;
}

function showBuffPicker(buffIcon, buffId, groupIndex, sourceUid, sourceName, sourceClass, sourceSpec) {
  // Close any existing picker
  closeBuffPicker();

  const alts = getSwappableBuffs(buffId, sourceClass, sourceSpec);
  if (alts.length <= 1) return; // Nothing to swap to

  const element = activeRules().totemElements[buffId];
  const category = element || 'aura';
  const overrideKey = `${groupIndex}:${sourceUid}:${category}`;

  // Build picker HTML
  let pickerHTML = `<div class="buff-picker-title">Choose ${element ? element + ' totem' : 'aura'}</div>`;
  for (const alt of alts) {
    const isActive = alt.id === buffId;
    const iconUrl = Config.BuffIconURL(alt.id);
    const imgTag = iconUrl ? `<img src="${iconUrl}" alt="${alt.buff.name}">` : '';
    pickerHTML += `<button type="button" class="buff-picker-item${isActive ? ' active' : ''}" data-pick-id="${alt.id}">
      ${imgTag}<span class="picker-buff-name">${esc(alt.buff.name)}</span>${isActive ? '<span class="picker-check">&#10003;</span>' : ''}
    </button>`;
  }
  // Reset option if overridden
  if (State.buffOverrides[overrideKey]) {
    pickerHTML += `<button type="button" class="buff-picker-reset" data-pick-reset="true">Reset to default</button>`;
  }

  // Create overlay to catch outside clicks
  const overlay = document.createElement('div');
  overlay.className = 'buff-picker-overlay';
  overlay.addEventListener('click', closeBuffPicker);
  document.body.appendChild(overlay);

  // Create picker element positioned above the buff icon
  const picker = document.createElement('div');
  picker.className = 'buff-picker';
  picker.id = 'active-buff-picker';
  picker.innerHTML = pickerHTML;
  document.body.appendChild(picker);

  // Position above the icon
  const rect = buffIcon.getBoundingClientRect();
  picker.style.left = (rect.left + rect.width / 2 - picker.offsetWidth / 2) + 'px';
  picker.style.top = (rect.top - picker.offsetHeight - 6 + window.scrollY) + 'px';

  // Keyboard: Escape closes and hands focus back to the icon; focus starts on the current choice.
  picker.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeBuffPicker();
    buffIcon.focus({ preventScroll: true });
  });
  const startItem = picker.querySelector('.buff-picker-item.active') || picker.querySelector('.buff-picker-item');
  if (startItem) startItem.focus({ preventScroll: true });

  // Handle picks
  picker.querySelectorAll('.buff-picker-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const pickId = item.dataset.pickId;
      if (pickId === buffId && !State.buffOverrides[overrideKey]) {
        closeBuffPicker();
        buffIcon.focus({ preventScroll: true });
        return; // Already the default, no change
      }
      // Preserve the original default buff (before any overrides)
      const existingOriginal = State.buffOverrides[overrideKey]?.originalBuffId || buffId;
      if (pickId === existingOriginal) {
        // Picking the default — just remove the override
        delete State.buffOverrides[overrideKey];
      } else {
        State.buffOverrides[overrideKey] = { buffId: pickId, originalBuffId: existingOriginal };
      }
      rememberBuffIconFocus(groupIndex, sourceUid, [pickId, existingOriginal]);
      closeBuffPicker();
      commit();
    });
  });

  const resetBtn = picker.querySelector('.buff-picker-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      rememberBuffIconFocus(groupIndex, sourceUid, [buffId, State.buffOverrides[overrideKey]?.originalBuffId || buffId]);
      delete State.buffOverrides[overrideKey];
      closeBuffPicker();
      commit();
    });
  }
}

function closeBuffPicker() {
  const existing = document.getElementById('active-buff-picker');
  if (existing) existing.remove();
  const overlay = document.querySelector('.buff-picker-overlay');
  if (overlay) overlay.remove();
}

// Buff picker delegation — attached once
(function initBuffPickers() {
  document.getElementById('groups-container').addEventListener('click', e => {
    const icon = e.target.closest('.buff-icon.swappable');
    if (!icon) return;
    e.stopPropagation();
    const buffId = icon.dataset.buffId;
    const gi = parseInt(icon.dataset.group);
    const sourceUid = icon.dataset.uid;
    const sourceName = icon.dataset.source;
    const sourceClass = icon.dataset.class;
    const sourceSpec = icon.dataset.spec;
    showBuffPicker(icon, buffId, gi, sourceUid, sourceName, sourceClass, sourceSpec);
  });
})();

// ── BENCH PANEL ─────────────────────────────────────────────────
// Players who are in the roster but not slotted into a party. The Optimizer
// never sees them; they sit here until dragged back in or deleted.
// ── LEFT POOL "Not in a group" ──────────────────────────────────
// The people who are on the Raid-Helper list but not seated: Bench, Tentative and
// Late come from State.bench (real players, draggable as before); Absent ("Can't
// come") and classless sign-ups come from State.unplaced and are seated through
// UnplacedDialog. Pills filter the list, the search narrows it, and the rows sit
// under a Bench head and a Can't come head. Tentative and Late are subsets of Bench.
const SignupTray = {
  FILTERS: [
    { id:'all',       label:'All',        hint:'Everyone not in a group' },
    { id:'bench',     label:'Bench',      hint:'On the Raid-Helper bench, or signed up beyond the raid size' },
    { id:'tentative', label:'Tentative',  hint:'Marked Tentative on Raid-Helper' },
    { id:'late',      label:'Late',       hint:'Marked Late on Raid-Helper. Add them to a group when they arrive' },
    { id:'absent',    label:"Can't come", hint:"Marked Absent. You'll confirm before seating them" },
  ],
  filter: 'all',
  query: '',
  PANE_KEY: 'rs_pool_pane',

  entries() {
    return [
      ...(State.bench || []).map((p, bi) => ({ p, bi, unplaced:false })),
      ...(State.unplaced || []).map(p => ({ p, unplaced:true })),
    ];
  },

  tabOf(entry) { return SignupStatus.tabFor(entry.p.signupStatus); },

  // Tentative and Late people are on the Bench; only Absent ones can't come.
  groupOf(entry) { return this.tabOf(entry) === 'absent' ? 'absent' : 'bench'; },

  inFilter(entry, id) {
    if (id === 'all') return true;
    if (id === 'bench') return this.groupOf(entry) === 'bench';
    return this.tabOf(entry) === id;
  },

  matchesQuery(entry) {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    const p = entry.p;
    return [p.name, p.class, p.spec].filter(Boolean).join(' ').toLowerCase().includes(q);
  },

  setFilter(id) {
    if (!this.FILTERS.some(f => f.id === id)) return;
    this.filter = id;
    this.render();
    const btn = document.querySelector(`[data-pool-filter="${id}"]`);
    if (btn) btn.focus({ preventScroll: true });
  },

  // Phone: one pane at a time, remembered for the session.
  pane() {
    try { return sessionStorage.getItem(this.PANE_KEY) === 'pool' ? 'pool' : 'groups'; } catch { return 'groups'; }
  },
  setPane(pane) {
    try { sessionStorage.setItem(this.PANE_KEY, pane); } catch { /* the choice just is not remembered */ }
    this.render();
    const btn = document.querySelector(`[data-pool-pane="${pane}"]`);
    if (btn) btn.focus({ preventScroll: true });
  },

  // The optimizer's reason for a player on the bench ('' unless a guild raid's sit-out history is loaded and the player is a confirmed raider left out).
  benchReasonOf(p) {
    if (!Fairness.active()) return '';
    try { return Optimizer.benchReasons().get(p.uid) || ''; } catch { return ''; }
  },

  // One row, like a board row. Exceptions only: a status chip (Signed up / Tentative / Late) under the Bench head, the standby
  // arrow, the guild's note, a review badge, the sit-out reason. The Can't come head already says why.
  slotHTML(entry) {
    const p = entry.p;
    const displayName = (p.name || 'Unknown').split('-')[0];
    const tag = this.groupOf(entry) === 'bench' && p.signupStatus !== 'bench' ? getStatusTag(p.signupStatus) : '';
    if (entry.unplaced) {
      const color = classColorClass(p.class, 'muted');
      const icon = p.class ? getSpecIcon(p) : '<span class="role-icon unplaced-icon">?</span>';
      const specText = p.class ? `${p.spec} ${RosterEdit.ClassLabel(p.class)}` : 'No spec on Raid-Helper';
      return `<div class="player-slot bench-slot unplaced-slot${changedSlotClass(p)}" draggable="true" role="button" tabindex="0" aria-label="${esc(playerSlotLabel(p, 'not seated'))}" data-unplaced-uid="${esc(p.uid)}" title="Click or drag into a group to seat them">
        ${icon}
        <div class="player-info">
          <span class="player-name ${color}">${esc(displayName)}</span>
          <span class="player-spec">${esc(specText)}</span>
        </div>
        ${changedTag(p)}
        ${tag}
        ${getMarkerTag(p)}
      </div>`;
    }
    const color = classColorClass(p.class);
    const specClass = p.spec
      ? (p.spec + ' ' + (p.class ? p.class.charAt(0) + p.class.slice(1).toLowerCase() : ''))
      : '';
    const backupPrimary = Backups.primaryNameFor(p.name);
    const backupBadge = backupPrimary ? `<span class="backup-badge backup-badge-bench" title="Standby for ${esc(backupPrimary.split('-')[0])}" aria-label="Standby for ${esc(backupPrimary.split('-')[0])}">-&gt; ${esc(backupPrimary.split('-')[0])}</span>` : '';
    const reviewBadge = p.needsReview ? `<span class="review-badge" title="${esc(p.reviewReason || 'Needs review — spec was defaulted')}">Needs review</span>` : '';
    // Why the optimizer left a confirmed raider out, while a guild raid's sit-out history is loaded (Optimizer.benchReasons): fairness, a Standby volunteer, or the buff plan.
    const reason = this.benchReasonOf(p);
    return `<div class="player-slot bench-slot${p.needsReview ? ' needs-review' : ''}${changedSlotClass(p)}" draggable="true" role="button" tabindex="0" aria-label="${esc(playerSlotLabel(p, 'on the bench') + (reason ? ', ' + reason : ''))}" data-bench-slot="${entry.bi}" data-uid="${esc(p.uid)}" title="Click to edit, or drag into a group">
      ${getSpecIcon(p)}
      <div class="player-info">
        <span class="player-name ${color}">${esc(displayName)}</span>
        <span class="player-spec">${esc(specClass)}</span>
        ${reason ? `<span class="bench-reason" title="${esc(reason)}">${esc(reason)}</span>` : ''}
      </div>
      ${changedTag(p)}
      ${tag}
      ${getMarkerTag(p)}
      ${reviewBadge}
      ${backupBadge}
    </div>`;
  },

  // The rows under their group heads, for the active pill and the search.
  listHTML(entries) {
    const shown = entries.filter(e => this.inFilter(e, this.filter) && this.matchesQuery(e));
    if (!shown.length) {
      const f = this.FILTERS.find(x => x.id === this.filter);
      const msg = this.query.trim() ? 'No one matches that search.' : `No one is marked ${esc(f.label)}.`;
      return `<p class="gs-pb-poolempty">${msg}</p>`;
    }
    return [{ id:'bench', label:'Bench' }, { id:'absent', label:"Can't come" }].map(g => {
      const rows = shown.filter(e => this.groupOf(e) === g.id);
      if (!rows.length) return '';
      return `<div class="gs-pb-pgroup"><h3 class="gs-fg-gh gs-pb-pgh"><span class="gs-fg-ght">${g.label}</span><span class="gs-fg-ghn">${rows.length}</span></h3>${rows.map(e => this.slotHTML(e)).join('')}</div>`;
    }).join('');
  },

  // Search keeps focus in the box, so it redraws only the rows.
  renderList() {
    const list = document.getElementById('bench-list');
    if (list) list.innerHTML = this.listHTML(this.entries());
  },

  render() {
    const section = document.getElementById('bench-section');
    if (!section) return;
    const onPlan = State.activeTab === 'plan';
    section.style.display = onPlan ? '' : 'none';
    const entries = this.entries();
    const pane = this.pane();
    const board = document.querySelector('.app-body');
    if (board && board.dataset) board.dataset.pane = pane;

    const searchHadFocus = document.activeElement && document.activeElement.id === 'pool-search';
    const caret = searchHadFocus ? document.activeElement.selectionStart : 0;

    const counts = Object.fromEntries(this.FILTERS.map(f => [f.id, entries.filter(e => this.inFilter(e, f.id)).length]));
    const changed = new Set(); // pills holding someone with an unseen change
    for (const f of this.FILTERS) if (entries.some(e => this.inFilter(e, f.id) && ChangeLog.highlightFor(e.p))) changed.add(f.id);

    const switchEl = document.getElementById('pool-switch');
    if (switchEl) {
      switchEl.style.display = onPlan ? '' : 'none';
      switchEl.innerHTML = `<button type="button" class="gs-fg-seg" data-pool-pane="groups" aria-pressed="${pane === 'groups'}">Groups</button><button type="button" class="gs-fg-seg" data-pool-pane="pool" aria-pressed="${pane === 'pool'}">Not in a group <span class="gs-fg-segn">${entries.length}</span></button>`;
    }

    const pills = this.FILTERS.map(f => {
      const selected = f.id === this.filter;
      // A dot on a pill the leader is not looking at, when a changed player is in it (All shows everyone, so never).
      const dot = f.id !== 'all' && this.filter !== 'all' && !selected && changed.has(f.id) ? '<span class="gs-pb-dot" aria-hidden="true"></span><span class="sr-only">, has changes</span>' : '';
      return `<button type="button" class="gs-fg-pill" data-pool-filter="${f.id}" title="${esc(f.hint)}" aria-pressed="${selected}">${f.label} <span class="gs-fg-segn">${counts[f.id]}</span>${dot}</button>`;
    }).join('');

    const controls = entries.length ? `<div class="gs-pb-poolctl">
        <label class="sr-only" for="pool-search">Search people not in a group</label>
        <input type="search" class="gs-input gs-pb-search" id="pool-search" placeholder="Search names" autocomplete="off" value="${esc(this.query)}">
        <div class="gs-fg-pills" role="group" aria-label="Filter by status">${pills}</div>
      </div>` : '';
    const body = entries.length ? this.listHTML(entries)
      : '<p class="gs-pb-poolempty">No one is waiting.</p>';

    section.innerHTML = `<h2 class="gs-hd-sl gs-pb-pooltitle" id="pool-title"><span>Not in a group</span><span class="gs-pb-poolcount">${entries.length}</span></h2>
      ${controls}
      <div class="gs-pb-poolbody bench-list" id="bench-list">${body}</div>
      <p class="gs-pb-poolfoot"><span class="gs-pb-foot-wide">Drag a name onto a group, or open it to choose one.</span><span class="gs-pb-foot-phone">Open a name to choose a group.</span></p>`;

    if (searchHadFocus) {
      const input = document.getElementById('pool-search');
      if (input) { input.focus({ preventScroll: true }); try { input.setSelectionRange(caret, caret); } catch { /* not a text field */ } }
    }
  },
};

// Confirm-and-seat for an unplaced sign-up: someone marked Absent, or sent
// with no class. Asks for a class/spec only when Raid-Helper didn't send one.
const UnplacedDialog = {
  uid: null,

  el(id) { return document.getElementById(id); },

  fillSpecs(classFile, selectedSpec) {
    const specs = Object.values(Config.Specs[classFile] || {});
    this.el('unplaced-spec').innerHTML = specs.map(sp =>
      `<option value="${esc(sp.name)}"${sp.name === selectedSpec ? ' selected' : ''}>${esc(sp.name)}</option>`).join('');
  },

  open(uid, groupIdx) {
    const entry = (State.unplaced || []).find(p => p.uid === uid);
    if (!entry) return;
    this.uid = uid;
    const name = (entry.name || 'This player').split('-')[0];
    const status = SignupStatus.label(entry.signupStatus) || 'not signed up';
    const needsClass = !entry.class;
    this.el('unplaced-message').textContent = needsClass
      ? `${name} is marked ${status} on Raid-Helper and didn't pick a class. Choose one to seat them.`
      : `${name} is marked ${status} on Raid-Helper. Add them to a group anyway?`;

    const classSel = this.el('unplaced-class');
    const classes = Object.keys(Config.Specs);
    classSel.innerHTML = classes.map(c => `<option value="${c}">${esc(RosterEdit.ClassLabel(c))}</option>`).join('');
    classSel.value = entry.class || classes[0];
    this.fillSpecs(classSel.value, entry.spec);
    this.el('unplaced-class-field').hidden = !needsClass;
    this.el('unplaced-spec-field').hidden = !needsClass;

    const groupSel = this.el('unplaced-group');
    groupSel.innerHTML = State.groups.map((g, gi) =>
      `<option value="${gi}"${g.length >= RosterEdit.MAX_GROUP_SIZE ? ' disabled' : ''}>Group ${gi + 1} (${g.length}/5)</option>`).join('');
    const open = State.groups.findIndex(g => g.length < RosterEdit.MAX_GROUP_SIZE);
    const wanted = Number.isInteger(groupIdx) && State.groups[groupIdx]?.length < RosterEdit.MAX_GROUP_SIZE ? groupIdx : open;
    if (wanted >= 0) groupSel.value = String(wanted);

    this.el('unplaced-error').textContent = open < 0 ? 'Every group is full. Bench someone first.' : '';
    this.el('btn-unplaced-confirm').disabled = open < 0;
    this.el('unplaced-dialog').showModal();
    (needsClass ? classSel : this.el('btn-unplaced-confirm')).focus();
  },

  confirm() {
    const pick = this.el('unplaced-class-field').hidden ? {} : { class: this.el('unplaced-class').value, spec: this.el('unplaced-spec').value };
    const groupIdx = parseInt(this.el('unplaced-group').value);
    const result = RosterEdit.PlaceUnplaced(this.uid, groupIdx, pick);
    if (!result.success) { this.el('unplaced-error').textContent = result.error; return; }
    this.close();
    commit();
    showToast(`${result.player.name.split('-')[0]} joined group ${groupIdx + 1}`);
  },

  close() {
    this.uid = null;
    this.el('unplaced-dialog').close();
  },
};

// ── PLAYER EDITOR POPOVER ───────────────────────────────────────
const ROLE_LABELS = {
  tank: 'Tank', healer: 'Healer',
  melee_dps: 'Melee DPS', ranged_dps: 'Ranged DPS', caster_dps: 'Caster DPS',
};

// ── FOCUS TRAP (feature-backlog-2.md #10) ────────────────────────
// Shared by every hand-rolled overlay below (the player editor, the Save/
// Load overlay, the toolbar Import overlay). The five native <dialog>
// modals elsewhere in the app (share/rename/split/history/shortcuts/plain-
// import) already trap Tab and restore focus on close per the HTML spec's
// modal top-layer behavior, and already carry aria-labelledby, so they
// don't need this helper.
// ── Generic accessible dropdown menu (nav redesign) ────────────────
// Backs every toolbar dropdown (Plan, Sign-ups, Share, Settings, the
// optimizer-strategy split-button menu). One `trigger` button toggles one
// `menu` element (role="menu", its direct action children role="menuitem").
// Handles positioning under the trigger without overflowing the viewport,
// arrow-key/Home/End navigation, Escape-to-close-and-refocus, closing on an
// outside click, and keeping only one menu open at a time. isShortcutBlocked
// (below ── UI RENDERING's keyboard-shortcut section) checks for any
// `.menu:not([hidden])` so global shortcuts never fire behind an open menu.
const Menu = {
  open: null, // { trigger, menu }
  init(trigger, menu) {
    if (!trigger || !menu) return;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    menu.setAttribute('role', menu.getAttribute('role') || 'menu');
    menu.hidden = true;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle(trigger, menu);
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.openMenu(trigger, menu);
        this.focusItem(menu, 0);
      }
    });
    menu.addEventListener('keydown', (e) => this.handleMenuKeydown(e, trigger, menu));
    // Let the clicked item's own handler run first (it's already fired by
    // the time this bubbles up), then close — so picking an action never
    // leaves its menu sitting open behind whatever dialog it opened.
    menu.addEventListener('click', (e) => {
      // No focusTrigger here: several items open a dialog synchronously
      // (Save, Rename, Templates…) which already moves focus into itself —
      // yanking it back to the trigger right after would fight that.
      if (e.target.closest('[role="menuitem"], [role="menuitemradio"]')) this.closeMenu(trigger, menu);
    });
  },
  items(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter(el => !el.hidden && !el.disabled);
  },
  openMenu(trigger, menu) {
    if (this.open && this.open.menu !== menu) this.closeMenu(this.open.trigger, this.open.menu);
    menu.hidden = false;
    menu.dispatchEvent(new Event('menuopen'));
    trigger.setAttribute('aria-expanded', 'true');
    this.position(trigger, menu);
    this.open = { trigger, menu };
    document.addEventListener('mousedown', this._onDocMouseDown, true);
    // Escape closes even when focus never left the trigger (a mouse-opened
    // menu doesn't auto-focus its first item), not just when focus is
    // already inside the menu (handleMenuKeydown covers that case too).
    document.addEventListener('keydown', this._onDocKeyDown, true);
  },
  closeMenu(trigger, menu, opts) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (this.open && this.open.menu === menu) this.open = null;
    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    document.removeEventListener('keydown', this._onDocKeyDown, true);
    if (opts && opts.focusTrigger) trigger.focus();
  },
  toggle(trigger, menu) {
    if (menu.hidden) this.openMenu(trigger, menu);
    else this.closeMenu(trigger, menu);
  },
  closeAll() {
    if (this.open) this.closeMenu(this.open.trigger, this.open.menu);
  },
  focusItem(menu, index) {
    const items = this.items(menu);
    if (!items.length) return;
    const i = ((index % items.length) + items.length) % items.length;
    items[i].focus();
  },
  handleMenuKeydown(e, trigger, menu) {
    const items = this.items(menu);
    const current = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); this.focusItem(menu, current + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.focusItem(menu, current - 1); }
    else if (e.key === 'Home') { e.preventDefault(); this.focusItem(menu, 0); }
    else if (e.key === 'End') { e.preventDefault(); this.focusItem(menu, items.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); this.closeMenu(trigger, menu, { focusTrigger: true }); }
    else if (e.key === 'Tab') { this.closeMenu(trigger, menu); }
  },
  // Fixed-position popover anchored under the trigger, clamped so it never
  // overflows the viewport on the right or bottom edge.
  //
  // CSS zoom scales an element's rendered box without changing what a length *inside* it means: getBoundingClientRect()
  // returns real, post-zoom viewport pixels, but an inline `style.left/top` set on a zoomed descendant is a pre-zoom
  // length that gets multiplied by zoom again at paint time. `scale` below is that zoom factor, measured off the trigger
  // itself (post-zoom rect / pre-zoom offsetWidth). The frame is no longer zoomed, so it is 1 today; the correction stays
  // so a zoomed ancestor can never plant the menu off-screen.
  position(trigger, menu) {
    const scale = (trigger.offsetWidth && trigger.getBoundingClientRect().width / trigger.offsetWidth) || 1;
    const rect = trigger.getBoundingClientRect();
    menu.style.left = '0px'; menu.style.top = '0px'; menu.style.maxHeight = '';
    const menuRect = menu.getBoundingClientRect();
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - menuRect.width - 8);
    // Open below the trigger, or above it when that side has more room; never over
    // the trigger itself. A menu taller than its side scrolls (max-height is in the
    // menu's own CSS px, so the frame's zoom scale is divided out).
    const below = window.innerHeight - rect.bottom - 4 - 8;
    const above = rect.top - 4 - 8;
    const openBelow = menuRect.height <= below || below >= above;
    const room = Math.max(0, openBelow ? below : above);
    const height = Math.min(menuRect.height, room);
    if (menuRect.height > room) menu.style.maxHeight = (room / scale) + 'px';
    const top = openBelow ? rect.bottom + 4 : rect.top - 4 - height;
    menu.style.left = (left / scale) + 'px';
    menu.style.top = (top / scale) + 'px';
  },
};
Menu._onDocMouseDown = (e) => {
  if (!Menu.open) return;
  const { trigger, menu } = Menu.open;
  if (menu.contains(e.target) || trigger.contains(e.target)) return;
  Menu.closeMenu(trigger, menu);
};
Menu._onDocKeyDown = (e) => {
  if (e.key !== 'Escape' || !Menu.open) return;
  const { trigger, menu } = Menu.open;
  // A menu item's own keydown handler (handleMenuKeydown) already handles
  // this same keypress when focus is inside the menu — let it own that
  // case (it stops here via the closed menu on the next check) rather than
  // double-closing/double-focusing.
  if (menu.contains(document.activeElement)) return;
  e.preventDefault();
  Menu.closeMenu(trigger, menu, { focusTrigger: true });
};

const FocusTrap = {
  active: null, // { modalEl, trigger, handler }
  focusables(modalEl) {
    return Array.from(modalEl.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null || el === document.activeElement);
  },
  // onEscape is optional — pass it for an overlay that doesn't already
  // close on Escape (the player editor already has its own global handler).
  // Re-opening the SAME modal element (e.g. the Load modal re-rendering
  // itself after a delete) keeps the original trigger and never restores
  // focus mid-flow — only close() does that.
  open(modalEl, triggerEl, onEscape) {
    if (!modalEl) return;
    const reopeningSame = !!(this.active && this.active.modalEl === modalEl);
    if (this.active) this.active.modalEl.removeEventListener('keydown', this.active.handler);
    const trigger = reopeningSame ? this.active.trigger : (triggerEl || document.activeElement);
    const handler = (e) => {
      if (e.key === 'Escape') { if (onEscape) { e.stopPropagation(); onEscape(); } return; }
      if (e.key !== 'Tab') return;
      const els = this.focusables(modalEl);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!els.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    modalEl.addEventListener('keydown', handler);
    this.active = { modalEl, trigger, handler };
  },
  // Pass the modal element to only release the trap if it's still the active
  // one (avoids one overlay's close tearing down a different overlay's trap
  // when several close calls chain together); omit it to always release.
  close(expectedEl) {
    if (!this.active) return;
    if (expectedEl && this.active.modalEl !== expectedEl) return;
    const { modalEl, trigger, handler } = this.active;
    modalEl.removeEventListener('keydown', handler);
    this.active = null;
    // No focus moves while a guild page covers the planner (PP.shell.setActive closes the planner's overlays).
    if (trigger && typeof trigger.focus === 'function' && document.body.contains(trigger) && (typeof plannerActive !== 'function' || plannerActive())) trigger.focus();
  },
};

// Opened by clicking a player slot (edit) or an empty slot (add). Follows the
// same anchored-popover pattern as the buff picker.
// ── Feature spotlight: DOM half (feature-backlog-3.md #4) ─────────
// Anchors a small dismissible callout near `anchorEl` the first time `id`
// hasn't been seen (Spotlight.shouldShow, pure logic above `UI RENDERING`).
// At most one is ever visible — runSpotlightQueue below stops at the first
// match — and showing a callout immediately marks it seen (Spotlight.dismiss
// fires up front), so an anchor that disappears before the user reacts (e.g.
// the player editor closes) can never cause it to reappear.
function removeSpotlightCallout() {
  document.querySelectorAll('.spotlight-callout').forEach(el => el.remove());
}
// opts.side 'left' puts the callout to the left of opts.edgeEl (the drawer), level with the anchor.
// opts.belowEl keeps the callout under that element (the page's top bar) so it never covers a control in it.
function showSpotlightCallout(id, anchorEl, text, opts = {}) {
  if (!anchorEl || document.querySelector('.spotlight-callout')) return false;
  const rect = anchorEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false; // display:none — not rendered at all
  // The callout is position:fixed (viewport-relative), so an anchor that's
  // off-screen below/above/beside the current scroll position (e.g. the
  // status-bar shortcuts link on a long roster that needs scrolling to
  // reach) would otherwise be placed off-screen too. Skip silently rather
  // than mark it seen — leaves it eligible to show next time it's in view.
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
  // No room left of the drawer: skip without marking it seen, so it shows on a later open that has room.
  if (opts.side === 'left' && opts.edgeEl
      && opts.edgeEl.getBoundingClientRect().left - Math.min(260, window.innerWidth - 24) - 14 < 8) return false;
  Spotlight.dismiss(localStorage, id);

  const callout = document.createElement('div');
  callout.className = 'spotlight-callout';
  callout.setAttribute('role', 'note');
  callout.tabIndex = -1;
  callout.innerHTML = `<button type="button" class="spotlight-close" aria-label="Dismiss tip">&times;</button><p>${esc(text)}</p>`;
  document.body.appendChild(callout);

  const remove = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    callout.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') remove(); };
  const onOutside = (e) => { if (!callout.contains(e.target)) remove(); };
  callout.querySelector('.spotlight-close').addEventListener('click', remove);
  document.addEventListener('keydown', onKey, true);
  // Deferred: the same click that opened this view shouldn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

  const w = Math.min(260, window.innerWidth - 24);
  callout.style.width = w + 'px';
  let top = rect.bottom + 10;
  if (opts.belowEl) top = Math.max(top, opts.belowEl.getBoundingClientRect().bottom + 10);
  let arrowClass = 'arrow-top';
  if (top + 90 > window.innerHeight) { top = Math.max(8, rect.top - 90); arrowClass = 'arrow-bottom'; }
  let left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
  if (opts.side === 'left' && opts.edgeEl) {
    top = Math.max(8, Math.min(rect.top, window.innerHeight - 90));
    left = Math.max(8, opts.edgeEl.getBoundingClientRect().left - w - 14);
    arrowClass = 'arrow-right';
  }
  callout.classList.add(arrowClass);
  callout.style.top = top + 'px';
  callout.style.left = left + 'px';
  // setTimeout rather than requestAnimationFrame: reliably fires even in a
  // backgrounded/inactive tab (some environments never schedule a paint
  // frame there), which just gates the fade-in transition, not visibility.
  setTimeout(() => callout.classList.add('visible'), 0);
  return true;
}

// Small, hand-curated set of highest-value entry points (per the backlog's
// "ship 3-4 of the highest-value ones" guidance) rather than covering every
// module — Assignments tab, the Settings gear menu (data backup, keyboard
// shortcuts and "show tips again" live there now that the old Options panel
// is gone; Templates/Attendance moved into the Plan/Sign-ups menus), and
// keyboard shortcuts. The player-editor callout (constraints/backups/Why
// here?) is triggered separately from showPlayerEditor itself, since it has
// no toolbar anchor.
const SPOTLIGHT_DEFS = [
  // Anchorless while the Assignments tab is hidden (ASSIGNMENTS_TAB_ENABLED), so it never shows.
  { id: 'assignments-tab', text: 'New: assign who casts curses, blessings and other one-per-raid buffs here.', anchor: () => document.querySelector('.mode-tab[data-tab="assignments"]') },
  // A new id (was 'options-panel') so people who saw the old tip learn where the menus went.
  { id: 'menu-panel-v2', text: 'Save a copy, templates, backups and shortcuts are in this menu.', anchor: () => document.getElementById('btn-settings-menu'), below: () => document.getElementById('shell-topbar') },
  // The gear menu holds Keyboard shortcuts; it is hidden on phones, so the tip skips them.
  { id: 'shortcuts-help', text: 'Press ? anytime for the full list of keyboard shortcuts.', anchor: () => document.getElementById('btn-settings-menu'), below: () => document.getElementById('shell-topbar') },
];
// First-run tips wait until the import feedback is out of the way: about 3 seconds after the view opens,
// and a further beat while a toast is still showing.
const SPOTLIGHT_DELAY_MS = 3000;
let spotlightTimer = null;
function scheduleSpotlightQueue() {
  clearTimeout(spotlightTimer);
  const attempt = () => {
    const toast = document.getElementById('toast');
    if (toast && toast.classList.contains('visible')) { spotlightTimer = setTimeout(attempt, 500); return; }
    if (State.view === 'app') runSpotlightQueue();
  };
  spotlightTimer = setTimeout(attempt, SPOTLIGHT_DELAY_MS);
}
function runSpotlightQueue() {
  if (typeof plannerActive === 'function' && !plannerActive()) return; // a guild page covers the planner: no tips
  if (document.querySelector('.spotlight-callout')) return;
  for (const def of SPOTLIGHT_DEFS) {
    if (!Spotlight.shouldShow(localStorage, def.id)) continue;
    if (showSpotlightCallout(def.id, def.anchor(), def.text, def.below ? { belowEl: def.below() } : {})) return;
  }
}

function closePlayerEditor() {
  const existing = document.getElementById('active-player-editor');
  if (existing) { FocusTrap.close(existing); existing.remove(); }
  const overlay = document.querySelector('.player-editor-overlay');
  if (overlay) overlay.remove();
  document.querySelectorAll('.editing').forEach(el => el.classList.remove('editing'));
  stopTrackingEditorDrawer();
  removeSpotlightCallout();
}

// ── Editor drawer + move chips ─────────────────────────────────────
// On desktop the editor is a drawer fixed to the right edge, from the bottom of the shell top bar down.
// The top bar scrolls with the page, so the drawer's top follows it while the editor is open.
let stopEditorDrawerTracking = null;
function placeEditorDrawer(editor) {
  const bar = document.querySelector('#shell-topbar');
  editor.style.top = Math.max(0, bar ? bar.getBoundingClientRect().bottom : 0) + 'px';
}
function trackEditorDrawer(editor) {
  stopTrackingEditorDrawer();
  let frame = 0;
  const onMove = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; placeEditorDrawer(editor); });
  };
  window.addEventListener('scroll', onMove, true);
  window.addEventListener('resize', onMove);
  stopEditorDrawerTracking = () => {
    window.removeEventListener('scroll', onMove, true);
    window.removeEventListener('resize', onMove);
    if (frame) cancelAnimationFrame(frame);
  };
}
function stopTrackingEditorDrawer() {
  if (stopEditorDrawerTracking) stopEditorDrawerTracking();
  stopEditorDrawerTracking = null;
}

const MOVE_HINT = 'A group with room moves the player at once. A full group lists its players to swap with.';

// One chip per group of the raid. No ids: the handlers read data-move-group.
function moveChipsHTML(uid) {
  return RosterEdit.MoveTargets(uid).map(t => {
    const current = t.state === 'current';
    return `<button type="button" class="pe-chip pe-chip-${t.state}" data-move-group="${t.groupIdx}"${current ? ' disabled aria-current="true"' : ''}>`
      + `<b class="pe-chip-num">${t.groupIdx + 1}</b><span class="pe-chip-sep">&middot;</span><span class="pe-chip-count">${t.count}/${RosterEdit.MAX_GROUP_SIZE}</span>`
      + `<small class="pe-chip-state">${current ? 'current' : t.state === 'room' ? 'room' : 'swap'}</small></button>`;
  }).join('');
}

// Shown in place of the hint when a full group's chip is pressed: who to swap with.
function moveSwapListHTML(uid, groupIdx) {
  const found = RosterEdit.FindPlayer(uid);
  const group = State.groups[groupIdx];
  if (!found || !group) return '';
  const dest = found.benched ? 'the bench' : 'Group ' + (found.groupIdx + 1);
  const rows = group.map(p => `<button type="button" class="pe-swap-row" data-swap-uid="${esc(p.uid)}" data-swap-group="${groupIdx}" title="${esc(p.name)}">`
    + `<span class="pe-swap-name ${classColorClass(p.class, 'primary')}">${esc((p.name || '').split('-')[0])}</span><small>${esc(p.spec)}</small><em>Swap</em></button>`).join('');
  return `<div class="pe-swap"><p class="pe-swap-prompt">Group ${groupIdx + 1} is full. Pick who goes to ${dest}.</p>${rows}</div>`;
}

// A room chip or a swap row: move (or swap), close the editor and say what happened.
function performEditorMove(uid, groupIdx, swapUid) {
  const found = RosterEdit.FindPlayer(uid);
  if (!found) return { success: false, error: 'Player not found' };
  const swapped = swapUid ? (State.groups[groupIdx] || []).find(p => p.uid === swapUid) : null;
  const result = RosterEdit.MovePlayer(uid, groupIdx, swapUid);
  if (!result.success) return result;
  const shortName = p => (p.name || '').split('-')[0];
  let text = `Moved ${shortName(found.player)} to Group ${groupIdx + 1}`;
  if (swapped) text += found.benched ? `; ${shortName(swapped)} to the bench` : `; ${shortName(swapped)} to Group ${found.groupIdx + 1}`;
  closePlayerEditor(); commit(); showToast(text);
  return result;
}

// ── Keep-together / Keep-apart editor (backlog #3) ───────────────
// Two "Choose a player…" selects (one per constraint type) plus a list of
// this player's existing constraints with per-row remove buttons. `curName`
// is used for both matching and display since it's always the live name.
function renderConstraintEditor(player, curName) {
  if (!player || !curName) return '';
  const others = [...State.roster, ...(State.bench || [])]
    .filter(p => p !== player && (p.name || '').toLowerCase() !== curName.toLowerCase());
  if (!others.length && !Constraints.forPlayer(curName).length) return '';
  const options = '<option value="">Choose a player…</option>' +
    others.map(p => `<option value="${esc(p.name)}">${esc(p.name.split('-')[0])} (${esc(p.spec)} ${esc(RosterEdit.ClassLabel(p.class))})</option>`).join('');
  const rows = Constraints.forPlayer(curName).map((c, i) => {
    const otherName = Constraints.otherName(c, curName);
    const label = c.type === 'together' ? 'With' : 'Apart from';
    return `<div class="constraint-row"><span>${label} ${esc(otherName.split('-')[0])}</span><button type="button" class="gs-btn gs-btn-ghost" data-remove-constraint="${esc(otherName)}" title="Remove this constraint" aria-label="Remove this constraint: ${label} ${esc(otherName.split('-')[0])}">&times;</button></div>`;
  }).join('');
  return `<div class="player-constraints">
    <h4 class="pe-section-title gs-fg-lbl pe-desktop-only">Keep together / apart</h4>
    ${rows ? `<div class="player-constraints-list">${rows}</div>` : ''}
    ${others.length ? `<div class="player-move">
      <label for="pe-keep-with">Keep with&hellip;</label>
      <select class="pe-input" id="pe-keep-with">${options}</select>
      <button type="button" class="gs-btn" id="pe-add-together">Add</button>
    </div>
    <div class="player-move">
      <label for="pe-keep-apart">Keep away from&hellip;</label>
      <select class="pe-input" id="pe-keep-apart">${options}</select>
      <button type="button" class="gs-btn" id="pe-add-apart">Add</button>
    </div>` : ''}
  </div>`;
}

// ── Drummer tagging (feature-backlog-3 #5, TBC only) ──────────────
// A single checkbox ("this player is a Leatherworker who carries drums")
// plus an optional drum-type select, shown for any real player (seated or
// benched — the tag is a profession fact independent of seating, same as
// Constraints). Never shown outside TBC: Classic Era has no Drums
// equivalent and Forever's status is unconfirmed (tasks/lessons.md #5).
function renderDrummerEditor(player, curName) {
  if (!player || !curName || State.gameVersion !== 'tbc') return '';
  const tag = Drummers.get(curName);
  const drumOptions = ['<option value="">Type unspecified</option>']
    .concat(DRUM_TYPES.map(t => `<option value="${t}"${tag && tag.drum === t ? ' selected' : ''}>${t}</option>`))
    .join('');
  return `<div class="player-move">
    <label for="pe-drummer-toggle" class="pe-inline-label">
      <input type="checkbox" id="pe-drummer-toggle"${tag ? ' checked' : ''}> Leatherworker drummer
    </label>
  </div>
  <div class="player-move" id="pe-drummer-drum-row"${tag ? '' : ' hidden'}>
    <label for="pe-drummer-drum">Drum (optional)</label>
    <select class="pe-input" id="pe-drummer-drum">${drumOptions}</select>
  </div>`;
}

// ── "Why here?" explanation (backlog #4) ─────────────────────────
function renderWhyHere(player, groupIdx) {
  const reasons = explainPlacement(player, State.groups[groupIdx] || [], groupIdx, State.groups, State.optimizerMode);
  if (!reasons.length) return '<div class="player-why-here gs-hd-panel"><h4 class="gs-fg-lbl">Why here?</h4><p class="why-here-empty">No particular buff or convention explains this placement.</p></div>';
  return `<div class="player-why-here gs-hd-panel"><h4 class="gs-fg-lbl">Why here?</h4><ul>${reasons.map(r => `<li>${esc(r.text)}</li>`).join('')}</ul></div>`;
}

// The editor header's spec art (the class crest where a spec has none), for the chosen class and spec.
function peIconHTML(p) {
  if (!p) return '';
  return getSpecIcon({ class: p.class, spec: p.spec, role: RosterEdit.RoleForSpec(p.class, p.spec) || p.role });
}

// opts: { uid } to edit an existing player, or { groupIdx } to add a new one.
function showPlayerEditor(anchorEl, opts) {
  closePlayerEditor();
  closeBuffPicker();

  const isAdd = !opts.uid;
  const found = isAdd ? null : RosterEdit.FindPlayer(opts.uid);
  if (!isAdd && !found) return;

  const player = found ? found.player : null;
  const preference = isAdd ? PreferredSlots.forGroup(opts.groupIdx)[opts.preferenceIndex] : null;
  const benched = !!(found && found.benched);
  const curClass = player ? player.class : preference?.class || 'WARRIOR';
  const curSpec = player ? player.spec : preference?.spec || RosterEdit.SpecsForClass('WARRIOR')[0].name;
  const curName = player ? (player.name || '') : '';

  const classOptions = RosterEdit.ClassList.map(c =>
    `<option value="${c}"${c === curClass ? ' selected' : ''}>${esc(RosterEdit.ClassLabel(c))}</option>`
  ).join('');
  const specOptions = RosterEdit.SpecsForClass(curClass).map(sp =>
    `<option value="${esc(sp.name)}"${sp.name === curSpec ? ' selected' : ''}>${esc(sp.name)}</option>`
  ).join('');

  const title = isAdd
    ? 'Open slot · Group ' + (opts.groupIdx + 1)
    : (benched ? 'Edit benched player' : 'Edit player');

  // A benched player is deleted outright; an assigned player is only benched.
  const removeLabel = isAdd ? '' : (benched ? 'Delete' : 'Bench');
  const removeTitle = benched
    ? 'Remove this player from the roster for good'
    : 'Move this player to the bench';

  const editor = document.createElement('div');
  editor.className = 'player-editor gs-forge';
  editor.id = 'active-player-editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-modal', 'true');
  editor.setAttribute('aria-label', title);
  editor.innerHTML = `
    <div class="pe-sheet-handle" aria-hidden="true"></div>
    ${!isAdd ? `<div class="pe-sheet-header pe-short-only">
      <span class="pe-sheet-swatch pe-icon ${classColorClass(curClass, 'primary')}" id="pe-sheet-swatch" aria-hidden="true">${peIconHTML(player)}</span>
      <div class="pe-sheet-heading"><div class="pe-sheet-name ${classColorClass(curClass, 'primary')}" id="pe-sheet-name">${esc(curName.split('-')[0])}</div><div class="pe-sheet-sub" id="pe-sheet-sub"></div></div>
    </div>
    <div class="pe-sheet-header pe-more-only">
      <button type="button" class="pe-sheet-back gs-btn gs-btn-ghost" id="pe-more-back" aria-label="Back to the short menu">&lsaquo;</button>
      <div class="pe-sheet-heading"><div class="pe-sheet-name ${classColorClass(curClass, 'primary')}">${esc(curName.split('-')[0])}</div><div class="pe-sheet-sub">More options</div></div>
    </div>` : ''}
    ${isAdd ? `<div class="player-editor-title pe-phone-only">${esc(title)}</div>` : ''}
    <div class="pe-drawer-head pe-desktop-only">
      ${!isAdd ? `<span class="pe-drawer-icon pe-icon" aria-hidden="true">${peIconHTML(player)}</span>` : ''}
      <div class="pe-drawer-heading">
        <span class="pe-drawer-kicker">${esc(title)}</span>
        ${!isAdd ? `<span class="pe-drawer-name ${classColorClass(curClass, 'primary')}">${esc(curName.split('-')[0])}</span><span class="pe-drawer-sub"></span>` : ''}
      </div>
      <button type="button" class="pe-drawer-close gs-btn gs-btn-ghost" aria-label="Close editor"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="pe-body">
    ${!isAdd ? `<div class="pe-move-section pe-short-only">
      <h4 class="pe-section-title gs-fg-lbl pe-desktop-only">Move</h4>
      <div class="pe-move-label pe-phone-only"><span>Move to</span><span class="pe-move-note">${benched ? 'on the bench' : 'now in Group ' + (found.groupIdx + 1)}</span></div>
      <div class="pe-chips" role="group" aria-label="Move ${esc(curName.split('-')[0])} to a group">${moveChipsHTML(opts.uid)}</div>
      <div class="pe-move-detail" aria-live="polite"><p class="pe-move-hint pe-desktop-only">${MOVE_HINT}</p></div>
    </div>` : ''}
    <h4 class="pe-section-title gs-fg-lbl pe-desktop-only">Player</h4>
    ${!isAdd && player && player.needsReview ? `<div class="player-editor-review-notice">${esc(player.reviewReason || 'Needs review — spec was defaulted')}. Pick the real class/spec below to clear this.</div>` : ''}
    <div class="pe-fields">
    <label class="player-editor-field pe-field-name">
      <span>Name</span>
      <input type="text" class="pe-input" id="pe-name" value="${esc(curName)}" maxlength="32" autocomplete="off" spellcheck="false">
    </label>
    <label class="player-editor-field pe-field-class">
      <span>Class</span>
      <select class="pe-input" id="pe-class">${classOptions}</select>
    </label>
    <label class="player-editor-field pe-field-spec">
      <span>Spec</span>
      <select class="pe-input" id="pe-spec">${specOptions}</select>
    </label>
    </div>
    <div class="player-editor-role pe-desktop-only" id="pe-role"></div>
    ${isAdd ? `<div class="preferred-actions"><p>Choose a class and spec to request a player. No name needed; confirmed matching imports fill this spot.</p><button type="button" class="gs-btn pe-strong" id="pe-prefer">${preference ? 'Update preference' : 'Set preferred slot'}</button>${preference ? '<button type="button" class="gs-btn gs-btn-danger-outline" id="pe-remove-preference">Remove preference</button>' : ''}</div>` : ''}
    ${!isAdd && benched ? `<div class="player-move pe-more-only">
      <label for="pe-backup-for">Standby for</label>
      <select class="pe-input" id="pe-backup-for">
        <option value="">Not on Standby</option>
        ${State.roster.map(sp => `<option value="${esc(sp.name)}"${Backups.backupNameFor(sp.name) === curName ? ' selected' : ''}>${esc((sp.name || '').split('-')[0])} (${esc(sp.spec)} ${esc(RosterEdit.ClassLabel(sp.class))})</option>`).join('')}
      </select>
      <button type="button" class="gs-btn" id="pe-backup-save">Save Standby</button>
    </div>` : ''}
    ${!isAdd && !benched && Backups.backupNameFor(curName) ? `<div class="player-move pe-backup-row">
      <span class="pe-short-only">Standby: <b>${esc(Backups.backupNameFor(curName).split('-')[0])}</b></span>
      <button type="button" class="gs-btn pe-short-only" id="pe-backup-swap">Swap in Standby</button>
      <button type="button" class="gs-btn gs-btn-danger-outline pe-more-only" id="pe-backup-clear">Remove Standby</button>
    </div>` : ''}
    ${!isAdd && !benched && player.locked ? `<div class="player-move pe-more-only">
      <span>Locked by comp template</span>
      <button type="button" class="gs-btn" id="pe-unlock">Unlock</button>
    </div>` : ''}
    ${!isAdd ? `<button type="button" class="pe-more-row pe-short-only" id="pe-more-toggle" aria-expanded="false" aria-controls="pe-more-group"><span>More options</span><span class="pe-more-hint">Drummer, keep with/apart, Why here? &rsaquo;</span><svg class="pe-more-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>` : ''}
    ${!isAdd ? `<div class="pe-more-group pe-more-only" id="pe-more-group">${renderDrummerEditor(player, curName)}${renderConstraintEditor(player, curName)}${!benched && GameVersions[State.gameVersion].modeled ? renderWhyHere(player, found.groupIdx) : ''}</div>` : ''}
    </div>
    <div class="player-editor-error" id="pe-error"></div>
    <div class="player-editor-actions">
      ${removeLabel ? `<button type="button" class="gs-btn${benched ? ' gs-btn-danger-outline' : ''}" id="pe-remove" title="${esc(removeTitle)}">${esc(removeLabel)}</button>` : '<span></span>'}
      <div class="pe-actions-right">
        <button type="button" class="gs-btn gs-btn-ghost" id="pe-cancel">Cancel</button>
        <button type="button" class="gs-btn pe-strong" id="pe-save">${isAdd ? 'Add named player' : 'Save'}</button>
      </div>
    </div>`;

  const overlay = document.createElement('div');
  overlay.className = 'player-editor-overlay';
  overlay.addEventListener('click', closePlayerEditor);
  document.body.appendChild(overlay);
  document.body.appendChild(editor);

  // Desktop drawer: fixed to the right edge; the edited card gets a neutral outline.
  anchorEl.classList.add('editing');
  placeEditorDrawer(editor);
  trackEditorDrawer(editor);
  const isPhone = window.matchMedia('(max-width: 600px)').matches;

  if (!isAdd && Spotlight.shouldShow(localStorage, 'player-editor-features')) {
    // getBoundingClientRect() below forces layout synchronously, so this can
    // run immediately — no need to wait on a paint/animation frame, which
    // some hidden/backgrounded tabs never schedule.
    // Desktop: left of the drawer, level with Move. Phone: the old anchors (hidden in the short view, so usually no tip).
    const spotlightAnchor = isPhone
      ? (editor.querySelector('.player-constraints') || editor.querySelector('.player-why-here') || editor)
      : editor.querySelector('.pe-move-section');
    showSpotlightCallout('player-editor-features', spotlightAnchor, 'Constraints, Standby links and "Why here?" all live in this panel.', isPhone ? {} : { side: 'left', edgeEl: editor });
  }

  const nameInput = editor.querySelector('#pe-name');
  const classSel = editor.querySelector('#pe-class');
  const specSel = editor.querySelector('#pe-spec');
  const roleEl = editor.querySelector('#pe-role');
  const errorEl = editor.querySelector('#pe-error');

  const sheetSub = editor.querySelector('#pe-sheet-sub');
  const drawerSub = editor.querySelector('.pe-drawer-sub');
  function refreshRole() {
    const role = RosterEdit.RoleForSpec(classSel.value, specSel.value);
    roleEl.innerHTML = role
      ? `${getRoleIcon(role)}<span>Role: ${esc(ROLE_LABELS[role] || role)}</span>`
      : '';
    // Phone sheet header: "Spec Class · Group N", tinted by the chosen class.
    if (sheetSub) {
      sheetSub.textContent = `${specSel.value} ${RosterEdit.ClassLabel(classSel.value)} · ${benched ? 'Bench' : 'Group ' + (found.groupIdx + 1)}`;
      if (drawerSub) drawerSub.textContent = sheetSub.textContent;
      for (const el of editor.querySelectorAll('.pe-icon')) el.innerHTML = peIconHTML({ class: classSel.value, spec: specSel.value });
      for (const el of editor.querySelectorAll('.pe-sheet-swatch, .pe-sheet-name, .pe-drawer-name')) {
        el.className = el.className.replace(/cc-[a-z-]+/, classColorClass(classSel.value, 'primary'));
      }
    }
  }

  // Class change repopulates specs, since specs are class-specific.
  classSel.addEventListener('change', () => {
    const specs = RosterEdit.SpecsForClass(classSel.value);
    specSel.innerHTML = specs.map(sp => `<option value="${esc(sp.name)}">${esc(sp.name)}</option>`).join('');
    refreshRole();
  });
  specSel.addEventListener('change', refreshRole);
  refreshRole();

  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  editor.querySelector('#pe-prefer')?.addEventListener('click', () => {
    if (!PreferredSlots.add(opts.groupIdx, classSel.value, specSel.value, preference)) { showError('This group has no open slots'); return; }
    closePlayerEditor(); commit(); showToast('Preferred slot saved');
  });
  editor.querySelector('#pe-remove-preference')?.addEventListener('click', () => {
    PreferredSlots.remove(preference); closePlayerEditor(); commit(); showToast('Preference removed');
  });

  editor.querySelector('#pe-backup-save')?.addEventListener('click', () => {
    const backupSelect = editor.querySelector('#pe-backup-for');
    const target = backupSelect.value;
    if (!target) { Backups.clearBackup(curName); }
    else {
      const result = Backups.link(target, curName);
      if (!result.success) { showError(result.error); return; }
    }
    closePlayerEditor(); commit();
    showToast(target ? `${curName.split('-')[0]} is now Standby for ${target.split('-')[0]}` : 'Standby link removed');
  });
  editor.querySelector('#pe-backup-swap')?.addEventListener('click', () => {
    const result = Backups.swapIn(curName, found.groupIdx);
    if (!result.success) { showError(result.error); return; }
    closePlayerEditor(); commit();
    showToast(`Swapped in ${result.player.name.split('-')[0]} for ${curName.split('-')[0]}`);
  });
  editor.querySelector('#pe-backup-clear')?.addEventListener('click', () => {
    Backups.unlink(curName); closePlayerEditor(); commit(); showToast('Standby link removed');
  });

  editor.querySelector('#pe-unlock')?.addEventListener('click', () => {
    player.locked = false;
    closePlayerEditor(); commit(); showToast(`${curName.split('-')[0]} unlocked`);
  });

  editor.querySelector('#pe-drummer-toggle')?.addEventListener('change', (e) => {
    const drumSel = editor.querySelector('#pe-drummer-drum');
    if (e.target.checked) Drummers.set(curName, drumSel ? drumSel.value : '');
    else Drummers.remove(curName);
    closePlayerEditor(); commit();
    showToast(e.target.checked ? `${curName.split('-')[0]} tagged as a drummer` : `${curName.split('-')[0]} untagged as a drummer`);
  });
  editor.querySelector('#pe-drummer-drum')?.addEventListener('change', (e) => {
    Drummers.set(curName, e.target.value);
    closePlayerEditor(); commit();
    showToast(`Updated ${curName.split('-')[0]}'s drum`);
  });

  editor.querySelector('#pe-add-together')?.addEventListener('click', () => {
    const other = editor.querySelector('#pe-keep-with').value;
    if (!other) { showError('Choose a player first'); return; }
    Constraints.add(curName, other, 'together');
    closePlayerEditor(); commit(); showToast(`${curName.split('-')[0]} will be kept with ${other.split('-')[0]}`);
  });
  editor.querySelector('#pe-add-apart')?.addEventListener('click', () => {
    const other = editor.querySelector('#pe-keep-apart').value;
    if (!other) { showError('Choose a player first'); return; }
    Constraints.add(curName, other, 'apart');
    closePlayerEditor(); commit(); showToast(`${curName.split('-')[0]} will be kept apart from ${other.split('-')[0]}`);
  });
  editor.querySelectorAll('[data-remove-constraint]').forEach(btn => {
    btn.addEventListener('click', () => {
      const other = btn.dataset.removeConstraint;
      Constraints.remove(curName, other);
      closePlayerEditor(); commit(); showToast('Constraint removed');
    });
  });

  function savePlayerEdit() {
    const changes = { name: nameInput.value, class: classSel.value, spec: specSel.value };
    const result = isAdd
      ? RosterEdit.AddPlayer(opts.groupIdx, changes)
      : RosterEdit.UpdatePlayer(opts.uid, changes);

    if (!result.success) { showError(result.error); return; }
    if (preference) PreferredSlots.remove(preference);
    closePlayerEditor();
    commit();
    showToast(isAdd ? `Added ${result.player.name}` : `Updated ${result.player.name}`);
  }

  editor.querySelector('#pe-save').addEventListener('click', savePlayerEdit);
  editor.querySelector('#pe-cancel').addEventListener('click', closePlayerEditor);
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); savePlayerEdit(); }
  });

  editor.querySelector('.pe-drawer-close').addEventListener('click', closePlayerEditor);
  // Group chips: a group with room moves the player at once; a full group lists its players to swap with.
  const moveDetail = editor.querySelector('.pe-move-detail');
  editor.querySelector('.pe-chips')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-move-group]');
    if (!chip || chip.disabled) return;
    const groupIdx = Number(chip.dataset.moveGroup);
    if (State.groups[groupIdx].length < RosterEdit.MAX_GROUP_SIZE) {
      const result = performEditorMove(opts.uid, groupIdx);
      if (!result.success) showError(result.error);
      return;
    }
    editor.querySelectorAll('[data-move-group]').forEach(c => {
      c.classList.toggle('pe-chip-pick', c === chip);
      if (!c.disabled) c.setAttribute('aria-pressed', String(c === chip));
    });
    moveDetail.innerHTML = moveSwapListHTML(opts.uid, groupIdx);
  });
  moveDetail?.addEventListener('click', e => {
    const row = e.target.closest('[data-swap-uid]');
    if (!row) return;
    const result = performEditorMove(opts.uid, Number(row.dataset.swapGroup), row.dataset.swapUid);
    if (!result.success) showError(result.error);
  });
  const removeBtn = editor.querySelector('#pe-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      const result = benched ? RosterEdit.DeletePlayer(opts.uid) : RosterEdit.BenchPlayer(opts.uid);
      if (!result.success) { showError(result.error); return; }
      closePlayerEditor();
      commit();
      showToast(benched ? `Removed ${result.player.name}` : `Benched ${result.player.name}`);
    });
  }

  // Phone bottom sheet: a short view and a "More options" view of the same
  // elements, switched by one class (the CSS hides the other view's sections).
  const moreToggle = editor.querySelector('#pe-more-toggle');
  const moreBack = editor.querySelector('#pe-more-back');
  // Phone: the More options view replaces the short one (focus follows). Drawer: the section opens in place and the toggle keeps focus.
  function setMoreOpen(open) {
    editor.classList.toggle('pe-more-open', open);
    if (moreToggle) moreToggle.setAttribute('aria-expanded', String(open));
    (open && isPhone ? moreBack : moreToggle).focus();
  }
  if (moreToggle) moreToggle.addEventListener('click', () => setMoreOpen(isPhone ? true : !editor.classList.contains('pe-more-open')));
  if (moreBack) moreBack.addEventListener('click', () => setMoreOpen(false));

  FocusTrap.open(editor, anchorEl);
  if (isAdd) classSel.focus();
  else nameInput.focus(); // the drawer and the sheet both open on the name
}

// Escape closes the editor, matching the modals elsewhere in the app.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePlayerEditor();
});

// Enter/Space on a focused role="button" slot opens it, same as a click.
function activateSlotOnKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.player-slot[role="button"]')) {
    e.preventDefault(); e.target.click();
  }
}

// Player editor delegation — attached once. Clicking a slot opens the editor;
// the buff-icon handler stops propagation, so buff clicks never reach this.
(function initPlayerEditor() {
  document.getElementById('groups-container').addEventListener('keydown', activateSlotOnKey);
  document.getElementById('groups-container').addEventListener('click', e => {
    if (e.target.closest('.buff-icon')) return;
    let slot = e.target.closest('.player-slot');
    if (!slot) return;
    const gi = parseInt(slot.dataset.group);
    const si = parseInt(slot.dataset.slot);
    if (isNaN(gi)) return;
    // Clicking anything but the fanned stack folds it first; the slot is then looked up again in the fresh markup.
    if (SuggestionStack.open && !e.target.closest('.preferred-fan')) {
      SuggestionStack.set(null);
      slot = document.querySelector(`#groups-container .player-slot[data-group="${gi}"][data-slot="${si}"]`) || slot;
    }
    const player = (State.groups[gi] || [])[si];
    const preferenceIndex = si - (State.groups[gi] || []).length;
    if (!player && slot.classList.contains('preferred-stack')) {
      const preference = PreferredSlots.forGroup(gi)[preferenceIndex];
      const control = e.target.closest('[data-stack-open], [data-stack-close], [data-stack-pick], [data-stack-other]');
      if (!preference || !control) return;
      if (control.hasAttribute('data-stack-open')) SuggestionStack.set(gi, si);
      else if (control.hasAttribute('data-stack-close')) SuggestionStack.set(null);
      else if (control.hasAttribute('data-stack-pick')) {
        const alt = (preference.alts || [])[Number(control.dataset.stackPick)];
        SuggestionStack.open = null;
        if (alt && PreferredSlots.add(gi, alt.class, alt.spec, preference)) { commit(); showToast(`Requested ${alt.spec} ${RosterEdit.ClassLabel(alt.class)}`); }
        else commit();
      } else { SuggestionStack.open = null; commit(); showPlayerEditor(slot, { groupIdx: gi, preferenceIndex }); }
      return;
    }
    if (player) showPlayerEditor(slot, { uid: player.uid });
    else showPlayerEditor(slot, { groupIdx: gi, preferenceIndex });
  });

  // One stack open at a time: a click outside the groups or Escape folds it. A target the groups handler just
  // re-rendered away is detached (closest() finds nothing), so it is no outside click.
  document.addEventListener('click', e => {
    if (SuggestionStack.open && e.target.isConnected && !e.target.closest('#groups-container')) SuggestionStack.set(null);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && SuggestionStack.open) SuggestionStack.set(null);
  });

  document.getElementById('bench-section').addEventListener('click', e => {
    const pill = e.target.closest('[data-pool-filter]');
    if (pill) { SignupTray.setFilter(pill.dataset.poolFilter); return; }
    const slot = e.target.closest('.bench-slot');
    if (!slot) return;
    if (slot.dataset.unplacedUid) { UnplacedDialog.open(slot.dataset.unplacedUid, null); return; }
    const uid = slot.dataset.uid;
    if (uid) showPlayerEditor(slot, { uid });
  });

  document.getElementById('bench-section').addEventListener('keydown', activateSlotOnKey);

  // The search narrows the rows in place (the box keeps focus).
  document.getElementById('bench-section').addEventListener('input', e => {
    if (e.target.id !== 'pool-search') return;
    SignupTray.query = e.target.value;
    SignupTray.renderList();
  });

  // Phone: the Groups | Not in a group switch.
  document.getElementById('pool-switch').addEventListener('click', e => {
    const btn = e.target.closest('[data-pool-pane]');
    if (btn) SignupTray.setPane(btn.dataset.poolPane);
  });

  document.getElementById('btn-unplaced-cancel').addEventListener('click', () => UnplacedDialog.close());
  document.getElementById('btn-unplaced-confirm').addEventListener('click', () => UnplacedDialog.confirm());
  document.getElementById('unplaced-class').addEventListener('change', e => UnplacedDialog.fillSpecs(e.target.value));
})();

