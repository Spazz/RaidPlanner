// -- PAGE: GUILD SETTINGS > ROLES --------------------------------
// The role editor. One card per role (the six built-in roles, then the guild's own), a permission grid per role in a dialog, New role, Reset to
// defaults for an edited built-in role, Delete for an own role. GET / POST /api/guild/:gid/roles, PUT / DELETE .../roles/:id, POST .../roles/:id/reset.
// Needs guild.roles; the tab is not shown without it. Every mutation answers with the full role list, which replaces the page's data (and the copy the
// People page reads its "Other roles" from, state.rolesList[gid]). What a role may hold comes from the Worker (`allowed` per role and action): this page
// never decides it. Only the Guild Master edits the built-in roles (canEditBuiltin); the Guild Master role itself is fixed.
(function (G) {
  'use strict';

  const SCOPE_LABELS = { guild: 'Whole guild', team: 'One team (given per team)', own_teams: 'Their own teams' };
  const DEFAULT_NAME_LENGTH = 32;
  const FIXED_TEXT = 'The Guild Master always holds every action. This role cannot be changed, so there is always someone who can manage roles.';

  function st() { return G.app.state; }
  function xs() { return st().rolesSettings; }
  function plural(n, one, many) { return G.ui.plural(Number(n) || 0, one, many); }
  function rolesOf(data) { return data && Array.isArray(data.roles) ? data.roles : []; }
  function findRole(data, id) { return rolesOf(data).filter(function (r) { return r.id === id; })[0] || null; }
  function customRoles(data) { return rolesOf(data).filter(function (r) { return r.kind === 'custom'; }); }

  // Whether this viewer can only look at the role: the Guild Master role is fixed, the built-in roles are the Guild Master's to edit.
  function isReadOnly(role, data) {
    if (!role) return false;
    return !!role.fixed || (role.kind === 'builtin' && !(data && data.canEditBuiltin));
  }

  function roleBadgesHtml(role) {
    const out = [];
    if (role.kind === 'custom') out.push('Custom');
    else out.push('Built-in');
    if (role.fixed) out.push('Fixed');
    if (role.customized) out.push('Edited');
    return out.map(function (b) { return '<span class="gs-badge">' + esc(b) + '</span>'; }).join('');
  }

  // "3 people - 1 Discord mapping - 0 guest links": the counts that apply to the role, plus any that are not zero.
  function countsText(role) {
    const parts = [];
    if (role.assignable || role.holders > 0) parts.push(plural(role.holders, 'person', 'people'));
    if (role.assignable || role.mapped > 0) parts.push(plural(role.mapped, 'Discord mapping', 'Discord mappings'));
    if (role.kind === 'custom' || role.id === 'guest' || role.links > 0) parts.push(plural(role.links, 'guest link', 'guest links'));
    if (parts.length) return parts.join(' - ');
    if (role.id === 'member') return 'Held by everyone in the guild';
    if (role.id === 'public') return 'Used by the public page';
    return '';
  }

  function roleCardHtml(role, data) {
    const readOnly = isReadOnly(role, data);
    const counts = countsText(role);
    const edit = '<button type="button" class="gs-btn gs-btn-sm" data-action="role-edit" data-role="' + esc(role.id) + '" data-key="role-edit-' + esc(role.id) + '" aria-label="' +
      (readOnly ? 'View ' : 'Edit ') + esc(role.name) + '">' + (readOnly ? 'View' : 'Edit') + '</button>';
    const del = role.kind === 'custom'
      ? '<button type="button" class="gs-btn gs-btn-sm gs-btn-danger-text" data-action="role-delete" data-role="' + esc(role.id) + '" data-key="role-delete-' + esc(role.id) + '" aria-label="Delete ' + esc(role.name) + '">Delete</button>'
      : '';
    return '<li class="gs-role-card"><div class="gs-role-main"><div class="gs-role-head"><h3 class="gs-h3 gs-role-name">' + esc(role.name) + '</h3>' + roleBadgesHtml(role) + '</div>' +
      (role.note ? '<p class="gs-fine gs-role-note">' + esc(role.note) + '</p>' : '') +
      (counts ? '<p class="gs-role-counts">' + esc(counts) + '</p>' : '') +
      (role.needsTeam ? '<p class="gs-fine">Given for one team</p>' : '') +
      '</div><div class="gs-row-actions">' + edit + del + '</div></li>';
  }

  // opts: { guildData, data (GET /roles or null), alert, notice }
  function settingsHtml(opts) {
    const d = opts.data;
    let body;
    let head = '';
    if (!d) {
      body = G.pages.signin.loadingHtml();
    } else {
      const own = customRoles(d).length;
      const limit = d.limits && d.limits.customRoles ? d.limits.customRoles : 0;
      const atLimit = limit > 0 && own >= limit;
      head = atLimit
        ? '<span class="gs-fine">The limit of ' + esc(limit) + ' own roles is reached.</span>'
        : '<button type="button" class="gs-btn gs-btn-molten" data-action="role-new" data-key="role-new">New role</button>';
      body = '<p class="gs-fine" id="roles-intro">A role is a set of things a person may do. Everyone in the guild is a Member; Officers, Team Leads and the roles you make here add to that.' +
        (d.canEditBuiltin ? '' : ' Only the Guild Master can change the built-in roles.') + '</p>' +
        '<ul class="gs-role-list" aria-label="Roles">' + rolesOf(d).map(function (r) { return roleCardHtml(r, d); }).join('') + '</ul>';
    }
    return '<section class="gs-section" aria-labelledby="settings-title"><div class="gs-section-head gs-section-head-actions">' + head + '</div>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  // -- the permission grid --
  function groupsOf(actions) {
    const groups = [];
    (Array.isArray(actions) ? actions : []).forEach(function (a) {
      if (!a || typeof a.action !== 'string') return;
      const name = a.group || 'Other';
      let g = groups.filter(function (x) { return x.name === name; })[0];
      if (!g) { g = { name: name, items: [] }; groups.push(g); }
      g.items.push(a);
    });
    return groups;
  }

  // The scopes each action may be given to this role, as the Worker computed them. A role being made has no list yet: it takes the one an own role
  // already has, else the catalogue's (an action marked staff is for the Officer role only).
  function allowedMap(role, data) {
    if (role && role.allowed) return role.allowed;
    const template = customRoles(data).filter(function (r) { return r.allowed; })[0];
    if (template) return template.allowed;
    const out = {};
    (data.actions || []).forEach(function (a) { out[a.action] = a.staff ? [] : (Array.isArray(a.scopes) ? a.scopes.slice() : []); });
    return out;
  }

  function reasonFor(role, action) {
    if (action.staff) return 'Officer role only';
    if (role && (role.id === 'guest' || role.id === 'public') && !action.view) return 'Read-only role';
    return 'Not available for this role';
  }

  function permRowHtml(action, n, role, allowed, readOnly) {
    const id = 'role-perm-' + n;
    const scopes = Array.isArray(allowed[action.action]) ? allowed[action.action] : [];
    const held = role && role.permissions && Object.prototype.hasOwnProperty.call(role.permissions, action.action) ? role.permissions[action.action] : '';
    const options = [{ value: '', label: 'No' }];
    scopes.forEach(function (s) { options.push({ value: s, label: SCOPE_LABELS[s] || s }); });
    // A scope the role holds that the rules no longer offer stays visible, so the grid never hides what the role really has.
    if (held && scopes.indexOf(held) < 0) options.push({ value: held, label: SCOPE_LABELS[held] || held });
    const locked = !scopes.length;
    const why = locked ? '<span class="gs-fine gs-perm-why" id="' + id + '-why">' + esc(reasonFor(role, action)) + '</span>' : '';
    return '<div class="gs-perm-row"><label class="gs-perm-label" for="' + id + '">' + esc(action.label || action.action) + '</label>' +
      '<div class="gs-perm-control"><select class="gs-input gs-perm-select" id="' + id + '" data-perm="' + esc(action.action) + '"' + (locked || readOnly ? ' disabled' : '') + (locked ? ' aria-describedby="' + id + '-why"' : '') + '>' +
      G.ui.optionsHtml(options, held) + '</select>' + why + '</div></div>';
  }

  function gridHtml(role, data, readOnly) {
    const allowed = allowedMap(role, data);
    let n = 0;
    return groupsOf(data.actions).map(function (g) {
      return '<fieldset class="gs-fieldset gs-perm-group"><legend class="gs-legend">' + esc(g.name) + '</legend>' +
        g.items.map(function (a) { n += 1; return permRowHtml(a, n, role, allowed, readOnly); }).join('') + '</fieldset>';
    }).join('');
  }

  // role: a role of GET /roles, or null for a new role. data: the GET /roles answer.
  function roleDialogHtml(role, data) {
    const d = data || {};
    if (role && role.fixed) {
      return '<div class="gs-dialog-form gs-dialog-role">' +
        '<h2 class="gs-dialog-title" id="dlg-title">' + esc(role.name) + '</h2>' +
        '<p class="gs-fine" id="dlg-help">' + esc(FIXED_TEXT) + '</p>' +
        '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Close</button></div></div>';
    }
    const isNew = !role;
    const custom = isNew || role.kind === 'custom';
    const readOnly = isReadOnly(role, d);
    const nameLength = d.limits && d.limits.nameLength ? d.limits.nameLength : DEFAULT_NAME_LENGTH;
    const title = isNew ? 'New role' : (readOnly ? esc(role.name) : 'Edit ' + esc(role.name));
    const help = isNew
      ? 'Name the role, then say what the people who hold it may do. You can only give what you can do yourself.'
      : (custom ? 'Change the name or what this role may do. People who hold it keep it.' : (role.note || ''));
    const nameField = custom
      ? '<div class="gs-field"><label class="gs-label" for="dlg-role-name">Role name</label>' +
        '<input class="gs-input" type="text" id="dlg-role-name" name="name" maxlength="' + esc(nameLength) + '" autocomplete="off" required data-field="name" value="' + esc(isNew ? '' : role.name) + '"' + (readOnly ? ' disabled' : '') + '>' +
        '<p class="gs-field-error" id="dlg-err-name" role="alert" hidden></p></div>'
      : '';
    const notes = (!isNew && role.needsTeam ? '<p class="gs-fine">Given for one team</p>' : '') +
      (!isNew && readOnly ? '<p class="gs-fine">Only the Guild Master can change the built-in roles.</p>' : '') +
      (!isNew && role.kind === 'builtin' && role.customized ? '<p class="gs-fine">This role has been edited for this guild.</p>' : '');
    const canReset = !isNew && !readOnly && role.kind === 'builtin' && role.customized;
    const canDelete = !isNew && !readOnly && role.kind === 'custom';
    const reset = canReset
      ? '<div class="gs-role-reset"><button type="button" class="gs-btn" id="dlg-reset-ask" data-action="role-reset-ask">Reset to defaults</button>' +
        '<div id="dlg-reset-confirm" hidden><p class="gs-fine">Reset ' + esc(role.name) + ' to its defaults? What was changed for this guild is lost.</p>' +
        '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="role-reset-cancel">Cancel</button>' +
        '<button type="button" class="gs-btn gs-btn-danger" data-action="role-reset-confirm">Reset to defaults</button></div></div></div>'
      : '';
    return '<form class="gs-dialog-form gs-dialog-role" data-submit="role-form" data-mode="' + (isNew ? 'new' : 'edit') + '"' + (isNew ? '' : ' data-role="' + esc(role.id) + '"') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + title + '</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(help) + '</p>' + notes + nameField +
      '<div class="gs-perm-grid">' + gridHtml(role, d, readOnly) + '</div>' +
      '<p class="gs-field-error" id="dlg-err-permissions" role="alert" hidden></p>' +
      reset +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions" id="dlg-role-footer"><button type="button" class="gs-btn" data-action="dialog-cancel">' + (readOnly ? 'Close' : 'Cancel') + '</button>' +
      (canDelete ? '<button type="button" class="gs-btn gs-btn-danger-outline" data-action="role-delete" data-role="' + esc(role.id) + '">Delete role</button>' : '') +
      (readOnly ? '' : '<button type="submit" class="gs-btn gs-btn-molten">' + (isNew ? 'Create role' : 'Save') + '</button>') + '</div></form>';
  }

  function deleteDialogHtml(role) {
    const r = role || {};
    return '<form class="gs-dialog-form" data-submit="role-delete-form" data-role="' + esc(r.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Delete ' + esc(r.name) + '?</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Deleting <strong>' + esc(r.name) + '</strong> takes it away from ' + esc(plural(r.holders, 'person', 'people')) + ', removes ' +
      esc(plural(r.mapped, 'Discord mapping', 'Discord mappings')) + ' and turns off ' + esc(plural(r.links, 'guest link', 'guest links')) + '. This cannot be undone.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Delete role</button></div></form>';
  }

  function load(gid) {
    return G.api.roles.list(gid).then(function (data) {
      st().rolesSettings = { gid: gid, data: data, notice: '' };
      keepList(gid, data);
      return data;
    });
  }

  // -- behaviour --
  // The People page reads the guild's own roles from here (its Edit roles dialog lists them).
  function keepList(gid, data) {
    if (!st().rolesList) st().rolesList = {};
    st().rolesList[gid] = data;
  }

  function applyRoles(gid, res, notice) {
    const x = xs();
    if (x && x.gid === gid) { x.data = res; x.notice = notice; }
    keepList(gid, res);
    st().pageAlert = '';
    G.app.render();
    // Editing a role can change what the viewer may do themselves.
    try {
      if (G.app.refreshGuild) {
        const p = G.app.refreshGuild(gid);
        if (p && p.catch) p.catch(function () { /* the change already worked */ });
      }
    } catch (e) { /* the change already worked */ }
  }

  function currentRole(id) {
    const x = xs();
    return x && x.data ? findRole(x.data, id) : null;
  }

  function openRoleDialog(role) {
    const x = xs();
    if (!x || !x.data) return;
    G.ui.openDialog(roleDialogHtml(role, x.data), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    const input = document.getElementById('dlg-role-name');
    if (input && !role && input.focus) input.focus();
  }

  G.handlers.click['role-new'] = function () { openRoleDialog(null); };
  G.handlers.click['role-edit'] = function (el) {
    const role = currentRole(el.getAttribute('data-role'));
    if (role) openRoleDialog(role);
  };

  G.handlers.click['role-delete'] = function (el) {
    const role = currentRole(el.getAttribute('data-role'));
    if (!role || role.kind !== 'custom') return;
    const inDialog = !!(el.closest && el.closest('dialog'));
    G.ui.closeDialogOf(el);
    G.ui.openDialog(deleteDialogHtml(role), { labelledBy: 'dlg-title', describedBy: 'dlg-text', returnKey: inDialog ? 'role-edit-' + role.id : undefined });
  };

  G.handlers.click['role-reset-ask'] = function (el) {
    el.hidden = true;
    const footer = document.getElementById('dlg-role-footer');
    if (footer) footer.hidden = true;
    const box = document.getElementById('dlg-reset-confirm');
    if (box) { box.hidden = false; const first = box.querySelector('button'); if (first) first.focus(); }
  };
  G.handlers.click['role-reset-cancel'] = function () {
    const box = document.getElementById('dlg-reset-confirm');
    const ask = document.getElementById('dlg-reset-ask');
    const footer = document.getElementById('dlg-role-footer');
    if (footer) footer.hidden = false;
    if (box) box.hidden = true;
    if (ask) { ask.hidden = false; ask.focus(); }
  };
  G.handlers.click['role-reset-confirm'] = function (el) {
    const form = el.closest('form');
    const x = xs();
    if (!form || !x || !x.data) return;
    const role = findRole(x.data, form.getAttribute('data-role'));
    if (!role || role.kind !== 'builtin' || role.fixed) return;
    G.ui.runDialogInline(form, G.api.roles.reset(x.gid, role.id), function (res) {
      applyRoles(x.gid, res, role.name + ' is back to its defaults.');
    });
  };

  // { action: scope } for every grid row set to something other than No. A locked row (no scope allowed) is disabled and sends nothing.
  function readPermissions(form) {
    const out = {};
    Array.prototype.forEach.call(form.querySelectorAll('select[data-perm]'), function (sel) {
      if (sel.disabled || !sel.value) return;
      out[sel.getAttribute('data-perm')] = sel.value;
    });
    return out;
  }

  G.handlers.submit['role-form'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    const mode = form.getAttribute('data-mode');
    if (mode !== 'new' && mode !== 'edit') return;
    const role = mode === 'edit' ? findRole(x.data, form.getAttribute('data-role')) : null;
    if (mode === 'edit' && (!role || isReadOnly(role, x.data))) return;
    ['dlg-err-name', 'dlg-err-permissions', 'dlg-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const body = { permissions: readPermissions(form) };
    if (!role || role.kind === 'custom') {
      const name = form.elements.name.value.trim();
      if (!name) {
        G.ui.setText('dlg-err-name', 'Enter a name for the role.');
        if (form.elements.name.focus) form.elements.name.focus();
        return;
      }
      body.name = name;
    }
    const label = body.name || (role && role.name) || 'the role';
    const call = role ? G.api.roles.update(x.gid, role.id, body) : G.api.roles.create(x.gid, body);
    G.ui.runDialogInline(form, call, function (res) {
      applyRoles(x.gid, res, (role ? 'Saved ' : 'Created ') + label + '.');
    });
  };

  G.handlers.submit['role-delete-form'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    const role = findRole(x.data, form.getAttribute('data-role'));
    if (!role || role.kind !== 'custom') return;
    G.ui.runDialogInline(form, G.api.roles.remove(x.gid, role.id), function (res) {
      applyRoles(x.gid, res, 'Deleted ' + role.name + '.');
    });
  };

  G.pages.settingsRoles = {
    SCOPE_LABELS: SCOPE_LABELS,
    settingsHtml: settingsHtml,
    roleDialogHtml: roleDialogHtml,
    deleteDialogHtml: deleteDialogHtml,
    load: load,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
