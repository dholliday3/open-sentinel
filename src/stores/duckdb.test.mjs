// The DuckDB store, run on @duckdb/node-api, a dev dependency (skipped when it isn't installed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { duckdbDialect, duckdbSchema, duckdbStore } from "./duckdb.ts";
import { checkSqlStore } from "./sql-checks.mjs";

let connection;
try {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  connection = await (await DuckDBInstance.create(":memory:")).connect();
} catch {
  connection = undefined;
}
const skip = connection ? false : "@duckdb/node-api isn't installed: run npm install";
const query = async (sql, params) => ({ rows: (await connection.runAndReadAll(sql, params)).getRowObjectsJS() });

checkSqlStore(
  "duckdbStore",
  async (table, partition, through = query, hitFloor) => {
    const store = duckdbStore({ query: through, table, ...(partition ? { partition } : {}), ...(hitFloor ? { hitFloor } : {}) });
    await store.migrate();
    return store;
  },
  { skip, query, dialect: duckdbDialect },
);

test("duckdbSchema is the SQL migrate() runs, and runs as one script in a migration tool of your own", { skip }, async () => {
  const sql = duckdbSchema("own", undefined, 0.1);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS own_events/);
  await connection.run(sql);
  const store = duckdbStore({ query, table: "own", hitFloor: 0.1 });
  await store.append([{ id: "a", at: 1, schema: "s@1", labeler: "l@1", probability: "native", signals: { bug: 0.9, small: 0.07 } }]);
  assert.deepEqual((await query("SELECT key, p FROM own_hits", [])).rows, [{ key: "bug", p: 0.9 }]);
  assert.deepEqual((await store.count({ schema: "s@1", windows: [{ from: 0, to: 2 }], signals: ["bug"], per: "event" }))[0].yes, { bug: 1 });
});

test("duckdbStore sends one statement at a time, however many a tick asks for together", { skip }, async () => {
  let running = 0;
  let most = 0;
  const watched = async (sql, params) => {
    running += 1;
    most = Math.max(most, running);
    try {
      return await query(sql, params);
    } finally {
      running -= 1;
    }
  };
  const store = duckdbStore({ query: watched, table: "serial" });
  await store.migrate();
  await store.append([{ id: "a", at: 1, schema: "s@1", labeler: "l@1", probability: "native", signals: { bug: 0.9 } }]);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.count({ schema: "s@1", windows: [{ from: 0, to: i + 2 }], signals: ["bug"], per: "event" })));
  assert.equal(most, 1);
});
