// Random TEXT ids: a prefix + 16 random bytes in base64url (22 characters).
const PATTERNS = {
  u: /^u_[A-Za-z0-9_-]{22}$/,
  g: /^g_[A-Za-z0-9_-]{22}$/,
  t: /^t_[A-Za-z0-9_-]{22}$/,
  ra: /^ra_[A-Za-z0-9_-]{22}$/,
  al: /^al_[A-Za-z0-9_-]{22}$/,
  p: /^p_[A-Za-z0-9_-]{22}$/,
  c: /^c_[A-Za-z0-9_-]{22}$/,
  r: /^r_[A-Za-z0-9_-]{22}$/,
  ap: /^ap_[A-Za-z0-9_-]{22}$/,
  ri: /^ri_[A-Za-z0-9_-]{22}$/,
  lo: /^lo_[A-Za-z0-9_-]{22}$/,
  lp: /^lp_[A-Za-z0-9_-]{22}$/,
  cl: /^cl_[A-Za-z0-9_-]{22}$/,
  ts: /^ts_[A-Za-z0-9_-]{22}$/,
  ct: /^ct_[A-Za-z0-9_-]{22}$/,
  // A custom role (Phase 7) and a guest link.
  cr: /^cr_[A-Za-z0-9_-]{22}$/,
  gl: /^gl_[A-Za-z0-9_-]{22}$/,
  an: /^an_[A-Za-z0-9_-]{22}$/,
  sg: /^sg_[A-Za-z0-9_-]{22}$/,
  // PM wave 3: an intent round and an application.
  ir: /^ir_[A-Za-z0-9_-]{22}$/,
  am: /^am_[A-Za-z0-9_-]{22}$/,
  // PM wave 4: a notification log row.
  nl: /^nl_[A-Za-z0-9_-]{22}$/,
  // PM wave 7: a read-only API key.
  ak: /^ak_[A-Za-z0-9_-]{22}$/,
  // PM wave 8: a guest sign-up link of a raid.
  jl: /^jl_[A-Za-z0-9_-]{22}$/,
  // Home redesign: a shared dismissal of a Needs attention item.
  ad: /^ad_[A-Za-z0-9_-]{22}$/,
  // Hierarchy build: one roster sync attempt (roster_syncs.id).
  rs: /^rs_[A-Za-z0-9_-]{22}$/,
  // Hierarchy build, lane B3: a team request (a person asks for one of their characters to be placed on a team).
  tq: /^tq_[A-Za-z0-9_-]{22}$/,
  // Hierarchy build, lane B6a: one person join (person_joins.id).
  pj: /^pj_[A-Za-z0-9_-]{22}$/,
};

export function defaultRandomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newId(prefix, randomBytes) {
  if (!PATTERNS[prefix]) throw new Error('unknown id prefix');
  return `${prefix}_${base64url(randomBytes(16))}`;
}

export function isId(prefix, value) {
  return typeof value === 'string' && !!PATTERNS[prefix] && PATTERNS[prefix].test(value);
}

// Route-parameter name -> the regex source that parameter must match.
export const PARAM_SOURCE = {
  gid: 'g_[A-Za-z0-9_-]{22}',
  tid: 't_[A-Za-z0-9_-]{22}',
  uid: 'u_[A-Za-z0-9_-]{22}',
  pid: 'p_[A-Za-z0-9_-]{22}',
  cid: 'c_[A-Za-z0-9_-]{22}',
  rid: 'r_[A-Za-z0-9_-]{22}',
  aid: 'lo_[A-Za-z0-9_-]{22}',
  // An item id (GET /loot/items/:lootitem): digits only, the Worker range-checks it.
  lootitem: '[0-9]{1,10}',
  // A character claim (Battle.net, Phase 5).
  clid: 'cl_[A-Za-z0-9_-]{22}',
  // A role: one of the guild's own (cr_...) or a built-in id; a guest link.
  rolid: '(?:cr_[A-Za-z0-9_-]{22}|guild_master|officer|team_lead|member|guest|public)',
  lid: 'gl_[A-Za-z0-9_-]{22}',
  // An away notice (worker/routes/away.js).
  nid: 'an_[A-Za-z0-9_-]{22}',
  // An intent round and an application (PM wave 3).
  iid: 'ir_[A-Za-z0-9_-]{22}',
  apid: 'am_[A-Za-z0-9_-]{22}',
  // A Warcraft Logs report code (DELETE /raids/:rid/reports/:code).
  code: '[A-Za-z0-9]{16}',
  // A calendar feed file name (GET /cal/:cal): a 43-character token and ".ics". The feed route checks it itself (it has no session).
  cal: '[A-Za-z0-9_-]{43}\\.ics',
  // A read-only API key (PM wave 7), and the dataset file of GET /api/v1/:dataset ("roster.csv", "loot.json"; the route checks it itself, it has no session).
  kid: 'ak_[A-Za-z0-9_-]{22}',
  // PM wave 8: a guest sign-up link (DELETE .../join-links/:jid) and a sign-up's number on its raid (DELETE .../guests/:sid).
  jid: 'jl_[A-Za-z0-9_-]{22}',
  // A team request (lane B3).
  trid: 'tq_[A-Za-z0-9_-]{22}',
  // A Needs attention item id (DELETE .../attention/dismissals/:itemid): 'claims', 'no_loot:r_..', 'watch:t_..:p_..'; the colons may arrive as %3A. The handler decodes it.
  itemid: '[a-z_]+(?:(?::|%3[Aa])[A-Za-z0-9_-]{1,40}){0,2}',
  sid: '[0-9]{1,9}',
  // A row of the Users list (GET .../users/:ukey): an account (u_...), an account-less person (p_...), a name seen but not on the roster ('n_' + the hex of its lower-cased key) or a
  // member of the in-game roster that no character carries ('r_' + the hex of its name key, '/' and realm slug).
  ukey: '(?:[up]_[A-Za-z0-9_-]{22}|[nr]_[0-9a-f]{2,512})',
  dataset: '[a-z]{3,12}\\.(?:csv|json)',
};
