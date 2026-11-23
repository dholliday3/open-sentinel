// A store in Postgres, with no driver of its own: hand it a function that runs a query, such as
// `pg`'s `pool.query`, or the same from Neon, Vercel Postgres or PGlite.
//
//   const store = postgresStore({ query: (sql, params) => pool.query(sql, params) });
//   await store.migrate();
//
// Counting happens in Postgres: a tick sends a few queries and gets back a row per window.
import { schemaSql, sqlStore } from "./sql.ts";
import type { ColumnType, Dialect, SqlStore, SqlStoreOptions } from "./sql.ts";

const TYPES: Record<ColumnType, string> = { integer: "INTEGER", double: "DOUBLE PRECISION", text: "TEXT", json: "JSONB" };
const asText = (placeholder: string): string => `CAST(${placeholder} AS TEXT)`;

export const postgresDialect: Dialect = {
  placeholder: (n) => `$${n}`,
  key: (name) => name,
  number: (column, name) => `CAST(${column} ->> ${asText(name)} AS DOUBLE PRECISION)`,
  text: (column, name) => `(${column} ->> ${asText(name)})`,
  without: (column, keys, bind) => `(COALESCE(${column}, CAST('{}' AS JSONB))${keys.map((name) => ` - ${asText(bind(name))}`).join("")})`,
  rows: (param, alias, columns) => `jsonb_to_recordset(CAST(${param} AS JSONB)) AS ${alias}(${Object.entries(columns).map(([name, type]) => `${name} ${TYPES[type]}`).join(", ")})`,
  json: (param) => `CAST(${param} AS JSONB)`,
  // Drivers return jsonb parsed already.
  parse: (value) => value ?? null,
  least: (values) => (values.length === 1 ? values[0]! : `LEAST(${values.join(", ")})`),
  whole: (value) => `CAST(FLOOR(${value}) AS INTEGER)`,
  ddl: ({ events, changes, state, prefix }) => [
    `CREATE TABLE IF NOT EXISTS ${events} (seq BIGINT GENERATED ALWAYS AS IDENTITY, schema_id TEXT NOT NULL, id TEXT NOT NULL, labeler TEXT NOT NULL, at_ms DOUBLE PRECISION NOT NULL, unit TEXT, tags JSONB, signals JSONB NOT NULL, probability TEXT NOT NULL, text TEXT, context JSONB, PRIMARY KEY (schema_id, id, labeler))`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_events_time ON ${events} (schema_id, labeler, at_ms)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_events_at ON ${events} (at_ms)`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_events_unit ON ${events} (unit) WHERE unit IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${changes} (seq BIGINT GENERATED ALWAYS AS IDENTITY, id TEXT PRIMARY KEY, at_ms DOUBLE PRECISION NOT NULL, change JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${state} (key TEXT PRIMARY KEY, value JSONB NOT NULL)`,
  ],
  maxParams: 65_535,
  // Keeps the signal parts in the scan, where workers share them, so only narrow rows are sorted.
  fence: " OFFSET 0",
};

/** A store in Postgres 12 or later. Run `migrate()` once, or put `postgresSchema()` in your own migrations. */
export const postgresStore = (options: SqlStoreOptions): SqlStore => sqlStore(postgresDialect, options);

/** The tables and indexes `postgresStore` needs, as SQL. */
export const postgresSchema = (table?: string): string => schemaSql(postgresDialect, table);

export type { Query, SqlStore, SqlStoreOptions } from "./sql.ts";
