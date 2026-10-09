# Party Planner

A raid group planner for World of Warcraft Classic Era, TBC Anniversary and WoW Forever. Import a Raid-Helper sign-up list (or paste a roster), let the optimizer lay out the parties for buff and debuff coverage, adjust by drag and drop, then share a link, copy raid chat text, or export an MRT note.

Production: https://raid-planner-theta.vercel.app

It is a static site with no build step and no npm dependencies: `index.html`, `app.css` and eleven plain `<script src>` files under `js/`, plus one serverless function (`api/share.js`) for short and live share links.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Markup only. Loads `app.css` and the scripts below, in this order. |
| `js/rules.js` | Rulesets (buffs, debuffs, specs, raids) per game version. |
| `js/changelog.js` | `APP_VERSION` and the release notes behind the landing page's "What's new". |
| `js/state.js`, `import.js`, `storage.js`, `livesync.js` | Plan state, importers and exporters, local storage, live link sync. |
| `js/optimizer.js`, `analysis.js` | `Optimizer.plan()` (pure layout), scoring, buff resolution, coverage insights. |
| `js/render.js`, `modals.js`, `app.js` | Rendering and wiring. Every plan change goes through `commit()` (reconcile, persist, render). |
| `api/share.js` | Short and live share links on Upstash Redis (REST, plain `fetch`). |
| `scenarios.js` | Test rosters. Also fetched by the `?dev` roster picker (open `/?dev`). |
| `icons/` | Self-hosted spec, class, role and buff icons. |
| `*-tests.js`, `tests.js`, `*-scenarios.js`, `tests/` | The test suites and their runner. Not deployed. |

`.gitignore` is a whitelist: a new tracked file needs a `!path` line there.

## Local development

Everything except short and live links works from any static file server, for example:

```
python -m http.server 5173
```

Then open http://localhost:5173/. The `/<version>/<id>` link rewrite and `api/share.js` need Vercel's runtime: install the Vercel CLI yourself (it is not a project dependency) and run `vercel dev` with the environment variables below set.

## Tests

```
npm test
```

`tests/run-all.js` runs every `tests.js`, `*-tests.js` and `*-scenarios.js` at the repo root as its own Node process, up to three at a time (`PP_TEST_JOBS=1` runs them one by one), and exits non-zero if any fails (about a minute). The slow scenario suite is split into shards listed in `tests/shards.js`; `node scenario-tests.js` still runs it whole, and `--shard i/n` runs one slice. Run one suite with `node tests/run-all.js <name-filter>` or `node <suite>.js`. `tests/load-app.js` reads the script list from `index.html`, so the suites always test the files the page loads.

GitHub Actions runs `npm test` on every push and pull request (`.github/workflows/test.yml`). Vercel does not run the tests, so a green check on `main` is what to look at before deploying.

## Environment variables

`api/share.js` reads these, set in the Vercel project (Production and Preview):

| Variable | Purpose |
|---|---|
| `PP_KV_REST_API_URL` | Upstash Redis REST endpoint. |
| `PP_KV_REST_API_TOKEN` | Upstash Redis REST token. Never sent to the browser. |

Without both, the function answers 503 "Short links are unavailable" and the planner falls back to long `#r=` links.

## Deploy

Vercel deploys from GitHub `main`: **pushing to `main` deploys to production**, other branches get preview deployments. There is no build step (`vercel.json` sets `framework: null` and an empty install command).

`vercel.json` carries:

- **Rewrite** `/:version(tbc|classic|forever)/:id` to `/index.html`, so a live link opens the planner and the page fetches the plan.
- **Headers** on every route: an enforced `Content-Security-Policy` (scripts and styles from the site, Google Fonts, connections only to the site and Raid-Helper, no inline scripts or styles), `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

`.vercelignore` keeps tests, CI files and docs out of the deployment; `deploy-tests.js` checks it can never exclude something the page loads.

## Releases

User-visible changes get an entry at the top of `CHANGELOG` in `js/changelog.js` and a matching bump of `APP_VERSION` there and `version` in `package.json` (a test checks they agree). The landing page lists the newest releases under "What's new" and shows a "New" badge once per version for everyone who has not dismissed that version.
