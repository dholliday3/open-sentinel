// The Postgres store, run against PGlite: real Postgres compiled to WebAssembly, a dev
// dependency (skipped when it isn't installed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { postgresDialect, postgresSchema, postgresStore } from "./postgres.ts";
import { checkSqlStore } from "./sql-checks.mjs";

let db;
try {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
} catch {
  db = undefined;
}
const skip = db ? false : "@electric-sql/pglite isn't installed: run npm install";

const query = (sql, params) => db.query(sql, params);

checkSqlStore(
  "postgresStore",
  async (table, partition, through = query, hitFloor) => {
    const store = postgresStore({ query: through, table, ...(partition ? { partition } : {}), ...(hitFloor ? { hitFloor } : {}) });
    await store.migrate();
    return store;
  },
  { skip, query, dialect: postgresDialect },
);

test("postgresSchema is the SQL migrate() runs, for a migration tool of your own", { skip }, async () => {
  const sql = postgresSchema("app_sentinel");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_sentinel_events/);
  await db.exec(sql);
  const store = postgresStore({ query: (text, params) => db.query(text, params), table: "app_sentinel" });
  await store.append([{ id: "a", at: 1, schema: "s@1", labeler: "l@1", probability: "native", signals: { bug: 0.9 } }]);
  assert.equal((await store.events()).length, 1);
  // Running it again changes nothing.
  await store.migrate();
  assert.equal((await store.events()).length, 1);
});
