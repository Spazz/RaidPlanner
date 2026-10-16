// ── PLAN SOURCE (browser) ───────────────────────────────────────
// Reads a Raidsmith plan out of what an officer pastes and returns only names + groups; the server never sees the
// plan link or anything else in it. Accepts a long link (...#r=<code>), a bare share code, a PP:2:... share string,
// or a short live link (/tbc/<7 characters>), which is fetched from /api/share (needs the live site).
//   G.planSource.read(text, deps) -> Promise<{ ok: true, label, players: [{ name, group }] } | { ok: false, error }>
//   deps (all optional; the page passes none): decode(code) -> string|null, readPlayers(str) -> { success, name, players, error },
//   fetchShare(id) -> Promise<{ code } | null>. Defaults use the planner's Import (loaded on index.html) and fetch.
(function (G) {
  'use strict';

  const MAX_PLAYERS = 80;
  const LABEL_MAX = 80;
  const LONG_LINK = /#r=([A-Za-z0-9_-]+)/;
  const SHORT_LINK = /\/(?:tbc|classic|forever)\/([0-9A-Za-z]{7})\/?(?:[?#]\S*)?$/;
  const BARE_CODE = /^[A-Za-z0-9_-]{8,}$/;

  // The server's character-name rule (worker cleanCharacterName): 2 to 12 letters, each with at most two combining marks.
  const NAME_PATTERN = /^(?:\p{L}\p{M}{0,2})+$/u;

  function fail(error) { return { ok: false, error: error }; }

  function validName(raw) {
    if (typeof raw !== 'string' || raw.length > 64) return false;
    const text = raw.normalize('NFC').trim();
    if (!NAME_PATTERN.test(text)) return false;
    const n = Array.from(text).length;
    return n >= 2 && n <= 12;
  }

  // Drops names the server would refuse and repeats (first one wins). -> { players, skipped: count }
  function sanitize(players) {
    const seen = {};
    const kept = [];
    let skipped = 0;
    (players || []).forEach(function (p) {
      if (!p || !validName(p.name)) { skipped++; return; }
      const key = p.name.normalize('NFC').trim().toLowerCase();
      if (seen[key]) { skipped++; return; }
      seen[key] = true;
      kept.push(p);
    });
    return { players: kept, skipped: skipped };
  }

  function skippedText(n) {
    return n > 0 ? n + (n === 1 ? ' name was' : ' names were') + ' left out of the plan (not a valid character name, or listed twice).' : '';
  }

  // A 400 plan_invalid names the offending entry by index into the players that were sent.
  function describeError(err, sent) {
    if (!err || err.code !== 'plan_invalid') return null;
    const entry = typeof err.index === 'number' && Array.isArray(sent) ? sent[err.index] : null;
    return (entry && entry.name ? entry.name + ': ' : '') + (err.message || 'The plan could not be saved.');
  }

  // What the pasted text is: { kind: 'string' | 'code' | 'short', value } or null.
  function classify(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    if (/^PP:/.test(t)) return { kind: 'string', value: t };
    const long = LONG_LINK.exec(t);
    if (long) return { kind: 'code', value: long[1] };
    const short = SHORT_LINK.exec(t);
    if (short) return { kind: 'short', value: short[1] };
    if (BARE_CODE.test(t)) return { kind: 'code', value: t };
    return null;
  }

  function defaultDeps() {
    const imp = typeof Import !== 'undefined' ? Import : null;
    return {
      decode: imp ? function (c) { return imp.decodeSharePayload(c); } : null,
      readPlayers: imp ? function (s) { return imp.readSharePlayers(s); } : null,
      fetchShare: typeof fetch === 'function' ? function (id) {
        return fetch('/api/share?id=' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (res) {
          if (res.status === 404) return null;
          if (!res.ok) throw new Error('share ' + res.status);
          return res.json();
        });
      } : null,
    };
  }

  function fromString(str, d) {
    if (!d.readPlayers) return fail('The plan reader is not available on this page. Open the planner once, then try again.');
    const parsed = d.readPlayers(str);
    if (!parsed || !parsed.success) return fail((parsed && parsed.error) || 'That plan link is damaged.');
    const all = (parsed.players || []).map(function (p) { return { name: p.name, group: p.groupNumber }; });
    if (!all.length) return fail('That plan has no players in it.');
    const clean = sanitize(all);
    if (!clean.players.length) return fail('None of the names in that plan are valid character names.');
    if (clean.players.length > MAX_PLAYERS) return fail('That plan lists ' + clean.players.length + ' players; at most ' + MAX_PLAYERS + ' can be added.');
    return { ok: true, label: String(parsed.name || 'Shared plan').slice(0, LABEL_MAX), players: clean.players, skipped: clean.skipped, skippedText: skippedText(clean.skipped) };
  }

  function fromCode(code, d) {
    if (!d.decode) return fail('The plan reader is not available on this page. Open the planner once, then try again.');
    const str = d.decode(code);
    if (!str) return fail('That plan link is invalid or damaged.');
    return fromString(str, d);
  }

  function read(text, deps) {
    const d = Object.assign(defaultDeps(), deps || {});
    const c = classify(text);
    if (!c) return Promise.resolve(fail('That does not look like a Raidsmith plan link or share code.'));
    if (c.kind === 'string') return Promise.resolve(fromString(c.value, d));
    if (c.kind === 'code') return Promise.resolve(fromCode(c.value, d));
    if (!d.fetchShare) return Promise.resolve(fail('Short links need the live site. Paste the long link (the one with #r=) instead.'));
    return Promise.resolve().then(function () { return d.fetchShare(c.value); }).then(function (remote) {
      if (!remote) return fail('That share link has expired or does not exist.');
      if (typeof remote.code !== 'string') return fail('The share link answered in a form this page cannot read.');
      return fromCode(remote.code, d);
    }, function () {
      return fail('Could not open that short link from here (it needs the live site). Paste the long link (the one with #r=) instead.');
    });
  }

  G.planSource = { classify: classify, read: read, sanitize: sanitize, describeError: describeError, MAX_PLAYERS: MAX_PLAYERS };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
