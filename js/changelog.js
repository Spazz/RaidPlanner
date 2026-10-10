// ── RELEASE NOTES ───────────────────────────────────────────────
// What the landing page's "What's new" list shows. Newest entry first; its version is
// APP_VERSION (package.json carries the same number, changelog-tests.js checks both).
// Shipping a user-visible change means adding an entry here and bumping both: the
// "New" badge then appears once for everyone who dismissed an older version.
const APP_VERSION = '4.2.0';
const CHANGELOG = [
  { version: '4.2.0', date: '2026-10-10', title: 'Smarter TBC groups', changes: [
    'A Ret Paladin is now placed in the same group as an Enhancement Shaman.',
    'Hunters stay out of caster groups, and when the raid has two Enhancement Shamans they spread over the melee groups as evenly as the seats allow.',
    'Destruction Warlocks now stack in a group with the Elemental Shaman and the Balance Druid.',
    'A spare Elemental or Restoration Shaman covers a melee group that has no Windfury.',
    'A second Feral Druid or Enhancement Shaman in one group is avoided, and a redundant third Enhancement Shaman is benched before a DPS player.',
    'At most 6 healers are seated when more healers would bench DPS players.',
    'A spare hunter is no longer parked in the tank group as its guest; a caster takes that seat.',
    'Optimize now also tries rotating players through three groups, and re-checks the board after its last passes.',
    "Open-slot suggestions favour a Feral Druid for a hunter group: a Feral no longer pays for a Windfury totem it cannot use, and Marksmanship gets no credit for Improved Hunter's Mark (every raid hunter build has it).",
  ] },
  { version: '4.1.0', date: '2026-10-09', title: 'See what changed', changes: [
    'A Changes button at the end of the action row lists what a sign-up sync, a raid size change or a live link update did to the roster, newest first.',
    'Each change names the player and what happened: benched, seated, a new sign-up status, a new sign-up, a dropped sign-up, or a group move from a co-editor.',
    'Changed players are outlined and tagged on their cards, on the bench and in the Sign-ups tabs until you click Mark all seen.',
    "Undoing a co-editor's update removes it from the list. The list covers this session only and starts over with each new plan or import.",
    'Phones: Changes is in the More sheet, and the More button shows how many changes you have not seen yet.',
    'Click the Party Planner title in the header to go back to the home screen and load a different plan. Your current plan stays there to resume.',
  ] },
  { version: '4.0.1', date: '2026-10-09', title: 'Smarter Open slots', changes: [
    'Optimize arranges suggested and requested Open slots together with everyone else, moving as many players as it takes: a suggested Enhancement Shaman now lands with the Arms, Ret, Fury and Rogue who use Windfury.',
    'Adding an Open slot to a group no longer freezes that group; Optimize can rearrange it.',
  ] },
  { version: '4.0.0', date: '2026-10-09', title: 'A slimmer planner header', changes: [
    'One action row: Optimize, Undo, Redo, Raid size, Compare to ideal comp and Raid notes, with the readiness line right below it.',
    'Optimize always places buffs for the most damage; the strategy picker and the Compare all strategies dialog are gone.',
    'Pick 10 or 25 (20 or 40 on Classic; 10, 20 or 40 on Forever) instead of a specific raid. Saved plans keep the raid they were made for.',
    'Comp templates show for every raid of the same size, labelled with their raid when two share a name.',
    'Going 25 to 10 and back to 25 seats the players the switch benched, even after undo or a reload. Anyone you bench yourself stays benched.',
    'The Plan and Sign-ups menus moved into the gear menu. To import sign-ups, use Menu > New plan, which opens the import screen.',
    'Plan names, raid chat text and the print sheet now say "25-man" instead of the raid name.',
    'The Assignments tab is hidden for now.',
    'Phones: plan name, raid size and a short readiness link share one compact row, so your groups start a little higher.',
  ] },
  { version: '3.0.0', date: '2026-10-08', title: 'Planning tools and polish', changes: [
    'Custom assignment rows (interrupts, cube clickers, kiters, marks) and a one-click MRT note export; templates carry the planning with them.',
    'Warriors now cast one shout each: a second warrior covers Commanding Shout for the tank group, and the optimizer values it.',
    'The strategy menu shows "Current board X vs optimized Y" so you can see whether Optimize would help before you click.',
    'New shortcuts: M copies the MRT note, L copies the share link, C copies the raid chat text. Ctrl+S is now labelled Save a copy, since plans save themselves.',
    'Live links check for changes less often while nothing is happening, and catch up the moment you switch back to the tab.',
    'Link previews with a proper card image, calmer animations for anyone who asks for reduced motion, and bigger tap targets for buff icons on phones.',
    'The Copy addon string action is gone; older addon strings still import.',
  ] },
  { version: '2.0.0', date: '2026-10-02', title: 'A sturdier foundation', changes: [
    'Plans are saved reliably: saved plans are never silently dropped, a full browser store is handled, and a second tab editing the same plan raises a banner.',
    'Live updates from a co-editor keep your own totem and aura picks, and wait while you have the editor, buff picker or notes open.',
    'Updated by someone else? A banner offers Undo, and a failed clipboard copy opens a manual-copy dialog.',
    'Confirmations before a shared link, a version switch or a random roster replaces your plan; the latest import always wins.',
    'Optimize reproduces the reference 25-man comp pattern: Survival hunters spread one per melee group, and one Affliction Warlock takes the healer group overflow seat.',
    'Spec, class, role and buff icons are served from the site with a text fallback, and the site enforces a Content-Security-Policy.',
    'Raid-Helper imports accept only Raid-Helper links.',
  ] },
  { version: '1.0.0', date: '2026-09-30', title: 'Security and reliability', changes: [
    'Share and live links no longer accept crafted class, spec or role values; names with dots or commas (Mr.T) now survive a share link.',
    'Live links re-create themselves when they expire, send your last edit when you close the tab, stop retrying plans the server rejects, and are rate limited.',
    'Every player slot can be reached and opened with the keyboard; toasts are announced to screen readers and faint text is easier to read.',
    'Buff data fixes: Misery belongs to Shadow Priests, Hunter\'s Mark to any Hunter, Unleashed Rage is melee-only, and Totem of Wrath reads correctly.',
    'Drum spreading no longer removes a group\'s only Leader of the Pack or Moonkin Aura.',
    'Data backups include your live links; a failed Raid B save when splitting a raid no longer reports success.',
    'Chat exports and the print sheet use the raid event\'s date, and importing an addon string starts a fresh plan.',
  ] },
  { version: '0.9.0', date: '2026-09-26', title: 'Earlier releases', changes: [
    'Classic Era and WoW Forever Beta rulesets, with real per-version buffs, debuffs and raids, not just TBC.',
    'Assignments tab: healer-to-tank pairings, Paladin blessings and boss debuff assignments.',
    'Raid Prep panel: per-encounter notes and consumable checklists, sourced and linked.',
    'Copy raid groups as chat-ready text for Discord or in-game raid chat, or open a clean printable raid sheet.',
    'Planned bench backups and one-click split into two raids for oversized sign-up lists.',
    'Utility and balance readiness checks, plus a raid notes panel for MT swaps and add plans.',
  ] },
];

// "3.0.0" -> [3, 0, 0], or null for anything that is not a plain three-part version.
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text == null ? '' : text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Whether a stored dismissal covers APP_VERSION. The stored value is the version that was
// dismissed; the pre-versioned "true" (and anything unreadable) covers nothing, so everyone
// who dismissed the old list sees the badge once for the first versioned release.
function whatsNewDismissed(stored, current = APP_VERSION) {
  const have = parseVersion(stored), want = parseVersion(current);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

// The markup for the newest `limit` releases (pure; the landing page assigns it once).
function renderChangelog(entries = CHANGELOG, limit = 3) {
  return entries.slice(0, limit).map(entry => `
      <h3 class="whats-new-version">${esc(entry.title)} <span>v${esc(entry.version)}, ${esc(entry.date)}</span></h3>
      <ul class="whats-new-list">${entry.changes.map(line => `<li>${esc(line)}</li>`).join('')}</ul>`).join('');
}
