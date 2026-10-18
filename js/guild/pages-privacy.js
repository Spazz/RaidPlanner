// ── PAGE: PRIVACY & MY DATA ─────────────────────────────────────
// The policy copy (board copy with the spec's fixes), plus Delete my data for signed-in users. The delete box
// reads /auth/me deleteImpact: a sole Guild Master with other members must hand over first; a solo Guild Master
// also deletes the guild, named in the confirm and echoed back as deleteGuildIds.
(function (G) {
  'use strict';

  const CONTACT = '[Contact]';

  function section(id, title, body) {
    return '<section aria-labelledby="' + id + '"><h2 class="gs-h2 gs-h2-plain" id="' + id + '">' + esc(title) + '</h2>' + body + '</section>';
  }

  function paragraphs(list) {
    return '<div class="gs-prose">' + list.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') + '</div>';
  }

  function bullets(list) {
    return '<ul class="gs-bullets gs-bullets-plain">' + list.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
  }

  function guildLinks(list) {
    const names = (Array.isArray(list) ? list : []).map(function (g) {
      return '<a href="' + esc(G.router.format({ name: 'settings', gid: g.id, tab: 'people' })) + '"><strong>' + esc(g.name) + '</strong></a>';
    });
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // One line per guild whose Guild Master seat changes when the account is deleted (deleteImpact.autoPromote).
  function autoPromoteHtml(list) {
    if (!list.length) return '';
    return '<ul class="gs-sentences" id="delete-autopromote">' + list.map(function (e) {
      const guild = '<strong>' + esc(e && e.name) + '</strong>';
      if (e && e.to && e.to.displayName) return '<li><strong>' + esc(e.to.displayName) + '</strong> becomes Guild Master of ' + guild + '.</li>';
      return '<li>' + guild + ' will have no Guild Master until an admin of its Discord server claims it.</li>';
    }).join('') + '</ul>';
  }

  // impact: /auth/me deleteImpact { handOverFirst: [{id,name}], guildsDeleted: [{id,name}], autoPromote: [{id,name,to}] }
  function deleteBoxHtml(impact, message) {
    const hand = impact && Array.isArray(impact.handOverFirst) ? impact.handOverFirst : [];
    const gone = impact && Array.isArray(impact.guildsDeleted) ? impact.guildsDeleted : [];
    const promote = impact && Array.isArray(impact.autoPromote) ? impact.autoPromote : [];
    const blocked = hand.length > 0;
    const intro = paragraphs([
      'Deletes your account, the name you chose and every sign-in linked to it, and all Discord data Raidsmith holds: your Discord ID, username and avatar, the Discord ID and nickname on your Raid-Helper sign-ups, and the notes you wrote on sign-ups made in Raidsmith. It also deletes your Battle.net link and character list, and the character claims you made.',
      'It deletes the calendar links you made too, so those calendar subscriptions stop updating.',
      'Delete my data also lifts any access block on you.',
      'If you are the only Guild Master of a guild, hand over first. If nobody else has joined, the guild is deleted too.',
      'Roster records stay with the guild, unlinked, once the guild keeps them: your roster entry, characters, attendance and officer notes would no longer be linked to your Discord account. To remove those, ask your guild\'s officers.',
      'Ideas you suggested on the Future enhancements page stay, no longer linked to you.',
    ]);
    let impactHtml = '';
    if (blocked) {
      impactHtml += '<p class="gs-warn" id="delete-blocked" role="alert">You are the only Guild Master of ' + guildLinks(hand) +
        ', and other people have joined. Hand over first: open People and roles, edit another person\'s roles and choose Make Guild Master. Then you can delete your data.</p>';
    }
    if (gone.length) {
      impactHtml += '<p class="gs-warn" id="delete-guilds">Nobody else has joined ' + G.ui.joinNames(gone) + '. Deleting your data also deletes ' + (gone.length === 1 ? 'that guild' : 'those guilds') + ', with its teams and roles.</p>';
    }
    const confirm = blocked ? '' :
      '<div id="delete-confirm" role="group" aria-label="Confirm deleting your data" hidden>' +
      '<p class="gs-confirm-text">This deletes your sign-in, your Discord data and your Battle.net data now.' + (gone.length ? ' It also deletes ' + G.ui.joinNames(gone) + '.' : '') + ' Roster records stay with the guild, unlinked. To remove those, ask your guild\'s officers.</p>' +
      autoPromoteHtml(promote) +
      '<div class="gs-check"><input type="checkbox" id="delete-understand" data-change="delete-understand"><label for="delete-understand">I understand</label></div>' +
      '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-danger" id="delete-go" data-action="delete-go" data-key="delete-go" disabled>Delete my data</button>' +
      '<button type="button" class="gs-btn" data-action="delete-cancel">Cancel</button></div></div>';
    return '<section class="gs-danger-box" aria-labelledby="privacy-delete"><h2 class="gs-h2 gs-h2-plain" id="privacy-delete">Delete my data</h2>' + intro + impactHtml +
      G.ui.alertHtml(message || '', 'delete-error') +
      '<div><button type="button" class="gs-btn gs-btn-danger-outline" id="delete-open" data-action="delete-open" data-key="delete-open" aria-expanded="false" aria-controls="delete-confirm"' +
      (blocked ? ' disabled aria-describedby="delete-blocked"' : '') + '>Delete my data</button></div>' + confirm + '</section>';
  }

  // opts: { me (or null when signed out), message }
  function privacyHtml(opts) {
    const o = opts || {};
    const me = o.me || null;
    return '<div class="gs-page gs-page-narrow"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Privacy &amp; my data</h1></div>' +
      section('privacy-keeps-you', 'What Raidsmith keeps about you', paragraphs([
        'Your Raidsmith account is made the first time you sign in, with Discord or with Battle.net. It can hold both: you connect the second on Linked accounts, and either one signs you in to the same account. Raidsmith never merges two accounts, so a Discord or Battle.net account that already has its own Raidsmith account cannot be connected to another one. The name you pick there (up to 32 characters) is shown to the people in your guilds.',
        'From Discord, when you sign in or connect it: your Discord ID, username and avatar. Not your email, not your messages. Disconnecting Discord deletes the Discord ID and nickname on roster entries and Raid-Helper sign-ups, as deleting all your data does; the people and their attendance stay. If a guild maps Discord roles to Raidsmith roles, signing in also reads your roles in that guild\'s Discord server and keeps the Raidsmith roles they map to, marked as given by Discord; leaving the Discord role, disconnecting Discord or deleting your data takes them away again.',
        'Your server list is checked each time you sign in with Discord, or connect it. Only the result is kept. For guild creators, the servers they can manage are kept for 30 minutes after sign-in.',
        'Ideas you suggest on the Future enhancements page: the title, details and area you write, linked to your account. Everyone who is signed in can read an idea, without your name.',
      ])) +
      section('privacy-battlenet', 'Battle.net, only if you connect it', paragraphs([
        'When you sign in with or connect Battle.net, Raidsmith keeps your Battle.net account number and BattleTag. They are how you sign in, so they stay while Battle.net is connected, and are refreshed every time you sign in with it. If you share it, Raidsmith also keeps the list of your characters in the games your guilds play: name, realm, class and level. It never sees your password, and it does not keep the access token Battle.net gives it: the token is used once, while you sign in or connect.',
        'Blizzard\'s rules allow Raidsmith to keep the character list for 30 days at most, so it is deleted 30 days after you load it unless you load it again; your BattleTag stays until you disconnect. Disconnect on Linked accounts to delete both at once, or delete all your data from this page.',
        'A character you claim is sent to your guild\'s officers with your name. A claim nobody has decided is deleted after 30 days too, and a decided one 30 days after the decision. A character an officer approves becomes part of the guild\'s roster, like any other.',
        'Officers can read their in-game guild\'s member list from Battle.net to fill the roster. That list is not kept: only the people they choose to add are saved.',
      ])) +
      section('privacy-guild-keeps', 'What your guild keeps', bullets([
        'Your roster entry: status, join and trial dates, characters, specs and team.',
        'Which Raidsmith account is yours: an officer can link your account to your roster entry (for example when you sign in with Battle.net only and are not in the guild\'s Discord server), or an approved character claim does. Unlinking it, or deleting your data, removes the link; the roster entry stays.',
        'Officer notes: only officers and team leads see them.',
        'Your attendance for each raid.',
        'The sign-ups you make in Raidsmith: the raid, your status, the character and spec you chose, and an optional note.',
      ])) +
      section('privacy-comes-from', 'Where it comes from', bullets([
        'Raid-Helper sign-ups: Discord ID, nickname and sign-up status.',
        'Sign-ups you or an officer make in Raidsmith: only your roster entry, status, character, spec and note, no Discord ID or nickname.',
        'Public Warcraft Logs reports: only who was present in which boss pulls. The report itself is not kept.',
        'Your officers\' own entries.',
      ]) + paragraphs([
        'Officers can import a Raid-Helper event. That stores each sign-up\'s Discord ID and nickname on the roster, linked to their roster entry, until an officer removes the person or the person signs in and deletes their data.',
        'Raid-Helper sign-ups on a raid store each Discord ID and nickname until the person signs in and deletes their data. Warcraft Logs reports are read once; only who was present in each boss pull is kept, never the report.',
      ])) +
      section('privacy-who-sees', 'Who can see it', paragraphs([
        'Members see the guild\'s roster and raids, and the attendance of the teams they have a character on. A member is someone in the guild\'s Discord server or whose account an officer has linked to a roster entry. Officers and team leads also see officer notes. Nobody outside the guild sees any of it, except what a Guild Master chooses to show on the guild\'s public page (roster names and classes, raids, attendance percentages, loot awards; never notes, Discord names or accounts) and what an officer shares through a guest link, which can only be read, never changed. An officer can look an account up only by typing its whole BattleTag or display name, or from the character claims sent to their guild; there is no list of accounts.',
      ])) +
      section('privacy-cookies', 'Cookies', paragraphs([
        'Two cookies: one keeps you signed in for 30 days, and a second lasts 10 minutes while you sign in. Connecting Battle.net sets one more for 10 minutes while you connect or sign in with it. A visitor who opens a guest link, which needs no account, gets one more cookie that lasts as long as the link works (30 days at most) and only lets them read what the link allows. No ads, no tracking.',
      ])) +
      section('privacy-stored', 'Where it is stored', paragraphs(['Raidsmith runs on Cloudflare.'])) +
      (me ? deleteBoxHtml(me.deleteImpact, o.message) : '') +
      '<p class="gs-prose-line">Questions about your data: ' + esc(CONTACT) + '</p></div>';
  }

  G.handlers.click['delete-open'] = function (el) {
    const box = document.getElementById('delete-confirm');
    if (!box) return;
    box.hidden = !box.hidden;
    el.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    if (!box.hidden) { const cb = document.getElementById('delete-understand'); if (cb) cb.focus(); }
  };

  G.handlers.click['delete-cancel'] = function () {
    const box = document.getElementById('delete-confirm');
    const open = document.getElementById('delete-open');
    const cb = document.getElementById('delete-understand');
    const go = document.getElementById('delete-go');
    if (cb) cb.checked = false;
    if (go) go.disabled = true;
    if (box) box.hidden = true;
    if (open) { open.setAttribute('aria-expanded', 'false'); open.focus(); }
  };

  G.handlers.change['delete-understand'] = function (el) {
    const go = document.getElementById('delete-go');
    if (go) go.disabled = !el.checked;
  };

  G.handlers.click['delete-go'] = function (el) {
    const me = G.app.state.me;
    if (!me || el.disabled) return;
    const ids = ((me.deleteImpact && me.deleteImpact.guildsDeleted) || []).map(function (g) { return g.id; });
    el.disabled = true;
    G.api.del('/auth/me', { deleteGuildIds: ids }).then(function () {
      G.app.afterAccountDeleted();
    }, function (err) {
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      // 409 (hand over first / the guild list changed): show the server's message and re-read the impact.
      G.app.state.privacyMessage = c.text;
      G.app.loadMe().then(function () { G.app.render(); });
    });
  };

  G.pages.privacy = { CONTACT: CONTACT, privacyHtml: privacyHtml, deleteBoxHtml: deleteBoxHtml, autoPromoteHtml: autoPromoteHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
