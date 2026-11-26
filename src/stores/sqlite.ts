// A store in SQLite, with no driver of its own: hand it a function that runs a query. It works
// with Node's built-in `node:sqlite`, better-sqlite3, libSQL/Turso and Cloudflare D1:
//
//   const db = new DatabaseSync("signals.db");                        // node:sqlite
//   const store = sqliteStore({ query: async (sql, params) => ({ rows: db.prepare(sql).all(...params) }) });
//
//   const store = sqliteStore({ query: async (sql, params) => ({ rows: (await env.DB.prepare(sql).bind(...params).all()).results }), maxParams: 100 });   // D1
//
// One file, one writer at a time; counting happens in SQLite, from a table of hits that triggers on
// the events table write and delete in the same statement as each event.
import { FLOOR_KEY, floorSql, HIT_COLUMNS, hitsOf, schemaSql, sqlStore } from "./sql.ts";
import type { ColumnType, Dialect, SqlStore, SqlStoreOptions, SqlValue } from "./sql.ts";

/** A JSON path to one key, quoted, so a key with dots, quotes or brackets is still one key. */
const path = (key: string): string => `$."${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const TYPES: Record<ColumnType, string> = { integer: "INTEGER", double: "REAL", text: "TEXT", json: "TEXT" };

export const sqliteDialect: Dialect = {
  placeholder: (n) => `?${n}`,
  key: path,
  number: (column, key) => `CAST(json_extract(${column}, ${key}) AS REAL)`,
  text: (column, key) => `json_extract(${column}, ${key})`,
  // Tags are stored with their keys sorted, so the same tags are the same text with or without some removed.
  without: (column, keys, bind) => (keys.length === 0 ? `COALESCE(${column}, '{}')` : `json_remove(COALESCE(${column}, '{}'), ${keys.map((key) => bind(path(key))).join(", ")})`),
  rows: (param, alias, columns) => `(SELECT ${Object.entries(columns).map(([name, type]) => `CAST(json_extract(value, '$.${name}') AS ${TYPES[type]}) AS ${name}`).join(", ")} FROM json_each(${param})) AS ${alias}`,
  json: (param) => param,
  parse: (value) => (value === null || value === undefined ? null : JSON.parse(String(value))),
  least: (values) => (values.length === 1 ? values[0]! : `MIN(${values.join(", ")})`),
  // Rounds toward zero, which is down for what is never negative; FLOOR isn't in every build.
  whole: (value) => `CAST(${value} AS INTEGER)`,
  ddl: ({ events, hits, changes, state, prefix, partitioned, hitFloor }) => [
    `CREATE TABLE IF NOT EXISTS ${events} (seq INTEGER PRIMARY KEY, schema_id TEXT NOT NULL, id TEXT NOT NULL, labeler TEXT NOT NULL, at_ms REAL NOT NULL, unit TEXT, tags TEXT, signals TEXT NOT NULL, probability TEXT NOT NULL, text TEXT, context TEXT, part TEXT, UNIQUE (schema_id, id, labeler))`,
    // With `unit`, a count reads these indexes and not the events themselves (wider by their text and JSON).
    `CREATE INDEX IF NOT EXISTS ${prefix}_events_count ON ${events} (schema_id, labeler, at_ms, unit)`,
    `DROP INDEX IF EXISTS ${prefix}_events_time`,
    ...(partitioned ? [`CREATE INDEX IF NOT EXISTS ${prefix}_events_part_count ON ${events} (schema_id, part, labeler, at_ms, unit)`, `DROP INDEX IF EXISTS ${prefix}_events_part`] : []),
    `CREATE INDEX IF NOT EXISTS ${prefix}_events_at ON ${events} (at_ms)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_events_unit ON ${events} (unit) WHERE unit IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${changes} (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at_ms REAL NOT NULL, change TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${state} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `INSERT INTO ${state} (key, value) VALUES ('${FLOOR_KEY}', '${hitFloor}') ON CONFLICT (key) DO NOTHING`,
    // The triggers come before the table they write to, so an event stored in between fails rather than going without hits.
    `CREATE TRIGGER IF NOT EXISTS ${prefix}_events_hits AFTER INSERT ON ${events} BEGIN INSERT INTO ${hits} (${HIT_COLUMNS}) ${hitsOf(sqliteDialect, undefined, "NEW", floorSql(hitFloor))}; END`,
    `CREATE TRIGGER IF NOT EXISTS ${prefix}_events_forget AFTER DELETE ON ${events} BEGIN DELETE FROM ${hits} WHERE seq = OLD.seq; END`,
    `CREATE TABLE IF NOT EXISTS ${hits} AS ${hitsOf(sqliteDialect, `${events} e`, "e", floorSql(hitFloor))}`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_hits_seq ON ${hits} (seq, key, p)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_hits_time ON ${hits} (schema_id, labeler, key, at_ms, p)`,
    ...(partitioned ? [`CREATE INDEX IF NOT EXISTS ${prefix}_hits_part ON ${hits} (schema_id, part, labeler, key, at_ms, p)`] : []),
  ],
  hits: { together: "triggers", lookup: "each", each: (column) => ({ from: `json_each(${column}) AS j`, p: "CAST(CASE WHEN j.type IN ('integer', 'real') THEN j.value END AS REAL)" }) },
  // SQLite's own limit before 3.32; Cloudflare D1 takes 100.
  maxParams: 999,
  // An OFFSET keeps SQLite from merging the scan into the query above it, which would look up each event's hits once per use.
  fence: " LIMIT -1 OFFSET 0",
  // Numbered while the statement is built; every driver takes plain `?`, one value per use, in order.
  finish: (sql, params) => {
    const ordered: SqlValue[] = [];
    return { sql: sql.replace(/\?(\d+)/g, (_, n: string) => (ordered.push(params[Number(n) - 1]), "?")), params: ordered };
  },
};

/** A store in SQLite 3.35 or later. Run `migrate()` once, or put `sqliteSchema()` in your own migrations. */
export const sqliteStore = (options: SqlStoreOptions): SqlStore => sqlStore(sqliteDialect, options);

/** The tables and indexes `sqliteStore` needs, as SQL. */
export const sqliteSchema = (table?: string, partition?: string, hitFloor?: number): string => schemaSql(sqliteDialect, table, partition, hitFloor);

export type { Query, SqlStore, SqlStoreOptions, SqlValue } from "./sql.ts";
