// ── BENCH DRAG & DROP ───────────────────────────────────────────
// Shares the `dragData` object with the group drag handlers above; a bench
// source is marked with group === 'bench' so each side can tell them apart.
(function initBenchDragDrop() {
  const section = document.getElementById('bench-section');
  const ghost = document.getElementById('drag-ghost');

  section.addEventListener('dragstart', e => {
    const slot = e.target.closest('.bench-slot[draggable="true"]');
    if (!slot) return;
    let p;
    if (slot.dataset.unplacedUid) {
      p = (State.unplaced || []).find(u => u.uid === slot.dataset.unplacedUid);
      if (!p) return;
      dragData = { group: 'unplaced', uid: p.uid };
    } else {
      const bi = parseInt(slot.dataset.benchSlot);
      p = (State.bench || [])[bi];
      if (!p) return;
      dragData = { group: 'bench', slot: bi, uid: p.uid };
    }
    slot.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    const img = new Image(); img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    e.dataTransfer.setDragImage(img, 0, 0);
    ghost.textContent = p.name.split('-')[0];
    ghost.style.color = Config.ClassColors[p.class] || 'var(--text-primary)';
    ghost.style.display = 'block';
    DragGhost.start(e.clientX, e.clientY);
  });

  section.addEventListener('drag', e => {
    if (e.clientX > 0) DragGhost.move(e.clientX, e.clientY);
  });

  section.addEventListener('dragend', e => {
    const slot = e.target.closest('.bench-slot');
    if (slot) slot.classList.remove('dragging');
    ghost.style.display = 'none';
    dragData = null;
    section.classList.remove('drag-over');
  });

  // Dropping anywhere on the bench panel benches the dragged group member.
  section.addEventListener('dragover', e => {
    if (!dragData || dragData.group === 'bench' || dragData.group === 'unplaced') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    section.classList.add('drag-over');
  });

  section.addEventListener('dragleave', e => {
    if (!section.contains(e.relatedTarget)) section.classList.remove('drag-over');
  });

  section.addEventListener('drop', e => {
    if (!dragData || dragData.group === 'bench' || dragData.group === 'unplaced') return;
    e.preventDefault();
    section.classList.remove('drag-over');
    const player = (State.groups[dragData.group] || [])[dragData.slot];
    ghost.style.display = 'none';
    const uid = player && player.uid;
    dragData = null;
    if (!uid) return;
    const result = RosterEdit.BenchPlayer(uid);
    if (!result.success) { showToast(result.error); return; }
    commit();
    showToast(`Benched ${result.player.name}`);
  });
})();

function renderManualChanges() {
  const container = document.getElementById('manual-changes');
  const entries = Object.entries(State.buffOverrides);

  if (entries.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  let html = '<h3>&#9888; Manual Changes Required</h3><ul>';

  for (const [key, override] of entries) {
    const parts = key.split(':');
    const gi = parseInt(parts[0]);
    const uid = parts[1];
    const toBuff = Config.Buffs[override.buffId];
    const fromBuff = Config.Buffs[override.originalBuffId];
    if (!toBuff || !fromBuff) continue;

    // Find player by uid for name and class color
    const group = State.groups[gi] || [];
    const player = group.find(p => p.uid === uid);
    const displayName = player ? player.name.split('-')[0] : 'Unknown';
    const colorClass = player ? classColorClass(player.class) : 'cc-unknown-primary';

    html += `<li>
      <span class="change-player ${colorClass}">${esc(displayName)}</span>
      <span>(Group ${gi + 1})</span>
      <span class="change-arrow">&#8594;</span>
      <span>Use <span class="change-buff">${esc(toBuff.name)}</span> instead of <span class="change-buff">${esc(fromBuff.name)}</span></span>
      <span class="change-remove" data-override-key="${esc(key)}" title="Remove override">&times;</span>
    </li>`;
  }
  html += '</ul>';
  container.innerHTML = html;

  // Wire up remove buttons
  container.querySelectorAll('.change-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      delete State.buffOverrides[btn.dataset.overrideKey];
      commit();
    });
  });
}

// ── CONFIRM DIALOG ──────────────────────────────────────────────
// The one styled yes/no prompt (replaces window.confirm, which blocks the page and
// cannot be styled or tested). Modal.confirm() resolves true only when the confirm
// button is pressed; Cancel, Escape and a newer confirm replacing it all resolve false.
// Cancel holds the initial focus so Enter never confirms a destructive action by accident.
const Modal = {
  resolver: null,
  confirm({ title = 'Are you sure?', message = '', confirmLabel = 'Continue', cancelLabel = 'Cancel' } = {}) {
    const dialog = document.getElementById('confirm-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(false);
    this.settle(false);
    document.getElementById('confirm-heading').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('btn-confirm-ok').textContent = confirmLabel;
    const cancel = document.getElementById('btn-confirm-cancel');
    cancel.textContent = cancelLabel;
    return new Promise(resolve => {
      this.resolver = resolve;
      dialog.returnValue = '';
      if (!dialog.open) dialog.showModal();
      cancel.focus();
    });
  },
  settle(result) {
    const resolve = this.resolver;
    this.resolver = null;
    if (resolve) resolve(result);
  },
};
document.getElementById('btn-confirm-ok').addEventListener('click', () => document.getElementById('confirm-dialog').close('ok'));
document.getElementById('btn-confirm-cancel').addEventListener('click', () => document.getElementById('confirm-dialog').close());
document.getElementById('confirm-dialog').addEventListener('close', e => Modal.settle(e.target.returnValue === 'ok'));

// ── TOAST NOTIFICATION ──────────────────────────────────────────
// One shared timer: a toast that arrives while another is showing restarts the
// countdown instead of being hidden by the earlier toast's timeout.
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ── CLIPBOARD ───────────────────────────────────────────────────
// Copies text and toasts the result. When the browser refuses (permission, an
// insecure page, no focus) the text opens in a dialog instead, selected, so it
// can still be copied by hand.
function showManualCopy(text) {
  const dialog = document.getElementById('manual-copy-dialog');
  const area = document.getElementById('manual-copy-text');
  document.getElementById('close-manual-copy').onclick = () => dialog.close();
  area.value = text;
  dialog.showModal();
  area.focus();
  area.select();
}
function copyText(text, successMessage) {
  let written;
  try { written = navigator.clipboard.writeText(text); } catch (err) { written = Promise.reject(err); }
  return written.then(() => showToast(successMessage), () => showManualCopy(text));
}

// ── VERSION AUTO-DETECT SUGGESTION (backlog #13) ──────────────────
// Thin DOM wiring around the pure detectVersionFromTemplateId(): shows the
// same non-blocking banner pattern as RaidHelperSync's sync-banner. Never
// switches anything by itself — only the explicit "Switch" click does, by
// clicking the real [data-version] toolbar button so every existing
// side-effect of switching versions (initGroups, toast, etc.) still runs.
function hideVersionSuggestBanner() {
  const banner = document.getElementById('version-suggest-banner');
  if (banner) banner.hidden = true;
}
function maybeSuggestVersionSwitch(templateId) {
  const detected = detectVersionFromTemplateId(templateId);
  if (!detected || detected === State.gameVersion || !GameVersions[detected]) { hideVersionSuggestBanner(); return; }
  const banner = document.getElementById('version-suggest-banner');
  const text = document.getElementById('version-suggest-text');
  const switchBtn = document.getElementById('btn-version-switch');
  const dismissBtn = document.getElementById('btn-version-dismiss');
  if (!banner || !text || !switchBtn || !dismissBtn) return;
  text.textContent = `This Raid-Helper event uses the ${GameVersions[detected].name} template — switch rulesets?`;
  banner.hidden = false;
  switchBtn.onclick = () => {
    const versionBtn = document.querySelector(`.game-version-tab[data-version="${detected}"]`);
    if (versionBtn) versionBtn.click();
    hideVersionSuggestBanner();
  };
  dismissBtn.onclick = hideVersionSuggestBanner;
}

// Toolbar mirror of the header autosave-status line (nav redesign).
function mirrorSaveStatus() {
  const status = document.getElementById('autosave-status');
  const statusLine = document.getElementById('roster-status-line');
  if (!statusLine) return;
  statusLine.textContent = status.textContent;
  if (status.dataset.failed) statusLine.dataset.failed = 'true';
  else delete statusLine.dataset.failed;
}

// What a PlanStore write came to (it runs a moment after the change, see saveSoon).
function showSaveOutcome(outcome) {
  const status = document.getElementById('autosave-status');
  if (outcome.ok) {
    status.textContent = LiveSync.statusText('Saved on this device');
    delete status.dataset.failed;
    // Saving made room by removing the oldest saved plans: say which and why.
    if (outcome.evicted.length) {
      const why = outcome.reason === 'quota' ? 'Browser storage was full' : `Plan limit reached (${PlanStore.max} kept)`;
      showToast(`${why}: removed the oldest saved plan${outcome.evicted.length === 1 ? '' : 's'} (${outcome.evicted.join(', ')})`);
    }
  } else {
    status.textContent = 'Could not save — export a copy';
    status.dataset.failed = 'true';
  }
  mirrorSaveStatus();
}

function persistWorkingPlan() {
  const result = PlanSession.observe();
  TabWatch.dropIfElsewhere();
  LiveSync.onRender();
  const status = document.getElementById('autosave-status');
  if (result) {
    // Any change to the plan retires the "updated by someone else" Undo, which would drop it.
    if (result.changed) { RemoteUpdate.hide(); TabWatch.hide(); }
    if (result.changed || status.dataset.failed) {
      try { PlanStore.saveSoon(localStorage, result.current, showSaveOutcome); }
      catch { showSaveOutcome({ ok: false }); }
    }
    // A failed save keeps saying so until a later write lands.
    if (!status.dataset.failed) status.textContent = LiveSync.statusText('Saved on this device');
  }
  document.getElementById('btn-undo').disabled = !PlanSession.undo.length;
  document.getElementById('btn-redo').disabled = !PlanSession.redo.length;
  document.getElementById('optimize-mode').value = State.optimizerMode;
  mirrorSaveStatus();
  syncStrategyChrome();
}

// Refreshes every UI surface that reflects the current optimizer strategy:
// the split-button menu's checkmark + descriptions, the muted "Strategy: X"
// label, and the phone segmented control. Called from persistWorkingPlan
// (itself called after nearly every state change — import, optimize, undo/
// redo, tab switches, loading a plan) so all of them stay correct no matter
// which entry point changed State.optimizerMode.
function syncStrategyChrome() {
  const mode = State.optimizerMode || 'max_dps';
  const labelValue = document.getElementById('strategy-label-value');
  if (labelValue) labelValue.textContent = strategyLabel(mode);
  document.querySelectorAll('#optimize-strategy-menu [data-mode]').forEach(item => {
    const current = item.dataset.mode === mode;
    item.classList.toggle('menu-item-current', current);
    const check = item.querySelector('.menu-item-check');
    if (check) check.textContent = current ? '✓' : '';
  });
  document.querySelectorAll('#phone-strategy-seg [data-mode]').forEach(item => {
    item.setAttribute('aria-pressed', String(item.dataset.mode === mode));
  });
  renderPhoneSummary();
}

// The phone's collapsed context row: line 1 "<raid> · <strategy>", line 2
// "<plan title> · notes" (notes only when the plan has some).
function renderPhoneSummary() {
  const main = document.getElementById('phone-summary-main');
  const sub = document.getElementById('phone-summary-sub');
  if (!main || !sub) return;
  const raid = Config.Raids[State.selectedRaid];
  main.textContent = `${raid ? raid.name : 'No raid'} (${raid ? raid.size : 25}) · ${strategyLabel(State.optimizerMode || 'max_dps')}`;
  const hasNotes = !!(State.notes && State.notes.trim());
  sub.textContent = `${State.rosterName || 'Untitled plan'}${hasNotes ? ' · notes' : ''}`;
}

function undoPlanChange() {
  if (!PlanSession.undoLast()) return;
  closePlayerEditor(); closeBuffPicker();
  initGroups(); commit(); renderLastRun(null);
  RaidHelperSync.hideBanner();
  showToast('Change undone');
}

function redoPlanChange() {
  if (!PlanSession.redoLast()) return;
  closePlayerEditor(); closeBuffPicker();
  initGroups(); commit(); renderLastRun(null);
  RaidHelperSync.hideBanner();
  showToast('Change redone');
}

function renderReadiness() {
  if (!GameVersions[State.gameVersion].modeled) {
    document.getElementById('readiness-text').textContent = `${GameVersions[State.gameVersion].name} · Manual planning · Buff and optimizer rules pending`;
    return;
  }
  const floors = Optimizer.floorsFor(Config.Raids[State.selectedRaid]?.size || 25);
  const tanks = State.roster.filter(p => p.role === 'tank').length;
  const healers = State.roster.filter(p => p.role === 'healer').length;
  const missing = Object.keys(getMissingBuffInsights()).filter(id => Config.Buffs[id]).length;
  const tankText = tanks < floors.tank ? `${floors.tank - tanks} tank${floors.tank - tanks === 1 ? '' : 's'} short` : `${tanks} tank slots filled`;
  const healerText = healers < floors.healer ? `${floors.healer - healers} healer${floors.healer - healers === 1 ? '' : 's'} short` : `${healers} healers ready`;
  // Classic Era is faction-locked: Shaman and Paladin cannot exist in the
  // same real raid. A roster that has both is a data problem worth calling
  // out, not something the optimizer should silently paper over.
  const rules = activeRules();
  const factionWarning = (rules.rules && rules.rules.factionLock && Faction.current() === 'mixed')
    ? ' · Mixed Horde/Alliance roster — impossible in Classic Era' : '';
  document.getElementById('readiness-text').textContent = hasLoadedWork()
    ? `${tankText} · ${healerText} · ${missing} missing party buffs${State.preferredSlots.length ? ` · ${State.preferredSlots.length} preferred slot${State.preferredSlots.length === 1 ? '' : 's'} open` : ''}${factionWarning}`
    : 'Import a roster, or click an empty slot to request a class and spec';
}

// ── RAID NOTES (backlog #11) ────────────────────────────────────
// Reflects State.notes into the textarea without disturbing an in-progress
// edit (commit() runs far more often than the user types), and shows a
// small dot on the collapsed "Raid notes" summary so non-empty notes aren't
// invisible when the panel is closed.
function syncRaidNotesUI() {
  const el = document.getElementById('raid-notes-textarea');
  const badge = document.getElementById('raid-notes-badge');
  if (el && document.activeElement !== el) el.value = State.notes || '';
  if (badge) badge.hidden = !(State.notes && State.notes.trim());
  renderPhoneSummary();
}

(function initRaidNotes() {
  const el = document.getElementById('raid-notes-textarea');
  if (!el) return;
  el.addEventListener('input', () => {
    State.notes = el.value.slice(0, NOTES_MAX_LENGTH);
    const badge = document.getElementById('raid-notes-badge');
    if (badge) badge.hidden = !(State.notes && State.notes.trim());
    persistWorkingPlan();
  });
})();

// ── LOCAL STORAGE ───────────────────────────────────────────────
function getSavedRosters() {
  try { return JSON.parse(localStorage.getItem('pp_rosters') || '{}'); }
  catch { return {}; }
}
function saveRosterToStorage(name, data) {
  const rosters = getSavedRosters();
  rosters[name] = data;
  return safeSetItem(localStorage, 'pp_rosters', JSON.stringify(rosters));
}
function deleteRosterFromStorage(name) {
  const rosters = getSavedRosters();
  delete rosters[name];
  return safeSetItem(localStorage, 'pp_rosters', JSON.stringify(rosters));
}

function rememberImport(source) {
  try {
    ImportHistory.add(localStorage, source);
    return '';
  } catch {
    return ' — Import history could not be saved in this browser. Export JSON to keep a copy.';
  }
}

function renderImportHistory(list, onLoad = () => {}, limit = 6) {
  if (!list) return;
  let items;
  try { items = ImportHistory.read(localStorage); }
  catch { list.textContent = 'Import history is unavailable because browser storage is blocked.'; return; }
  if (!items.length) {
    list.innerHTML = '<div class="saved-empty">No import history yet. Your next successful import will appear here automatically.</div>';
    return;
  }
  list.classList.toggle('history-preview', Number.isFinite(limit));
  list.innerHTML = items.slice(0, limit).map(item => {
    const r = item.roster;
    const source = r.sourceEventId ? `Raid-Helper event ${r.sourceEventId}` : (item.source || 'Imported roster');
    return `<div class="history-row">
      <button type="button" class="saved-item history-open" data-history-open="${esc(item.id)}">
        <span class="saved-item-name">${esc(r.name)} · ${esc(Config.Raids[r.raid].name)}</span>
        <span class="saved-item-meta">${esc(new Date(item.importedAt).toLocaleString())} · ${r.players.length} seated · ${r.bench.length} benched</span>
        <span class="saved-item-meta">${esc(source)}</span>
      </button>
      <button type="button" class="history-remove" data-history-delete="${esc(item.id)}" aria-label="Remove import from ${esc(new Date(item.importedAt).toLocaleString())}" title="Remove from history">&times;</button>
    </div>`;
  }).join('');
  if (items.length > limit) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn-secondary history-more';
    more.textContent = `View all imports (${items.length})`;
    more.onclick = showImportHistoryModal;
    list.appendChild(more);
  }
  list.querySelectorAll('[data-history-open]').forEach(button => button.onclick = () => {
    const item = items.find(entry => entry.id === button.dataset.historyOpen);
    if (!item || !Import.loadRoster(item.roster)) { showToast('That import could not be reopened'); return; }
    State.buffOverrides = {};
    RaidHelperSync.hideBanner();
    renderLastRun(null);
    document.getElementById('raid-select').value = State.selectedRaid;
    initGroups();
    commit();
    onLoad();
    showView('app');
    showToast('Reopened imported roster');
    RaidHelperSync.check();
  });
  list.querySelectorAll('[data-history-delete]').forEach(button => button.onclick = () => {
    try {
      ImportHistory.remove(localStorage, button.dataset.historyDelete);
      renderImportHistory(list, onLoad, limit);
    } catch { showToast('Could not remove this import from browser storage'); }
  });
}

// Shared by every path that hides the Save/Load overlay (Cancel, click-
// outside, Escape, and completing the action) so the focus trap always
// releases and returns focus to whatever opened it.
function closeSaveOverlay() {
  const overlay = document.getElementById('save-overlay');
  overlay.classList.remove('visible');
  FocusTrap.close(overlay);
}

function showImportHistoryModal() {
  const dialog = document.getElementById('history-dialog');
  renderImportHistory(document.getElementById('all-history-list'), () => {
    dialog.close();
    closeSaveOverlay();
  }, Infinity);
  dialog.showModal();
  document.getElementById('all-history-list').scrollTop = 0;
}

(function initHistoryDialog() {
  const dialog = document.getElementById('history-dialog');
  document.getElementById('btn-close-history').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    renderImportHistory(document.getElementById('landing-history-list'));
    renderImportHistory(document.getElementById('load-history-list'), () => closeSaveOverlay());
  });
})();

// ── MODAL: SAVE ─────────────────────────────────────────────────
function showSaveModal() {
  const modal = document.getElementById('save-modal');
  const overlay = document.getElementById('save-overlay');
  const trigger = document.activeElement;

  const defaultName = State.rosterName !== NO_ROSTER_NAME ? State.rosterName :
    'Raid ' + new Date().toLocaleDateString();

  modal.innerHTML = `
    <h3>Save a copy</h3>
    <input class="save-input" id="save-name-input" type="text" value="${esc(defaultName)}" placeholder="Roster name...">
    <div class="import-buttons">
      <button class="btn btn-secondary" id="btn-cancel-save">Cancel</button>
      <button class="btn btn-primary" id="btn-do-save">Save</button>
    </div>`;

  overlay.setAttribute('aria-label', 'Save a copy');
  overlay.classList.add('visible');
  FocusTrap.open(overlay, trigger, closeSaveOverlay);

  document.getElementById('btn-cancel-save').onclick = closeSaveOverlay;
  document.getElementById('btn-do-save').onclick = () => {
    const name = document.getElementById('save-name-input').value.trim();
    if (!name) return;
    const data = Import.exportRoster(name);
    if (!saveRosterToStorage(name, data)) return;
    State.rosterName = name;
    closeSaveOverlay();
    showToast(`Roster "${name}" saved`);
    commit();
  };
  overlay.onclick = e => { if (e.target === overlay) closeSaveOverlay(); };

  document.getElementById('save-name-input').focus();
  document.getElementById('save-name-input').select();
}

// ── MODAL: COMP TEMPLATES (backlog #1) ───────────────────────────
// Shares the Save modal's overlay/markup slot rather than adding a new one.
function showTemplatesModal() {
  const modal = document.getElementById('save-modal');
  const overlay = document.getElementById('save-overlay');
  const trigger = document.activeElement;
  const gameVersion = State.gameVersion, raid = State.selectedRaid;
  const templates = Templates.list(localStorage, gameVersion, raid);
  const raidLabel = Config.Raids[raid]?.name || raid;
  const versionLabel = GameVersions[gameVersion]?.name || gameVersion;
  const anyLocked = (State.roster || []).some(p => p.locked);

  let listHTML = '';
  if (!templates.length) {
    listHTML = '<p class="modal-empty-note">No templates saved for this raid yet</p>';
  } else {
    for (const t of templates) {
      listHTML += `<div class="saved-roster-item" data-template="${esc(t.name)}">
        <div><span class="roster-item-name">${esc(t.name)}</span><br><span class="roster-item-meta">${t.count} players &middot; ${esc(new Date(t.savedAt).toLocaleDateString())}</span></div>
        <button class="roster-item-delete" data-template-delete="${esc(t.name)}" title="Delete">&times;</button>
      </div>`;
    }
  }

  modal.innerHTML = `
    <h3>Comp Templates</h3>
    <p class="modal-note">${esc(versionLabel)} &middot; ${esc(raidLabel)}. Save tonight's group layout, then apply it to a fresh import to seed the same names into the same groups. Optimize fills the rest.</p>
    <div class="import-buttons">
      <input class="save-input" id="template-name-input" type="text" placeholder="Template name...">
      <button class="btn btn-secondary" id="btn-do-save-template">Save current layout</button>
    </div>
    <h4>Saved templates</h4>
    <div class="saved-roster-list">${listHTML}</div>
    <div class="import-buttons">
      ${anyLocked ? '<button type="button" class="btn btn-quiet" id="btn-unlock-templates">Unlock all placements</button>' : '<span></span>'}
      <button class="btn btn-secondary" id="btn-cancel-templates">Close</button>
    </div>`;

  overlay.setAttribute('aria-label', 'Comp Templates');
  overlay.classList.add('visible');
  FocusTrap.open(overlay, trigger, closeSaveOverlay);

  document.getElementById('btn-cancel-templates').onclick = closeSaveOverlay;
  overlay.onclick = e => { if (e.target === overlay) closeSaveOverlay(); };

  document.getElementById('btn-do-save-template').onclick = () => {
    const name = document.getElementById('template-name-input').value.trim();
    if (!name) return;
    const result = Templates.save(localStorage, name, gameVersion, raid);
    if (!result.success) { showToast(result.error); return; }
    showToast(`Template "${name}" saved`);
    showTemplatesModal();
  };

  modal.querySelectorAll('[data-template]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.dataset.templateDelete) return;
      const name = item.dataset.template;
      const result = Templates.applyToState(localStorage, name, gameVersion, raid);
      closeSaveOverlay();
      if (!result.success) { showToast(result.error); return; }
      commit();
      showToast(`Applied "${name}" — ${result.matched} seated in their old groups, ${result.unmatched} left for Optimize`);
    });
  });
  modal.querySelectorAll('[data-template-delete]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const deleted = Templates.delete(localStorage, btn.dataset.templateDelete, gameVersion, raid);
      showTemplatesModal();
      showToast(deleted.success ? 'Template deleted' : deleted.error);
    });
  });
  document.getElementById('btn-unlock-templates')?.addEventListener('click', () => {
    for (const p of State.roster) p.locked = false;
    commit();
    showTemplatesModal();
    showToast('Unlocked all template placements');
  });

  document.getElementById('template-name-input').focus();
}

// ── MODAL: LOAD ─────────────────────────────────────────────────
function showLoadModal() {
  const modal = document.getElementById('save-modal');
  const overlay = document.getElementById('save-overlay');
  const trigger = document.activeElement;
  const rosters = getSavedRosters();
  const names = Object.keys(rosters);

  let listHTML = '';
  if (names.length === 0) {
    listHTML = '<p class="modal-empty-note">No saved rosters yet</p>';
  } else {
    for (const name of names) {
      const r = rosters[name];
      const count = r.players ? r.players.length : 0;
      const raid = r.raid ? (Config.Raids[r.raid]?.name || r.raid) : '';
      listHTML += `<div class="saved-roster-item" data-name="${esc(name)}">
        <div><span class="roster-item-name">${esc(name)}</span><br><span class="roster-item-meta">${count} players — ${esc(raid)}</span></div>
        <button class="roster-item-delete" data-delete="${esc(name)}" title="Delete">&times;</button>
      </div>`;
    }
  }

  modal.innerHTML = `
    <h3>Load Roster</h3>
    <h4>Saved rosters</h4>
    <div class="saved-roster-list">${listHTML}</div>
    <h4>Import history</h4>
    <p class="modal-note">Latest 30 imports in this browser. Snapshots do not include later edits.</p>
    <div class="saved-list" id="load-history-list"></div>
    <div class="import-buttons">
      <button class="btn btn-secondary" id="btn-cancel-load">Close</button>
    </div>`;

  overlay.setAttribute('aria-label', 'Load Roster');
  overlay.classList.add('visible');
  FocusTrap.open(overlay, trigger, closeSaveOverlay);

  renderImportHistory(document.getElementById('load-history-list'), () => closeSaveOverlay());
  document.getElementById('btn-cancel-load').onclick = closeSaveOverlay;
  overlay.onclick = e => { if (e.target === overlay) closeSaveOverlay(); };

  modal.querySelectorAll('.saved-roster-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.dataset.delete) return;
      const name = item.dataset.name;
      const data = rosters[name];
      if (Import.loadRoster(data)) {
        closeSaveOverlay();
        initGroups();
        commit();
        showToast(`Loaded "${name}"`);
        RaidHelperSync.check();
      }
    });
  });

  modal.querySelectorAll('.roster-item-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name = btn.dataset.delete;
      if (!deleteRosterFromStorage(name)) return;
      showLoadModal(); // re-render
      showToast(`Deleted "${name}"`);
    });
  });
}

// ── MODAL: ATTENDANCE (feature-backlog-2.md #2) ──────────────────
const AttendanceUI = { sortKey: 'name', sortDir: 1, version: null };

function showAttendanceModal() {
  const dialog = document.getElementById('attendance-dialog');
  const data = computeAttendance(getSavedRosters());
  const versions = Object.keys(data);
  if (!versions.length) {
    document.getElementById('attendance-body').innerHTML =
      '<div class="saved-empty">No named saved rosters yet. Save a roster (toolbar &rarr; Save) after a raid to start building attendance history.</div>';
    dialog.showModal();
    return;
  }
  AttendanceUI.version = versions.includes(State.gameVersion) ? State.gameVersion : versions[0];
  AttendanceUI.sortKey = 'name';
  AttendanceUI.sortDir = 1;
  renderAttendanceBody(data);
  dialog.showModal();
}

function renderAttendanceBody(data) {
  const body = document.getElementById('attendance-body');
  const versions = Object.keys(data);
  const tabsHTML = versions.length > 1 ? `<div class="attendance-version-tabs">${versions.map(v =>
    `<button type="button" data-attendance-version="${esc(v)}" aria-pressed="${v === AttendanceUI.version}">${esc((GameVersions[v] || {}).name || v)}</button>`
  ).join('')}</div>` : '';

  const rows = (data[AttendanceUI.version] || []).slice();
  const key = AttendanceUI.sortKey, dir = AttendanceUI.sortDir;
  rows.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'name') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    else { av = av || 0; bv = bv || 0; }
    return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
  });

  // Cross-reference against the LIVE bench (only meaningful when viewing the
  // version currently loaded) to flag "benched often, benched again" — the
  // hint feature-backlog-2.md #2 asks for.
  const currentlyBenched = AttendanceUI.version === State.gameVersion
    ? new Set((State.bench || []).map(p => p.name)) : new Set();

  const arrow = (col) => AttendanceUI.sortKey === col ? (AttendanceUI.sortDir === 1 ? ' ↑' : ' ↓') : '';
  const sortState = (col) => AttendanceUI.sortKey === col ? (AttendanceUI.sortDir === 1 ? 'ascending' : 'descending') : 'none';

  const tableHTML = rows.length ? `
    <table class="attendance-table">
      <thead><tr>
        <th aria-sort="${sortState('name')}" data-attendance-sort="name">Name${arrow('name')}</th>
        <th class="num" aria-sort="${sortState('seated')}" data-attendance-sort="seated">Seated${arrow('seated')}</th>
        <th class="num" aria-sort="${sortState('benched')}" data-attendance-sort="benched">Benched${arrow('benched')}</th>
        <th class="num" aria-sort="${sortState('absent')}" data-attendance-sort="absent">Absent${arrow('absent')}</th>
        <th aria-sort="${sortState('lastSeen')}" data-attendance-sort="lastSeen">Last seen${arrow('lastSeen')}</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.name)}${currentlyBenched.has(r.name) && r.benched >= 2 ? '<span class="attendance-hint-badge" title="Benched often, and benched again in the current plan">Benched again</span>' : ''}</td>
        <td class="num">${r.seated}</td>
        <td class="num">${r.benched}</td>
        <td class="num">${r.absent}</td>
        <td>${r.lastSeen ? esc(new Date(r.lastSeen).toLocaleDateString()) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="saved-empty">No saved rosters for this version yet.</div>';

  body.innerHTML = tabsHTML + tableHTML;

  body.querySelectorAll('[data-attendance-version]').forEach(btn => btn.onclick = () => {
    AttendanceUI.version = btn.dataset.attendanceVersion;
    renderAttendanceBody(data);
  });
  body.querySelectorAll('[data-attendance-sort]').forEach(th => th.onclick = () => {
    const col = th.dataset.attendanceSort;
    if (AttendanceUI.sortKey === col) AttendanceUI.sortDir *= -1;
    else { AttendanceUI.sortKey = col; AttendanceUI.sortDir = 1; }
    renderAttendanceBody(data);
  });
}

(function initAttendanceDialog() {
  const dialog = document.getElementById('attendance-dialog');
  document.getElementById('btn-attendance').onclick = showAttendanceModal;
  document.getElementById('btn-close-attendance').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
})();

// ── MODAL: COMPARE OPTIMIZER MODES (feature-backlog-2.md #5) ─────
const MODE_LABELS = { max_dps: 'Max DPS', tank_mit: 'Tank Mitigation', balanced: 'Balanced', relaxed: 'Relaxed' };

function showCompareModesModal() {
  if (!GameVersions[State.gameVersion].modeled) { showToast(GameVersions[State.gameVersion].note); return; }
  if (State.roster.length === 0) { showToast('Import a roster first'); return; }
  const dialog = document.getElementById('compare-modes-dialog');
  const body = document.getElementById('compare-modes-body');
  body.innerHTML = '<div class="compare-modes-loading">Running all four optimizer modes…</div>';
  dialog.showModal();
  // Paint the loading state before the synchronous 4x-optimizer pass (cheap
  // at raid scale, but still worth a frame so the dialog doesn't look frozen).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const results = compareOptimizerModes();
    renderCompareModesBody(results);
  }));
}

function renderCompareModesBody(results) {
  const body = document.getElementById('compare-modes-body');
  if (!results) { body.innerHTML = '<div class="saved-empty">Nothing to compare yet.</div>'; return; }

  body.innerHTML = `<div class="compare-modes-grid">${Object.entries(results).map(([mode, r]) => `
    <div class="compare-mode-col">
      <h4>${esc(MODE_LABELS[mode] || mode)}</h4>
      <div class="compare-mode-stat"><strong>${r.groupCount}</strong> groups &middot; <strong>${r.seatedCount}</strong> seated &middot; <strong>${r.benchedCount}</strong> benched</div>
      <div class="compare-mode-stat">Buffs covered: <strong>${r.buffsCoveredCount}/${r.buffsTotal}</strong></div>
      ${r.meleeGroupsTotal != null ? `<div class="compare-mode-stat">Windfury in melee groups: <strong>${r.meleeGroupsWithWindfury}/${r.meleeGroupsTotal}</strong></div>` : ''}
      ${r.tankMitigation.length ? `<div class="compare-mode-stat">Tank group mitigation:<br>${r.tankMitigation.map(t => `Group ${t.groupIndex}: ${esc(t.buffs.join(', ') || 'none')}`).join('<br>')}</div>` : ''}
      ${r.missingBuffs.length ? `<div class="compare-mode-missing">Missing: ${esc(r.missingBuffs.join(', '))}</div>` : ''}
      <button type="button" class="btn btn-primary" data-apply-mode="${esc(mode)}">Apply</button>
    </div>
  `).join('')}</div>`;

  body.querySelectorAll('[data-apply-mode]').forEach(btn => btn.onclick = () => {
    document.getElementById('optimize-mode').value = btn.dataset.applyMode;
    document.getElementById('compare-modes-dialog').close();
    document.getElementById('btn-optimize').click();
  });
}

(function initCompareModesDialog() {
  const dialog = document.getElementById('compare-modes-dialog');
  document.getElementById('btn-compare-modes').onclick = showCompareModesModal;
  document.getElementById('btn-close-compare-modes').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
})();

// ── IMPORT (shared by the landing card and the toolbar modal) ───
// Accepts: a raid-helper event URL, an API URL, a bare event ID, raw JSON,
// or a PP: addon/share string. Resolves to { url }, { text } or { error }: only the
// Raid-Helper hosts the CSP's connect-src allows are ever fetched.
function normalizeImportSource(raw) {
  const t = (raw || '').trim();
  // The v4 events endpoint carries every sign-up; the raidplan endpoint only
  // holds a composition someone already built in Raid-Helper (often empty).
  const eventsApi = (id) => `https://raid-helper.dev/api/v4/events/${id}`;
  if (/^\d{6,}$/.test(t)) return { url: eventsApi(t), eventId: t };
  if (/^https?:\/\//i.test(t)) {
    // Raid-Helper answers on raid-helper.dev and raid-helper.xyz (no port or userinfo).
    // An explicit API link is fetched as pasted, over https, so it needs the exact host.
    // Event and raidplan page links only yield an event ID (the fetch always goes to the
    // fixed events API), so any subdomain (www.) is fine and text after the URL is ignored.
    // `eventId` is only known when the roster comes from the events endpoint,
    // which is what Refresh re-reads. Any other link is refused, not fetched.
    const parts = t.match(/^https?:\/\/([^\/?#\s]+)(\/\S*)?(?:\s[\s\S]*)?$/i);
    const host = parts ? parts[1].toLowerCase() : '';
    const rest = parts ? (parts[2] || '') : '';
    const exactHost = host === 'raid-helper.dev' || host === 'raid-helper.xyz';
    const raidHelperHost = exactHost || /^(?:[a-z0-9-]+\.)+raid-helper\.(?:dev|xyz)$/.test(host);
    if (!raidHelperHost) {
      return { error: 'Only Raid-Helper links can be imported (raid-helper.dev or raid-helper.xyz). Paste the Raid-Helper event link or ID, or paste the JSON text instead.' };
    }
    if (/^\/api\//i.test(rest)) {
      if (!exactHost) return { error: 'Only Raid-Helper links can be imported (raid-helper.dev or raid-helper.xyz). Paste the Raid-Helper event link or ID, or paste the JSON text instead.' };
      const api = rest.match(/^\/api\/v4\/events\/(\d+)/i);
      return { url: 'https://' + host + rest, eventId: api ? api[1] : null };
    }
    const m = rest.match(/^\/(?:event|raidplan)\/(\d+)/i);
    if (!m) return { error: 'That Raid-Helper link is not an event link. Paste the event link (raid-helper.dev/event/...) or ID, or paste the JSON text instead.' };
    return { url: eventsApi(m[1]), eventId: m[1] };
  }
  return { text: t };
}

// Numbers every import as it starts. A Raid-Helper fetch can take seconds, so when a newer
// import has started meanwhile the older one must not land on top of it (importFromText
// drops it after its await). The landing card and the Import dialog share this counter.
const ImportGate = {
  latest: 0,
  begin() { return ++this.latest; },
  isStale(ticket) { return ticket !== this.latest; },
};

// Fetch roster JSON from a URL. Resolves to the body, or null after reporting.
async function fetchRosterJson(url, report) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
    clearTimeout(timeoutId);
    if (!resp.ok) { report(`Fetch failed: HTTP ${resp.status}`, true); return null; }
    return await resp.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') report('Request timed out — try again or paste the JSON directly', true);
    else if (err instanceof TypeError) report('Network error — the server may not allow direct browser requests. Try pasting the JSON instead.', true);
    else report('Fetch failed: ' + err.message, true);
    return null;
  }
}

// Import from anything the user can paste. Returns true when a roster loaded.
// `report(msg, isError)` receives progress and errors; success is toasted.
async function importFromText(raw, report = (m) => showToast(m)) {
  const src = normalizeImportSource(raw);
  if (src.error) { report(src.error, true); return false; }
  if (!src.url && !src.text) return false;
  const ticket = ImportGate.begin();

  if (src.text && src.text.startsWith('PP:')) {
    const result = Import.importAddonString(src.text);
    if (!result.success) { report('Import failed: ' + result.error, true); return false; }
    State.planId = null;
    if (!src.text.startsWith('PP:2:') || State.rosterName === NO_ROSTER_NAME || State.rosterName === 'Imported Roster') State.rosterName = PlanStore.nameFor({}, null);
    document.getElementById('raid-select').value = State.selectedRaid;
    initGroups();
    commit();
    showToast(`Your groups are ready. Imported ${result.playerCount} players from addon string${rememberImport('Pasted roster string')}`);
    return true;
  }

  let jsonStr = src.text;
  if (src.url) {
    report('Fetching roster from Raid-Helper...', false);
    jsonStr = await fetchRosterJson(src.url, report);
    if (jsonStr == null) return false;
    if (ImportGate.isStale(ticket)) { report('Skipped: a newer import replaced this one', false); return false; }
  }

  let metadata;
  let isValidJson = true;
  try { metadata = JSON.parse(jsonStr); } catch { metadata = {}; isValidJson = false; }

  // Backlog #6: a paste that isn't JSON and wasn't a Raid-Helper URL falls
  // back to the tolerant plain-text/CSV roster parser. It never replaces the
  // JSON/URL/PP: paths above — only tried when nothing else matched.
  if (!src.url && !isValidJson) {
    const parsed = Import.parsePlainRoster(jsonStr, State.gameVersion);
    if (parsed.entries.length) {
      PlainRosterImport.preview(parsed, report);
      return false;
    }
  }

  // Backlog #13: a Raid-Helper event (has signUps + templateId) whose template
  // implies a different game version than the one currently active gets a
  // non-blocking suggestion — never applied automatically, never blocks import.
  if (Array.isArray(metadata.signUps) && metadata.templateId) maybeSuggestVersionSwitch(metadata.templateId);
  if (Array.isArray(metadata.players)) {
    if (!Import.loadRoster(metadata)) { report('Import failed: invalid game version or raid', true); return false; }
    initGroups(); commit();
    showToast('Loaded saved roster');
    return true;
  }
  if (src.eventId && Array.isArray(metadata.signUps)) {
    let existing;
    try { existing = PlanStore.read(localStorage).find(p => p.data.planId === 'event:' + src.eventId && (p.data.gameVersion || 'tbc') === State.gameVersion); } catch {}
    // Pasting the link again means "give me this event now": reopen the plan
    // and merge the sign-ups just fetched, so edited seats survive and the
    // roster is current without a second click on Refresh.
    if (existing) {
      PlanStore.restore(existing.data);
      RaidHelperSync.apply(Import.diffRaidHelperSignUps(jsonStr), 'Reopened your plan');
      return true;
    }
  }
  // A different event than the one the open plan is linked to starts that
  // event's own plan. Without this, an open plan with Open-slot requests takes
  // the fill-my-layout path and absorbs the other event's sign-ups under its
  // own name, notes and seats. Pasted JSON carries the event ID as `id`.
  const incomingEventId = src.eventId || (/^\d{6,}$/.test(String(metadata.id || '')) ? String(metadata.id) : null);
  const previousPlan = State.sourceEventId && incomingEventId !== State.sourceEventId ? PlanStore.capture() : null;
  if (previousPlan) PlanStore.startFresh();
  const result = Import.importRaidHelper(jsonStr);
  if (!result.success) {
    if (previousPlan) PlanStore.restore(previousPlan);
    report('Import failed: ' + result.error, true);
    return false;
  }
  if (result.preferredImport) {
    State.sourceEventId = src.eventId || State.sourceEventId;
    State.eventStartTime = PlanStore.eventStart(metadata) || State.eventStartTime;
    if (src.eventId) State.planId = 'event:' + src.eventId;
    if (State.rosterName === NO_ROSTER_NAME) State.rosterName = PlanStore.nameFor(metadata, src.eventId);
    RaidHelperSync.hideBanner(); initGroups(); commit();
    showToast(`Filled ${result.filledCount} preferred slots. Unmatched sign-ups are on the bench${rememberImport(src.url ? 'Raid-Helper URL' : 'Pasted JSON')}`);
    return true;
  }

  State.planId = src.eventId ? 'event:' + src.eventId : null;
  State.rosterName = PlanStore.nameFor(metadata, src.eventId);
  State.sourceEventId = src.eventId || null;
  State.eventStartTime = PlanStore.eventStart(metadata);
  RaidHelperSync.hideBanner();
  document.getElementById('raid-select').value = State.selectedRaid;
  const foldBenched = initGroups();
  commit();
  const historyNotice = rememberImport(src.url ? 'Raid-Helper URL' : 'Pasted JSON');
  // Bench/Tentative/Late sign-ups wait on the bench and Absences are held
  // unplaced, so report those counts rather than leave people unaccounted for.
  const overflow = (result.overflowCount || 0) + foldBenched;
  const extra = [];
  if (overflow) extra.push(`${overflow} over the raid size, benched`);
  else if (result.benchCount) extra.push(`${result.benchCount} benched`);
  if (result.unplacedCount) extra.push(`${result.unplacedCount} absent or without a class`);
  const suffix = extra.length ? ` (${extra.join(', ')})` : '';
  if (result.playerCount === 0 && result.benchCount) {
    report(`Nobody is confirmed yet: ${result.benchCount} Bench, Tentative or Late sign-ups are waiting in Sign-ups, ready to swap in${historyNotice}`, false);
    showToast(`Imported ${result.benchCount} benched sign-ups${historyNotice}`);
    return true;
  }
  showToast(result.wasUnassigned
    ? `Your groups are ready. Imported ${result.playerCount} sign-ups and auto-optimized into ${result.groupCount} groups${suffix}${historyNotice}`
    : `Imported ${result.playerCount} players into ${result.groupCount} groups${suffix}${historyNotice}`);
  return true;
}

// ── PLAIN-TEXT ROSTER IMPORT PREVIEW (feature-backlog-2.md #6) ───
// Drives Import.parsePlainRoster()'s output: a preview dialog lists every
// recognized row (flagging anything defaulted/ambiguous) plus whatever
// lines couldn't be parsed at all, so a leader can catch a misparsed row
// before anything is committed to State — mirrors the split-raids preview
// dialog's Cancel/confirm pattern above.
const PlainRosterImport = {
  pending: null, // last parsePlainRoster() result, for the preview dialog

  renderPreview(parsed) {
    const body = document.getElementById('plain-import-body');
    if (!body) return;
    const rows = parsed.entries.map(e => `
      <div class="plain-import-row${e.status === 'needsReview' ? ' needs-review' : ''}">
        <span class="plain-import-name">${esc(e.name)}</span>
        <span class="plain-import-spec">${esc(e.spec)} ${esc(RosterEdit.ClassLabel(e.class))}</span>
        ${e.status === 'needsReview' ? `<span class="plain-import-flag" title="${esc(e.reason || 'Needs review')}">Needs review</span>` : '<span class="plain-import-ok">OK</span>'}
      </div>`).join('') || '<p class="saved-empty">No recognizable players found.</p>';
    const unparsedHtml = parsed.unparsed.length
      ? `<div class="plain-import-unparsed"><h4>Could not parse (${parsed.unparsed.length})</h4>${parsed.unparsed.map(l => `<div class="plain-import-unparsed-line">${esc(l)}</div>`).join('')}</div>`
      : '';
    const flaggedCount = parsed.entries.filter(e => e.status === 'needsReview').length;
    const summary = document.getElementById('plain-import-summary');
    if (summary) summary.textContent =
      `${parsed.entries.length} player${parsed.entries.length === 1 ? '' : 's'} recognized` +
      (flaggedCount ? `, ${flaggedCount} flagged for review` : '') +
      (parsed.unparsed.length ? `, ${parsed.unparsed.length} line${parsed.unparsed.length === 1 ? '' : 's'} skipped` : '') + '.';
    body.innerHTML = rows + unparsedHtml;
    document.getElementById('btn-plain-import-confirm').disabled = !parsed.entries.length;
  },

  preview(parsed, report) {
    this.pending = parsed;
    this.renderPreview(parsed);
    if (report) report(`Found ${parsed.entries.length} player(s) — review below`, false);
    document.getElementById('plain-import-dialog').showModal();
  },

  confirm() {
    const parsed = this.pending;
    const dialog = document.getElementById('plain-import-dialog');
    if (!parsed || !parsed.entries.length) { dialog.close(); return; }
    const result = Import.importPlainRoster(parsed.entries);
    dialog.close();
    this.pending = null;
    if (!result.success) { showToast('Import failed: ' + result.error); return; }
    State.planId = null;
    closeImportOverlay();
    const landingBox = document.getElementById('landing-import');
    const toolbarBox = document.getElementById('import-textarea');
    if (landingBox) landingBox.value = '';
    if (toolbarBox) toolbarBox.value = '';
    document.getElementById('raid-select').value = State.selectedRaid;
    initGroups();
    commit();
    showView('app');
    SplitFlow.maybeOffer();
    const extra = result.benchCount ? ` (${result.benchCount} benched)` : '';
    showToast(`Imported ${result.playerCount} players from pasted text into ${result.groupCount} groups${extra}${rememberImport('Pasted plain-text roster')}`);
  },

  cancel() {
    document.getElementById('plain-import-dialog').close();
    this.pending = null;
  },
};

// ── RAID-HELPER RE-SYNC ─────────────────────────────────────────
// A roster imported from a Raid-Helper link remembers its event ID. Reopening
// such a roster (or returning to the tab after a while) quietly re-reads the
// event and offers a Refresh when sign-ups changed; the toolbar Refresh button
// pulls on demand. Nothing is merged until the user clicks.
const RaidHelperSync = {
  RECHECK_AFTER_MS: 5 * 60 * 1000,
  hiddenAt: 0,

  eventsApiUrl(id) { return `https://raid-helper.dev/api/v4/events/${id}`; },

  // Fetch the event and diff it against the loaded roster. Resolves to the
  // diff, or null after reporting. Ignores the result if the roster was
  // replaced while the request was in flight.
  async fetchDiff(report) {
    const eventId = State.sourceEventId;
    const planId = State.planId;
    if (!eventId) return null;
    const json = await fetchRosterJson(this.eventsApiUrl(eventId), report);
    if (json == null || State.sourceEventId !== eventId || State.planId !== planId) return null;
    const diff = Import.diffRaidHelperSignUps(json);
    if (!diff.success) { report('Refresh failed: ' + diff.error, true); return null; }
    return diff;
  },

  describe(diff) { return Import.describeRaidHelperChanges(diff); },

  // Quiet check: banner only when something changed, silence on any failure.
  async check() {
    if (!State.sourceEventId) return;
    const diff = await this.fetchDiff(() => {});
    if (!diff) return;
    if (Import.hasRaidHelperChanges(diff)) this.showBanner(diff);
    else this.hideBanner();
  },

  // User-initiated pull: re-reads the event and merges into the plan.
  async refresh() {
    if (!State.sourceEventId) { showToast('This roster is not linked to a Raid-Helper event'); return; }
    showToast('Checking Raid-Helper...');
    const diff = await this.fetchDiff((msg, isError) => { if (isError) showToast(msg); });
    if (!diff) return;
    this.apply(diff, 'Refreshed');
  },

  // Merge a diff into the plan (untouched seats stay put) and report it.
  // Shared by Refresh and by re-pasting the link of an event that already
  // has a plan; `lead` opens the toast.
  apply(diff, lead) {
    this.hideBanner();
    if (diff.eventStartTime) State.eventStartTime = diff.eventStartTime;
    const counts = Import.hasRaidHelperChanges(diff) ? Import.applyRaidHelperSync(diff) : null;
    initGroups();
    commit();
    if (!counts) {
      showToast(diff.promoted.length
        ? `${lead}. Up to date. ${this.describe(diff)}, swap them in from the bench`
        : `${lead}. Roster is up to date with Raid-Helper`);
      return;
    }
    showToast(`${lead}: ${this.describe(counts)}`);
    if (counts.backupSwapReady && counts.backupSwapReady.length) this.showBackupBanner(counts.backupSwapReady);
  },

  showBanner(diff) {
    const banner = document.getElementById('sync-banner');
    const text = document.getElementById('sync-banner-text');
    if (!banner || !text) return;
    text.innerHTML = `Raid-Helper has changed since this roster was imported: <strong>${esc(this.describe(diff))}</strong>.`;
    banner.hidden = false;
  },

  hideBanner() {
    const banner = document.getElementById('sync-banner');
    if (banner) banner.hidden = true;
  },

  // "Backup X is ready — swap in?" — surfaced when a Refresh withdraws or
  // demotes a seated player who had a designated backup still on the bench
  // (see Import.applyRaidHelperSync's backupSwapReady). One click seats that
  // exact backup in the vacated group instead of a generic optimizer Swap In.
  showBackupBanner(list) {
    const banner = document.getElementById('backup-banner');
    const text = document.getElementById('backup-banner-text');
    const actions = document.getElementById('backup-banner-actions');
    if (!banner || !text || !actions) return;
    text.textContent = list.length === 1
      ? `Backup ready: ${list[0].backupName.split('-')[0]} can take ${list[0].primaryName.split('-')[0]}'s seat.`
      : `${list.length} backups are ready to swap in.`;
    actions.innerHTML = list.map((item, i) =>
      `<button type="button" class="btn btn-primary" data-backup-swap="${i}">Swap in ${esc(item.backupName.split('-')[0])}</button>`
    ).join('') + '<button type="button" class="link-btn" id="backup-banner-dismiss">Dismiss</button>';
    actions.querySelectorAll('[data-backup-swap]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = list[Number(btn.dataset.backupSwap)];
        const result = Backups.swapIn(item.primaryName, Number.isInteger(item.groupNumber) ? item.groupNumber - 1 : undefined);
        if (result.success) { commit(); showToast(`Swapped in ${result.player.name.split('-')[0]}`); }
        else showToast(result.error);
        this.hideBackupBanner();
      });
    });
    document.getElementById('backup-banner-dismiss')?.addEventListener('click', () => this.hideBackupBanner());
    banner.hidden = false;
  },

  hideBackupBanner() {
    const banner = document.getElementById('backup-banner');
    if (banner) banner.hidden = true;
  },

  // Refresh is only offered for linked rosters.
  updateControls() {
    const linked = !!State.sourceEventId;
    const btn = document.getElementById('btn-refresh');
    if (btn) btn.hidden = !linked;
    if (!linked) { this.hideBanner(); this.hideBackupBanner(); }
  },
};

document.getElementById('btn-refresh').addEventListener('click', () => RaidHelperSync.refresh());
document.getElementById('btn-sync-apply').addEventListener('click', () => RaidHelperSync.refresh());
document.getElementById('btn-sync-dismiss').addEventListener('click', () => RaidHelperSync.hideBanner());

// Coming back to the tab after a while is a natural moment to look again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { RaidHelperSync.hiddenAt = Date.now(); return; }
  if (!State.sourceEventId || State.view !== 'app') return;
  if (Date.now() - RaidHelperSync.hiddenAt >= RaidHelperSync.RECHECK_AFTER_MS) RaidHelperSync.check();
});

// ── SPLIT SIGN-UPS INTO TWO RAIDS (UI) ──────────────────────────
// Drives RaidSplit.split() from the live roster: offers the split after an
// oversized import (see the two importFromText() call sites below), previews
// both resulting rosters, then on confirmation replaces the current plan
// with Raid A and saves Raid B as a second plan (feature-backlog.md #8).
const SplitFlow = {
  pending: null, // last computed RaidSplit.split() result, for the preview dialog

  // Called after every import; only shows the banner when sign-ups clear the
  // per-raid-size threshold (RaidSplit.suggestThreshold).
  maybeOffer() {
    const total = State.roster.length + (State.bench || []).length;
    if (!RaidSplit.shouldOffer(total, State.selectedRaid)) { this.dismiss(); return; }
    const banner = document.getElementById('split-banner');
    const text = document.getElementById('split-banner-text');
    if (!banner || !text) return;
    const raid = Config.Raids[State.selectedRaid];
    text.textContent = `${total} sign-ups is more than one ${raid.name} (${raid.size}-man) holds.`;
    banner.hidden = false;
  },
  dismiss() {
    const banner = document.getElementById('split-banner');
    if (banner) banner.hidden = true;
  },

  countsFor(list) {
    const roles = {};
    const classes = {};
    for (const p of list) { roles[p.role] = (roles[p.role] || 0) + 1; classes[p.class] = (classes[p.class] || 0) + 1; }
    return { roles, classes };
  },
  renderPreview(result) {
    const body = document.getElementById('split-dialog-body');
    if (!body) return;
    const summarize = (label, half) => {
      const c = this.countsFor(half.seated);
      const dps = (c.roles.melee_dps || 0) + (c.roles.ranged_dps || 0) + (c.roles.caster_dps || 0);
      const classLine = Object.keys(c.classes).sort().map(cls => `${RosterEdit.ClassLabel(cls)} ${c.classes[cls]}`).join(', ') || 'none';
      return `<div class="split-preview-col">
        <h4>${esc(label)}</h4>
        <p>${half.seated.length} seated${half.bench.length ? ` + ${half.bench.length} benched` : ''}</p>
        <p>Tanks ${c.roles.tank || 0} &middot; Healers ${c.roles.healer || 0} &middot; DPS ${dps}</p>
        <p class="split-preview-classes">${esc(classLine)}</p>
      </div>`;
    };
    body.innerHTML = summarize('Raid A (this plan)', result.a) + summarize('Raid B (new plan)', result.b);
  },
  preview() {
    const all = [...State.roster, ...(State.bench || [])];
    const result = RaidSplit.split(all, State.selectedRaid, State.gameVersion);
    if (!result) { showToast('Cannot split: unknown raid'); return; }
    this.pending = result;
    document.getElementById('split-dialog-error').hidden = true;
    this.renderPreview(result);
    document.getElementById('split-dialog').showModal();
  },
  showSaveError() {
    document.getElementById('split-dialog-error-text').textContent =
      "Raid B could not be saved because this browser's storage is full, so the raids were not split and your plan is unchanged. Export this plan as JSON, clear old saved rosters, then try again.";
    document.getElementById('split-dialog-error').hidden = false;
  },
  create() {
    const result = this.pending;
    if (!result) return;
    document.getElementById('split-dialog-error').hidden = true;
    const raidInfo = Config.Raids[result.raidKey];
    const mode = State.optimizerMode || 'max_dps';

    // Raid B is saved before anything about Raid A changes, so a failed save
    // leaves the plan whole. Its players are copies: arranging them cannot
    // touch the live board.
    const copy = (list) => JSON.parse(JSON.stringify(list));
    const groupsB = Optimizer.arrange(copy(result.b.seated), raidInfo.groups, raidInfo.size, 5, mode);
    groupsB.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
    const benchB = copy(result.b.bench).map(p => { p.groupNumber = 0; return p; });

    // Raid B becomes its own saved plan sharing this plan's sourceEventId
    // (compound-keyed by planId + gameVersion, same as every other saved
    // plan — see PlanStore), so Refresh keeps working on either one without
    // disturbing the 'event:<id>' lookup importFromText() uses to reopen A.
    const baseName = State.rosterName && State.rosterName !== NO_ROSTER_NAME ? State.rosterName : (raidInfo.name || 'Raid');
    const planId = State.planId || 'plan:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const dataB = {
      planId: planId + ':B',
      groups: groupsB, bench: benchB,
      campfires: Campfires.empty(),
      gameVersion: State.gameVersion, selectedRaid: State.selectedRaid,
      rosterName: baseName + ' - Raid B',
      sourceEventId: State.sourceEventId,
      eventStartTime: State.eventStartTime,
      optimizerMode: mode,
      buffOverrides: {}, preferredSlots: [], preserveGroupOrder: false,
      notes: '', assignments: { tankHealers:{}, blessings:{}, debuffs:{} }, backups: {},
    };
    try { PlanStore.save(localStorage, dataB); }
    catch { this.showSaveError(); return; }

    const groupsA = Optimizer.arrange(result.a.seated, raidInfo.groups, raidInfo.size, 5, mode);
    groupsA.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
    const benchA = result.a.bench.map(p => { p.groupNumber = 0; return p; });

    // Raid A replaces the current plan in place; stale manual state tied to
    // players who ended up in Raid B is dropped by the usual reconcile pass.
    State.groups = groupsA;
    State.bench = benchA;
    State.roster = groupsA.flat();
    Assignments.reconcileRoster();
    Backups.reconcile();
    State.planId = planId;

    document.getElementById('split-dialog').close();
    this.dismiss();
    this.pending = null;
    commit();
    showToast(`Split into two raids: ${groupsA.flat().length} seated here, "${dataB.rosterName}" saved separately`);
  },
};

document.getElementById('btn-split-offer').addEventListener('click', () => SplitFlow.preview());
document.getElementById('btn-split-dismiss').addEventListener('click', () => SplitFlow.dismiss());
document.getElementById('btn-split-cancel').addEventListener('click', () => document.getElementById('split-dialog').close());
document.getElementById('btn-split-create').addEventListener('click', () => SplitFlow.create());
document.getElementById('btn-split-export').addEventListener('click', () => document.getElementById('btn-export-json').click());

// ── SHARED IMPORT RUNNER ────────────────────────────────────────
// Landing page and the in-app Import dialog both go through this: empty paste
// is reported inline, the button stays disabled while the import runs (it may
// fetch from Raid-Helper), errors land in the status line, and onSuccess runs
// only when a roster was actually loaded.
const statusReporter = (id) => (msg, isError) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
};

async function runImport(inputId, statusId, btnId, onSuccess) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const report = statusReporter(statusId);
  if (btn.disabled) return;   // this runner's import is still in flight (Enter / Ctrl+Enter / a double click)
  const text = input.value.trim();
  if (!text) { report('Paste something first', true); input.focus(); return; }
  btn.disabled = true;
  report('', false);
  try {
    const ok = await importFromText(text, report);
    if (ok) { report('', false); input.value = ''; onSuccess(); }
  } finally {
    btn.disabled = false;
  }
}

// ── IMPORT MODAL (toolbar) ──────────────────────────────────────
function closeImportOverlay() {
  const overlay = document.getElementById('import-overlay');
  overlay.classList.remove('visible');
  FocusTrap.close(overlay);
}
document.getElementById('btn-import').addEventListener('click', () => {
  const overlay = document.getElementById('import-overlay');
  const trigger = document.activeElement;
  overlay.classList.add('visible');
  document.getElementById('import-textarea').value = '';
  statusReporter('import-status')('', false);
  document.getElementById('import-textarea').focus();
  FocusTrap.open(overlay, trigger, closeImportOverlay);
});
document.getElementById('btn-cancel-import').addEventListener('click', closeImportOverlay);
document.getElementById('import-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeImportOverlay();
});
const runDialogImport = () => runImport('import-textarea', 'import-status', 'btn-do-import', () => { closeImportOverlay(); SplitFlow.maybeOffer(); });
document.getElementById('btn-do-import').addEventListener('click', runDialogImport);
document.getElementById('import-textarea').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (!document.getElementById('btn-do-import').disabled) runDialogImport();
  }
});
document.getElementById('btn-plain-import-cancel').addEventListener('click', () => PlainRosterImport.cancel());
document.getElementById('btn-plain-import-confirm').addEventListener('click', () => PlainRosterImport.confirm());

