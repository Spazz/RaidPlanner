# Party Planner

A raid group planner for World of Warcraft Classic Era, TBC Anniversary and WoW Forever. Import a Raid-Helper sign-up list (or paste a roster), let the optimizer lay out the parties for buff and debuff coverage, adjust by drag and drop, then share a link, copy raid chat text, or export an MRT note.

Production: https://raid-planner-theta.vercel.app

It is a static site with no build step and no npm dependencies: `index.html`, `app.css` and sixteen plain `<script src>` files (twelve under `js/`, the four rules data files under `js/rules/`), plus one serverless function (`api/share.js`) for short and live share links.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Markup only. Loads `app.css` and the scripts below, in this order. |
| `js/rules.js` | `Config`, the rules compiler `Rulesets.compile` with its closed `Rulesets.CONVENTIONS` schema, the compiled rulesets (one per game version) and the version helpers. |
| `js/rules/` | The rules, as data: `catalog.js` (shared by every version: classes, specs, icons, abbreviations) and one file per game version (`tbc.js`, `classic.js`, `forever.js`: buffs, debuffs, weights, tuning numbers, raids). The source of truth, edited by hand; see Editing the rules. Loaded before `js/rules.js`. |
| `js/changelog.js` | `APP_VERSION` and the release notes behind the landing page's "What's new". |
| `js/state.js`, `import.js`, `storage.js`, `livesync.js` | Plan state, importers and exporters, local storage, live link sync. |
| `js/optimizer.js`, `analysis.js` | `Optimizer.plan()` (pure layout), scoring, buff resolution, coverage insights. |
| `js/changes.js` | The roster change log: who a sign-up sync, a raid size change or a live update benched, seated or moved. |
| `js/render.js`, `modals.js`, `app.js` | Rendering and wiring. Every plan change goes through `commit()` (reconcile, persist, render). |
| `api/share.js` | Short and live share links on Upstash Redis (REST, plain `fetch`). |
| `scenarios.js` | Test rosters. Also fetched by the `?dev` roster picker (open `/?dev`). |
| `tools/` | `rules-report.js` (prints a version's weights and tuning numbers for review) and `generate-rules-data.js` (a guarded one-shot record that refuses to run). Not deployed. |
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

`tests/run-all.js` runs every `tests.js`, `*-tests.js` and `*-scenarios.js` at the repo root as its own Node process, up to three at a time (`PP_TEST_JOBS=1` runs them one by one), and exits non-zero if any fails (about a minute). The slow suites (`scenario-tests.js`, `boards-tests.js`) are split into shards listed in `tests/shards.js`; running a suite file directly still runs it whole, and `--shard i/n` runs one slice. Run one suite with `node tests/run-all.js <name-filter>` or `node <suite>.js`. `tests/load-app.js` reads the script list from `index.html`, so the suites always test the files the page loads.

`boards-tests.js` builds the optimized board of every scenario in `scenarios.js` and of the six Classic/Forever rosters in `tests/classic-forever-fixtures.js`, and compares each with the golden snapshot `tests/boards-snapshot.json`, listing who moved when a rule or weight edit changes a layout. A changed layout is accepted only on purpose, with `node boards-tests.js --update`, which rewrites the snapshot (read its git diff before committing it).

`rules-data-tests.js` guards the rules data files in `js/rules/`: it pins the buff and debuff ids per version in `tests/rules-ids-snapshot.json` (a rename or removal is accepted only on purpose, with `node rules-data-tests.js --update`), checks that every version still compiles into the shape the app reads and keeps the vocabulary the code relies on (types, known roles, classes and specs, finite weights, references that exist, spell ids, an icon, abbreviation and CSS class for every buff id, an abbreviation for every debuff id), that each `conventions` block holds exactly the keys of `Rulesets.CONVENTIONS` and that the keys the code reads (`rules.rules.<name>`) and that schema agree, and exercises `Rulesets.compile` on small synthetic data.

GitHub Actions runs `npm test` on every push and pull request (`.github/workflows/test.yml`). Vercel does not run the tests, so a green check on `main` is what to look at before deploying.

## Editing the rules

Every tuning number in `conventions` and every buff and debuff weight lives in the rules data files in `js/rules/`, one per game version, meant to be edited by hand:

| Game version | File |
|---|---|
| WoW TBC Anniversary | `js/rules/tbc.js` |
| WoW Classic Era (faction-aware: Horde shamans, Alliance paladins) | `js/rules/classic.js` |
| WoW Forever (beta) | `js/rules/forever.js` |
| All three: classes, roles, specs and their icons, the Raid-Helper maps, and the icon, abbreviation and CSS class of every buff and debuff id | `js/rules/catalog.js` |

A version file is one plain object literal, `RulesData.<version> = { ... }`, loaded before `js/rules.js`, which compiles it at load (`Rulesets.compile`). There is no build step: edit and reload. The comments in each file explain its numbers, and a trailing comment on a weight names the research note behind it (`tasks/research-*.md`) where there is one. The Ideal-comp builders (`js/app.js`) and the blessing catalog (`js/analysis.js`) are code, not data.

**Buff entries** (`buffs`: one per id, in display order)

| Field | Meaning | Allowed values |
|---|---|---|
| `name`, `desc` | Name and tooltip text. | Strings. |
| `spellId` | The max-rank spell, to check the entry against Wowhead. Not read by the optimizer. | A positive integer, unique within the version; `null` when unknown. |
| `buffType` | The slot rule the optimizer applies. | `totem` (one per element per shaman), `paladinAura` (one per paladin), `warriorShout` (one per warrior), `passive` (always on while its provider is in the group). |
| `totemElement` | The element a totem occupies. | `air`, `earth`, `water`, `fire`; totems only. |
| `cooldownTotem` | Mana Tide: credited on top of the shaman's standing water totem instead of occupying the slot. | `true`; totems only. |
| `scope` | Where it applies. | `party` (everything the optimizer places) or `raid` (accepted, not used yet). |
| `sourceClass`, `sourceSpec` | Who provides it; `sourceSpec` only when the buff is talent-gated. | A class of the catalog; a spec of that class. |
| `preferSpec` | A placement hint shown in the UI; the scorer ignores it. | A spec of `sourceClass`. |
| `targetRoles` | The roles that gain from it. | Any of `tank`, `healer`, `melee_dps`, `ranged_dps`, `caster_dps`. |
| `priority` | The order of a group's buff badges (higher first) for the group's most common role. | A number, or a map role -> number. |
| `weight` | What the optimizer scores, see below. | `{ dps, mitigation, sustain }`, each optional. |
| `exclusiveBuffs` | Ids that share one slot per party with this one (Forever: Windfury and Grace of Air); the better-valued member wins. | Buff ids of the same version; both members list each other. |

**How `weight` is applied.** `weight.dps` is what a recipient gains. Its key is looked up on the recipient in this order: the exact `CLASS:Spec` (`PALADIN:Retribution`), then the bare class (`WARLOCK`), then the role (`melee_dps`); no match is 0. The number is then multiplied by the recipient's own DPS weight: `specDpsWeight` for its `CLASS:Spec`, else `roleDpsWeight` for its role (0.8 when the role is missing too), so the strongest DPS is placed where it gets buffed first. `dps: {}` is written out for a buff that is worth nothing to anyone's DPS. `weight.mitigation` is what a tank gains, keyed by the tank's `CLASS:Spec` with `'*'` as the fallback for any other tank (not multiplied by the DPS weight). `weight.sustain` is one number for the tank group's healers, counted per healer present (at most two).

**Debuff entries** (`debuffs`)

| Field | Meaning | Allowed values |
|---|---|---|
| `name`, `desc`, `spellId`, `sourceClass`, `sourceSpec` | As for buffs. | |
| `debuffType` | Descriptive only. | `armor`, `attackPower`, `magicVulnerability`, `physicalVulnerability`, `attackSpeed`, `hitChance`, `holyVulnerability`, `healOnHit`, `manaOnHit`, `other`. |
| `targetRoles` | Who profits; the Open-slot pricing has a group for each of these combinations. | `['melee_dps', 'ranged_dps']` (physical), `['ranged_dps']`, `['caster_dps']`, `['tank']`, or all three DPS roles. |
| `targetSchool` | Narrows casters to the specs that cast one school. | `shadow`, `fire`, `frost`, `nature`, `arcane`; only with `targetRoles: ['caster_dps']`. |
| `weight` | The Open-slot tier: what suggesting a spec that brings the debuff is worth (tier x the DPS weight of the raid members it helps; for a tank debuff, tier x tank count x `modeConfig.max_dps.mit` x 4), on the scale of `weight.dps`. It does not move the party layout. | A number. |
| `competesWith`, `supersededBy` | Debuffs that share its slot, and the one that replaces it; a debuff is not worth suggesting when one of them is already covered. | Debuff ids of the same version. |

**Sections of a version file**

| Section | Meaning | Allowed values |
|---|---|---|
| `buffs`, `debuffs` | The entries above. | Id -> entry. |
| `specDpsWeight` | Expected DPS output per spec relative to the raid's top spec (1.0): the multiplier on every buff weight that spec receives. | `CLASS:Spec` -> number. |
| `roleDpsWeight` | The same per role, for specs without an entry. | Role -> number. |
| `bestAirTotem`, `bestPaladinAura` | The default air totem and paladin aura per recipient role. A reference table the tests read; the layout picks by value. | Role -> buff id. |
| `specAura` | The aura a paladin spec runs when several are valued equally. | Paladin spec -> aura id. |
| `spreadProviders` | Classes whose buff is a single point of failure: the last optimizer phase spreads them one per group. Absent in TBC. | `[{ class, spec? }]`; `spec` may be a list, none means every spec. |
| `factionLock` | `true`: Shaman is Horde-only and Paladin Alliance-only (Classic Era); `false` or absent: both on both factions. | Boolean. |
| `tankAnchorOrder` | The tank classes in the order they anchor the healer/tank group; other classes come after. | A list of classes. |
| `healerGroupDps` | The DPS specs the reference comp parks in the healer group as its one overflow seat (no guest cost there). | `[{ class, spec }]`; `[]` for none. |
| `stackPenalty` | The penalty for a second copy of a party-buff provider in one group (triangular; every matching entry adds). | `[{ class, spec?, weight }]`; `[]` for none. |
| `conventions` | Every tuning number and flag, see below. | The closed key list of `Rulesets.CONVENTIONS`. |
| `raids` | The version's raids in picker order, planning templates last. | Id -> `{ name, size, groups, tier }`; ids are unique across versions. |
| `utilities` | The class-presence checklist (battle rez, cleanses, ...). | Id -> `{ name, providers: [{ class, spec?, note? }], desc }`. |

**Conventions.** `conventions` holds the scorer's tuning numbers and flags, `modeConfig` (the objective weights per optimizer mode: only `max_dps` is supported, the other three stay so old saved plans and share links validate) and `openSlots` (Open-slot pricing). Every version file lists every key: `Rulesets.CONVENTIONS` in `js/rules.js` is the closed list, and a missing, an unknown or a mistyped key stops the page at load and fails `rules-data-tests.js`, so a misspelled knob cannot be ignored. A number of `0` and a flag of `false` switch a rule off for that version; `healerCapOverFloor: null` means no cap. The line above each key gives its unit, what it trades against and the `boards-tests.js` fixtures that moved when its value was changed. Not yet in `conventions`, still literals in `js/optimizer.js`: the tank group's healer pull (10 per core healer), the fourth-healer bonus (3), the cost per healer past four (15), the two-healer cap on `weight.sustain`, the cost of a tank in a caster group (25) and the Open-slot tank-debuff scale (tank count x `mit` x 4).

**Ids never change.** Saved plans and share links store buff and debuff ids (manual totem overrides, debuff assignments), so `tests/rules-ids-snapshot.json` pins them per version. Do not rename or remove one; adding, renaming or removing an id fails `rules-data-tests.js` until you accept the new list on purpose with `node rules-data-tests.js --update`.

**The edit loop**

1. Edit `js/rules/<version>.js`.
2. `node rules-data-tests.js` checks the vocabulary, the references, the ids and the conventions keys.
3. `node tools/rules-report.js <tbc|classic|forever>` prints what the optimizer will use: the buff-by-recipient weight matrix (the effective weight per `CLASS:Spec`), the mitigation and sustain weights, the debuffs, and every convention flat with the first clause of its comment (`--json` for scripts). Read-only.
4. `node boards-tests.js` rebuilds the 120 fixture boards and lists who moved. A deliberate change is accepted with `node boards-tests.js --update` (read the diff of `tests/boards-snapshot.json` first).
5. `npm test` runs everything.

Classic and Forever are independent games: their files may differ on purpose and no test compares them, so edit one without touching the other.

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
