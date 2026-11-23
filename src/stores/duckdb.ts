// A store in DuckDB, with no driver of its own: hand it a function that runs a query, such as
// one over a `@duckdb/node-api` connection:
//
//   const connection = await (await DuckDBInstance.create("signals.duckdb")).connect();
//   const store = duckdbStore({ query: async (sql, params) => ({ rows: (await connection.runAndReadAll(sql, params)).getRowObjectsJS() }) });
//
// DuckDB is columnar: a count reads only the columns it needs, which suits long history and
// heavy volume. One process writes a DuckDB file at a time.
import { schemaSql, sqlStore } from "./sql.ts";
import type { ColumnType, Dialect, SqlStore, SqlStoreOptions } from "./sql.ts";

/** A JSON path to one key, quoted, so a key with dots, quotes or brackets is still one key. */
const path = (key: string): string => `$."${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const TYPES: Record<ColumnType, string> = { integer: "INTEGER", double: "DOUBLE", text: "VARCHAR", json: "JSON" };

export const duckdbDialect: Dialect = {
  placeholder: (n) => `$${n}`,
  key: path,
  number: (column, key) => `CAST(${column} ->> ${key} AS DOUBLE)`,
  text: (column, key) => `(${column} ->> ${key})`,
  // A merge patch with a key set to null removes it. Tags are stored with their keys sorted, so the same tags are the same text.
  without: (column, keys, bind) => `CAST(${keys.length === 0 ? `COALESCE(${column}, CAST('{}' AS JSON))` : `json_merge_patch(COALESCE(${column}, CAST('{}' AS JSON)), json_object(${keys.map((key) => `CAST(${bind(key)} AS VARCHAR), NULL`).join(", ")}))`} AS VARCHAR)`,
  rows: (param, alias, columns) => `(SELECT unnest(from_json(${param}, '${JSON.stringify([Object.fromEntries(Object.entries(columns).map(([name, type]) => [name, TYPES[type]]))])}'), recursive := true)) AS ${alias}`,
  json: (param) => `CAST(${param} AS JSON)`,
  parse: (value) => (value === null || value === undefined ? null : JSON.parse(String(value))),
  least: (values) => (values.length === 1 ? values[0]! : `LEAST(${values.join(", ")})`),
  whole: (value) => `CAST(FLOOR(${value}) AS INTEGER)`,
  // No indexes past the primary key: DuckDB skips row groups by their range of `at` instead.
  ddl: ({ events, changes, state }) => [
    `CREATE SEQUENCE IF NOT EXISTS ${events}_seq`,
    `CREATE TABLE IF NOT EXISTS ${events} (seq BIGINT DEFAULT nextval('${events}_seq'), schema_id VARCHAR NOT NULL, id VARCHAR NOT NULL, labeler VARCHAR NOT NULL, at_ms DOUBLE NOT NULL, unit VARCHAR, tags JSON, signals JSON NOT NULL, probability VARCHAR NOT NULL, text VARCHAR, context JSON, PRIMARY KEY (schema_id, id, labeler))`,
    `CREATE SEQUENCE IF NOT EXISTS ${changes}_seq`,
    `CREATE TABLE IF NOT EXISTS ${changes} (seq BIGINT DEFAULT nextval('${changes}_seq'), id VARCHAR PRIMARY KEY, at_ms DOUBLE NOT NULL, change JSON NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${state} (key VARCHAR PRIMARY KEY, value JSON NOT NULL)`,
  ],
  maxParams: 65_535,
  fence: "",
  // Statements sent together on one connection failed now and then ("Failed to execute prepared statement").
  serial: true,
};

/** A store in DuckDB 1.1 or later. Run `migrate()` once, or put `duckdbSchema()` in your own migrations. */
export const duckdbStore = (options: SqlStoreOptions): SqlStore => sqlStore(duckdbDialect, options);

/** The tables and sequences `duckdbStore` needs, as SQL. */
export const duckdbSchema = (table?: string): string => schemaSql(duckdbDialect, table);

export type { Query, SqlStore, SqlStoreOptions } from "./sql.ts";
