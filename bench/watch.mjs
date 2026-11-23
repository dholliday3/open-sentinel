// How much one watch tick costs at a given volume, on a given store. Not part of `npm test`.
//
//   node --expose-gc bench/watch.mjs <memory|pglite|sqlite|duckdb|postgres> <messages a week> [options]
//
//   --path <file or folder>  keep the database there (pglite, sqlite, duckdb) instead of in memory
//   --url <connection>       the Postgres server, for `postgres` (needs `pg`: PG_MODULE=<path to pg>)
//   --tick-only              don't fill the store: tick over what --path or --url already holds,
//                            in a process that has done nothing else, as a cron job would
//
// Prints one JSON line: how long filling took, how long the tick took, the heap the store's data
// took before it (after a full GC), how far the committed heap grew during it, the process's peak
// memory, and how many rows came back to Node.
// SENTINEL_SRC=<path to src/> runs it on another checkout, such as the code before a change.
import { performance } from "node:perf_hooks";
import { batches, changes, monitors, NOW, schema } from "./stream.mjs";

const src = process.env.SENTINEL_SRC ?? new URL("../src/", import.meta.url).pathname;
const lib = await import(`${src}index.ts`);
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [kind, volume] = args;
const perWeek = Number(volume);
const path = flag("--path");
const tickOnly = args.includes("--tick-only");
const mb = (bytes) => Math.round(bytes / 1e6);

const open = async () => {
  switch (kind) {
    case "memory":
      return { store: lib.memoryStore() };
    case "pglite": {
      const { PGlite } = await import("@electric-sql/pglite");
      const db = path ? new PGlite(path) : new PGlite();
      const { postgresStore } = await import(`${src}stores/postgres.ts`);
      return { store: postgresStore({ query: (sql, params) => db.query(sql, params) }), close: () => db.close() };
    }
    case "postgres": {
      const pg = (await import(process.env.PG_MODULE ?? "pg")).default;
      const pool = new pg.Pool({ connectionString: flag("--url"), max: 4 });
      const { postgresStore } = await import(`${src}stores/postgres.ts`);
      return { store: postgresStore({ query: (sql, params) => pool.query(sql, params) }), close: () => pool.end() };
    }
    case "sqlite": {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path ?? ":memory:");
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -262144");
      const { sqliteStore } = await import(`${src}stores/sqlite.ts`);
      return { store: sqliteStore({ query: async (sql, params) => ({ rows: db.prepare(sql).all(...params) }) }), close: () => db.close() };
    }
    case "duckdb": {
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const instance = await DuckDBInstance.create(path ?? ":memory:");
      const connection = await instance.connect();
      const { duckdbStore } = await import(`${src}stores/duckdb.ts`);
      return { store: duckdbStore({ query: async (sql, params) => ({ rows: (await connection.runAndReadAll(sql, params)).getRowObjectsJS() }) }), close: () => connection.closeSync() };
    }
    default:
      throw new Error(`No store named "${kind}"`);
  }
};

const { store, close } = await open();
let events = 0;
let ingestSec = 0;
if (!tickOnly) {
  await store.migrate?.();
  const started = performance.now();
  for (const batch of batches({ perWeek })) {
    await store.append(batch);
    events += batch.length;
  }
  for (const change of changes()) {
    await store.recordChange(change);
  }
  ingestSec = (performance.now() - started) / 1000;
}

// Every row a tick takes back from the store.
const read = { counts: 0, countRows: 0, reads: 0, eventRows: 0 };
const watched = {
  ...store,
  count: async (query) => {
    const rows = await store.count(query);
    read.counts += 1;
    read.countRows += rows.length;
    return rows;
  },
  events: async (query) => {
    const rows = await store.events(query);
    read.reads += 1;
    read.eventRows += rows.length;
    return rows;
  },
};
globalThis.gc?.();
const before = process.memoryUsage();
const started = performance.now();
const tick = await lib.createWatch({ schema, store: watched, monitors: monitors(), stateKey: `bench:${performance.timeOrigin}` }).tick(NOW);
const tickSec = (performance.now() - started) / 1000;
// V8 grows the committed heap to what the tick needed and doesn't hand it back straight away.
const after = process.memoryUsage();
await close?.();
console.log(
  JSON.stringify({
    store: kind,
    perWeek,
    ...(tickOnly ? {} : { events, ingestSec: +ingestSec.toFixed(1), ingestPerSec: Math.round(events / ingestSec) }),
    tickSec: +tickSec.toFixed(2),
    heapBeforeMB: mb(before.heapUsed),
    tickHeapMB: mb(after.heapTotal - before.heapTotal),
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    ...read,
    fired: tick.fired.length,
    notices: tick.notices.length,
    topSuspect: tick.notices.find((notice) => notice.suspects)?.suspects?.[0]?.change.id,
  }),
);
