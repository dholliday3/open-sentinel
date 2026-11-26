# Changelog

All notable changes to open-sentinel are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (before 1.0, a minor version may break the API).

## [0.2.0] - Unreleased

A watch tick no longer reads its lookback into memory. Monitors, suspects and the investigator's
tools read through a `Reader` that counts where the events are kept, and three database stores
count in the database. This breaks code that implements `Monitor`, implements `Store`, or calls
the counting helpers directly; the steps are under [Migrating from 0.1](#migrating-from-01).

### Changed

- **`Monitor.check(reader, now, context)`** replaces `check(view, now, context)`. A monitor counts
  through `reader.count(...)` and reads a few events with `reader.events(...)`, instead of
  filtering a view of every event in the lookback. The checks of one tick run together, and counts
  that differ only in their windows and signals reach the store as one query.
- **Helpers that counted a view now take a `Reader` and return a promise:** `series`,
  `breakdown`, `movers`, `summarize`, `estimateOnset`, `exposureOf`, `rankChanges` and
  `suspectsFor`.
- **`Runner.tick(reader, now, changes)`** takes a reader. `replay` and `backtestMonitors` build a
  `memoryReader` themselves; the watch builds a `storeReader` over its lookback each tick.
- **`ToolData` is `{ reader, changes }`** instead of `{ view, changes }`, for `toolsFor`,
  `investigate` and `mcpServer`.
- **`Store` has two more methods**, `count` and `labelers`, and `events` takes a richer query
  (`atLeast`, `order`, `onePerUnit`, `limit`, `labeler`, `oneAnswer`). `countEvents`,
  `readEvents` and `labelersOf` are the reference implementations over an array.

### Added

- **Database stores:** `postgresStore` (`open-sentinel/postgres`), `sqliteStore`
  (`open-sentinel/sqlite`: `node:sqlite`, better-sqlite3, libSQL/Turso, Cloudflare D1) and
  `duckdbStore` (`open-sentinel/duckdb`). Each takes a `query(sql, params)` function instead of a
  driver, so the package still has no runtime dependencies. `migrate()` creates the tables;
  `postgresSchema()`, `sqliteSchema()` and `duckdbSchema()` give the same SQL for a migration tool
  of your own. `partition` keeps one tag in an indexed column, for many workspaces in one store.
  The DuckDB store is tested on DuckDB 1.4.5 and 2.0.1; a DuckDB store is owned by one process.
- **A hits table** (`<table>_hits`) in SQLite and DuckDB, beside the events: one narrow row for
  each answer at or above the store's `hitFloor` (0.05 by default), written and deleted with its
  event, by trigger in SQLite and in one transaction in DuckDB. Counts read hits and parse no
  JSON, and reads that filter by a signal (one-event monitors, the examples on a notice) find
  their events through them. A count with a gate below the floor throws instead of miscounting; a
  read with `atLeast` below it still answers, from each event's JSON. Postgres keeps no hits: it
  counts from jsonb, which measured faster there.
- **`viewMonitor(monitor)`** runs a monitor written for 0.1: before each check it reads the events
  of the monitor's own `lookbackMs` through the reader and hands `check` a view of them.
- `storeReader`, `memoryReader` and `viewWithin` (in `open-sentinel`), and `storeContract` with a
  `hitFloor` option (in `open-sentinel/testing`), which checks a store's `count`, `events` and
  `labelers` against the reference implementations on random histories.

### Migrating from 0.1

1. **A monitor of your own:** rewrite `check` to count through the reader
   (`reader.count({ windows, signals, gates, per })`), or wrap it as it is:
   `viewMonitor(myMonitor)`. The wrapper reads every event of the monitor's lookback each check,
   as 0.1 did, so prefer the rewrite for a long lookback.
2. **Calls to `series`, `breakdown`, `movers`, `summarize`, `estimateOnset`, `exposureOf`,
   `rankChanges` or `suspectsFor`:** `await` them, and pass `memoryReader(events)` where you
   passed `viewOf(events)`, or `storeReader(store, { schema })` to count in a store.
3. **`runner.tick(view, ...)` and `toolsFor({ view, changes })`:** pass `memoryReader(events)` or
   a `storeReader` instead of the view, as `reader`.
4. **A `Store` of your own:** add `count` and `labelers`, and widen `events` to the new query.
   Answering them over an array with `countEvents`, `labelersOf` and `readEvents` is correct;
   then run `storeContract` from `open-sentinel/testing` against it.
5. **A SQLite or DuckDB store created before the hits table:** run `migrate()` once. It creates
   `<table>_hits` from the events already stored, in one statement, and records the floor in the
   state table under `open-sentinel:hitFloor`. On SQLite it also adds the two triggers that keep
   hits in step, and swaps the time index for one that includes `unit`. Running it again changes
   nothing. If you manage the schema yourself, apply the new statements from `sqliteSchema()` or
   `duckdbSchema()`. A Postgres store needs nothing.
6. **Gates below 0.05:** a count on a SQLite or DuckDB store throws for them. Use a gate of at
   least the floor, or create the store with a lower `hitFloor`. The floor is fixed when
   `migrate()` first creates the hits table: opening the store with another one throws, and
   changing it means dropping `<table>_hits` (and on SQLite its triggers) and the
   `open-sentinel:hitFloor` state, then running `migrate()` again.
