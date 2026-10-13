// ── SHARED HELPERS ──────────────────────────────────────────────
// Loaded first by every page (index.html, faq.html, whats-new.html), so the static pages
// can render the release notes without loading the rules.
// Regex-based (not DOM-round-trip) so it also escapes the characters that
// matter in HTML ATTRIBUTE position, not just text-node position: the old
// document.createElement/textContent trick only produced &amp;/&lt;/&gt;,
// which left every `attr="${esc(name)}"` call site open to attribute-
// injection from a raw " or ' in a player/template/roster name. Also keeps
// esc() DOM-free so it can be unit-tested under Node and used by PrintSheet.
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
