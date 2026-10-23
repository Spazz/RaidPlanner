// ── VIEWS: landing <-> planner ──────────────────────────────────
function hasLoadedWork() {
  return State.roster.length > 0 || (State.bench || []).length > 0 || State.preferredSlots.length > 0 || State.campfires.fires.length > 0;
}

// A random roster replaces the whole plan, so it asks first whenever there is work to lose.
async function confirmReplaceWithRandom() {
  if (!hasLoadedWork()) return true;
  return Modal.confirm({
    title: 'Replace your plan?',
    message: 'A random roster replaces your current layout.',
    confirmLabel: 'Generate random roster',
  });
}

function showView(view) {
  State.view = view;
  const landing = document.getElementById('landing-view');
  const app = document.getElementById('app');
  landing.hidden = view !== 'landing';
  app.hidden = view !== 'app';
  // The shell's top bar (version tabs on the landing, plan header row on the plan) follows this attribute.
  document.body.dataset.plannerView = view;
  document.dispatchEvent(new CustomEvent('planner:view', { detail: { view } }));
  // The full landing (How it works) is a landing mode; opening the planner ends it.
  if (view === 'app') document.body.classList.remove('landing-full');
  if (view === 'landing') renderLanding();
  else if (State.activeTab !== 'plan') switchTab('plan');
  // A guild page on top of the planner must not scroll under the person's feet.
  if (plannerActive()) window.scrollTo(0, 0);
  if (view === 'app') scheduleSpotlightQueue();
}

// An import error belongs to the paste that caused it: drop it when the landing re-renders
// or the user edits the box.
function clearLandingImportStatus() {
  const status = document.getElementById('landing-status-import');
  if (!status) return;
  status.textContent = '';
  status.classList.remove('error');
}

function renderLanding() {
  // Resume banner: the planner keeps its state while the landing is shown.
  const banner = document.getElementById('resume-banner');
  const summary = document.getElementById('resume-summary');
  if (banner && summary) {
    const loaded = hasLoadedWork();
    banner.hidden = !loaded;
    if (loaded) {
      const raid = Config.Raids[State.selectedRaid];
      const parts = [`${State.roster.length} players`];
      if ((State.bench || []).length) parts.push(`${State.bench.length} benched`);
      summary.textContent = `${State.rosterName === NO_ROSTER_NAME ? 'a roster' : State.rosterName} (${parts.join(', ')}${raid ? ', ' + raidSizeLabel(State.selectedRaid) : ''})`;
    }
  }
  clearLandingImportStatus();
  LandingSample.sync(document.getElementById('landing-import'));
  renderLandingSavedList();
  renderImportHistory(document.getElementById('landing-history-list'));
  renderPlannerContext();
}

// The head's context line: "<guild> - <team> - <version>" (the team only on the officer home). The guild shell names the guild (PP.shell.setGuildContext); the version is the one the planner is on.
const PLANNER_VERSION_LABELS = { tbc: 'TBC', classic: 'Classic', forever: 'Forever' };
let plannerGuildName = '';
let plannerTeamName = '';
function renderPlannerContext() {
  const line = document.getElementById('planner-context');
  if (!line) return;
  const parts = [plannerGuildName, plannerTeamName, PLANNER_VERSION_LABELS[State.gameVersion] || ''].filter(Boolean);
  line.innerHTML = parts.map(part => `<span>${esc(part)}</span>`).join('<span class="gs-ph-sep" aria-hidden="true"></span>');
}



// Asks, then removes one landing row: a working plan (kind 'plan', id = its plan key) or a saved
// copy (kind 'copy', id = its name). Resolves true only when something was removed. Declining keeps it.
async function deleteSavedEntry(kind, id, label) {
  // A guild raid's plan lives in the database: deleting the row only clears this device's copy.
  const planId = kind === 'plan' ? String(id).slice(String(id).indexOf('|') + 1) : ''; // a plan key is "<version>|<plan id>"
  const raidPlan = kind === 'plan' && typeof RaidLink !== 'undefined' && RaidLink.isRaidPlan(planId);
  const ok = await Modal.confirm(raidPlan
    ? { title: 'Remove from this device', message: `Remove "${label}" from this device? The raid keeps its plan.`, confirmLabel: 'Remove' }
    : { title: 'Delete plan', message: `Delete "${label}"? This can't be undone.`, confirmLabel: 'Delete' });
  if (!ok) return false;
  try {
    if (kind === 'plan') {
      if (raidPlan && typeof RaidContext !== 'undefined' && RaidContext.current && RaidContext.current.planId === planId) RaidContext.leave(); // sends what is waiting, then stops saving
      PlanStore.remove(localStorage, id);
      LiveLinks.drop(localStorage, id);
      if (typeof PlanDbLinks !== 'undefined') PlanDbLinks.forget(localStorage, id); // only the device copy goes; the raid keeps its plan
      // The open plan goes too: clear the working state so the Resume banner stops offering it
      // and nothing autosaves it back.
      if (LiveLinks.planKey(State) === id) {
        PlanStore.startFresh();
        State.planId = null;
        ChangeLog.clear();
        initGroups();
        syncAddressBar();
        renderLastRun(null);
      }
    } else if (!deleteRosterFromStorage(id)) return false;
  } catch { showToast('Could not delete this plan from browser storage'); return false; }
  showToast(raidPlan ? `Removed "${label}" from this device` : `Deleted "${label}"`);
  return true;
}

// A landing row's More: one button and its menu with Delete inside (design-spec 2.4). The menu is the planner's own Menu (render.js).
function landingRowMoreHtml(label, deleteAttr, deleteValue) {
  return `<div class="menu-wrap gs-ph-more">
      <button type="button" class="gs-btn gs-menu-trigger gs-ph-pm" aria-label="More for ${esc(label)}" aria-haspopup="menu" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
      <div class="menu gs-menu-list gs-pb-menu" role="menu" aria-label="More for ${esc(label)}" hidden>
        <button type="button" class="menu-item menu-item-danger" role="menuitem" ${deleteAttr}="${esc(deleteValue)}" data-label="${esc(label)}">Delete</button>
      </div>
    </div>`;
}

function renderLandingSavedList() {
  const backupNote = document.getElementById('landing-last-backup');
  if (backupNote) backupNote.textContent = BackupStamp.label(localStorage);
  const list = document.getElementById('landing-saved-list');
  if (!list) return;
  const copiesList = document.getElementById('landing-copies-list');
  const rosters = getSavedRosters();
  const names = Object.keys(rosters);
  let drafts = [];
  try { drafts = PlanStore.read(localStorage); } catch {}
  let imports = [];
  try { imports = ImportHistory.read(localStorage); } catch {}
  // The tab's gold count is the working plans; the Saved copies and Recent imports rows show only when they hold something.
  const count = document.getElementById('landing-plan-count');
  if (count) { count.textContent = String(drafts.length); count.hidden = drafts.length === 0; }
  const copiesWrap = document.getElementById('landing-copies-wrap');
  if (copiesWrap) copiesWrap.hidden = names.length === 0;
  const historyWrap = document.getElementById('landing-history-wrap');
  if (historyWrap) historyWrap.hidden = imports.length === 0;
  const stamp = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  list.innerHTML = drafts.length ? drafts.map(p => {
    const label = p.data.rosterName;
    return `<li class="gs-ph-prow">
    <button type="button" class="gs-ph-open saved-open" data-plan="${esc(LiveLinks.planKey(p.data))}">
      <span class="gs-ph-pname"><span class="gs-ph-ptext">${esc(label)}</span>${RaidLink.isRaidPlan(p.data.planId) ? '<span class="gs-hd-chip is-grey">Guild raid</span>' : ''}</span>
      <span class="gs-ph-pmeta">${p.data.groups.flat().length} seated - ${p.data.bench.length} benched - ${esc(stamp(p.updatedAt))}</span>
    </button>
    ${landingRowMoreHtml(label, 'data-delete-plan', LiveLinks.planKey(p.data))}
  </li>`;
  }).join('') : '<li class="gs-ph-empty">No plans yet. Import a roster and your work will be saved here automatically.</li>';
  if (copiesList) copiesList.innerHTML = names.map(name => {
    const r = rosters[name];
    const players = r.players ? r.players.length : 0;
    const raid = r.raid && Config.Raids[r.raid] ? raidSizeLabel(r.raid) : '';
    const linked = r.sourceEventId ? ' - Raid-Helper linked' : '';
    return `<li class="gs-ph-prow">
      <button type="button" class="gs-ph-open saved-open" data-name="${esc(name)}">
        <span class="gs-ph-pname"><span class="gs-ph-ptext">${esc(name)}</span></span>
        <span class="gs-ph-pmeta">${players} players${raid ? ' - ' + esc(raid) : ''}${linked}</span>
      </button>
      ${landingRowMoreHtml(name, 'data-delete-copy', name)}
    </li>`;
  }).join('');
  for (const box of [list, copiesList]) {
    if (!box) continue;
    if (typeof Menu !== 'undefined') box.querySelectorAll('.gs-ph-more').forEach(wrap => Menu.init(wrap.querySelector('.gs-menu-trigger'), wrap.querySelector('.gs-menu-list')));
    box.querySelectorAll('[data-delete-plan], [data-delete-copy]').forEach(btn => btn.addEventListener('click', async () => {
      const isPlan = btn.dataset.deletePlan !== undefined;
      const removed = await deleteSavedEntry(isPlan ? 'plan' : 'copy', isPlan ? btn.dataset.deletePlan : btn.dataset.deleteCopy, btn.dataset.label);
      if (removed) renderLanding();
    }));
    box.querySelectorAll('.saved-open').forEach(item => item.addEventListener('click', () => {
      if (item.dataset.plan) {
        const plan = drafts.find(p => LiveLinks.planKey(p.data) === item.dataset.plan);
        if (plan && openThroughRaid(plan.data, item.dataset.plan)) return;
        if (plan && PlanStore.restore(plan.data)) { ChangeLog.clear(); initGroups(); commit(); showView('app'); RaidHelperSync.check(); }
        return;
      }
      const data = rosters[item.dataset.name];
      if (!Import.loadRoster(data)) { showToast('That saved roster could not be loaded'); return; }
      ChangeLog.clear();
      initGroups();
      commit();
      showToast(`Loaded "${item.dataset.name}"`);
      showView('app');
      RaidHelperSync.check();
    }));
  }
}

// A guild raid's plan opens through the raid: the database copy is the plan, this device's copy only the cache. A browser that never opened
// the raid has no raid binding (PlanDbLinks) and opens the device copy. True when the raid's address was set.
function openThroughRaid(data, planKey) {
  if (!RaidLink.isRaidPlan(data.planId) || typeof PlanDbLinks === 'undefined') return false;
  const bound = PlanDbLinks.get(localStorage, planKey);
  const guild = window.Guild;
  if (!bound || !guild || !guild.router) return false;
  window.location.hash = guild.router.format({ name: 'planner', gid: bound.gid, rid: bound.rid });
  return true;
}

// The sample behind "a player list": shown gray like placeholder text, and the leader's first edit replaces it.
const LandingSample = {
  text: ['Korbridra - Retribution Paladin', 'Fensyl - Arms Warrior', 'Thiven - Restoration Druid',
    'Lormalisa - Destruction Warlock', 'Sarfendra - Frost Mage'].join('\n'),
  isShown(box) { return !!box && box.classList.contains('is-sample') && box.value === this.text; },
  // The class never outlives the text (a cleared or edited box is the leader's own).
  sync(box) { if (box && !this.isShown(box)) box.classList.remove('is-sample'); },
  fill(box) {
    if (!box) return;
    if (box.value.trim() && !this.isShown(box)) { box.focus(); box.select(); return; }
    box.value = this.text;
    box.classList.add('is-sample');
    box.focus();
  },
  beforeInput(box) { if (this.isShown(box)) { box.value = ''; box.classList.remove('is-sample'); } },
};

(function initLanding() {
  const card = document.getElementById('import-card');
  if (!card) return;

  // Tabs
  card.querySelectorAll('.gs-ph-tab').forEach(tab => tab.addEventListener('click', () => {
    card.querySelectorAll('.gs-ph-tab').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    card.querySelectorAll('.gs-ph-pane').forEach(pane => { pane.hidden = pane.dataset.pane !== tab.dataset.pane; });
    const focusEl = tab.dataset.pane === 'import' ? document.getElementById('landing-import') : null;
    if (focusEl) focusEl.focus();
  }));

  // Saved copies and Recent imports: disclosure rows.
  card.querySelectorAll('.gs-ph-disc').forEach(button => button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
  }));

  const loadInput = () => runImport('landing-import', 'landing-status-import', 'btn-landing-import', () => { showView('app'); SplitFlow.maybeOffer(); });
  document.getElementById('btn-landing-import').addEventListener('click', loadInput);
  document.getElementById('landing-import').addEventListener('input', clearLandingImportStatus);
  const landingBox = document.getElementById('landing-import');
  landingBox.addEventListener('beforeinput', () => LandingSample.beforeInput(landingBox));
  landingBox.addEventListener('input', () => LandingSample.sync(landingBox));
  document.getElementById('btn-landing-sample').addEventListener('click', () => LandingSample.fill(landingBox));
  document.getElementById('landing-import').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!document.getElementById('btn-landing-import').disabled) loadInput();
    }
  });

  // Dev-only: open index.html?dev to load scenarios.js (tracked test data, fetched only in dev mode) and pick
  // a roster from the scenario list. Production never requests the file.
  if (/[?&]dev(?:[&=]|$)/.test(location.search)) {
    const script = document.createElement('script');
    // Absolute: the address bar may be on a /<version>/<id> live link.
    script.src = '/scenarios.js';
    script.onload = () => {
      const S = window.PPScenarios;
      const pane = document.querySelector('.gs-ph-pane[data-pane="import"]');
      if (!S || !pane) return;
      const wrap = document.createElement('div');
      wrap.className = 'dev-scenarios';
      wrap.innerHTML = `<label for="dev-scenario">Dev - load a test scenario (${S.scenarios.length})</label>
        <select id="dev-scenario" class="raid-dropdown"><option value="" disabled selected>Pick a scenario</option>
        ${S.scenarios.map(sc => `<option value="${esc(sc.id)}">${esc(sc.id)} - ${esc(sc.label)}</option>`).join('')}</select>`;
      pane.insertBefore(wrap, pane.querySelector('.gs-ph-field'));
      wrap.querySelector('select').addEventListener('change', (e) => {
        const sc = S.scenarios.find(x => x.id === e.target.value);
        if (!sc) return;
        if (sc.raid) State.selectedRaid = sc.raid;
        document.getElementById('landing-import').value = JSON.stringify(S.toRaidHelperJson(sc), null, 1);
        LandingSample.sync(document.getElementById('landing-import'));
        loadInput();
      });
    };
    document.head.appendChild(script);
  }

  document.getElementById('btn-landing-random').addEventListener('click', async () => {
    if (!await confirmReplaceWithRandom()) return;
    NewPlanVersion.begin();
    State.planId = null;
    ChangeLog.clear();
    RandomRoster.generate();
    commit();
    showToast('Random ' + (Config.Raids[State.selectedRaid]?.size || 25) + '-man roster generated');
    showView('app');
  });

  // The plan restored at page load may be hours old, so look at its event again.
  document.getElementById('btn-resume').addEventListener('click', () => { showView('app'); RaidHelperSync.check(); });
  // "New plan…" (menu) goes back to the import screen; the planner keeps its plan meanwhile.
  document.getElementById('btn-new-plan').addEventListener('click', () => showView('landing'));
  // The way home is the shell's Planner item and brand (js/guild/shell.js), which call PP.shell.home().
})();

(function initPlanChrome() {
  document.getElementById('btn-undo').onclick = undoPlanChange;
  document.getElementById('btn-redo').onclick = redoPlanChange;
  const share = document.getElementById('share-dialog');
  document.getElementById('btn-share-main').onclick = () => share.showModal();
  document.getElementById('close-share').onclick = () => share.close();
  share.querySelectorAll('[data-share-action]').forEach(b => b.onclick = () => { share.close(); document.getElementById(b.dataset.shareAction).click(); });
  const renameDialog = document.getElementById('rename-dialog');
  document.getElementById('roster-name').onclick = () => { document.getElementById('plan-name').value=State.rosterName; renameDialog.returnValue=''; renameDialog.showModal(); };
  renameDialog.addEventListener('close', () => {
    if(renameDialog.returnValue !== 'save') return;
    const value=document.getElementById('plan-name').value.trim();
    if(value) { State.rosterName=value; commit(); }
  });
})();

// ── HEADER MENUS (nav slim-down) ─────────────────────────────────
// Share, and one More menu holding Changes, Raid settings, Reference comp, Raid notes and the Plan, Sign-ups and Data & help sections.
(function initToolbarMenus() {
  Menu.init(document.getElementById('btn-share-menu'), document.getElementById('share-menu'));
  Menu.init(document.getElementById('btn-settings-menu'), document.getElementById('settings-menu'));
})();

// ── RAID NOTES TOGGLE (More menu) ─────────────────────────────────
// The More menu item opens the notes panel under the Raid check strip; the panel's own summary closes it.
function syncRaidNotesToggle() {
  const panel = document.getElementById('raid-notes-panel');
  const toggle = document.getElementById('btn-raid-notes-toggle');
  if (!panel || !toggle) return;
  toggle.setAttribute('aria-expanded', String(panel.open));
}
(function initRaidNotesToggle() {
  const panel = document.getElementById('raid-notes-panel');
  const toggle = document.getElementById('btn-raid-notes-toggle');
  if (!panel || !toggle) return;
  toggle.addEventListener('click', () => {
    panel.open = !panel.open;
    if (panel.open) document.getElementById('raid-notes-textarea').focus();
  });
  panel.addEventListener('toggle', syncRaidNotesToggle);
  syncRaidNotesToggle();
})();

const PHONE_QUERY = window.matchMedia('(max-width: 600px)');

// ── COVERAGE DIALOG ───────────────────────────────────────────────
// "N covered" in the Raid check strip opens it: a modal <dialog> (desktop) that is a full-height sheet on phones (CSS).
// The browser closes it on Escape; FocusTrap keeps Tab inside it and hands focus back to the button when it closes.
function openCoverageDialog() {
  const dialog = document.getElementById('coverage-dialog');
  const trigger = document.getElementById('btn-coverage');
  if (!dialog || dialog.open || typeof dialog.showModal !== 'function') return;
  dialog.showModal();
  trigger?.setAttribute('aria-expanded', 'true');
  FocusTrap.open(dialog, trigger);
}
function closeCoverageDialog() {
  const dialog = document.getElementById('coverage-dialog');
  if (dialog && dialog.open) dialog.close();
}
(function initCoverageDialog() {
  const dialog = document.getElementById('coverage-dialog');
  const trigger = document.getElementById('btn-coverage');
  if (!dialog || !trigger) return;
  trigger.addEventListener('click', openCoverageDialog);
  document.getElementById('btn-close-coverage').addEventListener('click', closeCoverageDialog);
  // Escape, Close and the backdrop all end here.
  dialog.addEventListener('close', () => {
    trigger.setAttribute('aria-expanded', 'false');
    FocusTrap.close(dialog);
  });
  // A click on the backdrop (the dialog element itself, outside its box) closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeCoverageDialog(); });
})();

// ── RAID SETTINGS DIALOG ──────────────────────────────────────────
// More > Raid settings: the raid size and game version segments, the sign-ups source and the live link state. A choice applies at
// once, as the toolbar and the Version menu did, and closes the dialog: the board changed behind it and the toast (which
// cannot show above a modal) says what moved. The version switch asks first, so the dialog closes before the confirm opens
// and comes back if the answer is no.
function openRaidSettingsDialog() {
  const dialog = document.getElementById('raid-settings-dialog');
  const trigger = document.getElementById('btn-raid-settings');
  if (!dialog || dialog.open || typeof dialog.showModal !== 'function') return;
  renderPlanHead();
  renderRaidSizeControl();
  dialog.showModal();
  trigger?.setAttribute('aria-expanded', 'true');
  FocusTrap.open(dialog, document.getElementById(PHONE_QUERY.matches ? 'btn-phone-more' : 'btn-settings-menu'));
}
function closeRaidSettingsDialog() {
  const dialog = document.getElementById('raid-settings-dialog');
  if (dialog && dialog.open) dialog.close();
}
(function initRaidSettingsDialog() {
  const dialog = document.getElementById('raid-settings-dialog');
  const trigger = document.getElementById('btn-raid-settings');
  if (!dialog || !trigger) return;
  trigger.addEventListener('click', openRaidSettingsDialog);
  document.getElementById('btn-close-raid-settings').addEventListener('click', closeRaidSettingsDialog);
  dialog.addEventListener('close', () => {
    trigger.setAttribute('aria-expanded', 'false');
    FocusTrap.close(dialog);
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeRaidSettingsDialog(); });
  // The size control's own handler (render.js) has already switched the size when this bubbles up.
  document.getElementById('raid-size-control').addEventListener('click', (e) => { if (e.target.closest('[data-raid-size]')) closeRaidSettingsDialog(); });
  document.getElementById('raid-version-control').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-version]');
    if (!button || button.dataset.version === State.gameVersion) return;
    closeRaidSettingsDialog();
    const switched = await switchGameVersion(button.dataset.version);
    if (!switched && State.view === 'app') openRaidSettingsDialog();
  });
})();

// ── PHONE "MORE" SHEET ────────────────────────────────────────────
(function initMoreSheet() {
  const sheet = document.getElementById('mobile-more-sheet');
  const trigger = document.getElementById('btn-phone-more');
  const openSheet = () => {
    sheet.classList.add('visible');
    trigger.setAttribute('aria-expanded', 'true');
    FocusTrap.open(sheet, trigger, closeSheet);
    // FocusTrap listens on the sheet itself, so focus must start inside it
    // for Tab trapping and Escape to work.
    const first = FocusTrap.focusables(sheet)[0];
    if (first) first.focus();
  };
  const closeSheet = () => {
    sheet.classList.remove('visible');
    trigger.setAttribute('aria-expanded', 'false');
    FocusTrap.close(sheet);
  };
  trigger.addEventListener('click', openSheet);
  document.getElementById('btn-close-more-sheet').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  // Close whenever a sheet action actually runs, so the sheet never sits
  // open in front of a dialog the action just opened.
  sheet.addEventListener('click', (e) => { if (e.target.closest('button') && e.target !== sheet) closeSheet(); });
})();

// ── RESPONSIVE CHROME ─────────────────────────────────────────────
// On a phone the head's actions row is the fixed bottom bar (CSS): Undo, Optimize, Share and More stay where they are.
// The More menu's items have one id each, so the SAME elements physically move into the More sheet and snap back to the
// menu when the viewport widens (a comment node left at each element's original position remembers the spot). Redo sits
// in the sheet's first group on a phone. Slots fill in list order.
(function initResponsiveChrome() {
  const slots = ['btn-redo:phone-sheet-quick-slot', 'btn-changes:phone-sheet-quick-slot', 'btn-raid-settings:phone-sheet-quick-slot', 'btn-ideal-comp-link:phone-sheet-quick-slot', 'btn-raid-notes-toggle:phone-sheet-quick-slot',
    'btn-new-plan:phone-sheet-plan-slot', 'btn-load:phone-sheet-plan-slot', 'btn-save:phone-sheet-plan-slot', 'btn-templates:phone-sheet-plan-slot', 'btn-split-plan:phone-sheet-plan-slot', 'btn-clear:phone-sheet-plan-slot',
    'btn-refresh:phone-sheet-signups-slot', 'btn-attendance:phone-sheet-signups-slot', 'btn-random:phone-sheet-signups-slot',
    'btn-export-backup:phone-sheet-data-slot', 'btn-import-backup:phone-sheet-data-slot', 'btn-shortcuts-help:phone-sheet-data-slot', 'btn-show-tips-again:phone-sheet-data-slot',
  ].map(pair => {
    const [elId, phoneSlotId] = pair.split(':');
    const el = document.getElementById(elId);
    const anchor = document.createComment('anchor:' + elId);
    if (el && el.parentNode) el.parentNode.insertBefore(anchor, el);
    return { el, anchor, phoneSlot: document.getElementById(phoneSlotId) };
  });

  function sync() {
    const isPhone = PHONE_QUERY.matches;
    for (const slot of slots) {
      if (!slot.el) continue;
      if (isPhone) {
        if (slot.phoneSlot && slot.el.parentNode !== slot.phoneSlot) slot.phoneSlot.appendChild(slot.el);
      } else if (slot.anchor.parentNode && slot.el.previousSibling !== slot.anchor) {
        slot.anchor.parentNode.insertBefore(slot.el, slot.anchor.nextSibling);
      }
    }
  }
  PHONE_QUERY.addEventListener('change', sync);
  // A page whose viewport is still settling while this runs (seen in an embedded
  // frame) can match the phone query here and never get a 'change' back to
  // desktop, leaving every control in its phone slot. sync() is idempotent and
  // cheap, so it also runs on resize and once the page has loaded.
  window.addEventListener('resize', sync);
  window.addEventListener('load', sync);
  sync();
})();

// ── ACTION BUTTONS ──────────────────────────────────────────────
// "Last Optimize: 8 moved, Windfury +4 melee": the toast's wording in short form.
function renderLastRun(summary) {
  const el = document.getElementById('last-run');
  if (!el) return;
  if (!summary) { el.innerHTML = ''; return; }
  const parts = [`${summary.moved} moved`].concat(reachParts(summary.reach));
  el.textContent = `Last Optimize: ${parts.join(', ')}`;
}

// Optimize wipes the leader's totem/aura picks, so the toast says so when it did.
// It also names the players Optimize benched or seated again (after a raid size change it decides who sits),
// and which buffs now reach more or fewer players.
function optimizeToastMessage({ moved, benched = 0, seated = 0, reach = [], overridesReset }) {
  const reset = overridesReset > 0 ? `${overridesReset} buff override${overridesReset === 1 ? '' : 's'} reset` : '';
  if (moved === 0 && benched === 0 && seated === 0) return reset ? `No moves needed. ${reset}` : 'Already optimal — nothing moved';
  const counts = [`${moved} moved`, benched > 0 ? `${benched} benched` : '', seated > 0 ? `${seated} seated` : ''].filter(Boolean);
  const parts = reachParts(reach);
  return [`Optimized: ${counts.join(', ')}.`, parts.length ? `${parts.join(', ')}.` : '', reset].filter(Boolean).join(' ');
}

// Up to two gains and the largest loss from diffBuffReach(), as "Windfury +4 melee".
function reachParts(reach) {
  const list = Array.isArray(reach) ? reach : [];
  const gains = list.filter(r => r.delta > 0).slice(0, 2);
  const loss = list.filter(r => r.delta < 0).sort((x, y) => x.delta - y.delta)[0];
  return gains.concat(loss ? [loss] : []).map(r => `${r.name} ${r.delta > 0 ? '+' : ''}${r.delta} ${r.word}`);
}

// Ember glow on the Optimize button (app.css #btn-optimize.firing). Only the successful-rebuild path calls it.
// Removing the class, forcing a reflow and adding it again restarts the animation on repeated clicks.
let emberTimer = null;
function fireEmber(btn) {
  if (!btn || !btn.classList) return;
  btn.classList.remove('firing');
  void btn.offsetWidth;
  btn.classList.add('firing');
  clearTimeout(emberTimer);
  emberTimer = setTimeout(() => btn.classList.remove('firing'), 1300);
}

document.getElementById('btn-optimize').addEventListener('click', () => {
  if (!GameVersions[State.gameVersion].modeled) { showToast(GameVersions[State.gameVersion].note); return; }
  if (State.roster.length === 0) { showToast('Import a roster first'); return; }
  const reachBefore = snapshotBuffReach(); // the board as the leader saw it, overrides included
  const undoTopBefore = PlanSession.undo[PlanSession.undo.length - 1];

  // One strategy since the nav slim-down: Optimize always runs Max DPS.
  State.optimizerMode = 'max_dps';
  const overridesReset = Object.keys(State.buffOverrides).length;
  const { entry } = ChangeLog.track('optimize', 'Optimize', () => {
    State.buffOverrides = {};
    Optimizer.optimize();
    commit();
  }, { moves: true });

  // The step this click pushed, if it pushed one; Undo only acts while it is still the latest.
  const undoRef = PlanSession.undo[PlanSession.undo.length - 1];
  const pushed = undoRef !== undefined && undoRef !== undoTopBefore;
  if (entry && pushed) entry.undoRef = undoRef;
  const counts = { moved: 0, benched: 0, seated: 0 };
  for (const it of entry ? entry.items : []) if (it.kind in counts) counts[it.kind]++;
  const reach = diffBuffReach(reachBefore, snapshotBuffReach());
  renderLastRun({ moved: counts.moved, reach });
  if (pushed && (entry || overridesReset > 0)) fireEmber(document.getElementById('btn-optimize')); // something was rebuilt: no glow for "already optimal"
  const message = optimizeToastMessage({ ...counts, reach, overridesReset });
  ResultLine.show(message); // after the commit above, which clears any earlier result
  // Undo whenever the click pushed a step that changed something: moves, or only reset buff overrides.
  if (!pushed || (!entry && overridesReset === 0)) { showToast(message); return; } // nothing changed: no Undo, even if the groups were re-sorted
  showToast(message, { action: { label: 'Undo', onClick: () => {
    if (PlanSession.undo[PlanSession.undo.length - 1] !== undoRef) { showToast('Nothing to undo: the plan changed after Optimize'); return; }
    undoPlanChange();
  } } });
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  const confirmed = await Modal.confirm({
    title: 'Clear the board?',
    message: 'Removes every player, your notes and your picks from this plan. Undo brings it back.',
    confirmLabel: 'Clear board',
  });
  if (!confirmed) return;
  renderLastRun(null);
  // Wipe every per-roster feature keyed by player name/uid, or it dangles (stale notes,
  // together/apart pairs, Standby backups, drum tags) and resurfaces on the next import.
  PlanStore.startFresh();
  ChangeLog.clear();
  initGroups();
  commit();
  showToast('Cleared');
});

document.getElementById('btn-landing-empty').addEventListener('click', () => {
  State.planId = 'plan:' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  PlanStore.startFresh();
  NewPlanVersion.begin();
  ChangeLog.clear();
  State.rosterName = 'New raid plan';
  initGroups(); commit(); showView('app');
  showToast('Click an empty slot to choose a preferred class and spec');
});

document.getElementById('btn-random').addEventListener('click', async () => {
  if (!await confirmReplaceWithRandom()) return;
  State.planId = null;
  ChangeLog.clear();
  RandomRoster.generate();
  commit();
  showToast('Random ' + (Config.Raids[State.selectedRaid]?.size || 25) + '-man roster generated');
});

document.getElementById('btn-save').addEventListener('click', showSaveModal);
document.getElementById('btn-templates').addEventListener('click', showTemplatesModal);
// Open saved plan, and the head's "Your plans" back link: the landing's Your plans tab.
function openSavedPlans() { showView('landing'); document.querySelector('.gs-ph-tab[data-pane="saved"]').click(); }
document.getElementById('btn-load').addEventListener('click', openSavedPlans);
document.getElementById('btn-back-plans').addEventListener('click', openSavedPlans);

// ── SECOND TAB ──────────────────────────────────────────────────
// Another tab saving the plan open here (the storage event only reaches other
// tabs) would be overwritten by this tab's next save: say so, without blocking.
const TabWatch = {
  entry: null,
  onStorage(e) {
    if (e.key !== PlanStore.key) return;
    const entry = PlanStore.foreignEdit(e.newValue, LiveLinks.planKey(State));
    if (!entry) return;
    // A tab opened beside this one re-saves the same plan with a new updatedAt:
    // identical content is no conflict, but remember the stamp so a later real edit shows.
    // A tab still on a pre-4.0 build saves without sizeBenched; that alone is no edit.
    const mine = PlanStore.capture();
    if (entry.data && !('sizeBenched' in entry.data)) delete mine.sizeBenched;
    if (JSON.stringify(entry.data) === JSON.stringify(mine)) {
      PlanStore.known[LiveLinks.planKey(State)] = entry.updatedAt;
      return;
    }
    this.entry = entry;
    document.getElementById('tab-conflict-banner').hidden = false;
  },
  hide() {
    this.entry = null;
    document.getElementById('tab-conflict-banner').hidden = true;
  },
  // The warning is about one plan: drop it once a different plan is open.
  dropIfElsewhere() {
    if (this.entry && LiveLinks.planKey(State) !== LiveLinks.planKey(this.entry.data)) this.hide();
  },
  // Replace this tab's copy with the other tab's save.
  loadTheirs() {
    const entry = this.entry;
    this.hide();
    if (!entry || !PlanStore.restore(entry.data)) return false;
    closePlayerEditor(); closeBuffPicker();
    initGroups(); commit(); renderLastRun(null);
    showToast('Loaded the version from the other tab');
    return true;
  },
  // Carry on here; the warning returns only if the other tab saves again.
  keepMine() {
    if (this.entry) PlanStore.known[LiveLinks.planKey(State)] = this.entry.updatedAt;
    this.hide();
  },
};
document.getElementById('btn-tab-load').addEventListener('click', () => TabWatch.loadTheirs());
document.getElementById('btn-tab-keep').addEventListener('click', () => TabWatch.keepMine());
document.getElementById('btn-remote-undo').addEventListener('click', () => RemoteUpdate.undo());
document.getElementById('btn-remote-changes').addEventListener('click', () => RemoteUpdate.seeChanges());
document.getElementById('btn-remote-dismiss').addEventListener('click', () => RemoteUpdate.hide());
document.getElementById('btn-shared-gotit').addEventListener('click', () => SharedPlanBanner.hide({ focus: true }));
document.getElementById('btn-shared-copy').addEventListener('click', () => SharedPlanBanner.makeCopy());

// ── SHARE LINK ──────────────────────────────────────────────────
// Live links (/<version>/<id>): a plan's first Share stores its share code
// via the Worker's /api/share (worker/share.js); from then on every change auto-saves to that same link,
// the address bar shows it while the plan is open, and open pages pull other
// people's changes. Anyone with the link can edit and the latest save wins.
// The version segment is a readable label only (the stored code carries the
// real version and raid). When the API cannot create a link, Share says so.
const SHARE_API = '/api/share';
const SHORT_LINK_PATH = new RegExp(`^/(?:${Object.keys(GameVersions).join('|')})/([0-9A-Za-z]{7})/?$`);
// Read before the first render, which hands the address bar to syncAddressBar.
const SHORT_LINK_AT_LOAD = (window.location.pathname.match(SHORT_LINK_PATH) || [])[1] || null;
const LIVE_SAVE_DELAY_MS = 2000;
const LIVE_DEFER_POLL_MS = 500;

function currentShareCode() {
  return Import.encodeSharePayload(Import.exportShareString());
}

function linkStorage() {
  try { return window.localStorage; } catch { return null; }
}

function currentLiveLink() {
  const planKey = LiveLinks.planKey(State);
  const entry = LiveLinks.get(linkStorage(), planKey);
  return entry ? { planKey, entry } : null;
}

// A save still in flight when its plan is deleted must not re-create the binding: bind only for the
// open plan or a plan PlanStore still holds.
function planKeyIsLive(planKey) {
  if (!planKey) return false;
  if (LiveLinks.planKey(State) === planKey) return true;
  try { return PlanStore.read(linkStorage()).some(p => LiveLinks.planKey(p.data) === planKey); } catch { return false; }
}

function bindLiveLink(planKey, id, code, updatedAt) {
  if (!planKeyIsLive(planKey)) return;
  try { LiveLinks.bind(linkStorage(), planKey, id, code, updatedAt); } catch {}
}

function liveLinkPath(id) {
  return '/' + State.gameVersion + '/' + id;
}

// The address bar always names the open plan's live link, or / without one.
function syncAddressBar() {
  const link = currentLiveLink();
  const path = link ? liveLinkPath(link.entry.id) : '/';
  // A guild route (#/...) is kept: the shell shows a guild section on top of the open plan's address.
  const hash = window.location.hash.startsWith('#/') ? window.location.hash : '';
  if (window.location.pathname !== path) history.replaceState(null, '', path + window.location.search + hash);
}

// The Error for a failed API response: 429 carries retryAfterMs (back off,
// then retry); permanent marks a 4xx no retry can fix, with the server's reason.
async function shareError(resp) {
  const err = new Error('share ' + resp.status);
  err.status = resp.status;
  if (resp.status === 429) err.retryAfterMs = LiveLinks.retryAfterMs(resp.headers && resp.headers.get('Retry-After'));
  if (LiveLinks.isPermanentFailure(resp.status)) {
    err.permanent = true;
    const body = await resp.json().catch(() => null);
    err.reason = body && typeof body.error === 'string' && body.error ? body.error : 'the server refused it (' + resp.status + ')';
  }
  return err;
}

// Resolves to {code, updatedAt}, or null when the link is unknown/expired.
// Throws when the server cannot be reached.
async function fetchLiveLink(id) {
  const resp = await fetch(`${SHARE_API}?id=${id}`, { signal: timeoutSignal(8000) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw await shareError(resp);
  const data = await resp.json();
  if (!data || typeof data.code !== 'string') throw new Error('share: bad response');
  return { code: data.code, updatedAt: Number(data.updatedAt) || 0 };
}

// Stores code under a new link. Resolves to {id, updatedAt}; throws when the
// server cannot be reached, refuses it or answers with a malformed ID.
async function createLiveLink(code, { keepalive = false, timeoutMs = 8000 } = {}) {
  const resp = await fetch(SHARE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    keepalive,
    signal: timeoutSignal(timeoutMs),
  });
  if (!resp.ok) throw await shareError(resp);
  const { id, updatedAt } = await resp.json();
  if (!LiveLinks.ID.test(id)) throw new Error('share: bad response');
  return { id, updatedAt: Number(updatedAt) || 0 };
}

// A co-editor's update, logged under Changes with group moves (match by uid,
// then name: the share code carries no uids). Returns ChangeLog.track's {result, entry}.
function trackLiveUpdate(apply) {
  return ChangeLog.track('live', 'Live link update', apply, { moves: true, ignoreBackfill: false });
}

// Swaps in someone else's copy of this plan, keeping what makes it this
// browser's plan (its ID, Raid-Helper event and optimizer strategy) and what
// the share code does not carry (player identities, totem and aura picks).
function applyRemoteLiveCode(id, remote) {
  const str = Import.decodeSharePayload(remote.code);
  if (!str || !Import.previewShareString(str).success) return false;
  const keep = { planId: State.planId, sourceEventId: State.sourceEventId, optimizerMode: State.optimizerMode };
  const picks = LocalPicks.capture();
  if (!Import.importAddonString(str).success) return false;
  Object.assign(State, keep);
  LocalPicks.restore(picks);
  // Bound before rendering, so the render does not echo the copy straight back.
  bindLiveLink(LiveLinks.planKey(State), id, currentShareCode(), remote.updatedAt);
  commit();
  return true;
}

// Shown once per link when this browser opens someone else's live link: the
// plan is shared and edits reach everyone. The seen list is device-local (not
// part of the data backup).
const SHARED_SEEN_KEY = 'pp_shared_seen_v1';
const SHARED_SEEN_MAX = 50;
const SharedPlanBanner = {
  linkId: null,
  planKey: null, // the plan the banner was shown for; it hides when the open plan is another one
  seen() {
    try {
      const list = JSON.parse(linkStorage().getItem(SHARED_SEEN_KEY));
      return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  },
  remember(id) {
    if (!id) return;
    const list = this.seen().filter(x => x !== id);
    list.push(id);
    try { linkStorage().setItem(SHARED_SEEN_KEY, JSON.stringify(list.slice(-SHARED_SEEN_MAX))); } catch {}
  },
  show(id) {
    if (!id || this.seen().includes(id)) return;
    const banner = document.getElementById('shared-plan-banner');
    const text = document.getElementById('shared-plan-text');
    if (!banner || !text) return;
    this.linkId = id;
    this.planKey = LiveLinks.planKey(State);
    const name = document.createElement('strong');
    name.textContent = State.rosterName;
    text.replaceChildren('You opened a shared live plan: ', name, '. Changes you make are saved for everyone with this link.');
    banner.hidden = false;
  },
  // Hides the banner and marks the link seen. `focus`: the user pressed one of its buttons, so
  // focus moves to the plan name rather than falling to the page.
  hide({ focus = false } = {}) {
    const id = this.linkId;
    this.linkId = null;
    this.planKey = null;
    this.remember(id);
    const banner = document.getElementById('shared-plan-banner');
    if (banner) banner.hidden = true;
    if (focus) {
      const target = document.getElementById('roster-name');
      if (target && target.focus) target.focus();
    }
  },
  // True while the open plan is the one the banner was shown for. Otherwise the
  // banner goes away without marking the link seen: the user never answered it.
  belongsToOpenPlan() {
    if (!this.linkId) return false;
    if (this.planKey === LiveLinks.planKey(State)) return true;
    this.linkId = null;
    this.planKey = null;
    const banner = document.getElementById('shared-plan-banner');
    if (banner) banner.hidden = true;
    return false;
  },
  // Turns the open plan into this browser's own plan: a new planId, so no
  // link is bound to it. The shared plan stays saved as it was. Sends nothing.
  makeCopy() {
    if (!this.belongsToOpenPlan()) return;
    this.hide({ focus: true });
    PlanStore.flush();
    State.planId = 'plan:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    State.rosterName = State.rosterName + ' (my copy)';
    commit();
    syncAddressBar();
    showToast('Saved your own copy. Changes now stay in this browser.');
  },
};

// Stays up after a co-editor's change replaces the open plan, until the user
// dismisses it. Changing the plan themselves only retires its Undo.
const RemoteUpdate = {
  before: null,
  entryId: null, // the Changes entry the update recorded, dropped again by Undo
  // "Updated by someone else: 3 moved, 1 benched." from the update's Changes entry.
  // With the editor's name (a guild raid plan: "Updated by Kim: 3 moved, 1 benched.") the name replaces "someone else".
  summaryText(entry, editorName) {
    const who = typeof editorName === 'string' && editorName.trim() ? editorName.trim() : '';
    const counts = entry && entry.items && entry.items.length ? ChangeLog.countsText(entry) : '';
    if (who) return counts ? `Updated by ${who}: ${counts}.` : `Roster updated by ${who}.`;
    return counts ? `Updated by someone else: ${counts}.` : 'Roster updated by someone else.';
  },
  show(before, entry, editorName) {
    this.before = before;
    this.entryId = entry ? entry.id : null;
    const banner = document.getElementById('remote-update-banner');
    const text = document.getElementById('remote-update-text');
    const undo = document.getElementById('btn-remote-undo');
    if (text) text.textContent = this.summaryText(entry, editorName);
    if (undo) undo.hidden = false;
    if (banner) banner.hidden = false;
  },
  seeChanges() { ChangesPanel.setOpen(true); },
  // The user's own edit now sits on top of the update; Undo would throw it away.
  retireUndo() {
    this.before = null;
    this.entryId = null;
    const undo = document.getElementById('btn-remote-undo');
    if (undo) undo.hidden = true;
  },
  hide() {
    this.before = null;
    this.entryId = null;
    const banner = document.getElementById('remote-update-banner');
    if (banner) banner.hidden = true;
  },
  // Puts the plan as it was before the update back on screen; saving to the raid
  // (or the live link) then follows it like any other local change, as a new revision.
  undo() {
    const before = this.before;
    const entryId = this.entryId;
    this.hide();
    if (!before || !PlanStore.restore(before)) return false;
    if (entryId) ChangeLog.remove(entryId);
    closePlayerEditor(); closeBuffPicker();
    initGroups(); commit(); renderLastRun(null);
    showToast('Restored your version of the roster');
    return true;
  },
};

const LiveSync = {
  saveTimer: null,
  pending: false,
  saving: false,
  failed: false,
  // The server refused this exact code for good: {code, reason}. Cleared as
  // soon as the plan changes, since a different code may be accepted.
  rejected: null,
  // Link ID the server forgot (expired): its next save skips the PUT (which
  // would only 404) and goes out as a new link, even though this browser
  // already synced the same code.
  expiredId: null,
  // Rate limited (429): no requests until this time.
  backoffUntil: 0,
  // True while a /<version>/<id> link from page load is still being fetched.
  opening: !!SHORT_LINK_AT_LOAD,
  // An update waiting for the user to let go of the editor, picker or notes.
  deferTimer: null,

  // Called from persistWorkingPlan on every commit.
  onRender() {
    RaidContext.onCommit();
    if (SharedPlanBanner.linkId) SharedPlanBanner.belongsToOpenPlan();
    if (!this.opening) syncAddressBar();
    const link = currentLiveLink();
    if (!link) { clearTimeout(this.saveTimer); this.pending = false; return; }
    const code = currentShareCode();
    if (this.blocked(code)) { clearTimeout(this.saveTimer); this.pending = false; return; }
    if (!LiveLinks.needsPush(link.entry, code)) return;
    this.wake(); // someone is editing: collaborators may be too, so poll fast again
    this.pending = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), LIVE_SAVE_DELAY_MS);
  },

  // True when the server will never take this code (over the size limit, or
  // refused with a 4xx before); sets the reason the status line shows.
  blocked(code) {
    if (this.rejected && this.rejected.code !== code) this.rejected = null;
    const reason = this.rejected ? null : LiveLinks.rejection(code);
    if (reason) this.rejected = { code, reason };
    return !!this.rejected;
  },

  flush() {
    clearTimeout(this.saveTimer);
    if (this.pending && !this.saving) this.save();
  },

  // Resolves once the open plan's live link holds what is on screen (true), or false when it cannot (offline, refused,
  // rate limited, no link).
  async settle() {
    clearTimeout(this.saveTimer);
    for (let i = 0; i < 100 && this.saving; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.pending && !this.saving) await this.save();
    const link = currentLiveLink();
    return !!link && !this.failed && !this.rejected && !LiveLinks.needsPush(link.entry, currentShareCode());
  },

  // The page is being hidden or closed: send the waiting save now instead of
  // leaving it to the debounce timer. keepalive lets the request outlive the page.
  flushOnExit() {
    if (!this.pending || this.saving) return;
    this.save({ keepalive: true });
  },

  // The server forgot this link: this browser's copy goes out as a new link
  // (a PUT never re-creates an ID) and the plan rebinds to it.
  replaceExpiredLink(id) {
    this.expiredId = id;
    this.pending = true;
    this.save();
  },

  async save({ keepalive = false } = {}) {
    clearTimeout(this.saveTimer);
    const link = currentLiveLink();
    const code = link && currentShareCode();
    const expired = !!link && this.expiredId === link.entry.id;
    if (!link || !(expired || LiveLinks.needsPush(link.entry, code)) || this.blocked(code)) {
      // Nothing (left) to push, so a failed attempt no longer matters.
      this.pending = false;
      this.failed = false;
      this.refreshStatus();
      return;
    }
    if (!keepalive && Date.now() < this.backoffUntil) {
      // Rate limited: wait it out.
      this.pending = true;
      this.saveTimer = setTimeout(() => this.save(), this.backoffUntil - Date.now());
      this.refreshStatus();
      return;
    }
    this.saving = true;
    try {
      let needsNewLink = expired;
      if (!needsNewLink) {
        const resp = await fetch(SHARE_API, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: link.entry.id, code }),
          keepalive,
          signal: timeoutSignal(8000),
        });
        // 404: the link expired, and a PUT never creates an ID. Only a POST can.
        if (resp.status === 404) needsNewLink = true;
        else {
          if (!resp.ok) throw await shareError(resp);
          const { updatedAt } = await resp.json();
          bindLiveLink(link.planKey, link.entry.id, code, Number(updatedAt) || 0);
        }
      }
      if (needsNewLink) {
        const created = await createLiveLink(code, { keepalive });
        bindLiveLink(link.planKey, created.id, code, created.updatedAt);
        this.expiredId = null;
        syncAddressBar();
        showToast('That live link expired (links last 30 days after the last change). A new live link is active, so share the new one.');
      }
      this.failed = false;
      this.rejected = null;
      this.backoffUntil = 0;
    } catch (err) {
      // Retried by the next poll tick (or the next change), unless the server
      // refused this code for good.
      this.failed = true;
      if (err.retryAfterMs) this.backoffUntil = Date.now() + err.retryAfterMs;
      else if (err.permanent) { this.failed = false; this.rejected = { code, reason: err.reason }; }
    }
    this.saving = false;
    // An edit made while the save was in flight still needs its own save.
    const now = currentLiveLink();
    this.pending = this.failed || (!!now && !this.blocked(currentShareCode()) && LiveLinks.needsPush(now.entry, currentShareCode()));
    if (this.pending && !this.failed) this.saveTimer = setTimeout(() => this.save(), LIVE_SAVE_DELAY_MS);
    this.refreshStatus();
  },

  async pull() {
    if (document.hidden || this.opening || this.saving) return;
    const link = currentLiveLink();
    if (!link) return;
    if (this.failed) { this.save(); return; }
    if (this.pending || this.rejected) return;
    if (Date.now() < this.backoffUntil) return;

    let remote;
    try { remote = await fetchLiveLink(link.entry.id); } catch (err) {
      if (err.retryAfterMs) this.backoffUntil = Date.now() + err.retryAfterMs;
      return;
    }
    // An expired link is replaced by a new one holding this browser's copy.
    if (remote === null) { this.replaceExpiredLink(link.entry.id); return; }

    const now = currentLiveLink();
    if (!now || now.planKey !== link.planKey) return;
    if (dragData || document.querySelector('.dragging')) return;
    // 'changed' / 'quiet' tell the poll loop whether to keep polling fast.
    if (!LiveLinks.shouldApply(now.entry, remote, this.pending || this.saving)) return 'quiet';
    if (remote.code === currentShareCode()) { bindLiveLink(now.planKey, now.entry.id, remote.code, remote.updatedAt); return 'quiet'; }
    if (this.editing()) { this.deferUntilIdle(); return 'changed'; }
    const before = PlanStore.capture();
    const { result: applied, entry } = trackLiveUpdate(() => applyRemoteLiveCode(now.entry.id, remote));
    if (applied) RemoteUpdate.show(before, entry);
    return 'changed';
  },

  // The next poll, LivePoll.intervalMs() after the last one finished.
  schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      let outcome;
      // A throw after the fetch (re-import, render) must not end polling for the session.
      try { outcome = await this.pull(); } catch (err) { console.error(err); } finally {
        if (outcome === 'changed') LivePoll.sawChange();
        else if (outcome === 'quiet') LivePoll.sawNothing();
        this.schedulePoll();
      }
    }, LivePoll.intervalMs());
  },

  // Back to the fast cadence now (a local edit, or the tab became visible again).
  wake() {
    const wasSlow = LivePoll.quiet > 0;
    LivePoll.sawChange();
    if (wasSlow && this.pollTimer) this.schedulePoll();
  },

  // The player editor, buff picker or notes field is in use: an update now would
  // rebuild the plan under it.
  editing() {
    return UserEditing.active(document);
  },

  // Waits for the user to let go, then pulls again (which re-checks everything).
  deferUntilIdle() {
    if (this.deferTimer) return;
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      if (this.editing()) this.deferUntilIdle(); else this.pull();
    }, LIVE_DEFER_POLL_MS);
  },

  statusText(fallback) {
    if (!currentLiveLink()) return fallback;
    if (this.rejected) return 'Live link not saved: ' + this.rejected.reason + '. Your changes are safe on this device.';
    if (this.failed) return 'Live link not saved yet, retrying. Your changes are safe on this device.';
    if (this.pending || this.saving) return 'Saving to the live link...';
    return 'Shared plan, changes sync to everyone with the link';
  },

  refreshStatus() {
    const status = document.getElementById('autosave-status');
    if (!status || (status.dataset.failed && !status.dataset.raid)) return; // a failed device save keeps saying so
    applySaveLine(status);
    const line = document.getElementById('roster-status-line');
    if (line) line.textContent = status.textContent;
    if (typeof mirrorSaveStatus === 'function') mirrorSaveStatus(); // a failed save to the raid shows in the next-step bar
    if (typeof renderPlanHead === 'function') renderPlanHead(); // the head's context line names the live link state
  },

  start() {
    this.schedulePoll();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.flushOnExit(); return; }
      this.wake();
      this.pull();
    });
    window.addEventListener('pagehide', () => this.flushOnExit());
  },
};

// Resolves to {url, live: true}; rejects (with .reason for a refusal the server or the size limit gave) when no live link can be made.
async function getShareLink() {
  const code = currentShareCode();
  const existing = currentLiveLink();
  if (existing) {
    LiveSync.flush();
    return { url: window.location.origin + liveLinkPath(existing.entry.id), live: true };
  }
  const planKey = LiveLinks.planKey(State);
  if (!planKey) throw new Error('share: no plan');
  const tooLarge = LiveLinks.rejection(code);
  if (tooLarge) { const err = new Error('share: too large'); err.reason = tooLarge; throw err; }
  const { id, updatedAt } = await createLiveLink(code, { timeoutMs: 5000 });
  bindLiveLink(planKey, id, code, updatedAt);
  if (!currentLiveLink()) throw new Error('share: plan closed');
  syncAddressBar();
  LiveSync.refreshStatus();
  return { url: window.location.origin + liveLinkPath(id), live: true };
}

function shareFailureText(err) {
  const why = err && err.reason ? err.reason : (err && err.retryAfterMs ? 'too many requests, wait a moment' : 'the server could not be reached');
  return 'Could not make a live link: ' + why + '. Your plan is safe on this device.';
}

// Safari only allows clipboard writes inside the click itself, so the
// pending link goes in as a ClipboardItem promise; writeText covers the rest.
function copyShareLink(linkPromise) {
  if (!navigator.clipboard) return Promise.reject(new Error('no clipboard'));
  const writeText = () => linkPromise.then(link => navigator.clipboard.writeText(link.url));
  if (!window.ClipboardItem || !navigator.clipboard.write) return writeText();
  const item = new ClipboardItem({ 'text/plain': linkPromise.then(link => new Blob([link.url], { type: 'text/plain' })) });
  return navigator.clipboard.write([item]).catch(writeText);
}

async function loadFromShortLink() {
  const id = SHORT_LINK_AT_LOAD;
  if (!id) return false;
  try {
    showToast('Opening shared plan...');
    let remote;
    try { remote = await fetchLiveLink(id); } catch {
      showToast('Could not reach the server to open that share link');
      return false;
    }

    // This browser already owns a plan on that link: reopen it quietly (it is
    // saved on this device, so nothing is replaced) and catch up.
    const bound = LiveLinks.findById(linkStorage(), id);
    let saved = null;
    try { saved = bound && PlanStore.read(localStorage).find(p => LiveLinks.planKey(p.data) === bound.planKey); } catch {}
    if (!remote && !saved) { showToast('That share link has expired or does not exist (links last 30 days after the last change)'); return false; }
    if (saved) {
      if (LiveLinks.planKey(State) !== bound.planKey && PlanStore.restore(saved.data)) ChangeLog.clear();
      if (!remote) {
        // The server forgot the link, but this browser's copy is still here: give it a new link.
        commit();
        LiveSync.replaceExpiredLink(id);
        showToast(`Opened live plan "${State.rosterName}" (its link had expired, making a new one)`);
        return true;
      }
      const entry = LiveLinks.get(linkStorage(), bound.planKey);
      const caughtUp = LiveLinks.shouldApply(entry, remote, false) && remote.code !== currentShareCode()
        && trackLiveUpdate(() => applyRemoteLiveCode(id, remote)).result;
      if (!caughtUp) commit();
      showToast(`Opened live plan "${State.rosterName}"`);
      return true;
    }

    if (!await applyShareCode(remote.code)) return false;
    const planKey = LiveLinks.planKey(State);
    if (planKey) bindLiveLink(planKey, id, currentShareCode(), remote.updatedAt);
    SharedPlanBanner.show(id);
    return true;
  } finally {
    LiveSync.opening = false;
    syncAddressBar();
    LiveSync.refreshStatus();
  }
}

// The save line under the plan (#autosave-status): while a guild raid plan is open in database mode it tells where the raid's copy stands
// (PlanDb), otherwise the live link's state, otherwise "Saved on this device". `failed` = a save to the raid is not going through.
function saveStatusLine() {
  const live = LiveSync.statusText('Saved on this device');
  if (typeof PlanDb === 'undefined' || !PlanDb.active()) return { text: live, failed: false };
  const lost = RaidContext.current && RaidContext.current.lost;
  const key = lost || PlanDb.statusKey();
  return { text: lost ? PLAN_STATUS_TEXT[lost] : PlanDb.statusText(live), failed: !!key && key !== 'saved' && key !== 'saving' };
}

// Writes the save line into #autosave-status. A failed save to the raid flags it like a failed device save (the next-step bar shows
// it); data-raid says it is the raid's failure, which a later device save does not clear.
function applySaveLine(status) {
  const line = saveStatusLine();
  status.textContent = line.text;
  if (line.failed) { status.dataset.failed = 'true'; status.dataset.raid = 'true'; }
  else { delete status.dataset.failed; delete status.dataset.raid; }
}

// ── GUILD RAID CONTEXT ──────────────────────────────────────────
// "Plan in Planner" on a raid of the guild tracker opens the planner at #/planner?raid=<gid>.<rid> (the shell, js/guild/app.js,
// hands that address to route(); it survives a reload). The raid's plan is the plan 'raid:<rid>' (RaidLink) and lives in the guild's
// database: opening reads it (GET plan-doc, next to the sign-ups), PlanDb saves every change to it and PlanPoll picks up the other
// officers' changes (js/plansync.js). A raid with no plan there yet migrates the first plan found, in this order: this browser's
// copy of the raid plan, this browser's copy of the event's plan, the live link the raid page holds, the names the raid page holds,
// the sign-ups alone. The sign-ups are then folded in by the Raid-Helper re-sync (RaidHelperSync.apply), the guild's sign-ups
// standing in for the event. When the database cannot be reached the plan opens from this device's copy and stays on this device.
// Leaving the raid (Back to raid, the Planner link, any other address) flushes what is waiting and stops saving and polling; the
// plan stays open as a plan of this browser. An open plan that is not this raid's is set aside as an import does it: it is saved on
// this device (Your plans) before the raid's plan replaces it on screen.
const RaidContext = {
  current: null,  // { gid, rid, planId, seed, seedJson, loaded, db, rev, userEdited, settledJson, applying, lost, status, failed, opening } while a raid is open
  token: 0,       // the newest open wins
  dbOwner: null,  // the open raid PlanDb and PlanPoll are running for
  flushing: null, // the saver of a raid just left, still sending what was waiting

  api() { return window.Guild && window.Guild.api ? window.Guild.api : null; },
  basePath(c) { return '/api/guild/' + encodeURIComponent(c.gid) + '/raids/' + encodeURIComponent(c.rid); },
  errorText(err) {
    if (err && err.status === 401) return 'Sign in to Raidsmith, then open the raid again.';
    const api = this.api();
    return api && api.classify ? api.classify(err).text : 'Something went wrong. Try again in a moment.';
  },
  // True while the plan on screen is a raid plan that saves to the guild's database.
  inDatabase() {
    const c = this.current;
    return !!c && c.loaded && c.db && State.planId === c.planId;
  },

  // The shell hands over every address: a planner address with a raid opens it, anything else leaves it.
  route(hash) {
    const guild = window.Guild;
    const route = guild && guild.router ? guild.router.parse(String(hash || '')) : null;
    if (!route || route.name !== 'planner' || !route.gid || !route.rid) { this.leave(); return null; }
    const c = this.current;
    if (c && c.gid === route.gid && c.rid === route.rid) return c.opening;
    return this.open(route.gid, route.rid);
  },

  open(gid, rid) {
    const token = ++this.token;
    const api = this.api();
    const c = { gid, rid, planId: RaidLink.planId(rid), seed: null, seedJson: '', loaded: false, db: false, rev: 0, userEdited: false, settledJson: '', applying: false, lost: null, status: '', failed: false, opening: null };
    const previous = this.current;
    if (previous) this.flushing = this.releaseDb(previous);
    this.current = c;
    this.render();
    let fetched;
    if (api && c.planId) {
      // The sign-ups and the raid's database plan are asked together (after a raid just left has sent its last save, so the plan
      // read is not older than what this browser wrote); the plan failing only keeps this page off the database.
      fetched = (this.flushing || Promise.resolve()).then(() => {
        // plansync.js (PlanDb, PlanPoll, PlanDbLinks) is optional: without it the raid opens from this device and the database is never asked.
        const saver = typeof PlanDb !== 'undefined' && typeof PlanPoll !== 'undefined' && typeof PlanDbLinks !== 'undefined';
        const docGet = (saver ? api.get(this.basePath(c) + '/plan-doc') : Promise.reject(new Error('plan saving is not loaded'))).then(doc => ({ doc }), err => ({ err }));
        return Promise.all([api.get(this.basePath(c) + '/planner'), docGet]);
      });
    } else fetched = Promise.reject(new Error('guild tools missing'));
    c.opening = fetched.then(([seed, docResult]) => (token === this.token ? this.apply(c, seed, docResult, token) : false), err => {
      if (token !== this.token) return false;
      this.current = null;
      Fairness.clear();
      this.render();
      showToast(this.errorText(err));
      return false;
    });
    return c.opening;
  },

  leave() {
    this.token++;
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.flushing = this.releaseDb(c);
    Fairness.clear(); // the raid's sit-out history ends with the raid context
    this.render();
  },

  // Leaves for a change that rebuilds the plan (a version switch): resolves once the raid holds what was on screen.
  async detach() {
    if (!this.current) return;
    this.leave();
    await this.flushing;
  },

  // Ends database mode for a raid being left: the poll stops at once, the saver after it has sent what was waiting (`flush: false` =
  // the plan on screen is no longer this raid's, so there is nothing to send; unsent edits stay marked for the next open).
  releaseDb(c, { flush = true } = {}) {
    if (!c || !c.db) return Promise.resolve(false);
    c.db = false;
    if (typeof PlanPoll !== 'undefined') PlanPoll.stop();
    if (typeof PlanDb === 'undefined' || this.dbOwner !== c) return Promise.resolve(false);
    const finish = () => { if (this.dbOwner === c) { PlanDb.stop(); this.dbOwner = null; } };
    if (!flush) { finish(); return Promise.resolve(false); }
    return PlanDb.settle().then(saved => { finish(); return saved; }, () => { finish(); return false; });
  },

  async apply(c, seed, docResult, token) {
    if (!seed || !seed.raid) { this.current = null; Fairness.clear(); this.render(); showToast('That raid could not be opened.'); return false; }
    c.seed = seed;
    c.seedJson = RaidLink.seedToRaidHelper(seed);
    Fairness.load(seed); // before the plan is built: the bench choice reads it
    // A /<version>/<id> link being opened at page load owns the plan on screen until it is done.
    for (let i = 0; i < 100 && LiveSync.opening; i++) await new Promise(resolve => setTimeout(resolve, 100));
    await this.flushing; // a raid just left sends its last changes before this plan replaces it on screen
    if (token !== this.token) return false;
    let version = Object.prototype.hasOwnProperty.call(GameVersions, seed.raid.gameVersion) ? seed.raid.gameVersion : State.gameVersion;
    let { doc, caveat } = this.readDoc(c, docResult);
    if (doc && doc.rev > 0) version = doc.plan.gameVersion || version;
    LiveSync.flush();
    PlanStore.flush();
    const found = this.findLocal(c, seed.raid, version);
    // This browser saved the plan to the raid before, yet the raid holds none now: the raid page replaced or removed it (migrate()).
    const binding = typeof PlanDbLinks !== 'undefined' ? PlanDbLinks.get(linkStorage(), version + '|' + c.planId) : null;
    found.replaced = !!doc && doc.rev === 0 && !!binding && binding.rev > 0;
    // No plan in the database yet and nothing on this device to start from: the live link the raid page holds is the next source.
    let live = null;
    if (doc && doc.rev === 0 && (found.replaced || (!found.local && !found.event))) {
      const id = [doc.live, seed.livePlan].find(x => typeof x === 'string' && LiveLinks.ID.test(x));
      if (id) {
        try { live = await fetchLiveLink(id); } catch {
          // It cannot be told what the raid's saved plan holds, so nothing may be written over it: stay on this device.
          doc = null;
          caveat = " The plan saved on the raid could not be reached, so this is the copy on this device and it is not saved to the raid.";
        }
      }
    }
    if (token !== this.token) return false;
    c.status = this.load(c, seed, version, doc, live, found, caveat);
    c.settledJson = JSON.stringify(PlanStore.capture());
    c.loaded = true;
    this.render();
    LiveSync.refreshStatus();
    showView('app');
    return true;
  },

  // The raid's database plan as GET plan-doc answered it ({rev, plan, updatedBy, legacy, live}), or doc null with a sentence for the
  // banner when this page cannot work with it (unreachable, no right to edit, a plan it cannot read): the plan then stays on this device.
  readDoc(c, docResult) {
    const body = docResult && docResult.doc;
    if (!body) {
      const status = docResult && docResult.err && docResult.err.status;
      return { doc: null, caveat: status === 403
        ? ' You cannot edit this raid, so changes stay on this device.'
        : " The raid's saved plan could not be reached, so this is the copy on this device and it is not saved to the raid." };
    }
    const readable = Number.isInteger(body.rev) && body.rev >= 0 &&
      (body.rev === 0 || (PlanStore.valid(body.plan) && body.plan.planId === c.planId && !(Number(body.schemaVersion) > PlanStore.schemaVersion)));
    if (!readable) return { doc: null, caveat: " The plan saved on the raid was written by a newer Planner (reload this page), so this is the copy on this device and it is not saved to the raid." };
    return { doc: body, caveat: '' };
  },

  // What this browser holds for the raid: {local: its copy of the raid plan (on screen, else saved), event: its copy of the event's plan}.
  // Each is {data, onScreen} or null.
  findLocal(c, raid, version) {
    const copyOf = planId => {
      const planKey = version + '|' + planId;
      if (State.planId === planId && State.gameVersion === version) return { data: PlanStore.capture(), onScreen: true };
      try {
        const saved = PlanStore.read(localStorage).find(p => LiveLinks.planKey(p.data) === planKey);
        return saved ? { data: saved.data, onScreen: false } : null;
      } catch { return null; }
    };
    return { local: copyOf(c.planId), event: raid.eventId ? copyOf('event:' + raid.eventId) : null };
  },

  // Puts the raid's plan on screen, starts saving it when the database holds (or is about to hold) it, and returns the banner's status line.
  load(c, seed, version, doc, live, found, caveat) {
    if (!doc) return this.loadLocal(c, seed, version, found.local, caveat);
    if (doc.rev > 0) return this.loadFromDatabase(c, seed, doc, found.local);
    return this.migrate(c, seed, version, doc, live, found);
  },

  // The database cannot be used: this device's copy, else the sign-ups. Edits made here mark the raid binding unsent, so the next open
  // pushes them instead of replacing them.
  loadLocal(c, seed, version, local, caveat) {
    if (local) {
      if (!local.onScreen) PlanStore.restore(local.data);
      this.adopt(c, seed.raid);
      RaidHelperSync.apply(Import.diffRaidHelperSignUps(c.seedJson), 'Synced with the raid');
      return 'Opened your plan for this raid, with the latest sign-ups.' + caveat;
    }
    return this.fromSignUps(c, seed, version) + caveat;
  },

  // The plan the database holds. PlanDbLinks.decide says what to do with this browser's copy.
  loadFromDatabase(c, seed, doc, local) {
    if (typeof PlanDbLinks === 'undefined') return this.loadLocal(c, seed, doc.plan.gameVersion || State.gameVersion, local, '');
    const planKey = LiveLinks.planKey(doc.plan);
    const binding = PlanDbLinks.get(linkStorage(), planKey);
    const localDiffers = !!local && JSON.stringify(local.data) !== JSON.stringify(doc.plan);
    let decision = PlanDbLinks.decide({ binding, remoteRev: doc.rev, localDiffers });
    if (!local && (decision === 'push-local' || decision === 'use-db-with-undo')) decision = 'use-db';
    const editor = doc.updatedBy && doc.updatedBy.name ? doc.updatedBy.name : '';
    let before = null;
    let entry = null;
    let status;
    if (decision === 'push-local') {
      if (!local.onScreen) PlanStore.restore(local.data);
      this.adopt(c, seed.raid);
      status = 'Opened your plan for this raid. Your unsent changes are going to the raid.';
    } else {
      if (decision === 'use-db-save-copy') this.setAside(local);
      if (decision === 'use-db-with-undo') {
        if (!local.onScreen) PlanStore.restore(local.data);
        before = PlanStore.capture();
        ({ entry } = ChangeLog.track('remote', editor ? `Update by ${editor}` : 'Raid plan update', () => PlanStore.restore(doc.plan), { moves: true }));
      } else {
        PlanStore.restore(doc.plan);
        if (!(local && local.onScreen)) ChangeLog.clear();
      }
      this.adopt(c, seed.raid);
      status = editor ? `Opened the raid's plan, last saved by ${editor}.` : "Opened the raid's plan.";
    }
    initGroups();
    commit(); // the plan as the page normalises it is what the saver compares against: folding in sign-ups that change nothing writes nothing
    this.startDb(c, { rev: doc.rev, dirty: decision === 'push-local' });
    RaidHelperSync.apply(Import.diffRaidHelperSignUps(c.seedJson), 'Synced with the raid');
    if (before) RemoteUpdate.show(before, entry, editor);
    return status;
  },

  // The raid has no plan in the database yet (rev 0): the first source that has one becomes it (plan section 6).
  migrate(c, seed, version, doc, live, found) {
    const raid = seed.raid;
    const planKey = version + '|' + c.planId;
    let { local, event } = found;
    // What the raid holds now wins over this device's copy, which is set aside.
    if (found.replaced) {
      this.setAside(local);
      try { if (typeof PlanDbLinks !== 'undefined') PlanDbLinks.forget(linkStorage(), planKey); } catch {}
      local = null; event = null;
    }
    let source = 'signups';
    let status = '';
    let lead = 'Synced with the raid';
    let fold = true;
    if (local) {
      if (!local.onScreen) PlanStore.restore(local.data);
      this.adopt(c, raid);
      source = 'local';
      status = 'Opened your plan for this raid, with the latest sign-ups.';
    } else if (event && PlanStore.valid(event.data)) {
      const data = JSON.parse(JSON.stringify(event.data));
      data.planId = c.planId; // the event's plan, re-keyed to the raid; the event's own copy stays on this device
      PlanStore.restore(data);
      ChangeLog.clear();
      this.adopt(c, raid);
      source = 'local';
      status = "Opened your plan for this raid's Raid-Helper event, with the latest sign-ups.";
    } else if (live && this.fromLiveLink(c, raid, live)) {
      source = 'live';
      lead = 'Opened the plan saved on the raid';
      status = 'Opened the plan saved on the raid.';
    } else {
      const names = doc.legacy && Array.isArray(doc.legacy.players) ? doc.legacy.players : [];
      let seated = null;
      status = this.fromSignUps(c, seed, version, names.length ? () => { seated = this.seatLegacy(names); } : null);
      fold = false;
      if (seated) {
        source = 'legacy';
        status = `Opened the plan saved on the raid: ${seated.seated} ${seated.seated === 1 ? 'name' : 'names'} back in their groups.` +
          (seated.added ? ` ${seated.added} ${seated.added === 1 ? 'name is' : 'names are'} not among the sign-ups and ${seated.added === 1 ? 'waits' : 'wait'} on the bench: pick ${seated.added === 1 ? 'its' : 'their'} class, then seat them.` : '');
      }
    }
    if (fold) { initGroups(); commit(); }
    // A real source is written to the raid at once; a plan made of the sign-ups alone waits for the first real edit.
    this.startDb(c, { rev: 0, dirty: source !== 'signups', source });
    if (fold) RaidHelperSync.apply(Import.diffRaidHelperSignUps(c.seedJson), lead);
    return status;
  },

  // The plan the live link holds, opened as this raid's plan. False when it cannot be read (the next source is tried).
  fromLiveLink(c, raid, live) {
    const str = Import.decodeSharePayload(live.code);
    if (!str || !Import.previewShareString(str).success) return false;
    const previous = PlanStore.capture();
    PlanStore.startFresh();
    if (!Import.importAddonString(str).success) { PlanStore.restore(previous); return false; }
    this.adopt(c, raid);
    ChangeLog.clear();
    return true;
  },

  // Nothing saved: start from the sign-ups, as a Raid-Helper import does (the plan it replaces was saved above). `seat` runs once the
  // players are in, before the groups are fitted. Returns the banner's status line.
  fromSignUps(c, seed, version, seat) {
    const raid = seed.raid;
    PlanStore.startFresh();
    if (State.gameVersion !== version) {
      State.gameVersion = version;
      State.selectedRaid = GameVersions[version].defaultRaid;
      State.buffOverrides = {};
    }
    State.rosterName = RaidLink.planLabel(raid);
    // The raid's own size (or zone) picks the raid template; only a seed that names neither lets the sign-up count size it.
    const raidKey = RaidLink.raidKeyFor(raid, version);
    if (raidKey) State.selectedRaid = raidKey;
    const result = Import.importRaidHelper(c.seedJson, { fixedRaid: !!raidKey });
    this.adopt(c, raid);
    RaidHelperSync.hideBanner();
    ChangeLog.clear();
    if (seat) seat();
    initGroups();
    commit();
    return result.success ? `Started from the raid's ${result.playerCount + result.benchCount + result.unplacedCount} sign-ups.` : 'The raid has no sign-ups yet. Add players here, or import them on the raid page and open it again.';
  },

  // The names the raid page holds (group 0 = the bench) go back into their groups. A name that is not among the sign-ups is added as a
  // player with no class (the unplaced path of a classless Raid-Helper sign-up: it waits in the tray and the seating dialog asks for the class),
  // so no saved name is lost. A name whose group is full stays where the sign-ups put it. Returns {seated, added}.
  seatLegacy(entries) {
    const key = name => String(name || '').trim().toLowerCase();
    let seated = 0;
    let added = 0;
    for (const entry of entries) {
      const wanted = key(entry && entry.name);
      const from = State.groups.findIndex(g => g.some(p => key(p.name) === wanted));
      const list = from >= 0 ? State.groups[from] : State.bench;
      const at = list.findIndex(p => key(p.name) === wanted);
      if (at < 0) { // absent sign-ups stay absent; a name nobody signed up with is added without a class
        if (wanted && !State.unplaced.some(p => key(p.name) === wanted)) {
          State.unplaced.push(Import._makeUnplaced({ name: String(entry.name).trim(), status: 'confirmed', class: null, spec: null, role: null }));
          added++;
        }
        continue;
      }
      const group = Number(entry.group);
      const target = group >= 1 ? State.groups[group - 1] : group === 0 ? State.bench : null;
      if (!target || (target !== list && group >= 1 && target.length >= 5)) continue;
      if (target !== list) {
        const [player] = list.splice(at, 1);
        player.groupNumber = group;
        target.push(player);
      }
      seated++;
    }
    State.roster = State.groups.flat();
    return { seated, added };
  },

  // This device's copy of a raid plan the database replaced goes to Your plans under an id of its own, so nothing is lost.
  setAside(local) {
    if (!local || !PlanStore.valid(local.data)) return;
    const holds = [...local.data.groups.flat(), ...local.data.bench].length > 0;
    if (!holds) return;
    const copy = JSON.parse(JSON.stringify(local.data));
    copy.planId = 'plan:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    copy.rosterName = String(copy.rosterName || 'Raid plan') + ' (earlier copy)';
    try {
      PlanStore.save(linkStorage(), copy);
      showToast("Your earlier copy of this raid's plan is saved in Your plans.");
    } catch {}
  },

  // What makes the plan on screen this raid's plan: its id, the event it follows and its start (none for a raid that has
  // a date but no start time: its startsAt is a placeholder noon UTC).
  adopt(c, raid) {
    State.planId = c.planId;
    State.sourceEventId = raid.eventId || null;
    State.eventStartTime = raid.timeKnown === false ? null : PlanStore.cleanEventStart(raid.startsAt);
  },

  // ── database mode ──
  // Saving and polling for the plan on screen, which is the database's (or about to be: rev 0).
  startDb(c, { rev, dirty = false, source = null }) {
    if (typeof PlanDb === 'undefined' || typeof PlanPoll === 'undefined') return;
    const planKey = LiveLinks.planKey(State);
    // An old live link of this raid plan must not pull its copy over the database's plan.
    try { LiveLinks.drop(linkStorage(), planKey); } catch {}
    c.db = true;
    c.rev = rev;
    this.dbOwner = c;
    PlanDb.start({
      gid: c.gid, rid: c.rid, rev, planKey, dirty, source,
      onConflict: remote => this.onDbConflict(c, remote),
      onPermanent: failure => this.onDbPermanent(c, failure),
      onSaved: saved => this.onDbSaved(c, saved),
      onStatus: () => this.onDbStatus(c),
    });
    PlanPoll.start({ gid: c.gid, rid: c.rid, rev, onPlan: remote => this.onDbPoll(c, remote), onFailure: failure => this.onDbPermanent(c, failure) });
  },

  // Puts another officer's plan on screen (newest plan wins, whole plan). Returns false when it cannot be applied. `silent`: nothing to
  // offer Undo for (the plan on screen was never edited here), so no notice and no Changes entry.
  applyRemote(c, remote, { silent = false } = {}) {
    const plan = remote && remote.plan;
    if (State.planId !== c.planId || !plan || plan.planId !== c.planId || !PlanStore.valid(plan) || Number(remote.schemaVersion) > PlanStore.schemaVersion) return false;
    const before = PlanStore.capture();
    const editor = remote.updatedBy && remote.updatedBy.name ? remote.updatedBy.name : '';
    const swap = () => {
      PlanStore.restore(plan);
      closePlayerEditor(); closeBuffPicker();
      initGroups(); commit(); renderLastRun(null);
      return true;
    };
    c.applying = true;
    let entry = null;
    try {
      if (silent) swap();
      else ({ entry } = ChangeLog.track('remote', editor ? `Update by ${editor}` : 'Raid plan update', swap, { moves: true }));
    } finally { c.applying = false; }
    const after = PlanStore.capture();
    if (silent) c.settledJson = JSON.stringify(after);
    else if (JSON.stringify(before) !== JSON.stringify(after)) RemoteUpdate.show(before, entry, editor);
    return true;
  },

  // PlanDb: a save found a newer revision (409). Returning true tells it the plan on screen is now that revision.
  onDbConflict(c, remote) {
    if (this.dbOwner !== c) return false;
    const applied = this.applyRemote(c, remote, { silent: !c.userEdited });
    if (applied) { c.rev = remote.rev; if (typeof PlanPoll !== 'undefined') PlanPoll.setRev(remote.rev); }
    return applied;
  },

  // PlanPoll: a newer revision exists.
  onDbPoll(c, remote) {
    if (this.dbOwner !== c || this.current !== c) return false;
    if (!this.applyRemote(c, remote)) return false;
    c.rev = remote.rev;
    if (typeof PlanDb !== 'undefined') PlanDb.adopt(remote.rev);
    return true;
  },

  onDbSaved(c, saved) {
    if (this.dbOwner !== c) return;
    c.rev = saved.rev;
    if (typeof PlanPoll !== 'undefined') PlanPoll.setRev(saved.rev);
    if (this.current === c && !saved.adopted) this.setStatus(`Saved to the raid at ${this.timeText(c)}`, false);
    LiveSync.refreshStatus();
  },

  // The state of the saver changed: a failure shows in the banner, the save line and the next-step bar; recovery is reported by onDbSaved.
  onDbStatus(c) {
    if (this.dbOwner !== c || typeof PlanDb === 'undefined') return;
    const key = PlanDb.statusKey();
    if (this.current === c && key && key !== 'saving') {
      if (key === 'saved') { if (c.failed) this.setStatus('Saved to the raid', false); }
      else this.setStatus(PlanDb.statusText(''), true);
    }
    LiveSync.refreshStatus();
  },

  // The raid refused for good (a retry cannot fix it). Losing the right to edit or the raid itself offers to keep the plan as the user's own.
  onDbPermanent(c, failure) {
    if (this.dbOwner !== c || this.current !== c) return;
    const kind = failure && failure.kind;
    if (kind === 'forbidden' || kind === 'gone') c.lost = kind;
    this.setStatus(PLAN_STATUS_TEXT[kind] || 'The plan could not be saved to the raid.', true);
    LiveSync.refreshStatus();
  },

  timeText(c) {
    // The time is the guild's ("11:14 AM ET"), the same clock and label the raid page shows: the guild's zone, else the one the raid's
    // sign-ups came with. Without either (guild tools missing) it is the browser's clock, with no label.
    const guild = window.Guild;
    const gdata = guild && guild.app && guild.app.state && guild.app.state.guilds ? guild.app.state.guilds[c.gid] : null;
    const zone = (gdata && gdata.guild && gdata.guild.timeZone) || (c.seed && c.seed.raid && c.seed.raid.timeZone) || '';
    const labelled = zone && guild && guild.ui && guild.ui.timeInZone ? guild.ui.timeInZone(Date.now(), zone) : '';
    return labelled || new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  },

  // Stops saving and polling for good and forgets the raid binding (the plan becomes this browser's own).
  stopDb(c) {
    const planKey = LiveLinks.planKey(State);
    c.db = false;
    c.lost = null;
    if (this.dbOwner === c) {
      if (typeof PlanPoll !== 'undefined') PlanPoll.stop();
      if (typeof PlanDb !== 'undefined') PlanDb.stop();
      this.dbOwner = null;
    }
    try { if (typeof PlanDbLinks !== 'undefined') PlanDbLinks.forget(linkStorage(), planKey); } catch {}
  },

  // "Keep as my own copy": the plan on screen becomes a plan of this browser, as SharedPlanBanner.makeCopy does it.
  keepCopy() {
    const c = this.current;
    if (!c || !c.loaded || State.planId !== c.planId) return;
    const raidKey = LiveLinks.planKey(State);
    this.stopDb(c);
    PlanStore.flush();
    State.planId = 'plan:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    State.rosterName = State.rosterName + ' (my copy)';
    commit(); // the plan left the raid: onCommit ends the context
    // The raid's own saved entry and binding go: the copy is the only plan left.
    try {
      PlanStore.remove(linkStorage(), raidKey);
      LiveLinks.drop(linkStorage(), raidKey);
      if (typeof PlanDbLinks !== 'undefined') PlanDbLinks.forget(linkStorage(), raidKey);
    } catch {}
    syncAddressBar();
    // A reload must not reopen the raid: plain #/planner, replaced in place (no hashchange, no second route render).
    history.replaceState(null, '', window.location.pathname + window.location.search + '#/planner');
    showToast('Saved your own copy. Changes now stay in this browser.');
  },

  // "Remove": the raid is gone, so this device's copy of its plan goes too.
  removeCopy() {
    const c = this.current;
    if (!c || !c.loaded || State.planId !== c.planId) return;
    const planKey = LiveLinks.planKey(State);
    this.stopDb(c);
    try { PlanStore.remove(linkStorage(), planKey); LiveLinks.drop(linkStorage(), planKey); } catch {}
    PlanStore.startFresh();
    State.planId = null;
    ChangeLog.clear();
    initGroups();
    syncAddressBar();
    renderLastRun(null);
    this.leave();
    window.location.hash = '#/planner';
    showView('landing');
    showToast('Removed this raid plan from this device.');
  },

  // A commit that left the raid's plan (another plan opened, an import) ends the raid context. Otherwise: the first edit made here
  // is what separates "opened" from "edited" (a conflict while merely open adopts the other plan silently), edits wake the poll, and
  // while the database is out of reach they mark the raid binding unsent.
  onCommit() {
    const c = this.current;
    if (!c || !c.loaded) return;
    if (State.planId !== c.planId) { this.releaseDb(c, { flush: false }); this.leave(); return; }
    if (c.applying || c.userEdited) { if (c.db && !c.applying && typeof PlanPoll !== 'undefined') PlanPoll.wake(); return; }
    if (JSON.stringify(PlanStore.capture()) === c.settledJson) return;
    c.userEdited = true;
    if (c.db) { if (typeof PlanPoll !== 'undefined') PlanPoll.wake(); return; }
    try { if (typeof PlanDbLinks !== 'undefined') PlanDbLinks.markDirty(linkStorage(), LiveLinks.planKey(State)); } catch {}
  },

  // persistWorkingPlan: the plan changed. A raid plan edited outside its raid context (Back to raid, then the plain Planner) is saved on this
  // device only, so its binding is marked unsent: the next open pushes it, or offers it as Undo, instead of replacing it silently.
  noteLocalEdit() {
    if (this.current || !RaidLink.isRaidPlan(State.planId)) return;
    try { if (typeof PlanDbLinks !== 'undefined') PlanDbLinks.markDirty(linkStorage(), LiveLinks.planKey(State)); } catch {}
  },

  // Refresh in the planner reads the raid's sign-ups from the guild (what Plan in Planner or Refresh sign-ups imported last).
  async fetchDiff(report) {
    const c = this.current;
    const api = this.api();
    if (!c || !c.loaded || c.planId !== State.planId || !api) {
      report('This plan belongs to a guild raid. Use Plan in Planner on the raid page to bring in its sign-ups.', true);
      return null;
    }
    let seed;
    try { seed = await api.get(this.basePath(c) + '/planner'); } catch (err) { report('Refresh failed: ' + this.errorText(err), true); return null; }
    if (this.current !== c || State.planId !== c.planId) return null;
    c.seed = seed;
    c.seedJson = RaidLink.seedToRaidHelper(seed);
    Fairness.load(seed);
    const diff = Import.diffRaidHelperSignUps(c.seedJson);
    if (!diff.success) { report('Refresh failed: ' + diff.error, true); return null; }
    return diff;
  },

  // Back to raid: the raid page of the guild tracker; the plan stays open here.
  back() {
    const c = this.current;
    if (!c) return;
    const guild = window.Guild;
    const hash = guild && guild.router ? guild.router.format({ name: 'raid', gid: c.gid, rid: c.rid }) : '';
    this.leave();
    if (hash) window.location.hash = hash;
  },

  setStatus(text, failed) {
    const c = this.current;
    if (!c) return;
    c.status = text;
    c.failed = !!failed;
    this.render();
  },

  render() {
    const banner = document.getElementById('raid-context-banner');
    if (!banner) return;
    const c = this.current;
    banner.hidden = !c || !c.loaded;
    const lost = document.getElementById('raid-lost-banner');
    if (lost) lost.hidden = !c || !c.loaded || !c.lost;
    if (!c) return;
    const text = document.getElementById('raid-context-text');
    const status = document.getElementById('raid-context-status');
    if (text) text.textContent = RaidLink.bannerText(c.seed && c.seed.raid);
    if (status) { status.textContent = c.status; status.classList.toggle('error', c.failed); }
    const lostText = document.getElementById('raid-lost-text');
    if (lostText) lostText.textContent = c.lost === 'gone' ? 'This raid no longer exists. Your changes are safe on this device.' : 'You can no longer edit this raid. Your changes are safe on this device.';
    const remove = document.getElementById('btn-raid-remove');
    if (remove) remove.hidden = c.lost !== 'gone';
  },

  wire() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btn-raid-back', () => this.back());
    on('btn-raid-copy', () => this.keepCopy());
    on('btn-raid-remove', () => this.removeCopy());
  },
};
RaidContext.wire();

async function applyShareCode(code) {
  const str = Import.decodeSharePayload(code);
  if (!str) { showToast('That share link is invalid or damaged'); return false; }

  const preview = Import.previewShareString(str);
  if (!preview.success) { showToast(preview.error || 'That share link is invalid or damaged'); return false; }

  const hasWork = hasLoadedWork();
  if (hasWork && !await Modal.confirm({
    title: 'Open shared plan?',
    message: `"${preview.name}" opens as a new plan. Your current plan stays in Your plans.`,
    confirmLabel: 'Open shared plan',
  })) return false;

  LiveSync.flush();
  const res = Import.importAddonString(str);
  if (!res.success) { showToast(res.error || 'That share link is invalid or damaged'); return false; }

  ChangeLog.clear();
  commit();
  showToast(`Loaded shared plan "${State.rosterName}" (${res.playerCount} players)${rememberImport('Shared link')}`);
  return true;
}

document.getElementById('btn-share').addEventListener('click', () => {
  if (!hasLoadedWork()) {
    showToast('No roster to share');
    return;
  }
  const link = getShareLink();
  Promise.all([link, copyShareLink(link)])
    .then(() => showToast('Live link copied. Anyone with it can see and edit this plan; it expires 30 days after the last change.'))
    .catch(() => link.then(({ url }) => showManualCopy(url), err => showToast(shareFailureText(err))));
});

document.getElementById('btn-copy-mrt').addEventListener('click', () => {
  if (State.roster.length === 0) { showToast('No roster to export'); return; }
  const str = Import.exportMrtString();
  copyText(str, 'MRT string copied (seated groups only). In MRT: Raid Groups > Import > "From ExRT export string"');
});

document.getElementById('btn-copy-mrt-note').addEventListener('click', copyMrtNote);

document.getElementById('btn-export-json').addEventListener('click', () => {
  if (!hasLoadedWork()) { showToast('No roster to export'); return; }
  const data = Import.exportRoster(State.rosterName);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (State.rosterName || 'roster') + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported JSON file');
});

// ── DATA BACKUP: export / import UI (feature-backlog-3.md #3) ─────
document.getElementById('btn-export-backup').addEventListener('click', () => {
  PlanStore.flush();
  const backup = DataBackup.build(localStorage);
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `raidsmith-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  BackupStamp.record(localStorage);
  showToast('Backup downloaded');
});

const BackupRestoreUI = {
  pending: null,
  mode: 'merge',
  open(obj) {
    this.pending = obj;
    this.mode = 'merge';
    this.render();
    document.getElementById('backup-restore-dialog').showModal();
  },
  render() {
    const body = document.getElementById('backup-restore-body');
    if (!this.pending) { body.innerHTML = ''; return; }
    const planned = DataBackup.plan(localStorage, this.pending, this.mode);
    if (!planned.valid) {
      body.innerHTML = `<p>${planned.errors.map(esc).join('<br>')}</p>
        <div class="import-buttons"><button type="button" class="btn btn-secondary" id="btn-backup-cancel">Close</button></div>`;
      document.getElementById('btn-backup-cancel').onclick = () => document.getElementById('backup-restore-dialog').close();
      return;
    }
    const rows = Object.keys(planned.changes).map(key => {
      const c = planned.changes[key];
      const parts = [];
      if (c.added) parts.push(`${c.added} added`);
      if (c.updated) parts.push(`${c.updated} updated`);
      if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
      return `<li><strong>${esc(c.label)}</strong>${parts.length ? ': ' + esc(parts.join(', ')) : ' — no change'}</li>`;
    }).join('');
    body.innerHTML = `
      <p>${this.mode === 'replace'
        ? 'Replace overwrites matching data in this browser with the backup file.'
        : 'Merge adds anything missing and keeps whichever copy of a shared item is newer.'}</p>
      <ul class="backup-restore-summary">${rows}</ul>
      <div class="backup-restore-mode">
        <label><input type="radio" name="backup-mode" value="merge" ${this.mode === 'merge' ? 'checked' : ''}> Merge (recommended)</label>
        <label><input type="radio" name="backup-mode" value="replace" ${this.mode === 'replace' ? 'checked' : ''}> Replace</label>
      </div>
      <div class="import-buttons">
        <button type="button" class="btn btn-secondary" id="btn-backup-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="btn-backup-confirm">Apply</button>
      </div>`;
    body.querySelectorAll('input[name="backup-mode"]').forEach(r => r.addEventListener('change', e => { this.mode = e.target.value; this.render(); }));
    document.getElementById('btn-backup-cancel').onclick = () => document.getElementById('backup-restore-dialog').close();
    document.getElementById('btn-backup-confirm').onclick = () => {
      const result = DataBackup.apply(localStorage, this.pending, this.mode);
      document.getElementById('backup-restore-dialog').close();
      this.pending = null;
      if (!result.success) { showToast((result.errors && result.errors[0]) || 'Restore failed'); return; }
      showToast('Backup restored');
      if (State.view === 'landing') renderLanding();
    };
  },
};
document.getElementById('btn-close-backup-restore').addEventListener('click', () => document.getElementById('backup-restore-dialog').close());

document.getElementById('btn-import-backup').addEventListener('click', () => document.getElementById('backup-file-input').click());
// The landing link runs the same file picker and restore flow; the input lives outside #app so it works there.
document.getElementById('btn-landing-restore').addEventListener('click', () => document.getElementById('backup-file-input').click());
document.getElementById('backup-file-input').addEventListener('change', (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let obj;
    try { obj = JSON.parse(String(reader.result)); } catch { showToast('That file is not valid JSON'); return; }
    const check = DataBackup.validate(obj);
    if (!check.valid) { showToast(check.errors[0] || 'That backup file could not be read'); return; }
    BackupRestoreUI.open(obj);
  };
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
});

function showTipsAgain() {
  Spotlight.resetAll(localStorage);
  showToast('Feature tips will show again as you use the planner');
}
document.getElementById('btn-show-tips-again').addEventListener('click', showTipsAgain);

document.getElementById('btn-copy-json').addEventListener('click', () => {
  if (!hasLoadedWork()) { showToast('No roster to copy'); return; }
  const data = Import.exportRoster(State.rosterName);
  copyText(JSON.stringify(data, null, 2), 'JSON copied to clipboard');
});

document.getElementById('btn-copy-chat').addEventListener('click', () => {
  if (State.roster.length === 0) { showToast('No roster to export'); return; }
  copyText(Import.exportChatText({ compact: false }), 'Raid chat text copied to clipboard');
});

document.getElementById('btn-copy-chat-compact').addEventListener('click', () => {
  if (State.roster.length === 0) { showToast('No roster to export'); return; }
  copyText(Import.exportChatText({ compact: true }), 'Compact chat text copied — paste one line at a time into /raid chat');
});

// Backlog #12: renders PrintSheet.build()'s HTML into the body-level
// #print-sheet container (see its @media print CSS) and opens the browser
// print dialog. The screen view is never touched — #print-sheet stays
// display:none outside of print media.
document.getElementById('btn-print-sheet').addEventListener('click', () => {
  if (State.roster.length === 0) { showToast('No roster to print'); return; }
  const container = document.getElementById('print-sheet');
  if (!container) return;
  container.innerHTML = PrintSheet.build();
  window.print();
});

// ── IDEAL COMP MODULE ────────────────────────────────────────────
const IdealComp = {
  // 25-man: 1 tank, 5 healers, 19 DPS — optimized for buff synergies
  // 10-man: 2 tanks, 2 healers, 6 DPS
  generate(raidKey) {
    const raidInfo = Config.Raids[raidKey];
    if (!raidInfo || !GameVersions[State.gameVersion].modeled) return [];
    const comp = activeRules().idealComp;
    if (!comp) return [];
    // Dispatches on raid size ('build10Man'..'build40Man') so a ruleset only
    // needs to supply builders for the sizes it actually has raids at.
    const builder = comp['build' + raidInfo.size + 'Man'];
    return builder ? builder() : [];
  },

  makePlayer(cls, spec, role) {
    const specData = Object.values(Config.Specs[cls] || {}).find(s => s.name === spec);
    return {
      uid: nextUid(),
      name: spec + ' ' + cls.charAt(0) + cls.slice(1).toLowerCase(),
      class: cls,
      spec: spec,
      role: role || (specData ? specData.role : 'melee_dps'),
      imported: false,
    };
  },

  build25Man() {
    // Reference: classic TBC ideal 25-man comp
    // 1T + 5H + 19DPS (Ferals flex tank as needed)
    const groups = [
      // Group 1: Melee — LotP + WF + physical DPS
      [
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // LotP, flex tank
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('PALADIN', 'Retribution', 'melee_dps'),
        this.makePlayer('WARRIOR', 'Arms', 'melee_dps'),
        this.makePlayer('HUNTER', 'Beast Mastery', 'ranged_dps'), // FI + TSA
      ],
      // Group 2: Melee — LotP + WF + physical DPS
      [
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // LotP, flex tank
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
      ],
      // Group 3: Casters — Mana Tide + Shadow Weaving + healer support
      [
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),    // Mana Tide + WoA
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),     // Shadow Weaving
        this.makePlayer('PRIEST', 'Holy', 'healer'),
      ],
      // Group 4: Casters — ToW + Moonkin Aura + Warlock stack
      [
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),  // WoA + ToW
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),     // Moonkin Aura
      ],
      // Group 5: Healers + Tank
      [
        this.makePlayer('PALADIN', 'Holy', 'healer'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),    // Mana Tide
        this.makePlayer('DRUID', 'Restoration', 'healer'),
        this.makePlayer('PALADIN', 'Protection', 'tank'),
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
      ],
    ];

    for (let gi = 0; gi < groups.length; gi++) {
      for (const p of groups[gi]) p.groupNumber = gi + 1;
    }
    return groups;
  },

  build10Man() {
    // 2 tanks, 2 healers, 6 DPS
    const groups = [
      // Group 1: Tanks + Melee + Shaman
      [
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('DRUID', 'Feral', 'tank'),           // LotP
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),        // Devotion Aura
      ],
      // Group 2: Casters + Healer
      [
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),  // WoA + ToW
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('HUNTER', 'Beast Mastery', 'ranged_dps'), // FI
        this.makePlayer('PRIEST', 'Holy', 'healer'),
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) {
      for (const p of groups[gi]) p.groupNumber = gi + 1;
    }
    return groups;
  },

  // Classic Era 40-man/20-man reference comps (tasks/reference/research-classic-buffs.md
  // 40-man conventions + faction lock). Horde's Enhancement/Elemental/Resto
  // Shaman trio covers melee groups, caster groups AND the healer group —
  // Alliance has no caster-group equivalent (Paladins have no caster spec;
  // Concentration Aura is the only thing a caster group can get from one),
  // which is a real Classic Era Horde raid-buff advantage, not an omission.
  build40Man() {
    return Faction.current() === 'alliance' ? this.buildAlliance40Man() : this.buildHorde40Man();
  },
  build20Man() {
    return Faction.current() === 'alliance' ? this.buildAlliance20Man() : this.buildHorde20Man();
  },

  buildHorde40Man() {
    const groups = [
      [ // Melee A — WF/SoE Shaman, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // LotP
      ],
      [ // Melee B — WF/GoA Shaman, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Arms', 'melee_dps'),
        this.makePlayer('ROGUE', 'Assassination', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + GoA
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // LotP
      ],
      [ // Hunters — MM Trueshot, Elemental Shaman for Grace of Air
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'), // Trueshot Aura
        this.makePlayer('HUNTER', 'Beast Mastery', 'ranged_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
        this.makePlayer('ROGUE', 'Subtlety', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),   // Grace of Air + SoE
      ],
      [ // Casters A (mages) — Elemental Shaman for Mana Spring/Tranquil Air
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('MAGE', 'Frost', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),   // Mana Spring + Tranquil Air
      ],
      [ // Casters B (warlocks) — Moonkin Aura, Elemental Shaman
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Demonology', 'caster_dps'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),      // Moonkin Aura
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),   // Mana Spring
      ],
      [ // Healers core — Resto Shaman Mana Tide
        this.makePlayer('WARRIOR', 'Protection', 'tank'),       // anchor
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),     // Mana Tide
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('DRUID', 'Restoration', 'healer'),
      ],
      [ // Healers + Imp Blood Pact for the tanks
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('PRIEST', 'Discipline', 'healer'),
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'), // Imp Blood Pact
      ],
      [ // Overflow DPS
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'),
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),      // Shadow Weaving
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  buildAlliance40Man() {
    const groups = [
      [ // Melee A — Ret Paladin aura, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('PALADIN', 'Retribution', 'melee_dps'), // Retribution Aura
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),         // LotP
      ],
      [ // Melee B — Ret Paladin aura, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Arms', 'melee_dps'),
        this.makePlayer('ROGUE', 'Assassination', 'melee_dps'),
        this.makePlayer('PALADIN', 'Retribution', 'melee_dps'),
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),
      ],
      [ // Hunters — MM Trueshot, Battle Shout from a Fury Warrior (no
        // Paladin caster/hybrid spec exists to spare for this group)
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'), // Trueshot Aura
        this.makePlayer('HUNTER', 'Beast Mastery', 'ranged_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
        this.makePlayer('ROGUE', 'Subtlety', 'melee_dps'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),          // Battle Shout
      ],
      [ // Casters A (mages) — no Paladin totem-equivalent for casters
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('MAGE', 'Frost', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),        // Shadow Weaving
      ],
      [ // Casters B (warlocks) — Moonkin Aura
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Demonology', 'caster_dps'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),        // Moonkin Aura
        this.makePlayer('PRIEST', 'Discipline', 'healer'),
      ],
      [ // Healers core — Devotion Aura for the tanks
        this.makePlayer('WARRIOR', 'Protection', 'tank'),         // anchor
        this.makePlayer('PALADIN', 'Holy', 'healer'),             // Devotion Aura
        this.makePlayer('PALADIN', 'Holy', 'healer'),
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('DRUID', 'Restoration', 'healer'),
      ],
      [ // Healers + Imp Blood Pact for the tanks
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),             // Concentration Aura
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('DRUID', 'Restoration', 'healer'),
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),   // Imp Blood Pact
      ],
      [ // Overflow DPS
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'),
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  buildHorde20Man() {
    const groups = [
      [ // Melee — WF/SoE Shaman, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // LotP
      ],
      [ // Hunters + casters — Elemental Shaman for Mana Spring/Tranquil Air
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'), // Trueshot Aura
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),        // Shadow Weaving
      ],
      [ // Healers — Resto Shaman Mana Tide, Imp Blood Pact
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),       // Mana Tide
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('DRUID', 'Restoration', 'healer'),
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),   // Imp Blood Pact
      ],
      [ // Remaining DPS
        this.makePlayer('ROGUE', 'Assassination', 'melee_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('PRIEST', 'Discipline', 'healer'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),        // Moonkin Aura
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  buildAlliance20Man() {
    const groups = [
      [ // Melee — Ret Paladin aura, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('PALADIN', 'Retribution', 'melee_dps'),
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),
      ],
      [ // Hunters + casters — no Paladin caster equivalent
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'), // Trueshot Aura
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),       // Shadow Weaving
        this.makePlayer('PALADIN', 'Holy', 'healer'),            // Concentration Aura
      ],
      [ // Healers — Devotion Aura, Imp Blood Pact
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),            // Devotion Aura
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('DRUID', 'Restoration', 'healer'),
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),  // Imp Blood Pact
      ],
      [ // Remaining DPS
        this.makePlayer('ROGUE', 'Assassination', 'melee_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('PRIEST', 'Discipline', 'healer'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),       // Moonkin Aura
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  // Classic Era 10-man reference comp (the "10-player template" raid option —
  // Classic has no real 10-man raid, but the template still needs an Ideal
  // Comp so the tab isn't blank). Same 2-tank/2-healer/6-DPS split as TBC's
  // build10Man, faction-split like the 20/40-man builders above.
  buildHorde10Man() {
    const groups = [
      [ // Tanks + melee — Enhancement Shaman WF/SoE, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('DRUID', 'Feral', 'tank'),               // LotP
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'),   // WF + SoE
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),      // Mana Tide
      ],
      [ // Casters + healer — Elemental Shaman totems
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),    // Grace of Air/Mana Spring
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'), // Trueshot Aura
        this.makePlayer('PRIEST', 'Holy', 'healer'),
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },
  buildAlliance10Man() {
    const groups = [
      [ // Tanks + melee — Retribution Paladin aura, Feral LotP
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('DRUID', 'Feral', 'tank'),               // LotP
        this.makePlayer('PALADIN', 'Retribution', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),            // Devotion Aura
      ],
      [ // Casters + healer — no Paladin caster equivalent
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),       // Moonkin Aura
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'), // Trueshot Aura
        this.makePlayer('PRIEST', 'Holy', 'healer'),
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  // Forever reference comps — no faction lock, so unlike Classic these mix
  // Shaman totems and Paladin auras in the SAME roster (tasks/reference/research-forever.md
  // Browser verification: six new race/class combos put both classes on both
  // factions). Feral (LotP) and Balance (Moonkin) druids are raid-wide in
  // Forever (2026-10-16 notes), so where they sit is only a layout choice here.
  buildForever40Man() {
    const groups = [
      [ // Melee A — Shaman Windfury, Feral crit aura
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // Leader of the Pack
      ],
      [ // Melee B — Paladin Retribution/Sanctity Aura, Feral crit aura
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Arms', 'melee_dps'),
        this.makePlayer('ROGUE', 'Assassination', 'melee_dps'),
        this.makePlayer('PALADIN', 'Retribution', 'melee_dps'), // Sanctity Aura
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),         // Leader of the Pack
      ],
      [ // Hunters — Trueshot is baseline on every spec now; Elemental Shaman for Grace of Air
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'),
        this.makePlayer('HUNTER', 'Beast Mastery', 'ranged_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
        this.makePlayer('ROGUE', 'Subtlety', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),    // Grace of Air + SoE
      ],
      [ // Casters A (mages) — Holy Paladin for Concentration Aura
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('MAGE', 'Frost', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),            // Concentration Aura
      ],
      [ // Casters B (warlocks) — Moonkin Aura, Elemental Shaman
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Demonology', 'caster_dps'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),       // Moonkin Aura
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),    // Mana Spring
      ],
      [ // Healers core — Resto Shaman Mana Tide, Holy Paladin Devotion Aura
        this.makePlayer('WARRIOR', 'Protection', 'tank'),        // anchor
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),      // Mana Tide
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('DRUID', 'Restoration', 'healer'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),            // Devotion Aura
      ],
      [ // Healers + Imp Blood Pact for the tanks
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),
        this.makePlayer('PRIEST', 'Discipline', 'healer'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),  // Imp Blood Pact
      ],
      [ // Overflow DPS
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'),
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  buildForever20Man() {
    const groups = [
      [ // Melee — Shaman Windfury, Feral crit aura
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('WARRIOR', 'Fury', 'melee_dps'),
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'), // WF + SoE
        this.makePlayer('DRUID', 'Feral', 'melee_dps'),        // Leader of the Pack
      ],
      [ // Hunters + casters — Holy Paladin Concentration Aura
        this.makePlayer('HUNTER', 'Marksmanship', 'ranged_dps'),
        this.makePlayer('MAGE', 'Fire', 'caster_dps'),
        this.makePlayer('WARLOCK', 'Destruction', 'caster_dps'),
        this.makePlayer('PRIEST', 'Shadow', 'caster_dps'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),           // Concentration Aura
      ],
      [ // Healers — Resto Shaman Mana Tide, Paladin Devotion Aura for the tank
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('SHAMAN', 'Restoration', 'healer'),     // Mana Tide
        this.makePlayer('PRIEST', 'Holy', 'healer'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),           // Devotion Aura
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'), // Imp Blood Pact
      ],
      [ // Remaining DPS
        this.makePlayer('ROGUE', 'Assassination', 'melee_dps'),
        this.makePlayer('HUNTER', 'Survival', 'ranged_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('PRIEST', 'Discipline', 'healer'),
        this.makePlayer('DRUID', 'Balance', 'caster_dps'),      // Moonkin Aura
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },

  buildForever10Man() {
    const groups = [
      [ // Tanks + Melee + Shaman
        this.makePlayer('WARRIOR', 'Protection', 'tank'),
        this.makePlayer('DRUID', 'Feral', 'tank'),              // Leader of the Pack
        this.makePlayer('SHAMAN', 'Enhancement', 'melee_dps'),  // WF + SoE
        this.makePlayer('ROGUE', 'Combat', 'melee_dps'),
        this.makePlayer('PALADIN', 'Holy', 'healer'),           // Devotion Aura
      ],
      [ // Casters + Healer
        this.makePlayer('SHAMAN', 'Elemental', 'caster_dps'),   // Grace of Air + Mana Spring
        this.makePlayer('WARLOCK', 'Affliction', 'caster_dps'),
        this.makePlayer('MAGE', 'Arcane', 'caster_dps'),
        this.makePlayer('HUNTER', 'Beast Mastery', 'ranged_dps'), // baseline Trueshot Aura
        this.makePlayer('PRIEST', 'Holy', 'healer'),
      ],
    ];
    for (let gi = 0; gi < groups.length; gi++) for (const p of groups[gi]) p.groupNumber = gi + 1;
    return groups;
  },
};
// Wire the TBC ideal comp into the registry now that IdealComp exists —
// IdealComp.generate() dispatches through activeRules().idealComp, so a
// future ruleset only needs to supply its own build25Man/build10Man here.
Rulesets.tbc.idealComp = { build25Man: () => IdealComp.build25Man(), build10Man: () => IdealComp.build10Man() };
Rulesets.classic.idealComp = {
  build40Man: () => IdealComp.build40Man(), build20Man: () => IdealComp.build20Man(),
  build10Man: () => Faction.current() === 'alliance' ? IdealComp.buildAlliance10Man() : IdealComp.buildHorde10Man(),
};
Rulesets.forever.idealComp = {
  build40Man: () => IdealComp.buildForever40Man(),
  build20Man: () => IdealComp.buildForever20Man(),
  build10Man: () => IdealComp.buildForever10Man(),
};

// ── TAB SWITCHING ───────────────────────────────────────────────
// 'plan', 'ideal' (Reference comp) or 'assignments' (hidden while
// ASSIGNMENTS_TAB_ENABLED is false, see js/state.js: it lands on the plan).
function switchTab(tab) {
  if (tab === 'assignments' && !ASSIGNMENTS_TAB_ENABLED) tab = 'plan';
  const leavingReference = State.activeTab === 'ideal' && tab !== 'ideal';
  State.activeTab = tab;

  // The Reference comp view announces itself with a banner (its "Back to my raid" button returns here).
  document.getElementById('reference-banner').hidden = tab !== 'ideal';

  // Show/hide plan-mode-only sections, plus the header and action-row controls
  // marked .plan-only (Optimize, Undo/Redo, plan name, Share, menu, notes, missing).
  const planOnly = ['manual-changes', 'bench-section', 'raid-notes-panel', 'changes-log-panel'].map(
    cls => document.querySelector('.' + cls) || document.getElementById(cls)
  ).filter(Boolean);
  for (const el of [...planOnly, ...document.querySelectorAll('.plan-only')]) {
    el.style.display = tab === 'plan' ? '' : 'none';
  }

  // Assignments is a dedicated full-width panel — it replaces the group
  // board/sidebar the same way Ideal Comp repurposes them, just in its own section.
  const appBody = document.querySelector('.app-body');
  if (appBody) appBody.style.display = tab === 'assignments' ? 'none' : '';

  if (tab === 'ideal') {
    const assignPanel = document.getElementById('assignments-panel');
    if (assignPanel) assignPanel.hidden = true;
    renderIdealComp();
  } else {
    initGroups();
    commit();
  }

  // Opening the reference view on a phone hides the context panel, so focus goes to the way back.
  if (tab === 'ideal' && window.matchMedia('(max-width: 600px)').matches) {
    const back = document.getElementById('btn-back-to-raid');
    if (back) back.focus();
  }
  // Back from the reference comp: the More menu item that opened it sits in a closed menu, so focus goes to the More button
  // (the desktop one, then the phone one, whichever is shown).
  if (leavingReference) {
    for (const id of ['btn-settings-menu', 'btn-phone-more']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.focus();
      if (document.activeElement === el) break;
    }
  }
}

function renderIdealComp() {
  if (!GameVersions[State.gameVersion].modeled) { showToast(GameVersions[State.gameVersion].note); switchTab('plan'); return; }
  const container = document.getElementById('groups-container');
  container.innerHTML = '';

  const raidInfo = Config.Raids[State.selectedRaid];
  document.getElementById('reference-banner-text').innerHTML =
    `<strong>Reference comp, not your raid:</strong> a standard ${Number(raidInfo.size)}-man layout to compare against.`;
  const groups = IdealComp.generate(State.selectedRaid);
  const numGroups = groups.length;

  container.className = 'groups-container gs-pb-board';
  if (numGroups === 5) container.classList.add('groups-5');
  else if (numGroups === 2 || numGroups === 4 || numGroups === 8) container.classList.add('groups-' + numGroups);

  const coveredBuffIds = new Set();
  const cards = [];

  for (let gi = 0; gi < numGroups; gi++) {
    const players = groups[gi] || [];
    const buffList = getGroupBuffs(players, gi, groups);
    buffList.forEach(b => coveredBuffIds.add(b.id));

    let slotsHTML = '';
    for (let si = 0; si < 5; si++) {
      if (si < players.length) {
        const p = players[si];
        const specLabel = p.spec + ' ' + p.class.charAt(0) + p.class.slice(1).toLowerCase();
        slotsHTML += `<div class="player-slot" data-group="${gi}" data-slot="${si}">
          ${getSpecIcon(p)}
          <div class="player-info">
            <span class="player-name ${classColorClass(p.class)}">${esc(specLabel)}</span>
          </div>
        </div>`;
      } else {
        slotsHTML += `<div class="player-slot empty-slot" data-group="${gi}" data-slot="${si}">
          <span class="role-icon role-icon-empty">&#8226;</span>
          <div class="player-info"><span class="player-name">Empty Slot</span></div>
        </div>`;
      }
    }

    let buffsHTML = '';
    if (buffList.length === 0) {
      buffsHTML += '<span class="no-buffs">No buffs</span>';
    } else {
      for (const b of buffList) buffsHTML += groupBuffIconHTML(b, gi, false);
    }
    cards.push(groupCardHTML(gi, players, slotsHTML, buffsHTML, []));
  }
  container.innerHTML = cards.join('');

  const coveredDebuffIds = getRaidDebuffCoverage(groups);
  renderBuffCatalog(coveredBuffIds, coveredDebuffIds);
  renderUtilityCatalog(groups, []);
  // The Raid check strip shows the reference comp's own role counts; the Groups line has no seated count to give.
  document.getElementById('raid-check').hidden = false;
  renderRaidCheckTiles(groups.flat(), null);
  const seatedEl = document.getElementById('seated-count');
  if (seatedEl) seatedEl.textContent = '';
  // Balance warnings are about the live plan's realism, not the static
  // reference comp, so they're cleared rather than computed here.
  const balanceEl = document.getElementById('balance-warnings');
  if (balanceEl) balanceEl.innerHTML = '';

}

// Reference comp is a More menu item (a More sheet item on a phone).
document.getElementById('btn-ideal-comp-link').addEventListener('click', () => switchTab('ideal'));
document.getElementById('btn-back-to-raid').addEventListener('click', () => switchTab('plan'));

// ── GLOBAL KEYBOARD SHORTCUTS (feature-backlog-2.md #8) ──────────
// Single-key shortcuts and the toolbar button each one clicks (SHORTCUTS_HELP lists them for people).
const SHORTCUT_BUTTONS = { o: 'btn-optimize', e: 'btn-share-main', l: 'btn-share', g: 'btn-copy-mrt', m: 'btn-copy-mrt-note', c: 'btn-copy-chat' };

// Whether the planner section is the one showing. The shell (js/guild/app.js) turns it off through
// PP.shell.setActive while a guild page covers the planner; without the shell it stays on. Declared here,
// ahead of the keydown handler, so the shortcut tests that slice this range resolve it.
let plannerSectionActive = true;
function plannerActive() { return plannerSectionActive; }
const SHORTCUTS_HELP = [
  ['O', 'Optimize groups'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Y  (or Ctrl/Cmd + Shift + Z)', 'Redo'],
  ['Ctrl/Cmd + S', 'Save a copy (the plan also saves itself)'],
  ['E', 'Share and export'],
  ['L', 'Copy live link'],
  ['G', 'Copy for MRT'],
  ['M', 'Copy MRT note'],
  ['C', 'Copy raid chat text'],
  ['1', 'Back to the plan'],
  ...(ASSIGNMENTS_TAB_ENABLED ? [['2', 'Switch to Assignments']] : []),
  ['?', 'Show this help'],
];
function showShortcutsHelp() {
  const dialog = document.getElementById('shortcuts-dialog');
  if (!dialog) return;
  const body = document.getElementById('shortcuts-dialog-body');
  if (body) body.innerHTML = SHORTCUTS_HELP.map(([keys, label]) =>
    `<div class="shortcut-row"><kbd>${esc(keys)}</kbd><span>${esc(label)}</span></div>`).join('');
  dialog.showModal();
}
document.getElementById('btn-close-shortcuts')?.addEventListener('click', () => document.getElementById('shortcuts-dialog').close());
document.getElementById('btn-shortcuts-help')?.addEventListener('click', showShortcutsHelp);

// Blocks a shortcut not just while typing (isTypingTarget, defined pre-UI-
// split so input-tests.js can exercise it directly) but also while any
// modal — native <dialog> or one of the hand-rolled overlays above — has
// the user's attention, so e.g. 'o' typed while a save-name confirmation
// is open never fires Optimize behind it.
function isShortcutBlocked(target) {
  if (isTypingTarget(target)) return true;
  if (document.querySelector('dialog[open]')) return true;
  if (document.getElementById('save-overlay')?.classList.contains('visible')) return true;
  if (document.getElementById('active-player-editor')) return true;
  // Nav redesign: no global shortcut should fire behind an open toolbar
  // dropdown (role="menu") or the phone "More" sheet.
  if (document.querySelector('.menu:not([hidden])')) return true;
  if (document.getElementById('mobile-more-sheet')?.classList.contains('visible')) return true;
  return false;
}
// Icon <img> failures do not bubble, so one capture-phase listener covers them all.
document.addEventListener('error', e => handleIconError(e.target), true);

document.addEventListener('keydown', (e) => {
  if (!plannerActive()) return; // a guild page is showing: the planner's keys stay off
  if (State.view !== 'app') return; // shortcuts only act on the planner, not the landing page
  if (isShortcutBlocked(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); document.getElementById('btn-undo').click(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); document.getElementById('btn-redo').click(); return; }
  if (mod && k === 's') { e.preventDefault(); document.getElementById('btn-save').click(); return; }
  if (mod) return; // no other Ctrl/Cmd combos are shortcuts — never eat browser defaults
  if (SHORTCUT_BUTTONS[k] && !e.altKey) { e.preventDefault(); document.getElementById(SHORTCUT_BUTTONS[k]).click(); return; }
  if (k === '1') { e.preventDefault(); switchTab('plan'); return; }
  if (k === '2' && ASSIGNMENTS_TAB_ENABLED) { e.preventDefault(); switchTab('assignments'); return; }
  if (k === '?') { e.preventDefault(); showShortcutsHelp(); return; }
});

// ── INITIALIZE ──────────────────────────────────────────────────
syncVersionControls();
try {
  const latest = PlanStore.read(localStorage)[0];
  if (latest) PlanStore.restore(latest.data);
} catch {}
PlanSession.ready = true;
initGroups();
commit();
// A share link opens straight into the planner; everyone else lands on import.
// The link may ask before replacing the restored plan, so the page starts on the landing view.
showView('landing');
if (hasLoadedWork()) document.querySelector('.gs-ph-tab[data-pane="saved"]').click();
// A short link (/<version>/<id>) needs a server round-trip, so it lands on
// import first and switches to the planner once the layout arrives.
loadFromShortLink().then(opened => { if (opened) showView('app'); });
LiveSync.start();
// A debounced plan save must not be lost when the page is hidden or closed.
window.addEventListener('pagehide', () => PlanStore.flush());
document.addEventListener('visibilitychange', () => { if (document.hidden) PlanStore.flush(); });
window.addEventListener('storage', e => TabWatch.onStorage(e));

// ── SHELL CONTRACT ──────────────────────────────────────────────
// The page shell (js/guild/) shows the planner and the guild pages in one document. These are the planner's half
// of that contract: go home, open How it works, report the view, and switch off while a guild page is showing.
// Nothing here needs the shell, and the planner never reads it.

// Closes every overlay the planner can have open, so nothing of it lingers behind a guild page.
function closePlannerOverlays() {
  closePlayerEditor();
  closeBuffPicker();
  removeSpotlightCallout();
  clearTimeout(spotlightTimer);
  Menu.closeAll();
  document.querySelectorAll('.menu:not([hidden])').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
  closeCoverageDialog();
  if (document.getElementById('mobile-more-sheet').classList.contains('visible')) document.getElementById('btn-close-more-sheet').click();
  if (document.getElementById('save-overlay').classList.contains('visible')) closeSaveOverlay();
  // A pending Modal.confirm resolves as cancelled through the dialog's close event.
  document.querySelectorAll('#planner-root dialog[open]').forEach(dialog => dialog.close());
  Modal.settle(false);
}

function setPlannerActive(active) {
  const next = !!active;
  if (next === plannerSectionActive) return;
  plannerSectionActive = next;
  if (!next) { closePlannerOverlays(); return; }
  Modal.flushDeferred();
  if (State.view === 'app') scheduleSpotlightQueue();
}

const PlannerShell = {
  // The compact landing (import card, saved plans).
  home() {
    showView('landing');
    document.body.classList.remove('landing-full');
    window.scrollTo(0, 0);
  },
  // The full landing, scrolled to its How it works section.
  howItWorks() {
    showView('landing');
    document.body.classList.add('landing-full');
    const section = document.getElementById('how-it-works');
    if (section) section.scrollIntoView();
  },
  view: () => State.view,
  // The guild the head's context line names (the guild shell sets it; '' for no guild).
  setGuildContext(name, team) { plannerGuildName = name || ''; plannerTeamName = team || ''; renderPlannerContext(); },
  // The open plan's name, for the top bar's trail ("<Guild> / Planner / <plan name>").
  planName: () => State.rosterName,
  isActive: () => plannerActive(),
  setActive: setPlannerActive,
};

// The page starts with body.shell-pending (the landing hides what depends on the session) and the shell ends it. If
// the shell never started (a guild script failed to load or threw while loading), the landing would stay on the
// import card alone: once the page has loaded, show the signed-out landing instead.
function shellFailsafe() {
  if (window.Guild && window.Guild.app && window.Guild.app.started) return;
  document.body.classList.remove('shell-pending');
  document.body.classList.add('is-signed-out');
}
window.addEventListener('load', shellFailsafe);

// ── EXPOSE FOR TESTING ──────────────────────────────────────────
// ── BUFF TOOLTIP PORTAL ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  const portal = document.getElementById('buff-tooltip-portal');
  if (!portal) return;

  // One show/hide pair serves every way in: hover (mouse), focus (keyboard) and tap (touch).
  let shownFor = null;
  let lastTouchAt = 0;
  function showTooltip(icon) {
    // A modal dialog sits in the top layer, above everything in the page: inside one, the portal moves into it.
    const host = icon.closest('dialog[open]') || document.body;
    if (portal.parentNode !== host) host.appendChild(portal);
    const name = icon.getAttribute('data-tt-name');
    const desc = icon.getAttribute('data-tt-desc');
    const source = icon.getAttribute('data-tt-source');
    const sourceColor = icon.getAttribute('data-tt-source-color');

    // Built with textContent, not innerHTML/template-string concatenation:
    // these data-tt-* attributes carry player/template names and notes
    // (user-provided data, round-tripped through esc() when the attribute
    // was written). getAttribute() returns the attribute's DECODED value —
    // any HTML the name contains comes back out raw — so re-inserting it via
    // innerHTML here would re-parse it as markup and execute it. Every node
    // is built explicitly and text is assigned via .textContent instead.
    portal.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'tt-name';
    nameEl.textContent = name;
    portal.appendChild(nameEl);
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'tt-desc';
      descEl.textContent = desc;
      portal.appendChild(descEl);
    }
    if (source) {
      const sourceEl = document.createElement('div');
      sourceEl.className = 'tt-source';
      const sourceSpan = document.createElement('span');
      sourceSpan.style.color = sourceColor;
      sourceSpan.textContent = source;
      sourceEl.appendChild(sourceSpan);
      portal.appendChild(sourceEl);
    }
    portal.style.display = 'block';
    shownFor = icon;

    const rect = icon.getBoundingClientRect();
    const width = portal.offsetWidth;
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - portal.offsetHeight - 8;

    // Keep within viewport
    if (left < 4) left = 4;
    if (left + width > window.innerWidth) left = window.innerWidth - width - 4;
    if (top < 4) { top = rect.bottom + 8; }

    portal.style.left = left + 'px';
    portal.style.top = top + 'px';
  }
  function hideTooltip() {
    portal.style.display = 'none';
    shownFor = null;
  }
  // A focus that came from the keyboard (or from code after a keyboard action) is :focus-visible; a mouse click's focus is not
  // (the hover already shows it). Where :focus-visible is unknown, any focus counts.
  function focusIsVisible(el) {
    try { return el.matches(':focus-visible'); } catch (err) { return true; }
  }

  document.addEventListener('mouseover', function(e) {
    const icon = e.target.closest('[data-tt-name]');
    if (!icon) return;
    if (Date.now() - lastTouchAt < 700) return; // the mouseover a tap synthesizes: the tap handler below owns touch
    showTooltip(icon);
  });

  document.addEventListener('mouseout', function(e) {
    const icon = e.target.closest('[data-tt-name]');
    if (!icon) return;
    const related = e.relatedTarget;
    if (related && icon.contains(related)) return;
    hideTooltip();
  });

  // Keyboard: Tab onto an icon shows its tooltip, leaving it hides it.
  document.addEventListener('focusin', function(e) {
    const icon = e.target.closest && e.target.closest('[data-tt-name]');
    if (icon && focusIsVisible(e.target)) showTooltip(icon);
  });
  document.addEventListener('focusout', function(e) {
    const icon = e.target.closest && e.target.closest('[data-tt-name]');
    if (icon && shownFor === icon) hideTooltip();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && portal.style.display === 'block') hideTooltip();
  });

  // Touch has no hover: a tap on an icon toggles its tooltip, a tap anywhere else closes it.
  document.addEventListener('pointerdown', function(e) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    lastTouchAt = Date.now();
    const icon = e.target.closest('[data-tt-name]');
    if (!icon) { hideTooltip(); return; }
    if (shownFor === icon && portal.style.display === 'block') hideTooltip();
    else showTooltip(icon);
  });
  document.addEventListener('touchstart', function(e) {
    lastTouchAt = Date.now();
    if (e.target.closest('[data-tt-name]')) return;
    hideTooltip();
  }, { passive: true });
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Config, Import, Optimizer, IdealComp, RosterEdit, Readiness, Assignments, RaidPrep, PrintSheet, detectVersionFromTemplateId, getGroupBuffs, getBuffPriority, getRaidDebuffCoverage, getDrumsCoverage, getMissingBuffInsights, State, TOTEM_ELEMENTS, PALADIN_AURAS, BEST_AIR_TOTEM, BEST_PALADIN_AURA, NO_ROSTER_NAME, Backups, Constraints, Drummers, RaidSplit, PlanStore };
}
// Also expose on window for browser-based tests
window.PP = { Config, Import, Optimizer, IdealComp, RosterEdit, Readiness, getGroupBuffs, getMissingBuffInsights, State, TOTEM_ELEMENTS, PALADIN_AURAS, BEST_AIR_TOTEM, BEST_PALADIN_AURA, NO_ROSTER_NAME, Backups, RaidSplit, PlanStore, SplitFlow, shell: PlannerShell };
