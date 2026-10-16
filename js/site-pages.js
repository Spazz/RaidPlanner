// ── SITE PAGES ──────────────────────────────────────────────────
// The wiring shared by every page that draws the shell: index.html (the planner), faq.html
// and whats-new.html. Needs js/util.js and js/changelog.js (faq.html also js/storage.js, for
// the "Show tips again" button).
//   - whats-new.html (the page with #whats-new-body) lists every release and marks the current
//     one as seen, so the shell's "New" pill (js/guild/shell.js) goes the next time any page is opened.
//   - The footer feedback link gets the version and browser added to its issue body.
//   - faq.html (the page with #faq-show-tips-again) resets the one-time feature tips.
function initSitePage(doc, storage, nav) {
  if (!doc || !storage) return;
  const body = doc.getElementById('whats-new-body');
  if (body) {
    body.innerHTML = renderChangelog();
    dismissWhatsNew(storage);
  }

  // The static href works without JS; this adds the facts a fix needs to the issue body.
  const link = doc.getElementById('feedback-link');
  if (link && nav) {
    const text = `Raidsmith ${APP_VERSION}\nBrowser: ${nav.userAgent}\n\nWhat happened:\n`;
    link.href = `${link.getAttribute('href').split('?')[0]}?body=${encodeURIComponent(text)}`;
  }

  const tips = doc.getElementById('faq-show-tips-again');
  if (tips && typeof Spotlight !== 'undefined') {
    tips.addEventListener('click', () => {
      Spotlight.resetAll(storage);
      const status = doc.getElementById('faq-tips-status');
      if (status) status.textContent = 'Feature tips will show again as you use the planner.';
    });
  }
}
// Reading localStorage can throw (blocked site data); the pages still work without it.
try { initSitePage(document, localStorage, navigator); } catch {}
