// The public host of the site, in ONE place for the tests (the pages' og:url / og:image / twitter:image carry it).
// Deploy day: change SITE_HOST here and run the sweep in README.md ("When the domain changes"), nothing else in tests/ names the host.
const SITE_HOST = 'raidsmith.SUBDOMAIN.workers.dev';
const SITE = `https://${SITE_HOST}`;

module.exports = { SITE_HOST, SITE };
