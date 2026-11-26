// The SQLite store, run on Node's own `node:sqlite` (no flag from Node 22.13; skipped where it
// isn't there). Also run with D1's limit of 100 parameters a statement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSqlStore } from "./sql-checks.mjs";
import { sqliteDialect, sqliteSchema, sqliteStore } from "./sqlite.ts";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}
const skip = DatabaseSync ? false : "node:sqlite isn't in this version of Node";
const db = DatabaseSync ? new DatabaseSync(":memory:") : undefined;
const query = async (sql, params) => ({ rows: db.prepare(sql).all(...params) });

checkSqlStore(
  "sqliteStore",
  async (table, partition, through = query, hitFloor) => {
    const store = sqliteStore({ query: through, table, ...(partition ? { partition } : {}), ...(hitFloor ? { hitFloor } : {}) });
    await store.migrate();
    return store;
  },
  { skip, query, dialect: sqliteDialect },
);

test("sqliteStore with D1's limit counts many signals at once in halves, the same", { skip }, async () => {
  const store = sqliteStore({ query, table: "d1", maxParams: 100 });
  await store.migrate();
  const signals = Array.from({ length: 60 }, (_, i) => `s${i}`);
  await store.append([{ id: "a", at: 1, unit: "u", schema: "s@1", labeler: "l@1", probability: "native", signals: Object.fromEntries(signals.map((key, i) => [key, i % 2 ? 0.9 : 0.1])) }]);
  const statements = [];
  const counted = await sqliteStore({ query: (sql, params) => (statements.push(params.length), query(sql, params)), table: "d1", maxParams: 100 }).count({ schema: "s@1", windows: [{ from: 0, to: 2 }], signals, per: "unit" });
  assert.deepEqual(counted, [{ window: 0, total: 1, yes: Object.fromEntries(signals.map((key, i) => [key, i % 2])), events: 1 }]);
  assert.ok(statements.length > 1 && statements.every((n) => n <= 100), JSON.stringify(statements));
});

test("sqliteSchema is the SQL migrate() runs, and runs as one script in a migration tool of your own", { skip }, async () => {
  const sql = sqliteSchema("app", undefined, 0.1);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_events/);
  const own = new DatabaseSync(":memory:");
  own.exec(sql);
  const store = sqliteStore({ query: async (text, params) => ({ rows: own.prepare(text).all(...params) }), table: "app", hitFloor: 0.1 });
  await store.append([{ id: "a", at: 1, schema: "s@1", labeler: "l@1", probability: "native", signals: { bug: 0.9, small: 0.07 } }]);
  assert.deepEqual(own.prepare("SELECT key, p FROM app_hits").all().map((row) => ({ ...row })), [{ key: "bug", p: 0.9 }]);
  assert.deepEqual((await store.count({ schema: "s@1", windows: [{ from: 0, to: 2 }], signals: ["bug"], per: "event" }))[0].yes, { bug: 1 });
  await store.migrate();
  assert.equal(own.prepare("SELECT COUNT(*) AS n FROM app_hits").get().n, 1);
});
