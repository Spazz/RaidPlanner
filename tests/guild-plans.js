// Query-plan checks for the read budgets of the user-hierarchy build (plan "Model": EXPLAIN QUERY PLAN shows no SCAN of characters / guild_roster / players /
// role_assignments, plus a statement-count assertion from the D1 stand-in's statementLog). The stand-in's rows_read counts returned rows, so the plan is what proves a request
// does not walk a whole table.
//   scansSince(db, from, { tables })   the statements a request ran (db.statementLog from position `from`) whose plan walks a whole guarded table: [{ table, detail, sql }].
//                                      tables: the tables to guard (default GUARDED_TABLES); the Users suite adds the evidence tables (raid_signups, loot_awards, attendance, ...)
//   statementsSince(db, from)   how many statements it ran
// The views (effective_roles and friends, migration 0035) call their tables by their own aliases, so a plan row carries the view's alias: the alias names are read from the
// view definitions as well as from the statement.

const GUARDED_TABLES = ['guilds', 'players', 'characters', 'guild_roster', 'role_assignments'];
const touchesOf = (tables) => new RegExp(`\\b(${[...tables, 'effective_roles\\w*', 'ingame_proven_characters'].join('|')})\\b`);

// Every alias a text gives a table (and the table's own name): the names a plan row can call it.
function namesOf(text, table) {
  const skip = /^(WHERE|JOIN|ON|LEFT|INNER|SET|GROUP|ORDER|LIMIT|USING|CROSS|AND|OR|UNION|SELECT|INDEXED|NOT|AS|VALUES)$/i;
  const names = new Set([table]);
  for (const match of text.matchAll(new RegExp(`(?:\\b(?:FROM|JOIN)\\s+|,\\s*)${table}\\b(?:\\s+(?:AS\\s+)?([a-z_]\\w*))?`, 'gi'))) if (match[1] && !skip.test(match[1])) names.add(match[1]);
  return names;
}

function scansSince(db, from, { tables = GUARDED_TABLES } = {}) {
  const found = [];
  const TOUCHES = touchesOf(tables);
  const viewSql = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'view'").all().map((row) => row.sql).join('\n');
  for (const { sql, values } of db.statementLog.slice(from)) {
    if (!TOUCHES.test(sql)) continue;
    const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
    for (const table of tables) {
      const names = namesOf(`${sql}\n${viewSql}`, table);
      for (const row of plan) {
        const target = /^SCAN (?:TABLE )?(\S+)/.exec(row.detail);
        if (target && names.has(target[1])) found.push({ table, detail: row.detail, sql: sql.replace(/\s+/g, ' ').slice(0, 140) });
      }
    }
  }
  return found;
}

const statementsSince = (db, from) => db.statementLog.length - from;

// Every statement the request ran (from `from`) whose plan walks a whole TABLE, whichever one it is: [{ detail, sql }]. SQLite prints the ALIAS of a table ("SCAN ra"), so the aliases
// are read from the statement and from the view definitions (as namesOf does). A scan that can only be a one-row subquery (CONSTANT ROW, "SCAN c" for `(SELECT ? AS uid) c`) or the
// result of a view (its co-routine; its tables show up in their own plan rows) is not a table scan.
function anyScansSince(db, from) {
  const found = [];
  const master = db.sqlite.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view')").all();
  const tables = new Set(master.filter((row) => row.type === 'table').map((row) => row.name));
  const views = master.filter((row) => row.type === 'view');
  const viewSql = views.map((row) => row.sql).join('\n');
  const pair = /(?:\b(?:FROM|JOIN)\s+|,\s*)([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  const skip = /^(WHERE|JOIN|ON|LEFT|INNER|SET|GROUP|ORDER|LIMIT|USING|CROSS|AND|OR|UNION|SELECT|INDEXED|NOT|AS|VALUES)$/i;
  const standsFor = (text, target) => {
    const names = new Set();
    for (const match of text.matchAll(pair)) if ((match[2] && !skip.test(match[2]) ? match[2] : match[1]) === target) names.add(match[1]);
    return names;
  };
  for (const { sql, values } of db.statementLog.slice(from)) {
    const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => row.detail);
    for (const detail of plan) {
      const target = /^SCAN (?:TABLE )?(\S+)/.exec(detail);
      if (!target || target[1] === 'CONSTANT') continue;
      const candidates = new Set([...standsFor(sql, target[1]), ...standsFor(viewSql, target[1])]);
      if (tables.has(target[1])) candidates.add(target[1]);
      if ([...candidates].some((name) => tables.has(name))) found.push({ detail, sql: sql.replace(/\s+/g, ' ').slice(0, 140) });
    }
  }
  return found;
}

module.exports = { GUARDED_TABLES, namesOf, scansSince, statementsSince, anyScansSince };
