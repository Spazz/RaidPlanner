// The guild shell's scripts in load order, for the suites that load them into a vm. The list itself lives in ONE place,
// js/guild/manifest.js (the browser's js/guild/load.js injects it); this file only reads it. Nothing here is edited when a
// guild page is added: add the file's line to the manifest.
//   GUILD_SCRIPTS  '/js/util.js' (each page loads it first) followed by the manifest, in order
//   GUILD_MANIFEST the manifest alone
//   GUILD_LOADER   the one tag index.html, faq.html and whats-new.html carry for it
//   guildScriptsOf(html)  the js/guild scripts a page text loads, in order: the loader stands for the whole manifest
//                         (a stray plain tag for a guild script would be listed too, so a duplicate shows up in a comparison)
const GUILD_MANIFEST = require('../js/guild/manifest.js');
const GUILD_LOADER = '/js/guild/load.js';
const GUILD_SCRIPTS = ['/js/util.js'].concat(GUILD_MANIFEST);

function guildScriptsOf(html) {
  const out = [];
  for (const match of String(html).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    if (match[1] === GUILD_LOADER) out.push(...GUILD_MANIFEST);
    else if (match[1].startsWith('/js/guild/')) out.push(match[1]);
  }
  return out;
}

module.exports = { GUILD_SCRIPTS, GUILD_MANIFEST, GUILD_LOADER, guildScriptsOf };
