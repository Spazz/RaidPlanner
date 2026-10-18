// ── GUILD SCRIPT LOADER ─────────────────────────────────────────
// index.html, faq.html and whats-new.html end with this one tag instead of a copy of the guild script list. It loads
// js/guild/manifest.js, then adds a script element for every file the manifest names, in the manifest's order.
//   A script element created from code runs in the order it was added once async is false, like the plain tags this
//   replaces, and after the page's own scripts. The sources are same-origin files and nothing is inline, which is all the
//   pages' CSP asks (script-src 'self'). A file that fails to load is reported and the rest still load, as with plain tags.
(function () {
  'use strict';

  if (typeof document === 'undefined' || !document.createElement) return;

  const MANIFEST_SRC = '/js/guild/manifest.js';

  function report(message) {
    if (typeof console !== 'undefined' && console.error) console.error(message);
  }

  // Appends one classic script and calls onSettled(true | false) when it has run or failed.
  function addScript(src, onSettled) {
    const el = document.createElement('script');
    el.async = false;
    el.onload = function () { if (onSettled) onSettled(true); };
    el.onerror = function () {
      report('Guild script failed to load: ' + src);
      if (onSettled) onSettled(false);
    };
    el.src = src;
    (document.head || document.documentElement).appendChild(el);
  }

  addScript(MANIFEST_SRC, function (ok) {
    const guild = typeof window !== 'undefined' ? window.Guild : null;
    const scripts = ok && guild && Array.isArray(guild.manifest) && guild.manifest.length ? guild.manifest : null;
    if (!scripts) {
      if (ok) report('Guild script manifest is empty or missing');
      return;
    }
    scripts.forEach(function (src) { addScript(src); });
  });
})();
