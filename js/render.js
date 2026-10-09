// ── UI RENDERING ────────────────────────────────────────────────
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
  document.getElementById('landing-version-note').textContent = profile.note;
  document.getElementById('btn-landing-random').textContent = `Generate a random ${Config.Raids[State.selectedRaid].size}-player roster`;
  document.getElementById('btn-optimize').disabled = !profile.modeled;
  document.getElementById('optimize-mode').disabled = !profile.modeled;
  initRaidDropdown();
}
// Switching version refits the plan to the new version's default raid, so with a plan
// loaded it asks first, and afterwards says how many players the smaller raid benched.
async function switchGameVersion(version) {
  if (!Object.prototype.hasOwnProperty.call(GameVersions, version) || version === State.gameVersion) return false;
  if (hasLoadedWork() && !await Modal.confirm({
    title: `Switch to ${GameVersions[version].name}?`,
    message: 'Your players carry over to the default raid of the new version. Totem and aura picks are reset, and anyone who does not fit the new raid size moves to the bench.',
    confirmLabel: `Switch to ${GameVersions[version].name}`,
  })) return false;
  State.planId = null;
  State.gameVersion = version;
  State.selectedRaid = GameVersions[version].defaultRaid;
  State.buffOverrides = {};
  const benched = initGroups();
  State.preferredSlots = PreferredSlots.clean(State.preferredSlots);
  switchTab('plan');
  if (State.view === 'landing') renderLanding(); // its resume banner names the plan just replaced
  const size = Config.Raids[State.selectedRaid] ? Config.Raids[State.selectedRaid].size : 25;
  showToast((benched > 0 ? `${benched} player${benched === 1 ? '' : 's'} benched: the ${size}-man raid is full. ` : '') + GameVersions[version].note);
  return true;
}

function initRaidDropdown() {
  const sel = document.getElementById('raid-select');
  sel.innerHTML = '';
  for (const tier of [...new Set(Config.RaidOrder.map(key => Config.Raids[key].tier))]) {
    const group = document.createElement('optgroup');
    group.label = tier;
    for (const key of Config.RaidOrder) {
      const r = Config.Raids[key];
      if (r.tier !== tier) continue;
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${r.name} (${r.size})`;
      if (key === State.selectedRaid) opt.selected = true;
      group.appendChild(opt);
    }
    if (group.children.length) sel.appendChild(group);
  }
  sel.onchange = () => {
    State.selectedRaid = sel.value;
    if (State.activeTab === 'ideal') {
      renderIdealComp();
    } else {
      const benched = initGroups();
      commit();
      const raidInfo = Config.Raids[State.selectedRaid];
      if (benched > 0) showToast(`${benched} player${benched === 1 ? '' : 's'} benched — the ${raidInfo ? raidInfo.size : 25}-man raid is full`);
    }
  };
}

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
  const src = Config.IconURL(icon);
  // Spec art that fails to load falls back to the class crest (see handleIconError).
  const fallback = cls ? ` data-fallback="${esc(Config.IconURL('classicon_' + cls.toLowerCase()))}"` : '';
  return `<span class="role-icon spec-icon ${roleCls}"><img src="${esc(src)}" alt="${esc(label)}" loading="lazy"${fallback}></span>`;
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
  if (parent && (parent.classList.contains('buff-row-icon') || parent.classList.contains('role-icon'))) {
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

function getDragHandle() {
  return '<div class="drag-handle"><div class="drag-dot-row"><span class="drag-dot"></span><span class="drag-dot"></span></div><div class="drag-dot-row"><span class="drag-dot"></span><span class="drag-dot"></span></div><div class="drag-dot-row"><span class="drag-dot"></span><span class="drag-dot"></span></div></div>';
}

// A player slot is a role="button" (Enter/Space opens the editor), so the icon
// and badges inside would be read out piecemeal; this is the one spoken label.
function playerSlotLabel(p, where) {
  const name = (p.name || 'Unknown').split('-')[0];
  const cls = p.class ? p.class.charAt(0) + p.class.slice(1).toLowerCase() : '';
  const status = p.signupStatus && p.signupStatus !== 'confirmed' && p.signupStatus !== 'bench' ? SignupStatus.label(p.signupStatus) : '';
  return [name, [p.spec, cls].filter(Boolean).join(' '), where, status, p.needsReview ? 'needs review' : '']
    .filter(Boolean).join(', ');
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
  if (target) target.focus({ preventScroll: true });
}

function seatedSlotHTML(p, gi, si) {
  const displayName = (p.name || 'Unknown').split('-')[0];
  const specClass = p.spec ? (p.spec + ' ' + (p.class ? p.class.charAt(0) + p.class.slice(1).toLowerCase() : '')) : '';
  const backupName = Backups.backupNameFor(p.name);
  // Compact indicator — the full pairing is in the title tooltip so the
  // card stays narrow enough not to crowd out the player's own name.
  const backupBadge = backupName ? `<span class="backup-badge" title="Backup: ${esc(backupName.split('-')[0])}">B</span>` : '';
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
  return `<div class="player-slot${p.needsReview ? ' needs-review' : ''}" draggable="true" role="button" tabindex="0" aria-label="${esc(playerSlotLabel(p, 'group ' + (gi + 1)))}" data-uid="${esc(p.uid)}" data-group="${gi}" data-slot="${si}">
    ${getSpecIcon(p)}
    <div class="player-info">
      <span class="player-name ${classColorClass(p.class)}">${esc(displayName)}</span>
      <span class="player-spec">${esc(specClass)}</span>
    </div>
    ${reviewBadge}
    ${p.signupStatus && p.signupStatus !== 'confirmed' ? getStatusTag(p.signupStatus) : ''}
    ${lockBadge}
    ${constraintBadge}
    ${backupBadge}
    ${getDragHandle()}
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
  panel.innerHTML=`<div class="camp-heading"><div><span class="camp-kicker">Forever · Pre-raid preparation</span><h2>Campfires</h2></div><button type="button" class="btn btn-secondary" id="camp-add">+ Add campfire</button></div>
    <p class="camp-rules">1 minute sitting or crafting → 1 hour of buffs. Your last fire replaces your entire previous campfire buff package. Stronger class buffs take precedence.</p>
    <details ${open?'open':''}><summary>Raid professions <span>${data.professions.length} recorded</span></summary><p>Record profession skills to unlock eligible assets. Each member can contribute one asset across all fires. Benched members are labeled.</p>
    <div class="camp-professions">${data.professions.map((p,i)=>`<div><strong>${esc(p.player)}</strong><span>${esc(p.profession)} · ${p.skill}</span><button type="button" class="link-btn" data-prof-remove="${i}" aria-label="Remove ${esc(p.player)} ${esc(p.profession)}">Remove</button></div>`).join('')}</div>
    ${members.length?`<form id="camp-prof-form" class="camp-form"><label>Member<select name="player">${members.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}${State.bench.includes(p)?' (bench)':''}</option>`).join('')}</select></label><label>Profession<select name="profession">${Campfires.professionNames.map(p=>`<option>${p}</option>`).join('')}</select></label><label>Skill<input name="skill" type="number" min="1" max="300" step="1" value="300" required></label><button class="btn btn-secondary" type="submit">Set profession</button></form>`:'<p>Add or import raid members first to assign professions and assets.</p>'}</details>
    <div class="camp-grid">${data.fires.map((f,i)=>{
      const candidates=Campfires.eligible(i), tier=Campfires.tiers[f.capacity];
      const cook=data.professions.some(p=>p.profession==='Cooking' && p.skill>=tier.skill);
      return `<article class="camp-card"><div class="camp-card-heading"><label>Campfire name<input data-fire-name="${i}" maxlength="60" value="${esc(f.name)}"></label><button type="button" class="link-btn" data-fire-remove="${i}">Remove fire</button></div><div class="camp-capacity"><label>Campfire tier<select data-fire-capacity="${i}">${[3,5,10].map(n=>`<option value="${n}" ${n===f.capacity?'selected':''}>${Campfires.tiers[n].name} · ${n} assets</option>`).join('')}</select></label><strong>${f.assets.length} / ${f.capacity}</strong></div><p class="camp-note">Cooking ${tier.skill} required to build this fire${cook?' · Eligible cook recorded': ' · No eligible cook recorded'}.</p>
      <ul class="camp-assets">${f.assets.map((a,j)=>{const item=Campfires.catalog.find(x=>x.id===a.asset);return `<li><div><a href="https://www.wowhead.com/forever/item=${item.id}" target="_blank" rel="noopener noreferrer">${esc(item.name)}</a><span class="camp-owner">${esc(a.player)} · ${item.profession} ${item.skill}${State.bench.some(p=>Campfires.key(p.name)===Campfires.key(a.player))?' · Bench':''}</span><p>${esc(item.effect||'Utility asset')}${item.utility?' · '+esc(item.utility):''}</p>${item.conflict?`<small>Does not stack with ${esc(item.conflict)}</small>`:''}</div><button type="button" class="link-btn" data-asset-remove="${i}:${j}" aria-label="Remove ${esc(item.name)}">×</button></li>`;}).join('')||'<li class="camp-empty">No assets assigned. Choose contributors below.</li>'}</ul>
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

function renderGroups() {
  const focusedSlot = capturePlayerSlotFocus();
  const container = document.getElementById('groups-container');
  container.innerHTML = '';

  const raidInfo = Config.Raids[State.selectedRaid];
  const numGroups = raidInfo ? raidInfo.groups : 5;

  // Apply grid layout class based on group count
  container.className = 'groups-container';
  if (numGroups === 5) container.classList.add('groups-5');
  else if (numGroups === 4 || numGroups === 8) container.classList.add('groups-' + numGroups);

  const coveredBuffIds = new Set();

  for (let gi = 0; gi < numGroups; gi++) {
    const players = State.groups[gi] || [];
    const buffList = getGroupBuffs(players, gi);
    buffList.forEach(b => coveredBuffIds.add(b.id));
    const roleLabel = getDominantRoleLabel(players);

    let slotsHTML = '';
    for (let si = 0; si < 5; si++) {
      if (si < players.length) {
        slotsHTML += seatedSlotHTML(players[si], gi, si);
      } else if (PreferredSlots.forGroup(gi)[si - players.length]) {
        const preference = PreferredSlots.forGroup(gi)[si - players.length];
        slotsHTML += `<div class="player-slot preferred-slot${preferredColorClass(preference.class)}" role="button" tabindex="0" data-group="${gi}" data-slot="${si}">
          ${getSpecIcon(preference)}<div class="player-info"><span class="player-name">${esc(preference.spec + ' ' + RosterEdit.ClassLabel(preference.class))}</span><span class="player-spec">Preferred · awaiting sign-up</span></div><span class="preferred-badge">OPEN</span></div>`;
      } else {
        slotsHTML += `<div class="player-slot empty-slot" role="button" tabindex="0" data-group="${gi}" data-slot="${si}" aria-label="Group ${gi+1}, empty slot: add player or preferred spec">
          <span class="role-icon role-icon-empty">&#8226;</span>
          <div class="player-info"><span class="player-name">Empty Slot</span></div>
        </div>`;
      }
    }

    // TBC Drums (feature-backlog-3 #5) — not part of buffList/getGroupBuffs
    // (see getDrumsCoverage for why), so it's appended here as its own icon,
    // reusing the same abbreviation/CSS/icon/tooltip lookups as a real buff.
    const groupDrummers = State.gameVersion === 'tbc' ? players.filter(p => Drummers.isDrummer(p.name)) : [];

    let buffsHTML = '<span class="buff-bar-label">Buffs</span>';
    if (buffList.length === 0 && !groupDrummers.length) {
      buffsHTML += `<span class="no-buffs">${GameVersions[State.gameVersion].modeled ? 'No buffs' : 'Rules pending'}</span>`;
    } else {
      for (const b of buffList) {
        const abbr = Config.BuffAbbreviations[b.id] || b.id;
        const css = Config.BuffCSSClass[b.id] || '';
        const from = b.sourceName ? b.sourceName.split('-')[0] : '';
        const sourceColor = b.sourceClass ? (Config.ClassColors[b.sourceClass] || 'var(--text-secondary)') : 'var(--text-secondary)';
        const iconUrl = Config.BuffIconURL(b.id);
        const hasIcon = iconUrl ? ' has-icon' : '';
        const imgTag = iconUrl ? `<img src="${iconUrl}" alt="${esc(abbr)}" loading="lazy" class="buff-img">` : '';
        const isSwappable = !!buffSlotCategory(b.id);
        const swapClass = isSwappable ? ' swappable' : '';
        const overrideClass = b.isOverride ? ' overridden' : '';
        const dataAttrs = isSwappable ? ` data-buff-id="${esc(b.id)}" data-group="${gi}" data-uid="${esc(b.sourceUid)}" data-source="${esc(b.sourceName)}" data-class="${esc(b.sourceClass)}" data-spec="${esc(b.sourceSpec || '')}"` : '';
        const ttAttrs = ` data-tt-name="${esc(b.buff.name)}" data-tt-desc="${esc(b.buff.desc || '')}" data-tt-source="${esc(from)}" data-tt-source-color="${sourceColor}"`;
        buffsHTML += `<div class="buff-icon ${css}${hasIcon}${swapClass}${overrideClass}"${dataAttrs}${ttAttrs}>${imgTag}<span class="buff-label">${abbr}</span></div>`;
      }
      if (groupDrummers.length) {
        const drumIconUrl = Config.BuffIconURL('DRUMS');
        const drumImgTag = drumIconUrl ? `<img src="${drumIconUrl}" alt="Drm" loading="lazy" class="buff-img">` : '';
        const drumNames = groupDrummers.map(p => (p.name || '').split('-')[0]).join(', ');
        const drumDesc = 'Party-scoped haste/stat buff from a Leatherworker\'s drums. One effect active at a time per party — rotate multiple drummers for continuous uptime.';
        buffsHTML += `<div class="buff-icon ${Config.BuffCSSClass.DRUMS}${drumIconUrl ? ' has-icon' : ''}" data-tt-name="Drums" data-tt-desc="${esc(drumDesc)}" data-tt-source="${esc(drumNames)}">${drumImgTag}<span class="buff-label">${Config.BuffAbbreviations.DRUMS}</span></div>`;
      }
    }

    container.innerHTML += `<div class="group-card" role="listitem" data-group="${gi}">
      <div class="group-header">
        <h3>Group ${gi+1}</h3>
        <div class="group-header-tags">
          <span class="group-role-tag">${roleLabel}</span>
        </div>
      </div>
      <div class="player-list">${slotsHTML}</div>
      <div class="buff-bar">${buffsHTML}</div>
    </div>`;
  }

  const coveredDebuffIds = getRaidDebuffCoverage(State.groups);
  renderBuffCatalog(coveredBuffIds, coveredDebuffIds);
  renderUtilityCatalog();
  renderBalanceWarnings();

  renderSummaryBar();
  updateStatus();
  SignupTray.render();
  restorePlayerSlotFocus(focusedSlot);
  renderManualChanges();

  // Update version and raid controls after imports, restores and undo.
  syncVersionControls();
  document.getElementById('raid-select').value = State.selectedRaid;
  document.getElementById('roster-name-text').textContent = State.rosterName;
  document.getElementById('mobile-plan-title').textContent = State.rosterName;
  syncRaidNotesUI();
  RaidHelperSync.updateControls();
  renderCampfires();
  renderAssignments();
  renderReadiness();
}

function renderBuffCatalog(coveredBuffIds, coveredDebuffIds) {
  const insights = getMissingBuffInsights();
  // Faction-locked rosters (Classic) never show a buff the detected faction
  // could never field (Windfury for Alliance, Devotion Aura for Horde).
  const buffs = renderBuffRowList('buff-catalog-buffs', factionRelevantBuffs(), Config.BuffAbbreviations, id => Config.BuffIconURL(id), coveredBuffIds, insights);
  const debuffs = renderBuffRowList('buff-catalog-debuffs', Config.Debuffs, Config.DebuffAbbreviations, id => Config.DebuffIconURL(id), coveredDebuffIds, insights);
  renderSidebarSummary(buffs, debuffs);
}

// Collapsed-state strip: "Buffs 13/20 · Debuffs 18/28 · 17 missing".
function renderSidebarSummary(buffs, debuffs) {
  const el = document.getElementById('sidebar-summary');
  if (!el) return;
  if (!GameVersions[State.gameVersion].modeled) { el.innerHTML = '<p class="sidebar-note">Coverage rules are not configured for this version yet.</p>'; return; }
  const missing = (buffs.total - buffs.covered) + (debuffs.total - debuffs.covered);
  el.innerHTML = `
    <div class="sidebar-summary-row"><span>Buffs</span><b>${buffs.covered} / ${buffs.total}</b></div>
    <div class="sidebar-summary-row"><span>Debuffs</span><b>${debuffs.covered} / ${debuffs.total}</b></div>
    <div class="sidebar-summary-row missing${missing === 0 ? ' zero' : ''}"><span>Missing</span><b>${missing}</b></div>`;
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
      <span class="insight-text">In raid: <span class="insight-who ${color(p)}">${short(p)}</span></span>
      <button type="button" class="insight-btn" data-insight-switch="${esc(id)}" data-group="${insight.groupIdx}" data-uid="${esc(p.uid)}" title="Make ${short(p)} run ${esc(Config.Buffs[id].name)}">Switch</button>
    </div>`;
  }
  if (insight.kind === 'bench') {
    const p = insight.player;
    const specLabel = p.spec ? `${esc(p.spec)}` : '';
    return `<div class="buff-row-insight bench">
      <span class="insight-text">Benched: <span class="insight-who ${color(p)}">${short(p)}</span>${specLabel ? ' (' + specLabel + ')' : ''}</span>
      <button type="button" class="insight-btn" data-insight-swap="${esc(p.uid)}" title="Seat ${short(p)}; bench the lowest-value player in the same role if the raid is full">Swap In</button>
    </div>`;
  }
  if (insight.kind === 'shared') {
    return `<div class="buff-row-insight none"><span class="insight-text">Needs a 2nd warrior: <span class="insight-who ${color(insight.player)}">${short(insight.player)}</span> casts the other shout</span></div>`;
  }
  return `<div class="buff-row-insight none"><span class="insight-text">Nobody in roster</span></div>`;
}

function renderBuffRowList(containerId, dataset, abbrMap, iconUrlFn, coveredIds, insights) {
  const container = document.getElementById(containerId);
  if (!container) return { covered: 0, total: 0 };

  // Missing entries first so gaps are the first thing you see; covered below.
  const ids = Object.keys(dataset);
  const missingIds = ids.filter(id => !coveredIds.has(id));
  const coveredList = ids.filter(id => coveredIds.has(id));
  const countEl = document.getElementById(containerId.replace('buff-catalog-', 'buff-count-'));
  if (countEl) countEl.textContent = `${coveredList.length} / ${ids.length}`;

  let html = '';
  if (missingIds.length) html += `<div class="buff-sidebar-sub missing">Missing &middot; ${missingIds.length}</div>`;
  for (const id of [...missingIds, '__covered__', ...coveredList]) {
    if (id === '__covered__') {
      if (coveredList.length) html += `<div class="buff-sidebar-sub">Covered &middot; ${coveredList.length}</div>`;
      continue;
    }
    const entry = dataset[id];
    const iconUrl = iconUrlFn(id);
    const abbr = abbrMap[id] || id;
    const imgTag = iconUrl
      ? `<img src="${iconUrl}" alt="${esc(abbr)}" loading="lazy">`
      : esc(abbr);
    const sourceClassLabel = entry.sourceClass
      ? entry.sourceClass.charAt(0) + entry.sourceClass.slice(1).toLowerCase()
      : '';
    const sourceSpec = entry.sourceSpec || entry.preferSpec || '';
    const sourceLabel = sourceSpec ? `${sourceSpec} ${sourceClassLabel}` : sourceClassLabel;
    const sourceColor = entry.sourceClass ? (Config.ClassColors[entry.sourceClass] || 'var(--text-secondary)') : 'var(--text-secondary)';
    const isCovered = coveredIds.has(id);

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

    html += `<div class="buff-row${isCovered ? ' covered' : ''}">
      <div class="buff-row-icon"${ttAttrs}>${imgTag}</div>
      <span class="buff-row-name">${esc(entry.name)}</span>${warnBadge}
      <span class="buff-row-source ${classColorClass(entry.sourceClass, 'secondary')}">${esc(sourceLabel)}</span>
    </div>`;
    if (!isCovered && insights) html += renderInsightLine(id, insights[id]);
  }
  container.innerHTML = html;
  return { covered: coveredList.length, total: ids.length };
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
      <span class="insight-text">Benched: <span class="insight-who ${color}">${short}</span>${specLabel}</span>
      <button type="button" class="insight-btn" data-insight-swap="${esc(p.uid)}" title="Seat ${short}; bench the lowest-value player in the same role if the raid is full">Swap In</button>
    </div>`;
  }
  return `<div class="buff-row-insight none"><span class="insight-text">Nobody in roster</span></div>`;
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
  if (missing.length) html += `<div class="buff-sidebar-sub missing">Missing &middot; ${missing.length}</div>`;
  const ordered = [...missing, ...(covered.length ? ['__covered__'] : []), ...covered];
  for (const item of ordered) {
    if (item === '__covered__') { html += `<div class="buff-sidebar-sub">Covered &middot; ${covered.length}</div>`; continue; }
    const seatedNames = item.seatedProviders.map(p => esc((p.name || 'Unknown').split('-')[0])).join(', ');
    const sourceText = item.covered ? seatedNames : 'Not covered';
    const ttAttrs = ` data-tt-name="${esc(item.name)}" data-tt-desc="${esc(item.desc)}"`
      + ` data-tt-source="${item.covered ? esc(seatedNames) + ' - Covered by this raid' : 'Not covered'}"`;
    html += `<div class="buff-row${item.covered ? ' covered' : ''}"${ttAttrs}>
      <span class="buff-row-name">${esc(item.name)}</span>
      <span class="buff-row-source">${esc(sourceText)}</span>
    </div>`;
    if (!item.covered) html += renderUtilityInsightLine(item);
  }
  container.innerHTML = html;
}

// Soft composition warnings (melee/ranged skew, class stacking, healer
// ratio) shown above the Buffs/Debuffs/Utility sections, always visible
// (not gated behind the sidebar's collapsed state) since they're short.
function renderBalanceWarnings() {
  const el = document.getElementById('balance-warnings');
  if (!el) return;
  if (!GameVersions[State.gameVersion].modeled) { el.innerHTML = ''; return; }
  const warnings = Readiness.balanceWarnings();
  el.innerHTML = warnings.map(w => `<div class="balance-warning-row">${esc(w.text)}</div>`).join('');
}

// ── Sidebar collapse + insight actions (delegated, attached once) ──
const SIDEBAR_STORAGE_KEY = 'pp_sidebar_expanded';
function setSidebarExpanded(expanded, persist = true) {
  const aside = document.getElementById('buff-sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  if (!aside || !toggle) return;
  aside.classList.toggle('collapsed', !expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  if (persist) safeSetItem(localStorage, SIDEBAR_STORAGE_KEY, expanded ? '1' : '0');
}
(function initSidebar() {
  const aside = document.getElementById('buff-sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  if (!aside || !toggle) return;
  let expanded = false;
  try { expanded = localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'; } catch (e) {}
  setSidebarExpanded(expanded, false);
  toggle.addEventListener('click', () => setSidebarExpanded(aside.classList.contains('collapsed')));

  aside.addEventListener('click', (e) => {
    const swapBtn = e.target.closest('[data-insight-swap]');
    if (swapBtn) {
      const res = RosterEdit.SwapIn(swapBtn.dataset.insightSwap);
      if (!res.success) { showToast(res.error); return; }
      commit();
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
      commit();
      showToast(`${(res.player.name || '').split('-')[0]} now runs ${Config.Buffs[res.buffId].name}`);
    }
  });
})();

// ── Sticky raid summary bar ──
// The sentence the screen-reader region announces for the summary bar; the bar itself is
// not a live region (it is rebuilt on every render, which would re-read all of it).
function describeRaidSummary({ seated, capacity, counts, benched }) {
  const n = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${seated} of ${capacity} in raid: ${n(counts.tank, 'tank')}, ${n(counts.healer, 'healer')}, ${counts.melee_dps} melee, ${counts.ranged} ranged. ${benched} benched.`;
}

// One polite, atomic sr-only region for every announcement the page makes by itself.
// Repeating the last message is skipped, so re-rendering an unchanged plan stays silent.
let lastAnnouncement = '';
function announce(message) {
  const region = document.getElementById('sr-status');
  if (!region || !message || message === lastAnnouncement) return;
  lastAnnouncement = message;
  region.textContent = message;
}

function renderSummaryBar() {
  const bar = document.getElementById('summary-bar');
  if (!bar) return;
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
  const chip = (role, label, n) => `<span class="summary-chip">${getRoleIcon(role)}<b>${n}</b> ${label}</span>`;
  bar.innerHTML = `
    <span class="summary-main${seated > capacity ? ' over' : ''}"><b>${seated}</b>/ ${capacity} in raid</span>
    <span class="summary-divider"></span>
    ${chip('tank', 'Tanks', counts.tank)}
    ${chip('healer', 'Healers', counts.healer)}
    ${chip('melee', 'Melee', counts.melee_dps)}
    ${chip('ranged', 'Ranged', counts.ranged)}
    <span class="summary-chip bench"><b>${benched}</b> Benched</span>`;
  announce(describeRaidSummary({ seated, capacity, counts, benched }));
}

function updateStatus() {
  const total = State.roster.length;
  const raidInfo = Config.Raids[State.selectedRaid];
  const max = raidInfo ? raidInfo.size : 25;
  const benched = (State.bench || []).length;
  const benchNote = benched > 0 ? ` · ${benched} benched` : '';
  document.getElementById('status-text').textContent = total > 0
    ? `${total}/${max} players loaded${benchNote}`
    : State.preferredSlots.length ? `${State.preferredSlots.length} preferred slots awaiting matching sign-ups${benchNote}` : 'Ready — import a roster to begin';
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
    }
  });

  container.addEventListener('drag', e => {
    if (e.clientX > 0) {
      ghost.style.left = (e.clientX + 12) + 'px';
      ghost.style.top = (e.clientY - 10) + 'px';
    }
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

  function beginDrag(src, slot) {
    pending = null;
    active = { ...src, el: slot };
    slot.classList.add('dragging');
    ghost.textContent = src.player.name.split('-')[0];
    ghost.style.color = Config.ClassColors[src.player.class] || 'var(--text-primary)';
    ghost.style.display = 'block';
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function endDrag() {
    if (active && active.el) active.el.classList.remove('dragging');
    ghost.style.display = 'none';
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

  function highlight(target) {
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
      timer: setTimeout(() => beginDrag(src, slot), LONG_PRESS_MS),
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
    ghost.style.left = (t.clientX + 12) + 'px';
    ghost.style.top = (t.clientY - 10) + 'px';
    highlight(targetAt(t.clientX, t.clientY));

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
    pickerHTML += `<div class="buff-picker-item${isActive ? ' active' : ''}" data-pick-id="${alt.id}">
      ${imgTag}<span class="picker-buff-name">${esc(alt.buff.name)}</span>${isActive ? '<span class="picker-check">&#10003;</span>' : ''}
    </div>`;
  }
  // Reset option if overridden
  if (State.buffOverrides[overrideKey]) {
    pickerHTML += `<div class="buff-picker-reset" data-pick-reset="true">Reset to default</div>`;
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

  // Handle picks
  picker.querySelectorAll('.buff-picker-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const pickId = item.dataset.pickId;
      if (pickId === buffId && !State.buffOverrides[overrideKey]) {
        closeBuffPicker();
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
      closeBuffPicker();
      commit();
    });
  });

  const resetBtn = picker.querySelector('.buff-picker-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
// ── SIGN-UP TRAY ────────────────────────────────────────────────
// Replaces the single bench panel with one bench-sized panel whose tabs file
// everyone off the raid by their Raid-Helper status, so adding statuses adds
// tabs, not page height. Bench/Tentative/Late come from State.bench (real
// players, draggable as before); Absent and classless sign-ups come from
// State.unplaced and are seated through UnplacedDialog.
const SignupTray = {
  TABS: [
    { id:'bench',     label:'Bench',     hint:'Drag into a group, or tap to edit' },
    { id:'tentative', label:'Tentative', hint:'Marked Tentative on Raid-Helper' },
    { id:'late',      label:'Late',      hint:'Marked Late on Raid-Helper. Seat them when they arrive' },
    { id:'absent',    label:'Absent',    hint:"Marked Absent. You'll confirm before seating them" },
    { id:'all',       label:'All',       hint:'Everyone not seated, tagged by status' },
  ],
  activeTab: 'bench',
  chosen: false, // until the leader picks a tab, open the first one with people in it

  entries() {
    return [
      ...(State.bench || []).map((p, bi) => ({ p, bi, unplaced:false })),
      ...(State.unplaced || []).map(p => ({ p, unplaced:true })),
    ];
  },

  tabOf(entry) { return SignupStatus.tabFor(entry.p.signupStatus); },

  select(tab) {
    if (!this.TABS.some(t => t.id === tab)) return;
    this.activeTab = tab;
    this.chosen = true;
    this.render();
    const btn = document.querySelector(`[data-tray-tab="${tab}"]`);
    if (!btn) return;
    btn.focus({ preventScroll: true });
    // On a phone the tab row scrolls sideways; bring the chosen tab fully in.
    const row = btn.parentElement;
    if (btn.offsetLeft < row.scrollLeft || btn.offsetLeft + btn.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = btn.offsetLeft - (row.clientWidth - btn.offsetWidth) / 2;
    }
  },

  slotHTML(entry, tab) {
    const p = entry.p;
    const displayName = (p.name || 'Unknown').split('-')[0];
    // The Bench tab tags only "Signed up" (overflow raiders vs Raid-Helper
    // Bench); the All tab tags everyone; a status tab is its own label.
    const tag = tab === 'all' ? getStatusTag(p.signupStatus)
      : (tab === 'bench' && p.signupStatus === 'confirmed' ? getStatusTag('confirmed') : '');
    if (entry.unplaced) {
      const color = classColorClass(p.class, 'muted');
      const icon = p.class ? getSpecIcon(p) : '<span class="role-icon unplaced-icon">?</span>';
      const specText = p.class ? `${p.spec} ${RosterEdit.ClassLabel(p.class)}` : 'No spec on Raid-Helper';
      return `<div class="player-slot bench-slot unplaced-slot" draggable="true" role="button" tabindex="0" aria-label="${esc(playerSlotLabel(p, 'not seated'))}" data-unplaced-uid="${esc(p.uid)}" title="Click or drag into a group to seat them">
        ${icon}
        <div class="player-info">
          <span class="player-name ${color}">${esc(displayName)}</span>
          <span class="player-spec">${esc(specText)}</span>
        </div>
        ${tag}
        ${getDragHandle()}
      </div>`;
    }
    const color = classColorClass(p.class);
    const specClass = p.spec
      ? (p.spec + ' ' + (p.class ? p.class.charAt(0) + p.class.slice(1).toLowerCase() : ''))
      : '';
    const backupPrimary = Backups.primaryNameFor(p.name);
    const backupBadge = backupPrimary ? `<span class="backup-badge backup-badge-bench" title="Backup for ${esc(backupPrimary.split('-')[0])}">-&gt; ${esc(backupPrimary.split('-')[0])}</span>` : '';
    const reviewBadge = p.needsReview ? `<span class="review-badge" title="${esc(p.reviewReason || 'Needs review — spec was defaulted')}">Needs review</span>` : '';
    return `<div class="player-slot bench-slot${p.needsReview ? ' needs-review' : ''}" draggable="true" role="button" tabindex="0" aria-label="${esc(playerSlotLabel(p, 'on the bench'))}" data-bench-slot="${entry.bi}" data-uid="${esc(p.uid)}" title="Click to edit, or drag into a group">
      ${getSpecIcon(p)}
      <div class="player-info">
        <span class="player-name ${color}">${esc(displayName)}</span>
        <span class="player-spec">${esc(specClass)}</span>
      </div>
      ${tag}
      ${reviewBadge}
      ${backupBadge}
      ${getDragHandle()}
    </div>`;
  },

  render() {
    const section = document.getElementById('bench-section');
    if (!section) return;
    const entries = this.entries();
    if (entries.length === 0) {
      section.style.display = 'none';
      section.innerHTML = '';
      return;
    }
    section.style.display = State.activeTab === 'plan' ? 'block' : 'none';

    const counts = { all: entries.length };
    for (const e of entries) { const t = this.tabOf(e); counts[t] = (counts[t] || 0) + 1; }
    if (!this.chosen && !counts[this.activeTab]) {
      this.activeTab = (this.TABS.find(t => t.id !== 'all' && counts[t.id]) || { id:'all' }).id;
    }
    const tab = this.TABS.find(t => t.id === this.activeTab) || this.TABS[0];
    const shown = tab.id === 'all' ? entries : entries.filter(e => this.tabOf(e) === tab.id);

    const tabsHTML = this.TABS.map(t => {
      const n = counts[t.id] || 0;
      const selected = t.id === tab.id;
      return `<button type="button" role="tab" class="tray-tab${n ? '' : ' is-empty'}" id="tray-tab-${t.id}" data-tray-tab="${t.id}" aria-selected="${selected}" aria-controls="bench-list" tabindex="${selected ? 0 : -1}">${t.label} <span class="bench-count">${n}</span></button>`;
    }).join('');
    const slotsHTML = shown.length
      ? shown.map(e => this.slotHTML(e, tab.id)).join('')
      : `<div class="tray-empty">No one is marked ${esc(tab.label)}.</div>`;

    section.innerHTML = `<div class="bench-header tray-header">
        <h3>Sign-ups</h3>
        <div class="tray-tabs" role="tablist" aria-label="Sign-ups not in a group, by status">${tabsHTML}</div>
      </div>
      <div class="bench-hint tray-hint">${esc(tab.hint)}</div>
      <div class="bench-list" id="bench-list" role="tabpanel" aria-labelledby="tray-tab-${tab.id}">${slotsHTML}</div>`;
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
      : `${name} is marked ${status} on Raid-Helper. Seat them anyway?`;

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
      if (e.target.closest('[role="menuitem"]')) this.closeMenu(trigger, menu);
    });
  },
  items(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(el => !el.hidden && !el.disabled);
  },
  openMenu(trigger, menu) {
    if (this.open && this.open.menu !== menu) this.closeMenu(this.open.trigger, this.open.menu);
    menu.hidden = false;
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
  // The whole planner frame (.addon-frame) renders at `zoom: 1.5`, and CSS
  // zoom scales an element's rendered box without changing what a length
  // *inside* it means: getBoundingClientRect() returns real, post-zoom
  // viewport pixels, but an inline `style.left/top` set on a zoomed
  // descendant is a pre-zoom length that gets multiplied by zoom again at
  // paint time. Mixing the two without correction plants the menu at
  // (viewport position × 1.5) — off-screen for anything right of center.
  // `scale` below is that zoom factor, measured empirically off the
  // trigger itself (post-zoom rect ÷ pre-zoom offsetWidth) rather than
  // hard-coded, so this still works if the frame's zoom ever changes.
  position(trigger, menu) {
    const scale = (trigger.offsetWidth && trigger.getBoundingClientRect().width / trigger.offsetWidth) || 1;
    const rect = trigger.getBoundingClientRect();
    menu.style.left = '0px'; menu.style.top = '0px';
    const menuRect = menu.getBoundingClientRect();
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - menuRect.width - 8);
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
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
    if (trigger && typeof trigger.focus === 'function' && document.body.contains(trigger)) trigger.focus();
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
function showSpotlightCallout(id, anchorEl, text) {
  if (!anchorEl || document.querySelector('.spotlight-callout')) return false;
  const rect = anchorEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false; // display:none — not rendered at all
  // The callout is position:fixed (viewport-relative), so an anchor that's
  // off-screen below/above/beside the current scroll position (e.g. the
  // status-bar shortcuts link on a long roster that needs scrolling to
  // reach) would otherwise be placed off-screen too. Skip silently rather
  // than mark it seen — leaves it eligible to show next time it's in view.
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
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
  let arrowClass = 'arrow-top';
  if (top + 90 > window.innerHeight) { top = Math.max(8, rect.top - 90); arrowClass = 'arrow-bottom'; }
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
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
  { id: 'assignments-tab', text: 'New: assign who casts curses, blessings and other one-per-raid buffs here.', anchor: () => document.querySelector('.mode-tab[data-tab="assignments"]') },
  { id: 'options-panel', text: 'Templates and Attendance moved into the Plan and Sign-ups menus. Data backup and shortcuts live here.', anchor: () => document.getElementById('btn-settings-menu') },
  { id: 'shortcuts-help', text: 'Press ? anytime for the full list of keyboard shortcuts.', anchor: () => document.querySelector('.mode-tab[data-tab="plan"]') },
];
function runSpotlightQueue() {
  if (document.querySelector('.spotlight-callout')) return;
  for (const def of SPOTLIGHT_DEFS) {
    if (!Spotlight.shouldShow(localStorage, def.id)) continue;
    if (showSpotlightCallout(def.id, def.anchor(), def.text)) return;
  }
}

function closePlayerEditor() {
  const existing = document.getElementById('active-player-editor');
  if (existing) { FocusTrap.close(existing); existing.remove(); }
  const overlay = document.querySelector('.player-editor-overlay');
  if (overlay) overlay.remove();
  removeSpotlightCallout();
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
    return `<div class="constraint-row"><span>${label} ${esc(otherName.split('-')[0])}</span><button type="button" class="pe-btn pe-btn-danger" data-remove-constraint="${esc(otherName)}" title="Remove this constraint">&times;</button></div>`;
  }).join('');
  return `<div class="player-constraints">
    ${rows ? `<div class="player-constraints-list">${rows}</div>` : ''}
    ${others.length ? `<div class="player-move">
      <label for="pe-keep-with">Keep with&hellip;</label>
      <select id="pe-keep-with">${options}</select>
      <button type="button" class="pe-btn" id="pe-add-together">Add</button>
    </div>
    <div class="player-move">
      <label for="pe-keep-apart">Keep away from&hellip;</label>
      <select id="pe-keep-apart">${options}</select>
      <button type="button" class="pe-btn" id="pe-add-apart">Add</button>
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
    <select id="pe-drummer-drum">${drumOptions}</select>
  </div>`;
}

// ── "Why here?" explanation (backlog #4) ─────────────────────────
function renderWhyHere(player, groupIdx) {
  const reasons = explainPlacement(player, State.groups[groupIdx] || [], groupIdx, State.groups, State.optimizerMode);
  if (!reasons.length) return '<div class="player-why-here"><h4>Why here?</h4><p class="why-here-empty">No particular buff or convention explains this placement.</p></div>';
  return `<div class="player-why-here"><h4>Why here?</h4><ul>${reasons.map(r => `<li>${esc(r.text)}</li>`).join('')}</ul></div>`;
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
  editor.className = 'player-editor';
  editor.id = 'active-player-editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-modal', 'true');
  editor.setAttribute('aria-label', title);
  editor.innerHTML = `
    <div class="player-editor-title">${esc(title)}</div>
    ${!isAdd && player && player.needsReview ? `<div class="player-editor-review-notice">${esc(player.reviewReason || 'Needs review — spec was defaulted')}. Pick the real class/spec below to clear this.</div>` : ''}
    ${!isAdd ? `<div class="player-move"><label for="pe-destination">Move ${esc(curName)}</label><select id="pe-destination"><option value="">Choose a group…</option>${State.groups.map((g,gi) => gi === found.groupIdx ? '' : g.length < 5 ? `<option value="${gi}">Move to Group ${gi+1} (${g.length}/5)</option>` : `<optgroup label="Group ${gi+1} is full — swap with">${g.map(p => `<option value="${gi}:${esc(p.uid)}">${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}</select><button type="button" class="pe-btn" id="pe-move">Move / swap</button></div>` : ''}
    <label class="player-editor-field">
      <span>Name</span>
      <input type="text" id="pe-name" value="${esc(curName)}" maxlength="32" autocomplete="off" spellcheck="false">
    </label>
    <label class="player-editor-field">
      <span>Class</span>
      <select id="pe-class">${classOptions}</select>
    </label>
    <label class="player-editor-field">
      <span>Spec</span>
      <select id="pe-spec">${specOptions}</select>
    </label>
    <div class="player-editor-role" id="pe-role"></div>
    <div class="player-editor-error" id="pe-error"></div>
    ${isAdd ? `<div class="preferred-actions"><p>Choose a class and spec to request a player. No name needed; confirmed matching imports fill this spot.</p><button type="button" class="pe-btn pe-btn-primary" id="pe-prefer">${preference ? 'Update preference' : 'Set preferred slot'}</button>${preference ? '<button type="button" class="pe-btn pe-btn-danger" id="pe-remove-preference">Remove preference</button>' : ''}</div>` : ''}
    ${!isAdd && benched ? `<div class="player-move">
      <label for="pe-backup-for">Backup for</label>
      <select id="pe-backup-for">
        <option value="">Not a backup</option>
        ${State.roster.map(sp => `<option value="${esc(sp.name)}"${Backups.backupNameFor(sp.name) === curName ? ' selected' : ''}>${esc((sp.name || '').split('-')[0])} (${esc(sp.spec)} ${esc(RosterEdit.ClassLabel(sp.class))})</option>`).join('')}
      </select>
      <button type="button" class="pe-btn" id="pe-backup-save">Save backup</button>
    </div>` : ''}
    ${!isAdd && !benched && Backups.backupNameFor(curName) ? `<div class="player-move">
      <span>Backup: ${esc(Backups.backupNameFor(curName).split('-')[0])}</span>
      <button type="button" class="pe-btn" id="pe-backup-swap">Swap in backup</button>
      <button type="button" class="pe-btn pe-btn-danger" id="pe-backup-clear">Remove backup</button>
    </div>` : ''}
    ${!isAdd && !benched && player.locked ? `<div class="player-move">
      <span>Locked by comp template</span>
      <button type="button" class="pe-btn" id="pe-unlock">Unlock</button>
    </div>` : ''}
    ${!isAdd ? renderDrummerEditor(player, curName) : ''}
    ${!isAdd ? renderConstraintEditor(player, curName) : ''}
    ${!isAdd && !benched && GameVersions[State.gameVersion].modeled ? renderWhyHere(player, found.groupIdx) : ''}
    <div class="player-editor-actions">
      ${removeLabel ? `<button type="button" class="pe-btn pe-btn-danger" id="pe-remove" title="${esc(removeTitle)}">${esc(removeLabel)}</button>` : '<span></span>'}
      <div class="pe-actions-right">
        <button type="button" class="pe-btn" id="pe-cancel">Cancel</button>
        <button type="button" class="pe-btn pe-btn-primary" id="pe-save">${isAdd ? 'Add named player' : 'Save'}</button>
      </div>
    </div>`;

  const overlay = document.createElement('div');
  overlay.className = 'player-editor-overlay';
  overlay.addEventListener('click', closePlayerEditor);
  document.body.appendChild(overlay);
  document.body.appendChild(editor);

  // Anchor below the slot, flipping above when it would run off the viewport.
  const rect = anchorEl.getBoundingClientRect();
  const h = editor.offsetHeight;
  let top = rect.bottom + 6 + window.scrollY;
  if (rect.bottom + h + 12 > window.innerHeight) {
    top = Math.max(window.scrollY + 8, rect.top - h - 6 + window.scrollY);
  }
  let left = rect.left + window.scrollX;
  const overflowX = (left - window.scrollX) + editor.offsetWidth + 12 - window.innerWidth;
  if (overflowX > 0) left -= overflowX;
  editor.style.top = top + 'px';
  editor.style.left = Math.max(window.scrollX + 8, left) + 'px';

  if (!isAdd && Spotlight.shouldShow(localStorage, 'player-editor-features')) {
    // getBoundingClientRect() below forces layout synchronously, so this can
    // run immediately — no need to wait on a paint/animation frame, which
    // some hidden/backgrounded tabs never schedule.
    const spotlightAnchor = editor.querySelector('.player-constraints') || editor.querySelector('.player-why-here') || editor;
    showSpotlightCallout('player-editor-features', spotlightAnchor, 'Constraints, backup links and "Why here?" all live in this panel.');
  }

  const nameInput = editor.querySelector('#pe-name');
  const classSel = editor.querySelector('#pe-class');
  const specSel = editor.querySelector('#pe-spec');
  const roleEl = editor.querySelector('#pe-role');
  const errorEl = editor.querySelector('#pe-error');

  function refreshRole() {
    const role = RosterEdit.RoleForSpec(classSel.value, specSel.value);
    roleEl.innerHTML = role
      ? `${getRoleIcon(role)}<span>Role: ${esc(ROLE_LABELS[role] || role)}</span>`
      : '';
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
    showToast(target ? `${curName.split('-')[0]} is now backup for ${target.split('-')[0]}` : 'Backup link removed');
  });
  editor.querySelector('#pe-backup-swap')?.addEventListener('click', () => {
    const result = Backups.swapIn(curName, found.groupIdx);
    if (!result.success) { showError(result.error); return; }
    closePlayerEditor(); commit();
    showToast(`Swapped in ${result.player.name.split('-')[0]} for ${curName.split('-')[0]}`);
  });
  editor.querySelector('#pe-backup-clear')?.addEventListener('click', () => {
    Backups.unlink(curName); closePlayerEditor(); commit(); showToast('Backup link removed');
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

  const moveBtn = editor.querySelector('#pe-move');
  if (moveBtn) moveBtn.onclick = () => {
    const value = editor.querySelector('#pe-destination').value;
    if (!value) { showError('Choose a destination first'); return; }
    const [group, swapUid] = value.split(':');
    const result = RosterEdit.MovePlayer(opts.uid, Number(group), swapUid);
    if (!result.success) { showError(result.error); return; }
    closePlayerEditor(); commit(); showToast('Player moved');
  };
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

  FocusTrap.open(editor, anchorEl);
  if (isAdd) classSel.focus();
  else editor.querySelector('#pe-destination').focus();
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
    const slot = e.target.closest('.player-slot');
    if (!slot) return;
    const gi = parseInt(slot.dataset.group);
    const si = parseInt(slot.dataset.slot);
    if (isNaN(gi)) return;
    const player = (State.groups[gi] || [])[si];
    if (player) showPlayerEditor(slot, { uid: player.uid });
    else showPlayerEditor(slot, { groupIdx: gi, preferenceIndex: si - (State.groups[gi] || []).length });
  });

  document.getElementById('bench-section').addEventListener('click', e => {
    const tab = e.target.closest('[data-tray-tab]');
    if (tab) { SignupTray.select(tab.dataset.trayTab); return; }
    const slot = e.target.closest('.bench-slot');
    if (!slot) return;
    if (slot.dataset.unplacedUid) { UnplacedDialog.open(slot.dataset.unplacedUid, null); return; }
    const uid = slot.dataset.uid;
    if (uid) showPlayerEditor(slot, { uid });
  });

  // Arrow keys move between tray tabs (WAI-ARIA tabs pattern).
  document.getElementById('bench-section').addEventListener('keydown', e => {
    activateSlotOnKey(e);
    const tab = e.target.closest('[data-tray-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = SignupTray.TABS.map(t => t.id);
    const i = ids.indexOf(tab.dataset.trayTab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1
      : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    SignupTray.select(ids[next]);
  });

  document.getElementById('btn-unplaced-cancel').addEventListener('click', () => UnplacedDialog.close());
  document.getElementById('btn-unplaced-confirm').addEventListener('click', () => UnplacedDialog.confirm());
  document.getElementById('unplaced-class').addEventListener('change', e => UnplacedDialog.fillSpecs(e.target.value));
})();

