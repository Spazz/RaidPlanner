/**
 * Raidsmith guild tracker - PM wave 4 Worker tests (Discord channel posts, reminders, roster confirm reminder, automatic Raid-Helper refresh).
 * Run: node guild-wave4-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js) with a fake clock. Discord webhooks and Raid-Helper are faked by an injected
 * fetch that RECORDS what the Worker posts: nothing here touches the network, and no real Discord address is ever used.
 */
const assert = require('node:assert/strict');
const { load, adminOf, memberOf, makeWorld, signIn, newJar } = require('./tests/guild-world');

const SERVER = '900000000000000031';
const person = (n, name) => ({ id: `1100000000000001${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(1, 'Gmfour'), lead: person(2, 'Leadfour'), m1: person(3, 'Memberone'), m2: person(4, 'Membertwo'), m3: person(5, 'Memberthree') };
const STEP = 2000;
const HOUR = 3600000;
const TZ = 'America/New_York';
const HOOK_ID = '987654321098765432';
const HOOK_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDE';
const HOOK = `https://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`;
const HOOK_B = `https://discord.com/api/webhooks/${HOOK_ID}/zyxwvutsrqponmlkjihgfedcba9876543210EDCBA`;
const CRON = '*/15 * * * *';
const DAILY = '17 4 * * *';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const filter = process.argv[2] || '';

// A guild with a Guild Master, optionally members (signed in, so they join through the Discord server) and a lead, over a fetch that records webhook posts and
// answers Raid-Helper events. net.webhook(url) -> the status Discord answers a post with (204 = fine).
async function scenario({ teams = 1, members = [], leads = [] } = {}) {
  const net = { posts: [], events: new Map(), eventCalls: [], webhook: () => 204 };
  const w = await makeWorld({
    wrapFetch: (discordFetch) => async (url, init = {}) => {
      const text = String(url);
      if (text.startsWith('https://discord.com/api/webhooks/')) {
        const status = net.webhook(text);
        net.posts.push({ url: text, status, body: JSON.parse(init.body), at: w.clock.now });
        return new Response(status === 204 ? null : '{"message":"nope"}', { status });
      }
      const event = /^https:\/\/raid-helper\.dev\/api\/v4\/events\/(\d+)$/.exec(text);
      if (event) {
        net.eventCalls.push({ id: event[1], at: w.clock.now });
        const found = net.events.get(event[1]);
        if (found instanceof Error) throw found;
        return found ? Response.json(found) : new Response('{}', { status: 404 });
      }
      return discordFetch(url, init);
    },
  });
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Wave Four', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: TZ,
    multipleTeams: teams > 1, ...(teams > 1 ? { teamNames: ['Alpha', 'Bravo', 'Charlie'].slice(0, teams) } : {}),
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  if (teams === 1) assert.equal((await w.call(jars.gm, 'PATCH', `/api/guild/${gid}/teams/${tids[0]}`, { name: 'Alpha' })).status, 200);
  const uids = {};
  for (const key of new Set([...members, ...leads])) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  const s = {
    w, net, gid, tids, tid: tids[0], jars, uids, base: `/api/guild/${gid}`, lines: [],
    async call(who, method, tail, body) {
      w.advance(STEP);
      return w.call(jars[who], method, tail.startsWith('/api/') || tail.startsWith('/auth/') ? tail : `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // A raider on the team; link: the key of a signed-in member whose account becomes theirs; discordId: the Discord ID an import stored on the person.
    async person({ name, status = 'raider', team = tids[0], link = null, cls = 'WARRIOR', spec = 'Arms' } = {}) {
      const body = { teamId: team, name, class: cls, mainSpec: spec, offSpec: null, status };
      if (link) body.linkUserId = uids[link];
      const res = await s.ok('gm', 'POST', '/roster', body);
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    // The team's sign-up deadline (hours before the start), set straight in the database: the schedule page's own route is not what is tested here.
    deadline(hours, team = tids[0]) { w.db.sqlite.prepare('UPDATE teams SET signup_close_hours = ? WHERE id = ?').run(hours, team); },
    // The team's notification settings, saved by the Guild Master.
    async notify(patch, team = tids[0], who = 'gm') {
      return s.ok(who, 'PUT', `/teams/${team}/notifications`, patch);
    },
    // A raid starting `startsAt` (epoch ms, on a whole minute), made through the API; options: { title, zone, team, size }.
    async raidAt(startsAt, { title, zone = "Gruul's Lair", team = tids[0] } = {}) {
      const { localDate } = await load('worker/attendance-calendar.js');
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(startsAt));
      const res = await s.ok('gm', 'POST', '/raids', { teamId: team, raidOn: localDate(startsAt, TZ), startTime: time, zone, ...(title ? { title } : {}) });
      const check = await s.rows('SELECT starts_at FROM raids WHERE id = ?', res.raid.id);
      assert.equal(check[0].starts_at, startsAt, 'the raid starts when the test says');
      return res.raid.id;
    },
    // One 15-minute (or daily) scheduler run at the world's clock.
    async run(cron = CRON) {
      const { runCron } = await load('worker/scheduler.js');
      const { defaultRandomBytes } = await load('worker/ids.js');
      return runCron({ cron, db: w.db, env: w.env, fetch: w.fetch, now: () => w.clock.now, randomBytes: defaultRandomBytes, log: (line) => s.lines.push(line) });
    },
    async attention(who = 'gm') { return (await s.ok(who, 'GET', '/attention')); },
    async logRows() { return s.rows('SELECT kind, dedupe_key, status, attempts, http_status, people FROM notification_log ORDER BY created_at, id'); },
    async audits(action) { return (await s.rows('SELECT actor_user_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY created_at, id', gid, action)); },
  };
  for (const key of leads) await s.ok('gm', 'PUT', `/people/${uids[key]}/roles`, { officer: false, teamLeadTeamIds: [tids[0]] }, 200);
  return s;
}

// A second guild in the same database, made by its own Guild Master: { gid, tid, jar, path(tail) }.
async function secondGuild(s, name = 'Other Guild', serverId = '900000000000000032') {
  const jar = (await signIn(s.w, person(9, 'Gmtwo'), [adminOf(serverId)])).jar;
  const made = await s.w.call(jar, 'POST', '/api/guild', { serverId, name, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: TZ, multipleTeams: false });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  return { gid, tid: made.json.teams[0].id, jar, path: (tail) => `/api/guild/${gid}${tail}` };
}

// Starts 10 hours after the world's first moment, a whole number of hours, so raid times are whole minutes.
const T0 = 1_800_000_000_000;
const at = (hours) => T0 + hours * HOUR;
const embedOf = (post) => post.body.embeds[0];
const fieldText = (post) => JSON.stringify(post.body);

// ---------------------------------------------------------------------------
// Pure: worker/notify.js

check('webhook address: only Discord\'s own, a hint of the last four characters, role mentions and Discord\'s answers', async () => {
  const n = await load('worker/notify.js');
  assert.deepEqual(n.parseWebhookUrl(HOOK, {}), { ok: true, url: HOOK });
  assert.equal(n.parseWebhookUrl(`  ${HOOK}  `, {}).ok, true, 'trimmed');
  for (const bad of ['', '   ', null, undefined, 5, 'https://example.com/api/webhooks/123456789012345678/' + HOOK_TOKEN, `http://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`,
    `https://discord.com.evil.test/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`, `https://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}?wait=true`, `https://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}/x`,
    `https://discord.com/api/webhooks/12/${HOOK_TOKEN}`, `https://discord.com/api/webhooks/${HOOK_ID}/short`, `https://user@discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`,
    `https://discord.com:8443/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`, `https://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}#x`]) {
    assert.equal(n.parseWebhookUrl(bad, {}).ok, false, String(bad));
  }
  // A local fake is honoured only when DISCORD_API_BASE names one; a real server never posts anywhere but discord.com.
  const local = { DISCORD_API_BASE: 'http://127.0.0.1:18790' };
  assert.equal(n.parseWebhookUrl(`http://127.0.0.1:18790/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`, local).ok, true);
  assert.equal(n.parseWebhookUrl(HOOK, local).ok, false, 'with a local fake configured the real address is not accepted');
  assert.equal(n.parseWebhookUrl(`http://127.0.0.1:18790/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`, {}).ok, false);
  assert.equal(n.parseWebhookUrl(`http://evil.test:1/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`, { DISCORD_API_BASE: 'http://evil.test:1' }).ok, false, 'DISCORD_API_BASE is honoured for local fakes only');
  assert.equal(n.webhookHint(HOOK), '.../BCDE'.replace('BCDE', HOOK_TOKEN.slice(-4)));
  assert.equal(n.webhookHint(null), null);
  assert.deepEqual(n.parseRoleMention('<@&123456789012345678>'), { ok: true, value: '123456789012345678' });
  assert.deepEqual(n.parseRoleMention(' 123456789012345678 '), { ok: true, value: '123456789012345678' });
  assert.deepEqual([n.parseRoleMention(''), n.parseRoleMention(null), n.parseRoleMention(undefined)], [{ ok: true, value: null }, { ok: true, value: null }, { ok: true, value: null }]);
  for (const bad of ['@everyone', '@here', '<@123456789012345678>', '<@&1234>', '<@&123456789012345678> <@&123456789012345678>', 'role', 5, '<@&123456789012345678>x']) {
    assert.equal(n.parseRoleMention(bad).ok, false, String(bad));
  }
  assert.deepEqual([204, 200, 404, 401, 403, 429, 500, 502, 400, 302, null].map(n.classifyReply), ['sent', 'sent', 'disable', 'disable', 'disable', 'retry', 'retry', 'retry', 'failed', 'failed', 'retry']);
});

check('dueKinds: reminders 24 h and 2 h before (never a stale 24 h), no-reply N hours before the deadline, confirm 6 h before with a published roster; no time, no timer', async () => {
  const { dueKinds, dedupeKeyOf } = await load('worker/notify.js');
  const NOW = 1_000_000_000_000;
  const base = { time_known: 1, signups_locked: 0, signup_close_hours: null, team_close_hours: 0, roster_published_at: null };
  const all = { post_reminders: 1, post_noreply: 1, noreply_hours: 24, post_confirm: 1 };
  const raid = (hoursAway, extra = {}) => ({ ...base, starts_at: NOW + hoursAway * HOUR, ...extra });
  assert.deepEqual(dueKinds(raid(30), all, NOW), [], 'a day and more away: nothing yet');
  assert.deepEqual(dueKinds(raid(24), all, NOW), ['remind_24h', 'no_reply'], 'exactly 24 h: the reminder and (deadline at the start) the no-reply');
  assert.deepEqual(dueKinds(raid(25), all, NOW), [], 'a minute before the windows open');
  assert.deepEqual(dueKinds(raid(10), all, NOW), ['remind_24h', 'no_reply'], 'a raid made at 10 h still gets the 24 h one');
  assert.deepEqual(dueKinds(raid(2), all, NOW), ['remind_2h', 'no_reply'], 'inside the last 2 h only the 2 h reminder');
  assert.deepEqual(dueKinds(raid(1), { ...all, post_noreply: 0 }, NOW), ['remind_2h']);
  assert.deepEqual(dueKinds(raid(0), all, NOW), [], 'started');
  assert.deepEqual(dueKinds(raid(-3), all, NOW), []);
  // The no-reply window is [deadline - N h, deadline): a 12 h deadline with 24 h lead opens 36 h before the start and closes 12 h before it.
  assert.deepEqual(dueKinds(raid(40, { team_close_hours: 12 }), all, NOW), []);
  assert.deepEqual(dueKinds(raid(36, { team_close_hours: 12 }), all, NOW), ['no_reply']);
  assert.deepEqual(dueKinds(raid(13, { team_close_hours: 12 }), all, NOW), ['remind_24h', 'no_reply'], 'one hour before the deadline');
  assert.deepEqual(dueKinds(raid(12, { team_close_hours: 12 }), { ...all, post_reminders: 0 }, NOW), [], 'the deadline passed: members are shut out, nothing to ask for');
  assert.deepEqual(dueKinds(raid(36, { signup_close_hours: 12, team_close_hours: 0 }), all, NOW), ['no_reply'], 'the raid\'s own deadline wins');
  assert.deepEqual(dueKinds(raid(20, { signups_locked: 1 }), { post_noreply: 1, noreply_hours: 48 }, NOW), [], 'an officer locked sign-ups: nobody can answer');
  assert.deepEqual(dueKinds(raid(70, { team_close_hours: 72 }), { post_noreply: 1, noreply_hours: 6 }, NOW), [], 'a 72 h deadline that is already two hours gone');
  assert.deepEqual(dueKinds(raid(78, { team_close_hours: 72 }), { post_noreply: 1, noreply_hours: 6 }, NOW), ['no_reply']);
  // Confirm: needs a published roster and the last 6 h.
  assert.deepEqual(dueKinds(raid(5), { post_confirm: 1 }, NOW), [], 'no roster published');
  assert.deepEqual(dueKinds(raid(7, { roster_published_at: NOW - HOUR }), { post_confirm: 1 }, NOW), []);
  assert.deepEqual(dueKinds(raid(6, { roster_published_at: NOW - HOUR }), { post_confirm: 1 }, NOW), ['confirm']);
  assert.deepEqual(dueKinds(raid(5, { roster_published_at: NOW - HOUR }), { post_confirm: 0 }, NOW), []);
  // A raid with only a date has a placeholder start: no timers.
  assert.deepEqual(dueKinds(raid(5, { time_known: 0, roster_published_at: NOW }), all, NOW), []);
  assert.equal(dedupeKeyOf('remind_2h', 'r_1'), 'remind_2h:r_1');
});

check('refreshDue: every 12 h until 48 h before the start, every 2 h inside it; a failed ask waits as long; nothing for a raid that started', async () => {
  const { refreshDue } = await load('worker/notify.js');
  const NOW = 1_000_000_000_000;
  const r = (hoursAway, synced, checked = null) => ({ starts_at: NOW + hoursAway * HOUR, event_synced: synced === null ? null : NOW - synced * HOUR, event_checked_at: checked === null ? null : NOW - checked * HOUR });
  assert.equal(refreshDue(r(100, 11.9), NOW), false);
  assert.equal(refreshDue(r(100, 12), NOW), true);
  assert.equal(refreshDue(r(49, 13), NOW), true);
  assert.equal(refreshDue(r(48, 1.9), NOW), false);
  assert.equal(refreshDue(r(48, 2), NOW), true);
  assert.equal(refreshDue(r(3, 2.5), NOW), true);
  assert.equal(refreshDue(r(3, 1), NOW), false);
  assert.equal(refreshDue(r(3, null), NOW), true, 'never synced');
  assert.equal(refreshDue(r(3, 5, 0.5), NOW), false, 'the last ask (a failure) 30 minutes ago paces the next');
  assert.equal(refreshDue(r(3, 0.2, 3), NOW), false, 'the later of sync and check counts');
  assert.equal(refreshDue(r(-1, 50), NOW), false, 'started');
});

check('message bodies: no @everyone or @here can ever ping, only the named people and the officer\'s role; hostile names and titles are neutralised; limits hold; the link is the raid page', async () => {
  const n = await load('worker/notify.js');
  const raid = { starts_at: at(5), zone: 'Karazhan', title: '@everyone <@&999999999999999999> `raid` *now*' };
  const people = [
    { name: 'Aldric', discordId: '110000000000000001', optedOut: false },
    { name: 'Bryn', discordId: '110000000000000002', optedOut: true },
    { name: 'Cora', discordId: null, optedOut: false },
    { name: '@everyone', discordId: '110000000000000001', optedOut: false },
    { name: 'Dorn<script>', discordId: 'not-an-id', optedOut: false },
  ];
  const split = n.splitPeople(people);
  assert.deepEqual(split.users, ['110000000000000001'], 'only a valid, not opted-out Discord ID, once');
  assert.deepEqual(split.names, ['Aldric', 'Bryn', 'Cora', 'everyone', 'Dornscript']);
  const body = n.noReplyBody(raid, { teamName: 'Team @here', link: 'https://raidsmith.test/#/g/g_x/raids/r/r_x', roleId: '123456789012345678', people, closesAt: at(1) });
  assert.deepEqual(body.allowed_mentions, { parse: [], users: ['110000000000000001'], roles: ['123456789012345678'] });
  assert.equal(body.content, '<@&123456789012345678> <@110000000000000001>');
  assert(!/@everyone|@here/.test(body.content), 'the content never carries those');
  const embed = body.embeds[0];
  assert.equal(embed.url, 'https://raidsmith.test/#/g/g_x/raids/r/r_x');
  for (const text of [embed.title, embed.description]) assert(!/[<>`]/.test(text.replace(/<t:\d+:[FR]>/g, '')), `no raw mentions or markdown in: ${text}`);
  assert(embed.description.includes('- Bryn') && embed.description.includes('- Cora'), 'an opted-out person is listed by name');
  assert(embed.description.includes(`<t:${Math.floor(at(1) / 1000)}:R>`), 'the deadline is a Discord timestamp');
  // Nobody to ping and no role: an empty content, and still no parse.
  const quiet = n.confirmBody(raid, { teamName: 'Alpha', link: null, roleId: null, people: [{ name: 'Cora', discordId: null, optedOut: false }] });
  assert.equal(quiet.content, '');
  assert.deepEqual(quiet.allowed_mentions, { parse: [], users: [], roles: [] });
  assert.equal(quiet.embeds[0].url, undefined, 'no link when the site address is unknown');
  // A long list is capped.
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `Name${i}`, discordId: null, optedOut: false }));
  const big = n.noReplyBody(raid, { teamName: 'Alpha', link: null, roleId: null, people: many, closesAt: at(1) });
  assert(big.embeds[0].description.length <= 4096 && big.embeds[0].description.includes('and 90 more'));
  assert(JSON.stringify(big).length < 6000);
  // Roster and loot bodies.
  const roster = n.rosterBody(raid, { teamName: 'Alpha', link: null, roleId: null, seats: [{ name: 'Aldric', group: 1 }, { name: 'Bryn', group: 0 }, { name: 'Cora', group: 1 }, { name: 'Dorn', group: 2 }] });
  assert.deepEqual(roster.embeds[0].fields.map((f) => [f.name, f.value]), [['Group 1', 'Aldric, Cora'], ['Group 2', 'Dorn'], ['Bench', 'Bryn']]);
  const loot = n.lootBody(raid, { teamName: 'Alpha', link: null, roleId: null, awards: [{ itemName: 'Girdle of *Mighty* Resolve', winnerName: 'Aldric', tag: 'MS' }, { itemName: 'Shard', winnerName: null, tag: 'DE' }] });
  assert.equal(loot.embeds[0].description, '- Girdle of Mighty Resolve: Aldric (MS)\n- Shard: Disenchanted (DE)');
  assert.equal(n.raidLink('https://raidsmith.test', 'g_1', 'r_1'), 'https://raidsmith.test/#/g/g_1/raids/r/r_1');
  assert.equal(n.raidLink(null, 'g_1', 'r_1'), null);
});

// ---------------------------------------------------------------------------
// The settings API

check('settings: GET lists the active teams with everything off; the webhook address goes in and never comes back; a member and a lead cannot', async () => {
  const s = await scenario({ teams: 2, members: ['m1'], leads: ['lead'] });
  const first = await s.ok('gm', 'GET', '/notifications');
  assert.deepEqual(first.options, { noreplyHours: [6, 12, 24, 48] });
  assert.deepEqual(first.teams.map((t) => t.name), ['Alpha', 'Bravo']);
  assert.deepEqual(first.teams[0], {
    id: s.tids[0], name: 'Alpha', webhook: { set: false, hint: null, state: 'ok', disabledAt: null, disabledStatus: null }, roleMention: null,
    post: { roster: false, loot: false, reminders: false, noreply: false, confirm: false }, noreplyHours: 24,
  });
  const saved = await s.notify({ webhookUrl: HOOK, roleMention: '<@&123456789012345678>', roster: true, reminders: true, noreplyHours: 12 });
  assert.deepEqual(saved.team.webhook, { set: true, hint: `.../${HOOK_TOKEN.slice(-4)}`, state: 'ok', disabledAt: null, disabledStatus: null });
  assert.equal(saved.team.roleMention, '123456789012345678');
  assert.deepEqual(saved.team.post, { roster: true, loot: false, reminders: true, noreply: false, confirm: false });
  assert.equal(saved.team.noreplyHours, 12);
  // The secret is in no reply, anywhere: not the PUT, not the GET, not the audit log, not the export, not a page of the Activity log.
  const get = await s.call('gm', 'GET', '/notifications');
  const audit = await s.call('gm', 'GET', '/audit');
  const exported = await s.call('gm', 'GET', '/export');
  for (const res of [get, audit, exported]) {
    assert(!res.text.includes(HOOK_TOKEN) && !res.text.includes(HOOK_ID), 'the address is never sent back');
  }
  assert(!JSON.stringify(await s.rows('SELECT before, after FROM audit_log')).includes(HOOK_TOKEN));
  assert.equal((await s.rows('SELECT webhook_url FROM team_notifications'))[0].webhook_url, HOOK, 'it is stored for the Worker to post to');
  // Who may: guild.teams only.
  for (const who of ['m1', 'lead']) {
    assert.equal((await s.call(who, 'GET', '/notifications')).status, 403, who);
    assert.equal((await s.call(who, 'PUT', `/teams/${s.tids[0]}/notifications`, { roster: true })).status, 403, who);
  }
  assert.equal((await s.w.call(newJar(), 'GET', `${s.base}/notifications`)).status, 401);
});

check('settings: a field left out keeps its value; mistakes are 400 on their field; archived and foreign teams are 404; one audit row names what changed, never the address', async () => {
  const s = await scenario({ teams: 2 });
  await s.notify({ webhookUrl: HOOK, roster: true, loot: true, noreply: true, noreplyHours: 48 });
  const kept = await s.notify({ confirm: true });
  assert.deepEqual(kept.team.post, { roster: true, loot: true, reminders: false, noreply: true, confirm: true });
  assert.equal(kept.team.noreplyHours, 48);
  assert.equal(kept.team.webhook.set, true, 'the address stays when none is sent');
  const code = async (patch, status, field) => {
    const res = await s.call('gm', 'PUT', `/teams/${s.tids[0]}/notifications`, patch);
    assert.equal(res.status, status, JSON.stringify(patch) + res.text);
    if (field) assert.equal(res.json.field, field, JSON.stringify(patch));
    return res;
  };
  await code({ webhookUrl: 'https://example.com/hook' }, 400, 'webhookUrl');
  await code({ webhookUrl: 5 }, 400, 'webhookUrl');
  await code({ roleMention: '@everyone' }, 400, 'roleMention');
  await code({ roleMention: 7 }, 400, 'roleMention');
  await code({ roster: 'yes' }, 400, 'roster');
  await code({ confirm: 1 }, 400, 'confirm');
  await code({ noreplyHours: 5 }, 400, 'noreplyHours');
  await code({ noreplyHours: '12' }, 400, 'noreplyHours');
  assert.deepEqual((await s.audits('notify.update')).map((a) => JSON.parse(a.after).changed), [['webhook', 'roster', 'loot', 'noreply', 'noreplyHours'], ['confirm']]);
  assert.equal((await s.audits('notify.update')).length, 2, 'refused writes and an unchanged save leave no rows');
  await s.notify({ confirm: true });
  assert.equal((await s.audits('notify.update')).length, 2, 'saving the same values again is no change');
  const removed = await s.notify({ webhookUrl: null, roleMention: '' });
  assert.deepEqual([removed.team.webhook.set, removed.team.roleMention], [false, null]);
  assert.deepEqual((await s.audits('notify.update')).map((a) => JSON.parse(a.after).changed).at(-1), ['webhook'], 'a role that was never set is no change');
  // Teams: archived, unknown and another guild's.
  assert.equal((await s.call('gm', 'PUT', `/teams/t_${'A'.repeat(22)}/notifications`, { roster: true })).status, 404);
  await s.ok('gm', 'PATCH', `/teams/${s.tids[1]}`, { archived: true }, 200);
  assert.equal((await s.call('gm', 'PUT', `/teams/${s.tids[1]}/notifications`, { roster: true })).status, 404, 'an archived team');
  assert.deepEqual((await s.ok('gm', 'GET', '/notifications')).teams.map((t) => t.name), ['Alpha'], 'and it is not listed');
  const other = await secondGuild(s);
  assert.equal((await s.call('gm', 'PUT', `/teams/${other.tid}/notifications`, { roster: true })).status, 404, 'a team of another guild');
  assert.equal((await s.w.call(other.jar, 'PUT', other.path(`/teams/${s.tids[0]}/notifications`), { roster: true })).status, 404, 'and the other way round');
  assert.equal((await s.w.call(other.jar, 'GET', s.base + '/notifications')).status, 403, 'not a member of this guild');
  assert.equal(await s.w.count('team_notifications', 'team_id = ?', other.tid), 0, 'nothing was written for it');
});

// ---------------------------------------------------------------------------
// Reminders

check('raid reminders: 24 h and 2 h before, once each, with the signed-up count, a link, the officer\'s role and Discord timestamps; off by default; no time, no reminder', async () => {
  const s = await scenario({ members: ['m1'] });
  const rid = await s.raidAt(at(30), { title: 'Gruul night' });
  assert.deepEqual(await s.run(), { refresh: { due: 0, refreshed: 0, moved: 0, failed: 0 }, posts: { sent: 0, retry: 0, failed: 0, disabled: 0, guilds: 0 } });
  await s.notify({ webhookUrl: HOOK, roleMention: '123456789012345678' });
  s.w.clock.now = at(8); assert.equal((await s.run()).posts.sent, 0, 'webhook set but every switch off: nothing');
  await s.notify({ reminders: true });
  const a = await s.person({ name: 'Aldric', link: 'm1' });
  await s.ok('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' });
  s.w.clock.now = at(5);       // 25 h before
  assert.equal((await s.run()).posts.sent, 0, 'not yet');
  s.w.clock.now = at(6.5);     // 23.5 h before
  const result = await s.run();
  assert.equal(result.posts.sent, 1);
  assert.equal(s.net.posts.length, 1);
  const post = s.net.posts[0];
  assert.equal(post.url, HOOK);
  assert.equal(post.body.content, '<@&123456789012345678>');
  assert.deepEqual(post.body.allowed_mentions, { parse: [], users: [], roles: ['123456789012345678'] });
  const e = embedOf(post);
  assert.equal(e.title, 'Raid in about 24 hours: Gruul night - Alpha');
  assert.equal(e.url, `https://raidsmith.test/#/g/${s.gid}/raids/r/${rid}`);
  assert.deepEqual(e.fields.map((f) => f.name), ['Starts', 'Signed up']);
  assert.equal(e.fields[0].value, `<t:${at(30) / 1000}:F> (<t:${at(30) / 1000}:R>)`);
  assert.equal(e.fields[1].value, '1 of 25', 'Gruuls Lair is a 25-player raid');
  // The same moment, again and again: nothing more is sent.
  for (let i = 0; i < 3; i++) { s.w.clock.now += 15 * 60000; assert.equal((await s.run()).posts.sent, 0); }
  assert.equal(s.net.posts.length, 1);
  assert.deepEqual((await s.logRows()).map((r) => [r.kind, r.status, r.http_status]), [['remind_24h', 'sent', 204]]);
  // Two hours before: the 2 h reminder, once, even when two Cron invocations overlap (the log row is claimed before the post goes out).
  s.w.clock.now = at(28.5);
  const pair = await Promise.all([s.run(), s.run()]);
  assert.equal(pair.reduce((sum, r) => sum + r.posts.sent, 0), 1);
  assert.equal(embedOf(s.net.posts[1]).title, 'Raid in about 2 hours: Gruul night - Alpha');
  s.w.clock.now = at(29.5); assert.equal((await s.run()).posts.sent, 0);
  assert.deepEqual((await s.logRows()).map((r) => r.kind), ['remind_24h', 'remind_2h']);
  // A raid made inside the last two hours never gets a stale "tomorrow".
  await s.raidAt(at(55.5), { title: 'Late' });
  s.w.clock.now = at(54.2); // 1.3 h before the late raid (the next day), long after its 24 h mark
  const before = s.net.posts.length;
  await s.run();
  assert.deepEqual(s.net.posts.slice(before).map((p) => embedOf(p).title), ['Raid in about 2 hours: Late - Alpha']);
});

check('no-reply reminders: the raiders and trials with no sign-up and no notice, N hours before the deadline, once; pings by Discord ID unless opted out; reserves, inactive and answered people are left out', async () => {
  const s = await scenario({ members: ['m1', 'm2', 'm3'] });
  await s.person({ name: 'Quiet', link: 'm1' });                          // no answer, Discord account: pinged
  await s.person({ name: 'Shy', link: 'm2' });                              // no answer, but opted out: listed, not pinged
  await s.person({ name: 'Away', link: 'm3' });                             // an away notice
  const signed = await s.person({ name: 'Signed' });                       // signed up by an officer
  await s.person({ name: 'Nodiscord' });                                    // no answer, no Discord at all: listed by name
  await s.person({ name: 'Trialist', status: 'trial' });                    // trials are asked too
  await s.person({ name: 'Reserve', status: 'reserve' });                   // not asked
  const gone = await s.person({ name: 'Gone' });                           // not asked: inactive
  s.w.db.sqlite.prepare("UPDATE players SET status = 'inactive' WHERE id = ?").run(gone.pid);
  const otherTeamId = (await s.ok('gm', 'POST', '/teams', { name: 'Other' })).team.id;
  await s.person({ name: 'Stranger', team: otherTeamId }); // another team's raider
  const rid = await s.raidAt(at(40), { title: 'Sunday' });
  await s.ok('gm', 'PUT', `/raids/${rid}/signups/${signed.pid}`, { kind: 'signed' });
  const raidOn = (await s.rows('SELECT raid_on FROM raids WHERE id = ?', rid))[0].raid_on;
  await s.ok('m3', 'POST', '/away', { kind: 'away', from: raidOn, to: raidOn });
  await s.ok('m2', 'PUT', '/auth/reminders', { optOut: true }, 200);
  await s.notify({ webhookUrl: HOOK, noreply: true, noreplyHours: 24 });
  // The deadline is the start (the team has none): the window opens 24 h before the start.
  s.w.clock.now = at(15); assert.equal((await s.run()).posts.sent, 0, '25 h before: not yet');
  s.w.clock.now = at(17);
  assert.equal((await s.run()).posts.sent, 1);
  const post = s.net.posts[0];
  const e = embedOf(post);
  assert.equal(e.title, 'Sign up or send word: Sunday - Alpha');
  const listed = e.description.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
  assert.deepEqual(listed.sort(), ['Nodiscord', 'Quiet', 'Shy', 'Trialist']);
  assert(e.description.includes('The raid starts <t:'), 'the deadline is the start');
  assert.deepEqual(post.body.allowed_mentions.users, [P.m1.id], 'only the person with a Discord account who did not opt out is pinged');
  assert.equal(post.body.content, `<@${P.m1.id}>`);
  assert.deepEqual((await s.logRows()).map((r) => [r.kind, r.status, r.people]), [['no_reply', 'sent', 4]]);
  // Once per raid, even when the picture changes; a person who answers later is simply not on a list that is never sent again.
  await s.ok('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'signed' });
  s.w.clock.now = at(30); assert.equal((await s.run()).posts.sent, 0);
  assert.equal(s.net.posts.length, 1);
});

check('no-reply reminders: when everyone answered nothing is posted and nothing is claimed; a longer team deadline moves the window; the lead time is respected; a locked raid is skipped', async () => {
  const s = await scenario({ members: ['m1'] });
  s.deadline(12);
  await s.person({ name: 'Quiet', link: 'm1' });
  const rid = await s.raidAt(at(60));
  await s.ok('m1', 'PUT', `/raids/${rid}/signup`, { kind: 'tentative' });
  await s.notify({ webhookUrl: HOOK, noreply: true, noreplyHours: 6 });
  s.w.clock.now = at(60 - 14); assert.equal((await s.run()).posts.sent, 0, 'everyone answered');
  assert.equal(await s.w.count('notification_log'), 0, 'and nothing was claimed, so a later gap can still be reminded');
  await s.ok('m1', 'DELETE', `/raids/${rid}/signup`, undefined, 200);
  assert.equal((await s.run()).posts.sent, 1, 'the sign-up was withdrawn: the person is asked after all');
  assert.equal(embedOf(s.net.posts[0]).description.includes('- Quiet'), true);
  // The lead time is 6 h here; the same team with 12 h of deadline closes 12 h before the start.
  await s.raidAt(at(100));
  const before = s.net.posts.length;
  s.w.clock.now = at(100 - 12 - 7); await s.run(); assert.equal(s.net.posts.length, before, '19 h before: the window (12 h deadline + 6 h) opens at 18 h');
  s.w.clock.now = at(100 - 12 - 5); await s.run(); assert.equal(s.net.posts.length, before + 1);
  assert.match(embedOf(s.net.posts.at(-1)).description, /^Sign-ups close <t:\d+:F>/, 'the deadline, not the start, is named');
  // An officer who locked sign-ups has shut the members out: asking them to sign up would be a lie.
  const rid3 = await s.raidAt(at(130));
  await s.ok('gm', 'POST', `/raids/${rid3}/signups/lock`, {}, 200);
  const afterLock = s.net.posts.length;
  s.w.clock.now = at(130 - 12 - 3); await s.run();
  assert.equal(s.net.posts.length, afterLock);
});

check('roster confirm reminder: 6 h before, only the seats nobody answered, bench last, once; the count shows in Needs attention from the same moment, with or without a webhook', async () => {
  const s = await scenario({ members: ['m1', 'm2'] });
  await s.person({ name: 'Aldric', link: 'm1' });
  await s.person({ name: 'Bryn', link: 'm2' });
  await s.person({ name: 'Cora' });
  const rid = await s.raidAt(at(20));
  await s.ok('gm', 'PUT', `/raids/${rid}/plan`, { label: 'Plan', players: [{ name: 'Aldric', group: 1 }, { name: 'Bryn', group: 2 }, { name: 'Cora', group: 0 }] });
  await s.ok('gm', 'POST', `/raids/${rid}/roster`, {}, 200);
  assert.equal((await s.attention()).items.filter((i) => i.kind === 'roster_pending').length, 0, 'not yet: more than 6 h away');
  await s.notify({ webhookUrl: HOOK, confirm: true });
  s.w.clock.now = at(13); assert.equal((await s.run()).posts.sent, 0);
  s.w.clock.now = at(14.5);
  const items = (await s.attention()).items.filter((i) => i.kind === 'roster_pending');
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].count, items[0].raidId, items[0].link], [3, rid, { name: 'raid', rid }]);
  await s.ok('m1', 'POST', `/raids/${rid}/roster/confirm`, {}, 200);
  assert.equal((await s.run()).posts.sent, 1);
  const post = s.net.posts[0];
  assert.equal(embedOf(post).title, "Confirm your spot: Gruul's Lair - Alpha");
  assert.deepEqual(embedOf(post).description.split('\n').filter((l) => l.startsWith('- ')), ['- Bryn', '- Cora'], 'Aldric confirmed; the bench is last');
  assert.deepEqual(post.body.allowed_mentions.users, [P.m2.id], 'Bryn is pinged by the Discord ID of her account; Cora has none');
  s.w.clock.now = at(18); assert.equal((await s.run()).posts.sent, 0, 'once');
  assert.equal((await s.attention()).items.find((i) => i.kind === 'roster_pending').count, 2, 'the count follows the answers');
  await s.ok('m2', 'POST', `/raids/${rid}/roster/confirm`, {}, 200);
  assert.equal((await s.attention()).items.find((i) => i.kind === 'roster_pending').count, 1, 'only Cora, who has no account, is left');
});

// ---------------------------------------------------------------------------
// Failures

check('a webhook Discord refuses (404, 401) is switched off at once: audited by "Raidsmith", shown in Needs attention, never posted to again until a new address is saved', async () => {
  for (const status of [404, 401]) {
    const s = await scenario({ teams: 2 });
    await s.raidAt(at(20));
    await s.raidAt(at(20), { team: s.tids[1] });
    await s.notify({ webhookUrl: HOOK, reminders: true });
    await s.notify({ webhookUrl: HOOK_B, reminders: true }, s.tids[1]);
    s.net.webhook = (url) => (url === HOOK ? status : 204);
    s.w.clock.now = at(1);
    const result = await s.run();
    assert.deepEqual([result.posts.disabled, result.posts.sent], [1, 1], 'Alpha\'s webhook died, Bravo\'s is fine');
    const rows = await s.rows('SELECT team_id, webhook_state, disabled_status FROM team_notifications ORDER BY team_id');
    assert.deepEqual(rows.map((r) => [r.team_id === s.tids[0], r.webhook_state, r.disabled_status]).sort(), [[false, 'ok', null], [true, 'disabled', status]]);
    assert.deepEqual((await s.logRows()).map((r) => [r.kind, r.status, r.http_status]).sort(), [['remind_24h', 'retry', status], ['remind_24h', 'sent', 204]].sort(), 'the refused one was never delivered');
    assert.equal((await s.audits('notify.disabled')).length, 1);
    assert.equal((await s.audits('notify.disabled'))[0].actor_user_id, null);
    const log = await s.ok('gm', 'GET', '/audit?group=settings');
    const row = log.rows.find((r) => r.action === 'notify.disabled');
    assert.equal(row.text, `Turned off the Discord webhook of Alpha: Discord answered ${status}`);
    assert.deepEqual(row.actor, { id: null, displayName: 'Raidsmith' });
    const off = (await s.attention()).items.filter((i) => i.kind === 'webhook_off');
    assert.deepEqual(off.map((i) => [i.teamName, i.status, i.link]), [['Alpha', status, { name: 'settings', tab: 'notifications' }]]);
    assert.equal((await s.ok('gm', 'GET', '/notifications')).teams[0].webhook.state, 'disabled');
    assert.equal((await s.attention('gm')).total >= 1, true);
    // Nothing more is posted to the dead one; the live one is not posted twice either.
    const posts = s.net.posts.length;
    for (let i = 0; i < 3; i++) { s.w.clock.now += 15 * 60000; await s.run(); }
    assert.equal(s.net.posts.length, posts);
    // A new address turns it on again; the raid\'s reminder was never sent, so it goes out now.
    s.net.webhook = () => 204;
    const again = await s.notify({ webhookUrl: HOOK_B, reminders: true });
    assert.equal(again.team.webhook.state, 'ok');
    assert.equal((await s.attention()).items.filter((i) => i.kind === 'webhook_off').length, 0);
    s.w.clock.now += 15 * 60000;
    assert.equal((await s.run()).posts.sent, 1, 'the reminder the dead webhook could not deliver goes out now (the raid has not started)');
    assert.equal(s.net.posts.length, posts + 1);
    assert.deepEqual((await s.logRows()).map((r) => r.status), ['sent', 'sent']);
  }
});

check('a transient failure (500, 429, no answer) is retried by the next runs up to three attempts and then given up; the same address is not tried again once it sent', async () => {
  const s = await scenario();
  await s.raidAt(at(20));
  await s.notify({ webhookUrl: HOOK, reminders: true });
  s.net.webhook = () => 500;
  s.w.clock.now = at(1);
  assert.equal((await s.run()).posts.retry, 1);
  assert.deepEqual((await s.logRows()).map((r) => [r.status, r.attempts]), [['retry', 1]]);
  s.net.webhook = () => 429;
  s.w.clock.now += 15 * 60000; assert.equal((await s.run()).posts.retry, 1);
  assert.deepEqual((await s.logRows()).map((r) => [r.status, r.attempts, r.http_status]), [['retry', 2, 429]]);
  s.net.webhook = () => 204;
  s.w.clock.now += 15 * 60000; assert.equal((await s.run()).posts.sent, 1, 'the third attempt gets through');
  assert.deepEqual((await s.logRows()).map((r) => [r.status, r.attempts]), [['sent', 3]]);
  s.w.clock.now += 15 * 60000; assert.equal((await s.run()).posts.sent, 0);
  // A raid that never gets through is given up after three attempts.
  const s2 = await scenario();
  await s2.raidAt(at(20));
  await s2.notify({ webhookUrl: HOOK, reminders: true });
  s2.net.webhook = () => 503;
  s2.w.clock.now = at(1);
  for (let i = 0; i < 5; i++) { await s2.run(); s2.w.clock.now += 15 * 60000; }
  assert.equal(s2.net.posts.length, 3, 'three attempts, then no more');
  assert.deepEqual((await s2.logRows()).map((r) => [r.status, r.attempts]), [['failed', 3]]);
  assert.equal((await s2.rows('SELECT webhook_state FROM team_notifications'))[0].webhook_state, 'ok', 'a flaky Discord does not switch the webhook off');
  // A Discord that refuses the body (400) is final at once.
  const s3 = await scenario();
  await s3.raidAt(at(20));
  await s3.notify({ webhookUrl: HOOK, reminders: true });
  s3.net.webhook = () => 400;
  s3.w.clock.now = at(1);
  await s3.run(); await s3.run();
  assert.deepEqual((await s3.logRows()).map((r) => [r.status, r.attempts]), [['failed', 1]]);
  assert.equal(s3.net.posts.length, 1);
});

check('every run is bounded: at most maxMessages posts and maxGuilds guilds, the nearest raids first; the rest wait for the next run', async () => {
  const { runNotifications } = await load('worker/notify-run.js');
  const { defaultRandomBytes } = await load('worker/ids.js');
  const s = await scenario({ teams: 3 });
  for (const [index, team] of s.tids.entries()) {
    await s.raidAt(at(20 + index * 2), { team, title: `Raid ${index}` });
    await s.notify({ webhookUrl: HOOK, reminders: true }, team);
  }
  s.w.clock.now = at(1);
  const ctx = { db: s.w.db, env: s.w.env, fetch: s.w.fetch, now: () => s.w.clock.now, randomBytes: defaultRandomBytes, log: () => {} };
  const first = await runNotifications(ctx, { maxMessages: 2 });
  assert.equal(first.sent, 2);
  assert.deepEqual(s.net.posts.map((p) => embedOf(p).title), ['Raid in about 24 hours: Raid 0 - Alpha', 'Raid in about 24 hours: Raid 1 - Bravo'], 'nearest first');
  const second = await runNotifications(ctx, { maxMessages: 2 });
  assert.equal(second.sent, 1, 'the rest follow in the next run');
  assert.equal((await runNotifications(ctx, { maxMessages: 2 })).sent, 0);
  // The guild cap: a second guild in the same database waits when only one fits, and the nearest raid's guild is the one served.
  const g2 = await secondGuild(s);
  assert.equal((await s.w.call(g2.jar, 'PUT', g2.path(`/teams/${g2.tid}/notifications`), { webhookUrl: HOOK_B, reminders: true })).status, 200);
  const day = (await load('worker/attendance-calendar.js')).localDate(at(10), TZ);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at(10)));
  const raid2 = await s.w.call(g2.jar, 'POST', g2.path('/raids'), { teamId: g2.tid, raidOn: day, startTime: clock, zone: 'Karazhan' });
  assert.equal(raid2.status, 201, raid2.text);
  const posts = s.net.posts.length;
  const capped = await runNotifications(ctx, { maxGuilds: 1 });
  assert.deepEqual([capped.sent, capped.guilds], [1, 1]);
  assert.equal(s.net.posts.at(-1).url, HOOK_B, 'the guild with the nearest raid is served first');
  assert.equal(s.net.posts.length, posts + 1);
  const none = await runNotifications(ctx, { maxGuilds: 0 });
  assert.deepEqual([none.sent, none.guilds], [0, 0]);
});

// ---------------------------------------------------------------------------
// Posts a route makes itself

check('roster published: the team channel gets the groups once per publish (a second publish is a second post); off, no webhook or a dead one: nothing, and the publish still works', async () => {
  const s = await scenario({ members: ['m1'] });
  await s.person({ name: 'Aldric', link: 'm1' });
  await s.person({ name: 'Bryn' });
  await s.person({ name: 'Cora' });
  const rid = await s.raidAt(at(30), { title: 'Gruul' });
  await s.ok('gm', 'PUT', `/raids/${rid}/plan`, { label: 'Plan', players: [{ name: 'Aldric', group: 1 }, { name: 'Bryn', group: 1 }, { name: 'Cora', group: 0 }] });
  await s.ok('gm', 'POST', `/raids/${rid}/roster`, {}, 200);
  assert.equal(s.net.posts.length, 0, 'nothing set up');
  await s.notify({ webhookUrl: HOOK, roster: true, roleMention: '123456789012345678' });
  await s.ok('gm', 'POST', `/raids/${rid}/roster`, {}, 200);
  assert.equal(s.net.posts.length, 1);
  const e = embedOf(s.net.posts[0]);
  assert.equal(e.title, 'Roster published: Gruul - Alpha');
  assert.deepEqual(e.fields.map((f) => [f.name, f.value]), [['Group 1', 'Aldric, Bryn'], ['Bench', 'Cora']]);
  assert.equal(s.net.posts[0].body.content, '<@&123456789012345678>');
  assert.equal(e.url, `https://raidsmith.test/#/g/${s.gid}/raids/r/${rid}`);
  await s.ok('gm', 'POST', `/raids/${rid}/roster`, {}, 200);
  assert.equal(s.net.posts.length, 2, 'every publish is a post of its own');
  assert.deepEqual((await s.logRows()).map((r) => [r.kind, r.status]), [['roster', 'sent'], ['roster', 'sent']]);
  // A dead webhook never fails the publish; it switches itself off.
  s.net.webhook = () => 404;
  const published = await s.call('gm', 'POST', `/raids/${rid}/roster`, {});
  assert.equal(published.status, 200);
  assert.equal((await s.rows('SELECT webhook_state FROM team_notifications'))[0].webhook_state, 'disabled');
  const count = s.net.posts.length;
  await s.ok('gm', 'POST', `/raids/${rid}/roster`, {}, 200);
  assert.equal(s.net.posts.length, count, 'and a switched-off webhook is not tried');
});

check('loot imported: the new awards are posted once per import, nothing for an import that added none, nothing when the switch is off', async () => {
  const s = await scenario();
  await s.person({ name: 'Aldric' });
  const rid = await s.raidAt(at(1), { title: 'Gruul' });
  s.w.clock.now = at(3);
  const award = (id, item, winner, extra = {}) => ({ checksum: `check${id}${extra.rollType || 'MS'}`, itemId: id, itemName: item, quality: 4, winnerName: winner, rollType: 'MS', awardedAt: at(2), ...extra });
  const send = (awards) => s.call('gm', 'POST', `/raids/${rid}/loot`, { awards });
  const first = await send([award(28772, 'Sunfury Bow of the Phoenix', 'Aldric')]);
  assert.equal(first.status, 200, first.text);
  assert.equal(s.net.posts.length, 0, 'switch off');
  await s.notify({ webhookUrl: HOOK, loot: true });
  const second = await send([award(28772, 'Sunfury Bow of the Phoenix', 'Aldric'), award(28773, 'Gorehowl', 'Aldric', { rollType: 'OS' })]);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.inserted, 1);
  assert.equal(s.net.posts.length, 1);
  const e = embedOf(s.net.posts[0]);
  assert.equal(e.title, 'Loot imported: Gruul - Alpha');
  assert.match(e.description, /^- Gorehowl: Aldric/);
  assert(!e.description.includes('Sunfury'), 'only the new award');
  const same = await send([award(28772, 'Sunfury Bow of the Phoenix', 'Aldric'), award(28773, 'Gorehowl', 'Aldric', { rollType: 'OS' })]);
  assert.equal(same.json.inserted, 0);
  assert.equal(s.net.posts.length, 1, 'nothing new, nothing posted');
});

// ---------------------------------------------------------------------------
// Automatic Raid-Helper refresh

const EVENT_ID = '999900001111';
const eventOf = (startsAt, signUps, extra = {}) => ({ id: EVENT_ID, title: 'Gruul', serverId: SERVER, startTime: Math.floor(startsAt / 1000), signUps, ...extra });
const sign = (id, userId, name, className = 'Warrior', specName = 'Arms') => ({ id, userId, name, className, specName, status: 'primary', position: id });

async function eventScenario(opts = {}) {
  const s = await scenario(opts);
  const aldric = await s.person({ name: 'Aldric', link: 'm1' });
  const rid = await s.raidAt(at(60), { title: 'Gruul' });
  s.net.events.set(EVENT_ID, eventOf(at(60), [sign(1, P.m1.id, 'Aldric')]));
  await s.ok('gm', 'PUT', `/raids/${rid}/event`, { source: EVENT_ID }, 200);
  return { s, rid, aldric };
}
const rhRows = (s, rid) => s.rows("SELECT discord_user_id, nickname, kind FROM raid_signups WHERE raid_id = ? AND source = 'raid_helper' ORDER BY signup_id", rid);

check('auto refresh: every 12 h far out and every 2 h inside the last 48 h, replacing the Raid-Helper sign-ups like an officer\'s refresh; the Raids list says how fresh they are', async () => {
  const { s, rid } = await eventScenario({ members: ['m1'] });
  const linked = s.w.clock.now;
  assert.equal(s.net.eventCalls.length, 1, 'the officer\'s own link');
  s.net.events.set(EVENT_ID, eventOf(at(60), [sign(1, P.m1.id, 'Aldric'), sign(2, '110000000000000999', 'Newcomer')]));
  s.w.clock.now = linked + 11 * HOUR; assert.equal((await s.run()).refresh.due, 0, '11 h later: not yet');
  s.w.clock.now = linked + 12 * HOUR;
  assert.deepEqual((await s.run()).refresh, { due: 1, refreshed: 1, moved: 0, failed: 0 });
  assert.deepEqual((await rhRows(s, rid)).map((r) => r.nickname), ['Aldric', 'Newcomer']);
  const list = await s.ok('gm', 'GET', `/raids?team=${s.tid}`);
  const row = list.upcoming.find((r) => r.id === rid);
  assert.equal(row.eventSyncedAt, linked + 12 * HOUR);
  assert.equal(row.eventMovedOn, null);
  // Inside the last 48 h the cadence is 2 h.
  s.net.events.set(EVENT_ID, eventOf(at(60), [sign(1, P.m1.id, 'Aldric')]));
  s.w.clock.now = at(60 - 45);
  assert.equal((await s.run()).refresh.refreshed, 1);
  const calls = s.net.eventCalls.length;
  s.w.clock.now += 1.9 * HOUR; await s.run(); assert.equal(s.net.eventCalls.length, calls);
  s.w.clock.now += 0.2 * HOUR; await s.run(); assert.equal(s.net.eventCalls.length, calls + 1);
  assert.deepEqual((await rhRows(s, rid)).map((r) => r.nickname), ['Aldric'], 'the dropped sign-up is gone');
  // The recomputed day follows: a started raid is never asked about.
  s.w.clock.now = at(61);
  await s.run();
  assert.equal(s.net.eventCalls.length, calls + 1);
});

check('auto refresh never moves a raid: an event on another day is flagged on the raid and in Needs attention, sign-ups stay as they were; the officer\'s link settles it and clears the flag', async () => {
  const { s, rid } = await eventScenario({ members: ['m1'] });
  const moved = at(60 + 24);   // a day later
  s.net.events.set(EVENT_ID, eventOf(moved, [sign(1, P.m1.id, 'Aldric'), sign(2, '110000000000000999', 'Newcomer')]));
  s.w.clock.now = at(14);
  assert.deepEqual((await s.run()).refresh, { due: 1, refreshed: 0, moved: 1, failed: 0 });
  const raid = (await s.rows('SELECT raid_on, starts_at, event_moved_on, event_checked_at FROM raids WHERE id = ?', rid))[0];
  assert.equal(raid.starts_at, at(60), 'the raid stays');
  const { localDate } = await load('worker/attendance-calendar.js');
  assert.equal(raid.raid_on, localDate(at(60), TZ));
  assert.equal(raid.event_moved_on, localDate(moved, TZ));
  assert.equal(raid.event_checked_at, s.w.clock.now);
  assert.deepEqual((await rhRows(s, rid)).map((r) => r.nickname), ['Aldric'], 'the sign-ups of the other day are not mixed in');
  const item = (await s.attention()).items.find((i) => i.kind === 'event_moved');
  assert.deepEqual([item.raidId, item.eventDate, item.link], [rid, localDate(moved, TZ), { name: 'raid', rid }]);
  assert.equal((await s.ok('gm', 'GET', `/raids?team=${s.tid}`)).upcoming[0].eventMovedOn, localDate(moved, TZ));
  assert.equal((await s.ok('m1', 'GET', `/raids?team=${s.tid}`)).upcoming[0].eventMovedOn, null, 'members are not told');
  // The next ask waits its cadence; the officer settles it with the existing 409/moveRaid rule, which clears the flag.
  const calls = s.net.eventCalls.length;
  s.w.clock.now += 5 * 60000; await s.run(); assert.equal(s.net.eventCalls.length, calls);
  const refused = await s.call('gm', 'PUT', `/raids/${rid}/event`, { source: EVENT_ID });
  assert.deepEqual([refused.status, refused.json.error], [409, 'event_other_day']);
  await s.ok('gm', 'PUT', `/raids/${rid}/event`, { source: EVENT_ID, moveRaid: true }, 200);
  assert.equal((await s.rows('SELECT event_moved_on FROM raids WHERE id = ?', rid))[0].event_moved_on, null);
  assert.equal((await s.attention()).items.filter((i) => i.kind === 'event_moved').length, 0);
});

check('auto refresh: a same-day start time change follows the event; a failure (private, gone, down, another server) changes nothing and waits its cadence; bounded per run', async () => {
  const { s, rid } = await eventScenario({ members: ['m1'] });
  // The event moved two hours later the same day.
  s.net.events.set(EVENT_ID, eventOf(at(62), [sign(1, P.m1.id, 'Aldric')]));
  s.w.clock.now = at(14);
  assert.equal((await s.run()).refresh.refreshed, 1);
  assert.equal((await s.rows('SELECT starts_at FROM raids WHERE id = ?', rid))[0].starts_at, at(62), 'the start follows the event on the same day');
  // Failures.
  const before = (await rhRows(s, rid)).length;
  for (const [label, answer] of [['gone', undefined], ['down', new Error('network')], ['other server', eventOf(at(62), [], { serverId: '111111111111111111' })]]) {
    if (answer === undefined) s.net.events.delete(EVENT_ID); else s.net.events.set(EVENT_ID, answer);
    s.w.clock.now += 13 * HOUR;
    const run = await s.run();
    assert.deepEqual(run.refresh, { due: 1, refreshed: 0, moved: 0, failed: 1 }, label);
    assert.equal((await rhRows(s, rid)).length, before, `${label}: sign-ups untouched`);
    assert.equal((await s.rows('SELECT event_checked_at FROM raids WHERE id = ?', rid))[0].event_checked_at, s.w.clock.now, `${label}: the ask is stamped`);
    const calls = s.net.eventCalls.length;
    s.w.clock.now += 5 * 60000; await s.run(); assert.equal(s.net.eventCalls.length, calls, `${label}: not asked again within the cadence`);
  }
  // Bounded.
  const { refreshDueEvents } = await load('worker/event-refresh.js');
  const { defaultRandomBytes } = await load('worker/ids.js');
  s.net.events.set(EVENT_ID, eventOf(at(62), [sign(1, P.m1.id, 'Aldric')]));
  s.w.clock.now += 3 * HOUR;
  const ctx = { db: s.w.db, env: s.w.env, fetch: s.w.fetch, now: () => s.w.clock.now, randomBytes: defaultRandomBytes, log: () => {} };
  const none = await refreshDueEvents(ctx, { maxRefreshes: 0 });
  assert.deepEqual([none.due, none.refreshed], [1, 0]);
  const noGuild = await refreshDueEvents(ctx, { maxGuilds: 0 });
  assert.deepEqual([noGuild.due, noGuild.refreshed], [1, 0]);
  assert.equal((await refreshDueEvents(ctx, { maxRefreshes: 1 })).refreshed, 1);
});

// ---------------------------------------------------------------------------
// The scheduler, the opt-out and the data

check('the Worker\'s scheduled handler picks the work by cron string; the daily run keeps its one log line and prunes the notification log after 90 days', async () => {
  const s = await scenario();
  await s.raidAt(at(20));
  await s.notify({ webhookUrl: HOOK, reminders: true });
  s.w.clock.now = at(1);
  const { default: worker } = await load('worker/index.js');
  const waited = [];
  const realNow = Date.now;
  Date.now = () => s.w.clock.now;
  const realFetch = globalThis.fetch;
  globalThis.fetch = s.w.fetch;
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    worker.scheduled({ cron: CRON }, { DB: s.w.db, ...s.w.env }, { waitUntil: (promise) => waited.push(promise) });
    await Promise.all(waited);
  } finally {
    Date.now = realNow; globalThis.fetch = realFetch; console.log = realLog;
  }
  assert.equal(waited.length, 1);
  assert.equal(s.net.posts.length, 1, 'the 15-minute run posted the reminder');
  assert.deepEqual(lines, ['scheduler: 0 events refreshed (0 on another day), 1 post sent']);
  // Daily: only the Battle.net line; a log row older than 90 days goes, a recent one stays.
  assert.equal(await s.w.count('notification_log'), 1);
  await s.run(DAILY);
  assert.equal(await s.w.count('notification_log'), 1, 'recent rows stay');
  s.w.db.sqlite.prepare('UPDATE notification_log SET created_at = ?').run(s.w.clock.now - 91 * 24 * HOUR);
  const dailyLines = [];
  s.lines = dailyLines;
  await s.run(DAILY);
  assert.deepEqual(dailyLines, ['bnet purge: 0 snapshots, 0 claims']);
  assert.equal(await s.w.count('notification_log'), 0, 'older than 90 days: pruned');
  // An unknown cron string runs the daily work, like the only trigger did before this one.
  dailyLines.length = 0;
  await s.run('1 2 3 4 5');
  assert.deepEqual(dailyLines, ['bnet purge: 0 snapshots, 0 claims']);
});

check('"Don\'t mention me in reminders": a row per account, shown by /auth/me, undone by the same call; Delete my data removes it with the account; deleting the guild removes its settings and log', async () => {
  const s = await scenario({ members: ['m1'] });
  assert.equal((await s.ok('m1', 'GET', '/auth/me')).account.reminderOptOut, false);
  assert.equal((await s.call('m1', 'PUT', '/auth/reminders', { optOut: 'yes' })).status, 400);
  assert.equal((await s.call('m1', 'PUT', '/auth/reminders', {})).status, 400);
  assert.equal((await s.w.call(newJar(), 'PUT', '/auth/reminders', { optOut: true })).status, 401);
  assert.deepEqual((await s.ok('m1', 'PUT', '/auth/reminders', { optOut: true })), { optOut: true });
  await s.ok('m1', 'PUT', '/auth/reminders', { optOut: true });
  assert.equal(await s.w.count('reminder_optouts'), 1, 'one row, however often');
  assert.equal((await s.ok('m1', 'GET', '/auth/me')).account.reminderOptOut, true);
  assert.equal((await s.ok('gm', 'GET', '/auth/me')).account.reminderOptOut, false, 'it is the account\'s own');
  await s.ok('m1', 'PUT', '/auth/reminders', { optOut: false });
  assert.equal(await s.w.count('reminder_optouts'), 0);
  await s.ok('m1', 'PUT', '/auth/reminders', { optOut: true });
  // Delete my data: the member's row goes; the guild's settings and log are the guild's and stay.
  await s.raidAt(at(20));
  await s.notify({ webhookUrl: HOOK, reminders: true });
  s.w.clock.now = at(1); await s.run();
  assert.equal(await s.w.count('notification_log'), 1);
  const deleted = await s.call('m1', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(await s.w.count('reminder_optouts'), 0);
  assert.equal(await s.w.count('team_notifications'), 1);
  assert.equal(await s.w.count('notification_log'), 1);
  // The Guild Master deletes the guild: nothing of wave 4 is left.
  const gone = await s.call('gm', 'DELETE', `/api/guild/${s.gid}`, { confirmName: 'Wave Four' });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual([await s.w.count('team_notifications'), await s.w.count('notification_log')], [0, 0]);
});

check('Needs attention: a team lead without guild.teams does not see the webhook item; the items are limited to the viewer\'s teams', async () => {
  const s = await scenario({ teams: 2, leads: ['lead'] });
  await s.raidAt(at(20));
  await s.notify({ webhookUrl: HOOK, reminders: true });
  await s.notify({ webhookUrl: HOOK_B, reminders: true }, s.tids[1]);
  s.net.webhook = () => 404;
  s.w.clock.now = at(1); await s.run();
  assert.equal((await s.attention('gm')).items.filter((i) => i.kind === 'webhook_off').length, 1, 'Alpha has the raid; Bravo has none to post for');
  assert.equal((await s.attention('lead')).items.filter((i) => i.kind === 'webhook_off').length, 0);
});

check('Needs attention (pure): the three wave 4 kinds come after the declined seats and before the info kinds; each is limited to the teams its right covers', async () => {
  const { buildAttention, ATTENTION_KINDS, INFO_KINDS } = await load('worker/attention.js');
  assert.deepEqual(ATTENTION_KINDS.slice(-5), ['roster_declined', 'roster_pending', 'event_moved', 'webhook_off', 'unlocked']);
  assert.deepEqual(INFO_KINDS, ['unlocked'], 'all three count as open work');
  const NOW = 1_800_000_000_000;
  const teams = [{ id: 't_a', name: 'Alpha', size: 25, archived: 0 }, { id: 't_b', name: 'Bravo', size: 25, archived: 0 }, { id: 't_c', name: 'Old', size: 25, archived: 1 }];
  const raid = (id, team, extra = {}) => ({ id, team_id: team, raid_on: '2027-01-16', starts_at: NOW + 5 * HOUR, zone: 'Karazhan', title: null, event_title: null, ...extra });
  const input = (can) => ({
    today: '2027-01-15', now: NOW, teams, allowsTeam: (action, teamId) => (can[action] === 'guild' || (can[action] || []).includes(teamId)), granted: (action) => !!can[action],
    flaggedRaids: [], lootUnmatched: [], signupUnmatched: [], claims: 0, trials: [], noLoot: [], upcoming: [], watch: [],
    rosterPending: [{ ...raid('r_1', 't_a'), n: 3 }, { ...raid('r_2', 't_b'), n: 1 }, { ...raid('r_3', 't_c'), n: 2 }],
    eventMoved: [{ ...raid('r_1', 't_a'), event_moved_on: '2027-01-18' }, { ...raid('r_2', 't_b'), event_moved_on: '2027-01-19' }],
    webhooksOff: [{ team_id: 't_a', disabled_status: 404 }, { team_id: 't_b', disabled_status: 401 }, { team_id: 't_c', disabled_status: 404 }],
  });
  const officer = buildAttention(input({ 'raids.edit': 'guild', 'guild.teams': 'guild' }));
  assert.deepEqual(officer.items.map((i) => i.id), ['roster_pending:r_1', 'roster_pending:r_2', 'event_moved:r_1', 'event_moved:r_2', 'webhook_off:t_a', 'webhook_off:t_b'], 'an archived team shows nothing');
  assert.equal(officer.total, 6);
  assert.deepEqual(officer.items[0], {
    kind: 'roster_pending', severity: 'action', teamId: 't_a', teamName: 'Alpha', raidId: 'r_1', date: '2027-01-16', zone: 'Karazhan', title: null, startsAt: NOW + 5 * HOUR, count: 3,
    id: 'roster_pending:r_1', link: { name: 'raid', rid: 'r_1' },
  });
  assert.deepEqual(officer.items[2].eventDate, '2027-01-18');
  assert.deepEqual(officer.items[4], { kind: 'webhook_off', severity: 'action', teamId: 't_a', teamName: 'Alpha', status: 404, id: 'webhook_off:t_a', link: { name: 'settings', tab: 'notifications' } });
  const lead = buildAttention(input({ 'raids.edit': ['t_a'] }));
  assert.deepEqual(lead.items.map((i) => i.id), ['roster_pending:r_1', 'event_moved:r_1'], 'a lead sees the raids of their team and no webhook');
  const treasurer = buildAttention(input({ 'guild.teams': ['t_b'] }));
  assert.deepEqual(treasurer.items.map((i) => i.id), ['webhook_off:t_b'], 'guild.teams scoped to a team shows the webhook of that team');
  const none = buildAttention({ ...input({ 'raids.edit': 'guild' }), rosterPending: undefined, eventMoved: undefined, webhooksOff: undefined });
  assert.deepEqual(none.items, [], 'an older caller without the new lists still works');
});

check('migration 0018: the settings row needs a team of its guild and a legal lead time; the log is once-only per guild and key, and goes with its raid, team and guild', async () => {
  const s = await scenario({ teams: 2 });
  const sqlite = s.w.db.sqlite;
  const insert = (over = {}) => {
    const v = { team_id: s.tids[0], guild_id: s.gid, noreply_hours: 24, webhook_state: 'ok', role_mention: null, ...over };
    sqlite.prepare('INSERT INTO team_notifications (team_id, guild_id, noreply_hours, webhook_state, role_mention, updated_at) VALUES (?, ?, ?, ?, ?, 1)').run(v.team_id, v.guild_id, v.noreply_hours, v.webhook_state, v.role_mention);
  };
  assert.throws(() => insert({ noreply_hours: 5 }), /CHECK/);
  assert.throws(() => insert({ webhook_state: 'broken' }), /CHECK/);
  assert.throws(() => insert({ role_mention: '@everyone' }), /CHECK/);
  assert.throws(() => insert({ guild_id: 'g_other' }), /FOREIGN KEY/, 'the team must belong to the guild');
  insert();
  assert.throws(() => insert(), /UNIQUE|PRIMARY/);
  const rid = await s.raidAt(at(40));
  const log = (key, raid = rid) => sqlite.prepare("INSERT INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, created_at) VALUES (?, ?, ?, ?, 'remind_24h', ?, 'sent', 1)").run('nl_' + key, s.gid, s.tids[0], raid, key);
  log('k1');
  assert.throws(() => log('k1'), /UNIQUE/, 'one row per guild and key');
  assert.throws(() => sqlite.prepare("INSERT INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, created_at) VALUES ('nl_x', ?, ?, NULL, 'nope', 'k2', 'sent', 1)").run(s.gid, s.tids[0]), /CHECK/);
  assert.throws(() => log('k3', 'r_unknown'), /FOREIGN KEY/);
  assert.equal(await s.w.count('notification_log'), 1);
  await s.ok('gm', 'DELETE', `/raids/${rid}`, {}, 200);
  assert.equal(await s.w.count('notification_log'), 0, 'deleting the raid removes its log rows');
  sqlite.prepare("INSERT INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, created_at) VALUES ('nl_roster', ?, ?, NULL, 'roster', 'r', 'sent', 1)").run(s.gid, s.tids[0]);
  assert.deepEqual(s.w.tablesWithColumn('guild_id').filter((table) => ['team_notifications', 'notification_log'].includes(table)), ['notification_log', 'team_notifications']);
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  let passed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String((error && error.stack) || error).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
