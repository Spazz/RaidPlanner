// -- PAGE: GUILD SETTINGS > DISCORD ROLES ------------------------
// Which Raidsmith role each Discord role gives. A status card for the Raidsmith bot (silent, asks for no permissions), then one row per Discord role of
// the server with a "Gives" choice (Not mapped, Officer, Team Lead for a team, or one of the guild's own roles). GET /api/guild/:gid/discord,
// PUT .../discord/maps (replaces the whole list; the reply says how many Discord-given assignments went with a removed mapping). Needs guild.roles.
// Colours are not shown (no inline styles): the role name says which role it is.
// A guild with a rank source (the in-game guild roster, or ranks set by hand) gets no roles from Discord: the Worker refuses the mapping with 409 discord_roles_off. The page reads the guild's
// rank source with the roles (GET /bnet `pin.rankSource`, kept on the answer as `rankSource`) and shows one line instead of the mapping form; a save that is refused turns the page into that line too.
(function (G) {
  'use strict';

  const PROBLEM_TEXT = {
    bad_token: 'Discord did not accept the bot\'s token, so roles cannot be read. Whoever runs Raidsmith needs to check the bot\'s setup.',
    unavailable: 'Discord did not answer. Try again in a minute.',
    rate_limited: 'Discord is busy right now. Try again in a minute.',
  };
  const NOT_SET_UP = 'The Raidsmith bot is not set up on this server, so Discord roles cannot be read yet. Whoever runs Raidsmith needs to finish that first.';
  const RANK_SOURCE_LINE = {
    ingame: 'This guild takes its roles from the in-game guild roster, so Discord roles do not give any here.',
    manual: 'This guild sets its roles by hand, so Discord roles do not give any here.',
  };
  const FINE_PRINT = 'The mapping applies at every sign-in and with Sync now on the People page. A role set by hand always wins and stays. ' +
    'The Guild Master cannot be given by a Discord role. Everyone in your Discord server is already a Member.';

  function st() { return G.app.state; }
  function xs() { return st().discordSettings; }
  function listOf(v) { return Array.isArray(v) ? v : []; }

  // The bot's invite link opens in a new tab (Discord asks which server; the link pre-selects this guild's and asks for no permissions).
  function inviteLinkHtml(bot, label, cls) {
    if (typeof bot.inviteUrl !== 'string' || !/^https?:\/\//i.test(bot.inviteUrl)) return '';
    return '<a class="' + cls + '" href="' + esc(bot.inviteUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
  }

  function secondaryLink(bot) {
    const link = inviteLinkHtml(bot, 'Invite link for the Raidsmith bot', 'gs-discord-link');
    return link ? '<p class="gs-fine">' + link + '</p>' : '';
  }

  // The bot card: one of five states.
  function statusHtml(d) {
    const bot = d.bot || {};
    if (!bot.configured) {
      return '<p class="gs-warn" id="discord-status" role="status">' + esc(NOT_SET_UP) + '</p>';
    }
    if (bot.inServer === false) {
      return '<div class="gs-panel gs-hd-panel gs-discord-status" id="discord-status" role="status"><p class="gs-discord-line">The Raidsmith bot is not in your Discord server yet.</p>' +
        '<p class="gs-fine">Adding it asks for no permissions and it stays silent: it only reads which roles people have.</p>' +
        '<div class="gs-actions">' + inviteLinkHtml(bot, 'Add the Raidsmith bot', 'gs-btn') + '</div></div>';
    }
    if (bot.inServer !== true) {
      const text = Object.prototype.hasOwnProperty.call(PROBLEM_TEXT, bot.problem) ? PROBLEM_TEXT[bot.problem] : 'Discord roles cannot be read right now. Try again in a minute.';
      return '<p class="gs-warn" id="discord-status" role="status">' + esc(text) + '</p>';
    }
    return '<div class="gs-panel gs-hd-panel gs-discord-status" id="discord-status" role="status"><p class="gs-discord-line">Connected: ' + esc(G.ui.plural(listOf(d.roles).length, 'Discord role', 'Discord roles')) + '</p>' +
      secondaryLink(bot) + '</div>';
  }

  function targetOptionsHtml(targets, selected) {
    return '<option value="">Not mapped</option>' + targets.map(function (t) {
      return '<option value="' + esc(t.roleId) + '"' + (t.needsTeam ? ' data-needs-team="1"' : '') + (t.roleId === selected ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('');
  }

  function teamOptionsHtml(teams, selected) {
    return teams.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('');
  }

  function mapFor(maps, discordRoleId) {
    return maps.filter(function (m) { return m.discordRoleId === discordRoleId; })[0] || null;
  }

  // One row: the Discord role, then what it gives. The team choice is in the row for every guild that has a role given per team, and shows only
  // while such a role is chosen.
  function rowHtml(i, name, discordRoleId, map, targets, teams) {
    const chosen = map ? targets.filter(function (t) { return t.roleId === map.roleId; })[0] || null : null;
    const anyTeamRole = targets.some(function (t) { return t.needsTeam; });
    const team = anyTeamRole
      ? '<span class="gs-dmap-team" id="dmap-team-wrap-' + i + '"' + (chosen && chosen.needsTeam ? '' : ' hidden') + '>' +
        '<label class="gs-dmap-teamlabel" for="dmap-team-' + i + '">for team</label>' +
        '<select class="gs-input" id="dmap-team-' + i + '" aria-label="' + esc(name) + ': for team" name="mapteam-' + i + '" data-key="dmap-team-' + i + '">' + teamOptionsHtml(teams, map ? map.teamId : null) + '</select></span>'
      : '';
    return '<tr><th scope="row" class="gs-cell-strong">' + esc(name) + '</th><td data-label="Gives"><div class="gs-dmap-pick">' +
      '<label class="gs-sr" for="dmap-' + i + '">Raidsmith role given by ' + esc(name) + '</label>' +
      '<select class="gs-input" id="dmap-' + i + '" name="map-' + i + '" data-change="discord-target" data-idx="' + i + '" data-discord-role="' + esc(discordRoleId) + '" data-role-name="' + esc(name) + '" data-key="dmap-' + i + '">' +
      targetOptionsHtml(targets, chosen ? chosen.roleId : '') + '</select>' + team + '</div></td></tr>';
  }

  function tableHtml(label, rows) {
    return '<div class="gs-table-wrap gs-hd-panel"><table class="gs-table gs-table-stack gs-table-dmap" aria-label="' + esc(label) + '"><thead><tr><th scope="col">Discord role</th><th scope="col">Gives</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table></div>';
  }

  // opts: { guildData, data (GET /discord or null), alert, notice }
  function settingsHtml(opts) {
    const d = opts.data;
    let body;
    if (!d) {
      body = G.ui.settingsLoadingHtml();
    } else {
      const bot = d.bot || {};
      const roles = listOf(d.roles);
      const maps = listOf(d.maps);
      const targets = listOf(d.targets);
      const teams = G.shell.activeTeams(opts.guildData && opts.guildData.teams);
      const known = {};
      roles.forEach(function (r) { known[r.id] = true; });
      const orphans = maps.filter(function (m) { return !Object.prototype.hasOwnProperty.call(known, m.discordRoleId); });
      let i = 0;
      const rows = roles.map(function (r) { const html = rowHtml(i, r.name, r.id, mapFor(maps, r.id), targets, teams); i += 1; return html; });
      const orphanRows = orphans.map(function (m) { const html = rowHtml(i, 'Discord role ' + m.discordRoleId, m.discordRoleId, m, targets, teams); i += 1; return html; });
      // When the server's roles could not be read, saved mappings are not "gone": the card above says why nothing else is listed.
      const orphanHeading = bot.inServer === true ? 'Not in the server any more' : 'Saved mappings';
      const orphanNote = bot.inServer === true
        ? 'These Discord roles were deleted from your server. Set one to Not mapped and save to remove its mapping.'
        : 'These mappings are kept. Set one to Not mapped and save to remove it.';
      const any = rows.length || orphanRows.length;
      const off = d.rankSource === 'ingame' || d.rankSource === 'manual' ? RANK_SOURCE_LINE[d.rankSource] : '';
      body = off ? statusHtml(d) + '<p class="gs-fine" id="discord-roles-off" role="status">' + esc(off) + '</p>' : statusHtml(d) +
        (any
          ? '<form class="gs-form gs-dmap-form" id="discord-form" data-submit="discord-maps" novalidate' + G.ui.dirtyFormAttrs() + '>' +
            (rows.length ? '<h3 class="gs-h3" id="dmap-roles-h">Discord roles in your server</h3>' + tableHtml('Discord roles in your server', rows) : '') +
            (orphanRows.length ? '<h3 class="gs-h3" id="dmap-gone-h">' + esc(orphanHeading) + '</h3><p class="gs-fine">' + esc(orphanNote) + '</p>' + tableHtml(orphanHeading, orphanRows) : '') +
            '<p class="gs-alert" id="discord-form-error" role="alert" hidden></p>' +
            G.ui.saveBarHtml({ saveLabel: 'Save mapping' }) + '</form>'
          : (bot.inServer === true ? '<p class="gs-empty" id="discord-empty">Your Discord server has no roles to map yet.</p>' : '')) +
        '<p class="gs-fine" id="discord-fine">' + esc(FINE_PRINT) + '</p>';
    }
    return '<section class="gs-section" aria-labelledby="settings-title"><div class="gs-section-head gs-section-head-actions"></div>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  // The guild's rank source (null = it follows Discord roles). A read that fails (the person may not hold the Battle.net settings) leaves the form on; the save then says so.
  function readRankSource(gid) {
    return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/bnet').then(function (d) { return d && d.pin && typeof d.pin.rankSource === 'string' ? d.pin.rankSource : null; }, function () { return null; });
  }

  function load(gid) {
    return Promise.all([G.api.discord.get(gid), readRankSource(gid)]).then(function (res) {
      const data = res[0];
      data.rankSource = res[1];
      st().discordSettings = { gid: gid, data: data, notice: '' };
      return data;
    });
  }

  // -- behaviour --
  function targetById(data, id) {
    return listOf(data && data.targets).filter(function (t) { return t.roleId === id; })[0] || null;
  }

  // Choosing a role that is given per team shows the team choice next to it.
  G.handlers.change['discord-target'] = function (el) {
    const x = xs();
    const wrap = document.getElementById('dmap-team-wrap-' + el.getAttribute('data-idx'));
    if (!wrap) return;
    const target = x ? targetById(x.data, el.value) : null;
    wrap.hidden = !(target && target.needsTeam);
  };

  // [{ discordRoleId, roleId, teamId }] for every row with a target, or { error } naming the row that needs a team.
  function readMaps(form, data) {
    const maps = [];
    const selects = form.querySelectorAll('select[data-discord-role]');
    for (let i = 0; i < selects.length; i++) {
      const sel = selects[i];
      if (!sel.value) continue;
      const target = targetById(data, sel.value);
      if (!target) continue;
      const entry = { discordRoleId: sel.getAttribute('data-discord-role'), roleId: target.roleId, teamId: null };
      if (target.needsTeam) {
        const team = document.getElementById('dmap-team-' + sel.getAttribute('data-idx'));
        if (!team || !team.value) return { error: 'Pick a team for ' + (sel.getAttribute('data-role-name') || 'that Discord role') + ': ' + target.name + ' is given for one team.' };
        entry.teamId = team.value;
      }
      maps.push(entry);
    }
    return { maps: maps };
  }

  G.handlers.submit['discord-maps'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    G.ui.setText('discord-form-error', '');
    const read = readMaps(form, x.data);
    if (read.error) { G.ui.setText('discord-form-error', read.error); return; }
    G.ui.setBusy(form, true);
    G.api.discord.saveMaps(x.gid, read.maps).then(function (res) {
      const cleared = res && typeof res.cleared === 'number' ? res.cleared : 0;
      const cur = xs();
      if (cur && cur.gid === x.gid) {
        cur.data.maps = res && Array.isArray(res.maps) ? res.maps : read.maps;
        cur.notice = cleared > 0
          ? (cleared === 1 ? '1 role assignment from a removed mapping was taken away.' : cleared + ' role assignments from removed mappings were taken away.')
          : '';
      }
      G.app.markSettingsSaved('discord');
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      if (err && err.code === 'discord_roles_off') {
        // The guild has a rank source now (or the page was stale): nothing was saved, the page says why instead of the form.
        const cur = xs();
        if (cur && cur.gid === x.gid) cur.data.rankSource = /by hand/.test(err.message || '') ? 'manual' : 'ingame';
        st().pageAlert = '';
        G.app.render();
        return;
      }
      if (err && err.code === 'conflict') {
        // A role or team changed under the page: read the roles again (the choices made here go) and say why.
        load(x.gid).then(function () { st().pageAlert = c.text; G.app.render(); }, function () { G.ui.setText('discord-form-error', c.text); });
        return;
      }
      G.ui.setText('discord-form-error', c.text);
    });
  };

  G.pages.settingsDiscord = { PROBLEM_TEXT: PROBLEM_TEXT, NOT_SET_UP: NOT_SET_UP, FINE_PRINT: FINE_PRINT, RANK_SOURCE_LINE: RANK_SOURCE_LINE, settingsHtml: settingsHtml, load: load };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
