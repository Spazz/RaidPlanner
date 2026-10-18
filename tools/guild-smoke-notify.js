#!/usr/bin/env node
/**
 * The isolated check of PM wave 4 (Discord channel posts, reminders, automatic refresh) against a seeded `guild-smoke.js` server:
 *   node tools/guild-smoke.js up   --name w4 --port 8790
 *   node tools/guild-smoke.js run  --name w4 tools/guild-smoke-notify.js
 *   node tools/guild-smoke.js down --name w4
 *
 * It saves a webhook for the seeded team that points at the FAKE Discord (the Worker's DISCORD_API_BASE is that fake, so no real Discord address is
 * accepted or ever called), makes a raid about 20 hours away, triggers the 15-minute Cron Trigger through Wrangler's test-scheduled endpoint
 * (GET /__scheduled?cron=<the cron string>) and reads what the fake RECORDED: the 24 h raid reminder and the "no answer yet" reminder (one person opted out of
 * the ping), nothing on a second run, and a second team whose webhook the fake answers 404 is switched off and shows in Needs attention.
 * Exit code 1 and a message on the first thing that is not as expected.
 */
const assert = require('node:assert/strict');
const smoke = require('./guild-smoke.js').fromEnv();

const HOUR = 3600000;
const TZ = 'America/New_York';
const CRON = '*/15 * * * *';
const ROOT = `/api/guild/${smoke.ids.guildId}`;
const hook = (id) => `${smoke.fakes.discord}/api/webhooks/${id}/smoketoken_abcdefghijklmnopqrstuvwxyz`;
const GOOD = hook('555555555555555501');
const DEAD = hook('555555555555555502');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const need = async (who, method, route, body, status = [200, 201]) => {
  const res = await smoke.api(who, method, route, body);
  assert(status.includes(res.status), `${who} ${method} ${route} -> ${res.status} ${res.text.slice(0, 200)}`);
  return res.json;
};
const fake = async (route) => (await fetch(`${smoke.fakes.discord}${route}`)).json();
const posts = async () => (await fake('/__fake/webhook-posts')).posts;
const trigger = async () => {
  const res = await fetch(`${smoke.base}/__scheduled?cron=${encodeURIComponent(CRON).replace(/%20/g, '+')}`);
  assert.equal(res.status, 200, `/__scheduled answered ${res.status}`);
  await sleep(1500); // the run is a waitUntil; the fake has the posts a moment later at most
};
// The guild-local date and HH:MM of a moment, for the raid form.
function localParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

(async () => {
  const startsAt = Date.now() + 20 * HOUR;
  const { date, time } = localParts(startsAt);
  await fake('/__fake/webhook-mode'); // back to 204
  await fake('/__fake/webhook-posts?clear=1');

  // 1. Settings: the address goes in, a hint comes back, the address does not.
  const saved = await need('gm', 'PUT', `${ROOT}/teams/${smoke.ids.teamId}/notifications`, { webhookUrl: GOOD, reminders: true, noreply: true, noreplyHours: 24 });
  assert.equal(saved.team.webhook.set, true);
  assert(!JSON.stringify(saved).includes('smoketoken'), 'the address is never sent back');
  assert(!JSON.stringify(await need('gm', 'GET', `${ROOT}/notifications`)).includes('smoketoken'));
  const refused = await smoke.api('gm', 'PUT', `${ROOT}/teams/${smoke.ids.teamId}/notifications`, { webhookUrl: 'https://example.com/api/webhooks/1/x' });
  assert.equal(refused.status, 400);
  assert.equal((await smoke.api('member', 'GET', `${ROOT}/notifications`)).status, 403);

  // 2. A raid about 20 hours away, and member2 opts out of being pinged.
  const raid = await need('gm', 'POST', `${ROOT}/raids`, { teamId: smoke.ids.teamId, raidOn: date, startTime: time, zone: "Gruul's Lair", title: 'Smoke reminder' });
  await need('member2', 'PUT', '/auth/reminders', { optOut: true });
  assert.equal((await need('member2', 'GET', '/auth/me')).account.reminderOptOut, true);

  // 3. The 15-minute run: the raid reminder and the no-answer reminder, recorded by the fake.
  await trigger();
  const first = await posts();
  assert.equal(first.length, 2, `two posts expected, the fake recorded ${first.length}: ${JSON.stringify(first.map((p) => p.body.embeds[0].title))}`);
  const titles = first.map((p) => p.body.embeds[0].title).sort();
  const teamName = (await need('gm', 'GET', `${ROOT}/notifications`)).teams[0].name;
  assert.deepEqual(titles, [`Raid in about 24 hours: Smoke reminder - ${teamName}`, `Sign up or send word: Smoke reminder - ${teamName}`].sort());
  const ask = first.find((p) => p.body.embeds[0].title.startsWith('Sign up or send word')).body;
  const ids = smoke.ids.discordIds;
  assert.deepEqual(ask.allowed_mentions.users.sort(), [ids.gm, ids.member].sort(), 'member2 opted out: listed, not pinged');
  assert.deepEqual(ask.allowed_mentions.parse, [], 'no @everyone, no @here, nothing parsed');
  assert(ask.embeds[0].description.includes('- Quillfeather'), 'the opted-out person is still listed by name');
  assert(ask.embeds[0].url.endsWith(`/#/g/${smoke.ids.guildId}/raids/r/${raid.raid.id}`), ask.embeds[0].url);

  // 4. Again: nothing new (the log rows make every message once-only).
  await trigger();
  assert.equal((await posts()).length, 2, 'a second run sends nothing');

  // 5. A second team whose webhook Discord has deleted (the fake answers 404): switched off at once, in Needs attention.
  const two = await need('gm', 'POST', `${ROOT}/teams`, { name: 'Smoke Two' });
  await need('gm', 'POST', `${ROOT}/raids`, { teamId: two.team.id, raidOn: date, startTime: time, zone: "Gruul's Lair", title: 'Dead channel' });
  await need('gm', 'PUT', `${ROOT}/teams/${two.team.id}/notifications`, { webhookUrl: DEAD, reminders: true });
  await fake('/__fake/webhook-mode?status=404&id=555555555555555502');
  await trigger();
  const after = await posts();
  assert.equal(after.length, 3, 'the dead webhook was tried once');
  assert.equal(after[2].status, 404);
  const settings = await need('gm', 'GET', `${ROOT}/notifications`);
  assert.deepEqual(settings.teams.map((t) => [t.name === 'Smoke Two', t.webhook.state]).sort(), [[false, 'ok'], [true, 'disabled']]);
  const attention = await need('gm', 'GET', `${ROOT}/attention`);
  const off = attention.items.filter((i) => i.kind === 'webhook_off');
  assert.deepEqual(off.map((i) => [i.teamName, i.status]), [['Smoke Two', 404]]);
  await trigger();
  assert.equal((await posts()).length, 3, 'and not again');
  const log = await need('gm', 'GET', `${ROOT}/audit?group=settings`);
  assert(log.rows.some((r) => r.text === 'Turned off the Discord webhook of Smoke Two: Discord answered 404' && r.actor.displayName === 'Raidsmith'));

  console.log(JSON.stringify({ ok: true, posts: after.length, titles: after.map((p) => p.body.embeds[0].title), webhookOff: off.length }));
})().catch((error) => {
  console.error(`guild-smoke-notify: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
