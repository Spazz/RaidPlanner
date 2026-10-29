// ── FRESH SIGN-IN: the one helper every act that wants one uses (lane B8a-base; Worker side: worker/fresh.js, worker/routes/fresh.js) ──
// A sensitive act (hand-over, guild delete, pin, switch-over, claim, identity changes) is refused with 403 fresh_required until the person has signed in again just now. The page
// then shows ONE more step in the act's own dialog (never a second dialog on top): "Confirm it is you", with Battle.net or Discord to pick where the act allows both and the account
// holds both. The step starts the sign-in (POST .../fresh/start), keeps what the person was doing in sessionStorage and goes to the provider; the Worker's callback comes back to
// #/fresh?done=<purpose> (pages-fresh.js), which repeats the act with the function its page registered and goes on.
//
//   Guild.fresh.isRequired(err)                      true for 403 fresh_required (the ApiError keeps the body's `purpose` and `params`: err.purpose, err.params)
//   Guild.fresh.stepHtml({ purpose, providers, linked, stepLabel, primaryLabel, text, provider })   the step as a whole confirm dialog (ui.dialogHtml); the form's submit is data-submit
//                                                    "fresh-step-form", its Back "fresh-step-back" (handlers below)
//   Guild.fresh.toStep({ form, error, gid, act, linked, stepLabel, primaryLabel, text })        swaps the open dialog's body for the step (Back restores it); false when it cannot
//   Guild.fresh.openStep({ error, gid, act, linked, stepLabel, primaryLabel, text, returnTo })  the same step in a dialog of its own, for an act whose page has no dialog (an inline box); false when it cannot
//   Guild.fresh.runDialog(form, promise, opts, onOk, onConflict)    ui.runDialog that turns a 403 fresh_required into the step (opts = toStep's, minus form and error)
//   Guild.fresh.start({ gid, purpose, params, provider, act, returnTo })                          saves the pending act, POSTs the start, goes to the provider; rejects with the ApiError
//   Guild.fresh.registerAct(kind, fn)                fn(pending) -> Promise<address | null>: repeats the act (the address is where to go next: '#/...' is a route, anything else a
//                                                    page load; null = the act's returnTo). It rejects with an ApiError when the act fails again.
//   Guild.fresh.pending() / takePending() / clearPending() / isFreshEnough(record)              the saved act: { kind, gid, purpose, params, data, provider, returnTo, at }
//   Guild.fresh.linkedOf(me)                         { bnet: 'Name#1234' | null, discord: 'name' | null } from the /auth/me answer, or null when it carries no identities
//   An act is { kind, data }: `kind` names the registered function (default: the purpose), `data` is whatever the function needs to repeat it (a hand-over's target, the typed guild name).
(function (G) {
  'use strict';

  const fresh = G.fresh = G.fresh || {};

  const PENDING_KEY = 'raidsmith.fresh.pending';
  // The grant the Worker writes after the callback lives 15 minutes (worker/fresh.js FRESH_TTL_MS): an older pending act is not repeated (the person did something else in between).
  const MAX_AGE_MS = 15 * 60 * 1000;
  const PROVIDER_LABEL = { bnet: 'Battle.net', discord: 'Discord' };
  // worker/fresh.js FRESH_PURPOSES, the part the page needs (tests/guild/guild-b8a-base-tests.js pins the two together). scope: where the start goes (under the guild or under /api);
  // owner: the Worker answers 403 forbidden to anyone but the Owner.
  const PURPOSES = {
    handover: { providers: ['bnet', 'discord'], scope: 'guild', owner: true },
    guild_delete: { providers: ['bnet', 'discord'], scope: 'guild', owner: true },
    pin: { providers: ['bnet'], scope: 'guild', owner: true },
    source_switch: { providers: ['bnet'], scope: 'guild', owner: true },
    gm_claim: { providers: ['bnet'], scope: 'guild', owner: false },
    ingame_create: { providers: ['bnet'], scope: 'account', owner: false },
    identity_change: { providers: ['bnet', 'discord'], scope: 'account', owner: false },
    account_delete: { providers: ['bnet', 'discord'], scope: 'account', owner: false },
  };

  fresh.PENDING_KEY = PENDING_KEY;
  fresh.MAX_AGE_MS = MAX_AGE_MS;
  fresh.PURPOSES = PURPOSES;
  fresh.PROVIDER_LABEL = PROVIDER_LABEL;
  fresh.now = function () { return Date.now(); };
  // Where the browser goes for the provider (a test replaces it).
  fresh.navigate = function (url) {
    if (typeof window !== 'undefined' && window.location && typeof window.location.assign === 'function') window.location.assign(url);
  };

  const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const known = function (provider) { return provider === 'bnet' || provider === 'discord'; };

  fresh.isRequired = function (err) {
    return !!err && err.status === 403 && err.code === 'fresh_required';
  };

  // ── the pending act (sessionStorage: it survives the round trip to the provider in this tab and nowhere else) ──
  function store() {
    try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null; } catch (e) { return null; }
  }
  function currentHash() {
    try { return typeof window !== 'undefined' && window.location ? String(window.location.hash || '') : ''; } catch (e) { return ''; }
  }
  function savePending(record) {
    const s = store();
    if (!s) return false;
    try { s.setItem(PENDING_KEY, JSON.stringify(record)); return true; } catch (e) { return false; }
  }
  fresh.clearPending = function () {
    const s = store();
    if (!s) return;
    try { s.removeItem(PENDING_KEY); } catch (e) { /* private window: nothing was kept */ }
  };
  // The saved act, or null (nothing saved, unreadable, or not shaped like one).
  fresh.pending = function () {
    const s = store();
    if (!s) return null;
    let record = null;
    try { record = JSON.parse(s.getItem(PENDING_KEY)); } catch (e) { return null; }
    if (!record || typeof record !== 'object' || typeof record.kind !== 'string' || !has(PURPOSES, record.purpose) || typeof record.at !== 'number') return null;
    return {
      kind: record.kind, gid: typeof record.gid === 'string' ? record.gid : null, purpose: record.purpose,
      params: record.params && typeof record.params === 'object' ? record.params : {}, data: record.data === undefined ? null : record.data,
      provider: known(record.provider) ? record.provider : null, returnTo: typeof record.returnTo === 'string' ? record.returnTo : '', at: record.at,
    };
  };
  fresh.takePending = function () {
    const record = fresh.pending();
    fresh.clearPending();
    return record;
  };
  // Younger than the grant's 15 minutes.
  fresh.isFreshEnough = function (record) {
    return !!record && fresh.now() - record.at < MAX_AGE_MS;
  };

  // ── who is linked, and which sign-ins an act may use ──
  // null when the answer carries no identities (an older /auth/me): the step then offers what the act allows and the Worker says what is not linked.
  fresh.linkedOf = function (me) {
    const i = me && me.identities ? me.identities : null;
    if (!i) return null;
    const discord = i.discord ? (i.discord.username || i.discord.globalName || 'linked') : null;
    return { bnet: i.bnet ? (i.bnet.battletag || 'linked') : null, discord: discord };
  };
  // The sign-ins that may confirm this purpose, filtered by what the account holds when `linked` is given. A purpose this file does not know allows both.
  function optionsFor(purpose, linked, providers) {
    const allowed = (Array.isArray(providers) ? providers : (has(PURPOSES, purpose) ? PURPOSES[purpose].providers : ['bnet', 'discord'])).filter(known);
    return linked ? allowed.filter(function (p) { return !!linked[p]; }) : allowed;
  }
  fresh.optionsFor = optionsFor;
  const labelWithName = function (provider, linked) {
    const name = linked && typeof linked[provider] === 'string' && linked[provider] !== 'linked' ? linked[provider] : '';
    return PROVIDER_LABEL[provider] + (name ? ' (' + name + ')' : '');
  };

  // ── the step ──
  function lead(text) { return '<p class="gs-confirm-text">' + esc(text) + '</p>'; }
  function factRow(label, value) {
    return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(label) + '</span><span class="gs-pr-v">' + esc(value) + '</span></div>';
  }
  const DEFAULT_LEAD = 'Sign in again so Raidsmith knows it is you. You come back to this page and the action runs.';

  // opts: { purpose, providers (default: the purpose's), linked ({ bnet, discord } labels, default: no filter), stepLabel ("Delete guild - step 2 of 2"), primaryLabel, text (the lead sentence), provider (the one preselected),
  //         noBack (no Back button: the step is the dialog's only body, Cancel closes it) }
  fresh.stepHtml = function (opts) {
    const o = opts || {};
    const options = optionsFor(o.purpose, o.linked, o.providers);
    let body;
    let primary;
    if (options.length > 1) {
      const chosen = options.indexOf(o.provider) >= 0 ? o.provider : options[0];
      body = lead(o.text || DEFAULT_LEAD) + '<fieldset class="gs-fieldset"><legend class="gs-legend">Sign in with</legend>' + options.map(function (p) {
        return '<div class="gs-check"><input type="radio" name="provider" id="fresh-prov-' + p + '" value="' + p + '"' + (p === chosen ? ' checked' : '') + '><label for="fresh-prov-' + p + '">' + esc(labelWithName(p, o.linked)) + '</label></div>';
      }).join('') + '</fieldset>';
      primary = { label: o.primaryLabel || 'Sign in' };
    } else if (options.length === 1) {
      const p = options[0];
      const name = o.linked && typeof o.linked[p] === 'string' && o.linked[p] !== 'linked' ? o.linked[p] : '';
      body = lead(o.text || 'Sign in with ' + PROVIDER_LABEL[p] + ' again so Raidsmith knows it is you. You come back to this page and the action runs.') + (name ? factRow(PROVIDER_LABEL[p] + ' account', name) : '');
      primary = { label: o.primaryLabel || 'Sign in with ' + PROVIDER_LABEL[p] };
    } else {
      const allowed = optionsFor(o.purpose, null, o.providers);
      body = lead('Connect ' + (allowed.map(function (p) { return PROVIDER_LABEL[p]; }).join(' or ') || 'a sign-in') + ' to your account first, then repeat this.');
      primary = { label: o.primaryLabel || 'Sign in', disabled: true };
    }
    return G.ui.dialogHtml({
      kind: 'confirm', step: o.stepLabel, title: 'Confirm it is you', bodyHtml: body, className: 'gs-forge',
      back: o.noBack ? undefined : { attrs: { 'data-action': 'fresh-step-back', 'data-key': 'fresh-step-back' } }, primary: primary, formAttrs: { 'data-submit': 'fresh-step-form' },
    });
  };

  // One sentence for a refused start (the step shows it inline).
  fresh.errorText = function (err, purpose) {
    const code = err && err.code;
    const spec = has(PURPOSES, purpose) ? PURPOSES[purpose] : null;
    const providerOf = function () { return err && err.body && known(err.body.provider) ? PROVIDER_LABEL[err.body.provider] : 'That sign-in'; };
    if (code === 'forbidden') return spec && spec.owner ? 'Only the Owner of the guild can confirm this.' : (err.message || 'You do not have permission to do that.');
    if (code === 'identity_not_linked') return 'Connect ' + (err.body && known(err.body.provider) ? PROVIDER_LABEL[err.body.provider] : 'that sign-in') + ' to your account first, then repeat this.';
    if (code === 'not_configured') return providerOf() + ' sign-in is not set up on this server.';
    if (code === 'bad_request') return err.message || 'That sign-in cannot confirm this.';
    return G.api.classify(err).text;
  };

  // ── start ──
  const refusal = function (message, field) { return new G.api.ApiError(400, { error: 'bad_request', message: message, field: field }); };

  // Saves the pending act, asks the Worker for the provider's address and goes there. Resolves (with the Worker's answer) only when the browser is on its way.
  fresh.start = function (opts) {
    const o = opts || {};
    if (!has(PURPOSES, o.purpose)) return Promise.reject(refusal('That act cannot be confirmed with a sign-in.', 'purpose'));
    const spec = PURPOSES[o.purpose];
    const gid = spec.scope === 'guild' ? (o.gid || null) : null;
    if (spec.scope === 'guild' && !gid) return Promise.reject(refusal('That act belongs to a guild.', 'purpose'));
    const params = o.params && typeof o.params === 'object' ? o.params : {};
    const act = o.act && typeof o.act === 'object' ? o.act : {};
    const provider = known(o.provider) ? o.provider : null;
    savePending({
      kind: typeof act.kind === 'string' && act.kind ? act.kind : o.purpose, gid: gid, purpose: o.purpose, params: params, data: act.data === undefined ? null : act.data,
      provider: provider, returnTo: typeof o.returnTo === 'string' && o.returnTo ? o.returnTo : currentHash(), at: fresh.now(),
    });
    const body = { purpose: o.purpose, params: params };
    if (provider) body.provider = provider;
    return G.api.fresh.start(gid, body).then(function (res) {
      const url = res && typeof res.authorizeUrl === 'string' ? res.authorizeUrl : '';
      if (!/^https?:\/\//i.test(url)) {
        fresh.clearPending();
        throw new G.api.ApiError(502, { error: 'bad_gateway', message: 'The sign-in did not start. Try again in a moment.' });
      }
      fresh.navigate(url);
      return res;
    }, function (err) {
      fresh.clearPending();
      throw err;
    });
  };

  // ── repeating an act ──
  const acts = {};
  fresh.registerAct = function (kind, fn) {
    if (typeof kind === 'string' && kind && typeof fn === 'function') acts[kind] = fn;
  };
  fresh.hasAct = function (kind) { return has(acts, kind); };
  // Runs the registered function of a saved act -> Promise<address | null>. No function registered: null (the page says the sign-in worked and the person repeats the act).
  fresh.repeat = function (record) {
    if (!record || !has(acts, record.kind)) return Promise.resolve(null);
    let out;
    try { out = acts[record.kind](record); } catch (err) { return Promise.reject(err); }
    return Promise.resolve(out).then(function (address) { return typeof address === 'string' && address ? address : null; });
  };

  // ── the step inside an open dialog ──
  let step = null;

  // Remembers the act the step starts and returns the step's html, or null for a purpose this file does not know. backHtml: what Back restores.
  function armStep(o, backHtml, noBack) {
    const err = o.error || null;
    const purpose = o.purpose || (err && err.purpose) || null;
    if (!has(PURPOSES, purpose)) return null;
    const linked = o.linked || fresh.linkedOf(G.app && G.app.state ? G.app.state.me : null);
    const options = optionsFor(purpose, linked);
    step = {
      gid: o.gid || null, purpose: purpose, params: o.params || (err && err.params) || {}, act: o.act || { kind: purpose }, returnTo: o.returnTo || '',
      provider: options[0] || null, options: options.length, backHtml: backHtml,
    };
    return fresh.stepHtml({ purpose: purpose, linked: linked, stepLabel: o.stepLabel, primaryLabel: o.primaryLabel, text: o.text, noBack: noBack });
  }

  // opts: { form (the open dialog's form), error (the 403: purpose and params come from it), purpose, params, gid, act, linked, stepLabel, primaryLabel, text, returnTo }
  fresh.toStep = function (opts) {
    const o = opts || {};
    const dlg = o.form && o.form.closest ? o.form.closest('dialog') : null;
    if (!dlg) return false;
    const html = armStep(o, dlg.innerHTML, false);
    if (html === null) return false;
    G.ui.replaceDialogBody(dlg, html);
    return true;
  };

  // The step in a dialog of its own, for an act whose page has no dialog to swap (the delete box on the privacy page is inline). opts: toStep's, without `form`.
  fresh.openStep = function (opts) {
    const html = armStep(opts || {}, '', true);
    if (html === null) return false;
    if (G.ui.openDialog(html, { labelledBy: 'dlg-title' })) return true;
    step = null;
    return false;
  };

  // ui.runDialog for an act that may want the step: a 403 fresh_required swaps the dialog's body for the step (and the request is not "done": the returned promise settles only on
  // success or on another error); everything else is runDialog's own. opts: toStep's options without `form` and `error`.
  fresh.runDialog = function (form, promise, opts, onOk, onConflict) {
    const guarded = promise.then(null, function (err) {
      if (fresh.isRequired(err) && fresh.toStep(Object.assign({}, opts, { form: form, error: err }))) return new Promise(function () { /* the step took over this dialog */ });
      throw err;
    });
    return G.ui.runDialog(form, guarded, onOk, onConflict);
  };

  function chosenProvider(form) {
    const el = form && form.querySelector ? form.querySelector('input[name="provider"]:checked') : null;
    return el && known(el.value) ? el.value : null;
  }

  G.handlers.click['fresh-step-back'] = function (el) {
    const dlg = el && el.closest ? el.closest('dialog') : null;
    if (!dlg || !step) return;
    const back = step.backHtml;
    step = null;
    G.ui.replaceDialogBody(dlg, back);
  };

  G.handlers.submit['fresh-step-form'] = function (form) {
    if (!step) return;
    const current = step;
    G.ui.setText('dlg-error', '');
    G.ui.setBusy(form, true);
    fresh.start({ gid: current.gid, purpose: current.purpose, params: current.params, provider: chosenProvider(form) || current.provider, act: current.act, returnTo: current.returnTo }).then(null, function (err) {
      G.ui.setBusy(form, false);
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      G.ui.setText('dlg-error', fresh.errorText(err, current.purpose));
    });
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
