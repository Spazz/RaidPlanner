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
  renderVersionComparison();
}

// Static 3-column TBC / Classic Era / Forever comparison (feature-backlog-2.md
// #9). Sources every blurb from GameVersions[key].note and GameVersions[key].raids
// so it can never drift out of sync with the FAQ, which quotes the same facts.
function renderVersionComparison() {
  const table = document.getElementById('version-compare-table');
  if (!table) return;
  // Re-rendering after a switch replaces the focused card; give focus back to the same one.
  const focused = document.activeElement && table.contains(document.activeElement) ? document.activeElement : null;
  const refocus = focused ? focused.dataset.version : null;
  const order = ['tbc', 'classic', 'forever'];
  table.innerHTML = order.map(key => {
    const profile = GameVersions[key];
    if (!profile) return '';
    // GameVersions[key].raids also carries the classicN/foreverN planning
    // templates (kept for old saved plans — see the raids section of
    // js/rules/classic.js and forever.js); this landing table only advertises real raids.
    const raidNames = (profile.raids || [])
      .map(r => Config.Raids[r])
      .filter(r => r && r.tier !== 'Planning templates')
      .map(r => r.name);
    const here = key === State.gameVersion;
    return `<button type="button" class="version-compare-col${here ? ' here' : ''}" data-version="${esc(key)}" aria-label="${esc(here ? profile.name + ', current version' : 'Switch to ' + profile.name)}"${here ? ' aria-current="true"' : ''}>
      <span class="version-compare-name">${esc(profile.name)}</span>
      <span class="version-compare-note">${esc(profile.note)}</span>
      <span class="version-compare-raids"><strong>${raidNames.length} raid${raidNames.length === 1 ? '' : 's'} modeled:</strong> ${esc(raidNames.join(', ') || 'Planning templates only')}</span>
      <span class="go">${here ? 'You are here' : 'Switch to ' + esc(profile.name)}</span>
    </button>`;
  }).join('');
  if (refocus) {
    const card = table.querySelector(`[data-version="${refocus}"]`);
    if (card) card.focus();
  }
}

// The cards are buttons that switch the game version (switchGameVersion asks first when a
// plan is loaded). Own handler on the container: syncVersionControls wires only the real
// .game-version-tab buttons, so the cards never get its generic [data-version] click.
function onVersionCardClick(event) {
  const card = event.target && event.target.closest ? event.target.closest('button[data-version]') : null;
  if (!card || card.getAttribute('aria-current') === 'true') return;
  switchGameVersion(card.dataset.version);
}
(function initVersionCards() {
  const table = document.getElementById('version-compare-table');
  if (table) table.addEventListener('click', onVersionCardClick);
})();

// Status bar version, set once from APP_VERSION (js/changelog.js).
(function initStatusVersion() {
  const el = document.getElementById('status-version');
  if (el) el.textContent = `Raidsmith v${APP_VERSION}`;
})();

// Asks, then removes one landing row: a working plan (kind 'plan', id = its plan key) or a saved
// copy (kind 'copy', id = its name). Resolves true only when something was removed. Declining keeps it.
async function deleteSavedEntry(kind, id, label) {
  const ok = await Modal.confirm({ title: 'Delete plan', message: `Delete "${label}"? This can't be undone.`, confirmLabel: 'Delete' });
  if (!ok) return false;
  try {
    if (kind === 'plan') {
      PlanStore.remove(localStorage, id);
      LiveLinks.drop(localStorage, id);
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
  showToast(`Deleted "${label}"`);
  return true;
}

function renderLandingSavedList() {
  const backupNote = document.getElementById('landing-last-backup');
  if (backupNote) backupNote.textContent = BackupStamp.label(localStorage);
  const list = document.getElementById('landing-saved-list');
  if (!list) return;
  const rosters = getSavedRosters();
  const names = Object.keys(rosters);
  let drafts = [];
  try { drafts = PlanStore.read(localStorage); } catch {}
  // Nothing saved and nothing imported: the pane shows one message and the restore row instead of two empty lists.
  let imports = [];
  try { imports = ImportHistory.read(localStorage); } catch {}
  const pane = list.closest('.import-pane');
  if (pane) pane.classList.toggle('is-empty', names.length === 0 && drafts.length === 0 && imports.length === 0);
  if (names.length === 0 && drafts.length === 0) {
    list.innerHTML = '<div class="saved-empty">No plans yet. Import a roster and your work will be saved here automatically.</div>';
    return;
  }
  list.innerHTML = drafts.map(p => `<div class="history-row saved-row">
    <button type="button" class="saved-item history-open saved-open" data-plan="${esc(LiveLinks.planKey(p.data))}">
      <span class="saved-item-name">${esc(p.data.rosterName)}</span>
      <span class="saved-item-meta">${p.data.groups.flat().length} seated · ${p.data.bench.length} benched · ${esc(new Date(p.updatedAt).toLocaleString())}</span>
    </button>
    <span class="row-actions"><button type="button" class="link-btn del" data-delete-plan="${esc(LiveLinks.planKey(p.data))}" data-label="${esc(p.data.rosterName)}" aria-label="Delete plan ${esc(p.data.rosterName)}">Delete</button></span>
  </div>`).join('') + (names.length ? '<div class="saved-item-meta">Saved copies</div>' : '') + names.map(name => {
    const r = rosters[name];
    const count = r.players ? r.players.length : 0;
    const raid = r.raid && Config.Raids[r.raid] ? raidSizeLabel(r.raid) : '';
    const linked = r.sourceEventId ? ' \u00b7 Raid-Helper linked' : '';
    return `<div class="history-row saved-row">
      <button type="button" class="saved-item history-open saved-open" data-name="${esc(name)}">
        <span class="saved-item-name">${esc(name)}</span>
        <span class="saved-item-meta">${count} players${raid ? ' \u00b7 ' + esc(raid) : ''}${linked}</span>
      </button>
      <span class="row-actions"><button type="button" class="link-btn del" data-delete-copy="${esc(name)}" data-label="${esc(name)}" aria-label="Delete saved copy ${esc(name)}">Delete</button></span>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-delete-plan], [data-delete-copy]').forEach(btn => btn.addEventListener('click', async () => {
    const isPlan = btn.dataset.deletePlan !== undefined;
    const removed = await deleteSavedEntry(isPlan ? 'plan' : 'copy', isPlan ? btn.dataset.deletePlan : btn.dataset.deleteCopy, btn.dataset.label);
    if (removed) renderLanding();
  }));
  list.querySelectorAll('.saved-open').forEach(item => item.addEventListener('click', () => {
    if (item.dataset.plan) {
      const plan = drafts.find(p => LiveLinks.planKey(p.data) === item.dataset.plan);
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
  card.querySelectorAll('.import-tab').forEach(tab => tab.addEventListener('click', () => {
    card.querySelectorAll('.import-tab').forEach(t => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    card.querySelectorAll('.import-pane').forEach(pane => { pane.hidden = pane.dataset.pane !== tab.dataset.pane; });
    const focusEl = card.querySelector(`.import-pane[data-pane="${tab.dataset.pane}"] .import-field`);
    if (focusEl) focusEl.focus();
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
      const pane = document.querySelector('.import-pane[data-pane="import"]');
      if (!S || !pane) return;
      const wrap = document.createElement('div');
      wrap.className = 'dev-scenarios';
      wrap.innerHTML = `<label for="dev-scenario">Dev - load a test scenario (${S.scenarios.length})</label>
        <select id="dev-scenario" class="raid-dropdown"><option value="" disabled selected>Pick a scenario</option>
        ${S.scenarios.map(sc => `<option value="${esc(sc.id)}">${esc(sc.id)} - ${esc(sc.label)}</option>`).join('')}</select>`;
      pane.insertBefore(wrap, pane.querySelector('textarea'));
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
  document.getElementById('readiness-text').onclick = (e) => {
    // Phones open the Coverage sheet; desktop opens the rail in place.
    if (PHONE_QUERY.matches) { openCoverageSheet(e.currentTarget); return; }
    setSidebarExpanded(true);
    document.getElementById('buff-sidebar').scrollIntoView({block:'nearest'});
  };
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
// Share, and one menu (gear) holding the Plan, Sign-ups and Data & help sections.
(function initToolbarMenus() {
  Menu.init(document.getElementById('btn-version-menu'), document.getElementById('version-menu'));
  Menu.init(document.getElementById('btn-share-menu'), document.getElementById('share-menu'));
  Menu.init(document.getElementById('btn-settings-menu'), document.getElementById('settings-menu'));
})();

// ── RAID NOTES TOGGLE (desktop action row) ───────────────────────
// On desktop the notes panel's own summary is hidden and this button opens it;
// on phones the panel sits in the context row and keeps its summary.
function syncRaidNotesToggle() {
  const panel = document.getElementById('raid-notes-panel');
  const toggle = document.getElementById('btn-raid-notes-toggle');
  if (!panel || !toggle) return;
  toggle.setAttribute('aria-expanded', String(panel.open));
  document.getElementById('raid-notes-chevron').innerHTML = panel.open ? '&#9662;' : '&#9656;';
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

// ── PHONE COVERAGE SHEET ──────────────────────────────────────────
// The rail itself moves into this non-modal bottom sheet on phones (see initResponsiveChrome).
// It opens half height ("peek") so the board stays usable; Show all grows it to nearly full height.
let coverageSheetTrigger = null;
function setCoverageSheetExpanded(expanded) {
  const sheet = document.getElementById('coverage-sheet');
  const more = document.getElementById('btn-coverage-expand');
  if (!sheet || !more) return;
  sheet.classList.toggle('expanded', expanded);
  document.body.classList.toggle('coverage-expanded', expanded);
  more.setAttribute('aria-expanded', String(expanded));
  more.innerHTML = expanded ? 'Show less &#9662;' : 'Show all &#9652;';
}
function openCoverageSheet(trigger) {
  const sheet = document.getElementById('coverage-sheet');
  if (!sheet || !PHONE_QUERY.matches) return;
  closeCoverageSheet(false);
  coverageSheetTrigger = trigger || null;
  setCoverageSheetExpanded(false);
  sheet.classList.add('visible');
  document.body.classList.add('coverage-open'); // the page gets bottom padding equal to the sheet, so its end can scroll clear
  if (coverageSheetTrigger) coverageSheetTrigger.setAttribute('aria-expanded', 'true');
  document.getElementById('coverage-sheet-heading').focus();
}
function closeCoverageSheet(restoreFocus = true) {
  const sheet = document.getElementById('coverage-sheet');
  if (!sheet || !sheet.classList.contains('visible')) return;
  sheet.classList.remove('visible');
  document.body.classList.remove('coverage-open', 'coverage-expanded');
  const trigger = coverageSheetTrigger;
  coverageSheetTrigger = null;
  if (!trigger) return;
  trigger.setAttribute('aria-expanded', 'false');
  // A fix can clear the last gap and hide the link that opened the sheet: focus the summary toggle then.
  if (restoreFocus) (trigger.hidden ? document.getElementById('phone-summary-toggle') : trigger)?.focus();
}
(function initCoverageSheet() {
  const sheet = document.getElementById('coverage-sheet');
  if (!sheet) return;
  document.getElementById('btn-close-coverage-sheet').addEventListener('click', () => closeCoverageSheet());
  document.getElementById('btn-coverage-expand').addEventListener('click', () => setCoverageSheetExpanded(!sheet.classList.contains('expanded')));
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCoverageSheet(); } });
  // Escape from anywhere, unless another overlay is open (capture: the player editor's own Escape runs after this and closes it first).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sheet.classList.contains('visible')) return;
    if (document.querySelector('dialog[open], #active-player-editor, .menu:not([hidden])')) return;
    if (document.getElementById('mobile-more-sheet').classList.contains('visible')) return;
    e.preventDefault();
    closeCoverageSheet();
  }, true);
  // Leaving phone width puts the rail back in its desktop place, so the sheet has nothing to show.
  PHONE_QUERY.addEventListener('change', () => { if (!PHONE_QUERY.matches) closeCoverageSheet(false); });
})();

// ── PHONE "MORE" SHEET ────────────────────────────────────────────
(function initMoreSheet() {
  const sheet = document.getElementById('mobile-more-sheet');
  const trigger = document.getElementById('btn-phone-more');
  const openSheet = () => {
    closeCoverageSheet(false);
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
// Phone width hides the desktop header and action row: Undo, Optimize and Share
// go to a fixed bottom bar, the Raid size control to line 2 of the context row, the plan name to its Edit body, and the gear menu's
// three sections to the More sheet. Rather than duplicating every action as a
// second button — which drifts out of sync — the SAME element physically moves
// between its desktop slot and its phone slot. A comment node left at each
// element's original position lets it snap back to that exact spot when the
// viewport widens again. Slots fill in list order.
(function initResponsiveChrome() {
  const slots = ['version-menu-wrap:phone-version-slot', 'btn-undo:phone-bar-undo-slot', 'btn-optimize:phone-bar-optimize-slot', 'btn-share-main:phone-bar-share-slot',
    'raid-size-wrap:raid-size-phone-slot', 'roster-name:phone-plan-name-slot',
    'btn-redo:phone-sheet-quick-slot', 'btn-changes:phone-sheet-quick-slot',
    'btn-new-plan:phone-sheet-plan-slot', 'btn-load:phone-sheet-plan-slot', 'btn-save:phone-sheet-plan-slot', 'btn-templates:phone-sheet-plan-slot', 'btn-split-plan:phone-sheet-plan-slot', 'btn-clear:phone-sheet-plan-slot',
    'btn-refresh:phone-sheet-signups-slot', 'btn-attendance:phone-sheet-signups-slot', 'btn-random:phone-sheet-signups-slot',
    'raid-notes-panel:phone-context-notes-slot', 'buff-sidebar:coverage-sheet-slot',
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
    // Shorter label in the thumb-width phone bottom bar (plain "Share"); the
    // fuller desktop text "Share and export…" comes back once
    // btn-share-main is a Share-menu item again instead of a bottom-bar button.
    const shareLabel = document.querySelector('#btn-share-main .btn-label');
    // Written only when it changes: sync() also runs on every resize.
    const label = isPhone ? 'Share' : 'Share and export…';
    if (shareLabel && shareLabel.textContent !== label) shareLabel.textContent = label;
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

// Phone context summary: line 1 is the plan name (a button that expands the Edit
// body in place); line 2 holds the seated count, Raid size and missing link. Collapsed by default; the choice
// is remembered for the session only.
const PHONE_CONTEXT_STORAGE_KEY = 'pp_phone_context_open';
function setPhoneContextOpen(open, persist = true) {
  const toggle = document.getElementById('phone-summary-toggle');
  const body = document.getElementById('phone-context-body');
  if (!toggle || !body) return;
  toggle.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
  document.getElementById('phone-summary-edit-label').textContent = open ? 'Done' : 'Edit';
  document.getElementById('phone-summary-chevron').innerHTML = open ? '&#9652;' : '&#9662;';
  if (persist) safeSetItem(sessionStorage, PHONE_CONTEXT_STORAGE_KEY, open ? '1' : '0');
}
(function initPhoneContextToggle() {
  const toggle = document.getElementById('phone-summary-toggle');
  if (!toggle) return;
  let open = false;
  try { open = sessionStorage.getItem(PHONE_CONTEXT_STORAGE_KEY) === '1'; } catch (e) {}
  setPhoneContextOpen(open, false);
  toggle.addEventListener('click', () => setPhoneContextOpen(toggle.getAttribute('aria-expanded') !== 'true'));
})();

// ── ACTION BUTTONS ──────────────────────────────────────────────
// "Last Optimize: 8 moved, Windfury +4 melee": the toast's wording in short form.
function renderLastRun(summary) {
  const el = document.getElementById('last-run');
  if (!el) return;
  if (!summary) { el.innerHTML = ''; return; }
  const parts = [`${summary.moved} moved`].concat(reachParts(summary.reach));
  el.innerHTML = `&middot; Last Optimize: ${parts.join(', ')}`;
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
document.getElementById('btn-load').addEventListener('click', () => { showView('landing'); document.querySelector('.import-tab[data-pane="saved"]').click(); });

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
// via api/share.js; from then on every change auto-saves to that same link,
// the address bar shows it while the plan is open, and open pages pull other
// people's changes. Anyone with the link can edit and the latest save wins.
// The version segment is a readable label only (the stored code carries the
// real version and raid). The long #r= link is the fallback when the API is
// unreachable, and old #r= links keep loading.
const SHARE_API = '/api/share';
const SHORT_LINK_PATH = new RegExp(`^/(?:${Object.keys(GameVersions).join('|')})/([0-9A-Za-z]{7})/?$`);
// Read before the first render, which hands the address bar to syncAddressBar.
const SHORT_LINK_AT_LOAD = (window.location.pathname.match(SHORT_LINK_PATH) || [])[1] || null;
const LIVE_SAVE_DELAY_MS = 2000;
const LIVE_DEFER_POLL_MS = 500;

function siteRoot() {
  return window.location.origin + '/';
}

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
  // A pending #r= share link has not been read yet: keep it. So is a guild route (#/...): the shell shows a
  // guild section on top of the open plan's address.
  const hash = (window.location.hash.startsWith('#r=') || window.location.hash.startsWith('#/')) ? window.location.hash : '';
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
  summaryText(entry) {
    if (!entry || !entry.items || !entry.items.length) return 'Roster updated by someone else.';
    const counts = ChangeLog.countsText(entry);
    return counts ? `Updated by someone else: ${counts}.` : 'Roster updated by someone else.';
  },
  show(before, entry) {
    this.before = before;
    this.entryId = entry ? entry.id : null;
    const banner = document.getElementById('remote-update-banner');
    const text = document.getElementById('remote-update-text');
    const undo = document.getElementById('btn-remote-undo');
    if (text) text.textContent = this.summaryText(entry);
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
  // Puts the plan as it was before the update back on screen; the live link
  // then follows it like any other local change.
  undo() {
    const before = this.before;
    const entryId = this.entryId;
    this.hide();
    if (!before || !PlanStore.restore(before)) return false;
    if (entryId) ChangeLog.remove(entryId);
    closePlayerEditor(); closeBuffPicker();
    initGroups(); commit(); renderLastRun(null);
    showToast('Restored your version of the roster (a live link will now show it)');
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
    const notes = document.getElementById('raid-notes-textarea');
    return !!(document.getElementById('active-player-editor') || document.getElementById('active-buff-picker') ||
      (notes && document.activeElement === notes));
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
    if (!status || status.dataset.failed) return;
    status.textContent = this.statusText('Saved on this device');
    const line = document.getElementById('roster-status-line');
    if (line) line.textContent = status.textContent;
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

// Resolves to {url, live} and never rejects, so Share always has a link.
async function getShareLink() {
  const code = currentShareCode();
  const fallback = { url: siteRoot() + '#r=' + code, live: false };
  const existing = currentLiveLink();
  if (existing) {
    LiveSync.flush();
    return { url: window.location.origin + liveLinkPath(existing.entry.id), live: true };
  }
  const planKey = LiveLinks.planKey(State);
  if (!planKey || LiveLinks.rejection(code)) return fallback;
  try {
    const { id, updatedAt } = await createLiveLink(code, { timeoutMs: 5000 });
    bindLiveLink(planKey, id, code, updatedAt);
    if (!currentLiveLink()) return fallback;
    syncAddressBar();
    LiveSync.refreshStatus();
    return { url: window.location.origin + liveLinkPath(id), live: true };
  } catch {
    return fallback;
  }
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

async function loadFromShareLink() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#r=')) return false;

  // Strip the fragment first, so a refresh (or a declined prompt) never re-fires.
  history.replaceState(null, '', window.location.origin + window.location.pathname);
  return await applyShareCode(hash.slice(3));
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

// ── GUILD RAID CONTEXT ──────────────────────────────────────────
// "Plan in Planner" on a raid of the guild tracker opens the planner at #/planner?raid=<gid>.<rid> (the shell, js/guild/app.js,
// hands that address to route(); it survives a reload). The raid's plan is the plan 'raid:<rid>' (RaidLink). It opens from the
// plan saved on the raid when there is one, else from this browser's copy of it, else from the raid's sign-ups alone; the
// sign-ups are then folded in by the Raid-Helper re-sync (RaidHelperSync.apply), the guild's sign-ups standing in for the
// event. "Save to raid" puts the plan on a live link and sends its names and groups to the raid (PUT .../plan), which keeps
// the link for the next time. Leaving the raid (Back to raid, the Planner link, any other address) only drops the banner:
// the plan stays open as a plan of this browser. An open plan that is not this raid's is set aside as an import does it:
// it is saved on this device (Your plans) before the raid's plan replaces it on screen.
const RaidContext = {
  current: null, // { gid, rid, planId, seed, seedJson, loaded, saving, status, failed, opening } while a raid is open
  token: 0,      // the newest open wins

  api() { return window.Guild && window.Guild.api ? window.Guild.api : null; },
  basePath(c) { return '/api/guild/' + encodeURIComponent(c.gid) + '/raids/' + encodeURIComponent(c.rid); },
  errorText(err) {
    if (err && err.status === 401) return 'Sign in to Raidsmith, then open the raid again.';
    const api = this.api();
    return api && api.classify ? api.classify(err).text : 'Something went wrong. Try again in a moment.';
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
    const c = { gid, rid, planId: RaidLink.planId(rid), seed: null, seedJson: '', loaded: false, saving: false, status: '', failed: false, opening: null };
    this.current = c;
    this.render();
    const fetched = api && c.planId ? api.get(this.basePath(c) + '/planner') : Promise.reject(new Error('guild tools missing'));
    c.opening = fetched.then(seed => (token === this.token ? this.apply(c, seed, token) : false), err => {
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
    if (!this.current) return;
    this.current = null;
    Fairness.clear(); // the raid's sit-out history ends with the raid context
    this.render();
  },

  async apply(c, seed, token) {
    if (!seed || !seed.raid) { this.current = null; Fairness.clear(); this.render(); showToast('That raid could not be opened.'); return false; }
    c.seed = seed;
    c.seedJson = RaidLink.seedToRaidHelper(seed);
    Fairness.load(seed); // before the plan is built: the bench choice reads it
    // A /<version>/<id> link being opened at page load owns the plan on screen until it is done.
    for (let i = 0; i < 100 && LiveSync.opening; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const version = Object.prototype.hasOwnProperty.call(GameVersions, seed.raid.gameVersion) ? seed.raid.gameVersion : State.gameVersion;
    let remote = null;
    let remoteDown = false;
    if (seed.livePlan && LiveLinks.ID.test(seed.livePlan)) {
      try { remote = await fetchLiveLink(seed.livePlan); } catch { remoteDown = true; }
    }
    if (token !== this.token) return false;
    c.status = this.load(c, seed, version, remote, remoteDown);
    c.loaded = true;
    this.render();
    showView('app');
    return true;
  },

  // Puts the raid's plan on screen and returns the banner's status line.
  load(c, seed, version, remote, remoteDown) {
    const raid = seed.raid;
    const planKey = version + '|' + c.planId;
    const onScreen = State.planId === c.planId && State.gameVersion === version;
    let saved = null;
    if (!onScreen) { try { saved = PlanStore.read(localStorage).find(p => LiveLinks.planKey(p.data) === planKey) || null; } catch {} }
    const bound = seed.livePlan ? LiveLinks.findById(linkStorage(), seed.livePlan) : null;
    const ownsLive = !!bound && bound.planKey === planKey;
    const gone = !!seed.livePlan && !remote && !remoteDown;
    const caveat = (remoteDown ? ' The plan saved on the raid could not be reached, so this is the copy on this device.' : '') +
      (gone ? ' The plan saved on the raid has expired (live links last 30 days after their last change).' : '');
    LiveSync.flush();
    PlanStore.flush();

    // The plan saved on the raid wins over a copy this browser holds that was never linked to it.
    if (remote && !ownsLive) {
      const str = Import.decodeSharePayload(remote.code);
      if (str && Import.previewShareString(str).success) {
        const previous = PlanStore.capture();
        PlanStore.startFresh();
        if (Import.importAddonString(str).success) {
          this.adopt(c, raid);
          // Bound before the sync commits, so the render does not echo the copy straight back.
          bindLiveLink(LiveLinks.planKey(State), seed.livePlan, currentShareCode(), remote.updatedAt);
          ChangeLog.clear();
          RaidHelperSync.apply(Import.diffRaidHelperSignUps(c.seedJson), 'Opened the plan saved on the raid');
          return 'Opened the plan saved on the raid.';
        }
        PlanStore.restore(previous);
      }
    }

    if (onScreen || saved) {
      if (saved) PlanStore.restore(saved.data);
      this.adopt(c, raid);
      if (remote && ownsLive) {
        const entry = LiveLinks.get(linkStorage(), planKey);
        if (LiveLinks.shouldApply(entry, remote, false) && remote.code !== currentShareCode()) trackLiveUpdate(() => applyRemoteLiveCode(seed.livePlan, remote));
      }
      RaidHelperSync.apply(Import.diffRaidHelperSignUps(c.seedJson), 'Synced with the raid');
      if (gone && ownsLive) LiveSync.replaceExpiredLink(seed.livePlan);
      return 'Opened your plan for this raid, with the latest sign-ups.' + caveat;
    }

    // Nothing saved: start from the sign-ups, as a Raid-Helper import does (the plan it replaces was saved above).
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
    initGroups();
    commit();
    return (result.success ? `Started from the raid's ${result.playerCount + result.benchCount + result.unplacedCount} sign-ups.` : 'The raid has no sign-ups yet. Add players here, or import them on the raid page and open it again.') + caveat;
  },

  // What makes the plan on screen this raid's plan: its id, the event it follows and its start (none for a raid that has
  // a date but no start time: its startsAt is a placeholder noon UTC).
  adopt(c, raid) {
    State.planId = c.planId;
    State.sourceEventId = raid.eventId || null;
    State.eventStartTime = raid.timeKnown === false ? null : PlanStore.cleanEventStart(raid.startsAt);
  },

  // A commit that left the raid's plan (another plan opened, an import) ends the raid context.
  onCommit() {
    const c = this.current;
    if (c && c.loaded && State.planId !== c.planId) this.leave();
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

  // The id of the live link that holds the plan on screen: made here when the plan has none, else brought up to date first.
  async liveId() {
    const tooBig = LiveLinks.rejection(currentShareCode());
    if (tooBig) throw new Error('The plan cannot be saved to a live link: ' + tooBig + '.');
    if (!currentLiveLink()) {
      const made = await getShareLink();
      if (!made.live) throw new Error('Live links are down right now, so the plan was not saved to the raid. Try again in a moment.');
    } else if (!await LiveSync.settle()) {
      throw new Error('The live link has not caught up yet. Your changes are safe on this device; try Save to raid again in a moment.');
    }
    const link = currentLiveLink();
    if (!link) throw new Error('The plan has no live link, so it was not saved to the raid.');
    return link.entry.id;
  },

  // Save to raid: the live link holds the whole plan, the raid keeps its names and groups (and the link, to reopen it).
  async save() {
    const c = this.current;
    if (!c || !c.loaded || c.saving) return;
    const guild = window.Guild;
    const api = this.api();
    if (State.planId !== c.planId) { this.setStatus('This is no longer the raid plan. Open the raid again from the guild page.', true); return; }
    if (!api || !guild.planSource) { this.setStatus('The guild tools are not loaded on this page.', true); return; }
    c.saving = true;
    this.setStatus('Saving to the raid...', false);
    let sent = [];
    try {
      const live = await this.liveId();
      const read = Import.readSharePlayers(Import.exportShareString());
      if (!read.success) throw new Error(read.error);
      const clean = guild.planSource.sanitize(read.players.map(p => ({ name: p.name, group: p.groupNumber })));
      sent = clean.players;
      if (!sent.length) throw new Error('None of the names in this plan are valid character names (2 to 12 letters), so there is nothing to save to the raid.');
      if (sent.length > guild.planSource.MAX_PLAYERS) throw new Error(`The plan has ${sent.length} players; a raid plan holds at most ${guild.planSource.MAX_PLAYERS}.`);
      await api.put(this.basePath(c) + '/plan', { label: RaidLink.planLabel(c.seed.raid), players: sent, live });
      const left = clean.skipped ? ` ${clean.skipped} ${clean.skipped === 1 ? 'name was' : 'names were'} left out (not a valid character name, or listed twice).` : '';
      // The time is the guild's ("11:14 AM ET"), the same clock the raid page shows, not the browser's.
      const gdata = guild.app && guild.app.state && guild.app.state.guilds ? guild.app.state.guilds[c.gid] : null;
      const at = guild.ui && guild.ui.timeInZone ? guild.ui.timeInZone(Date.now(), gdata && gdata.guild ? gdata.guild.timeZone : '') : new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      this.setStatus(`Saved to the raid at ${at}.${left}`, false);
    } catch (err) {
      const planText = err && err.code === 'plan_invalid' && guild.planSource ? guild.planSource.describeError(err, sent) : null;
      this.setStatus(planText || (err && err.status !== undefined ? this.errorText(err) : (err && err.message) || 'The plan could not be saved to the raid.'), true);
    } finally {
      c.saving = false;
      this.render();
    }
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
    if (!c) return;
    const text = document.getElementById('raid-context-text');
    const status = document.getElementById('raid-context-status');
    const save = document.getElementById('btn-raid-save');
    if (text) text.textContent = RaidLink.bannerText(c.seed && c.seed.raid);
    if (status) { status.textContent = c.status; status.classList.toggle('error', c.failed); }
    if (save) save.disabled = c.saving;
  },

  wire() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btn-raid-save', () => this.save());
    on('btn-raid-back', () => this.back());
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
    .then(([{ live }]) => showToast(live
      ? 'Live link copied. Anyone with it can see and edit this plan; it expires 30 days after the last change.'
      : 'Live links are down right now, so this is a snapshot link: it will not update when the plan changes.'))
    .catch(() => link.then(({ url }) => showManualCopy(url)));
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
      try { setSidebarExpanded(localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1', false); } catch {}
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
  const planOnly = ['phone-context-panel', 'phone-action-bar', 'manual-changes', 'action-bar', 'bench-section', 'readiness-banner', 'raid-notes-panel', 'changes-log-panel'].map(
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
  // Back from the reference comp: the link that opened it is visible again, so focus goes there
  // (the phone link, then the phone summary toggle, when the desktop one is not shown).
  if (leavingReference) {
    for (const id of ['btn-ideal-comp-link', 'btn-ideal-comp-link-phone', 'phone-summary-toggle']) {
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
  // Balance warnings are about the live plan's realism, not the static
  // reference comp, so they're cleared rather than computed here.
  const balanceEl = document.getElementById('balance-warnings');
  if (balanceEl) balanceEl.innerHTML = '';

  document.getElementById('status-text').textContent = `Reference ${raidInfo.size}-man comp`;
}

// Reference comp is a quiet link in the action row (desktop) and the Edit body (phone).
document.getElementById('btn-ideal-comp-link').addEventListener('click', () => switchTab('ideal'));
document.getElementById('btn-ideal-comp-link-phone').addEventListener('click', () => switchTab('ideal'));
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
if (hasLoadedWork()) document.querySelector('.import-tab[data-pane="saved"]').click();
loadFromShareLink().then(opened => { if (opened) showView('app'); });
// A short link (/<version>/<id>) needs a server round-trip, so it lands on
// import first and switches to the planner once the layout arrives.
loadFromShortLink().then(opened => { if (opened) showView('app'); });
LiveSync.start();
// A debounced plan save must not be lost when the page is hidden or closed.
window.addEventListener('pagehide', () => PlanStore.flush());
document.addEventListener('visibilitychange', () => { if (document.hidden) PlanStore.flush(); });
window.addEventListener('storage', e => TabWatch.onStorage(e));
// A share link pasted into the address bar of an already-open page only
// changes the hash, so honour it there too.
window.addEventListener('hashchange', () => { loadFromShareLink().then(opened => { if (opened) showView('app'); }); });

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
  closeCoverageSheet(false);
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
