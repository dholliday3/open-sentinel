# Limits

What open-sentinel can't do yet, and what hasn't been tested.

## Limits

- **Real data.** Not tried. Every message it has been tested on was written by a model to a
  brief. Synthetic incidents describe themselves more clearly than real customers do, and each
  planted cause shipped within 2 hours of its incident, which flatters attribution.
- **The alarm budget assumes the things counted are independent.** Counting customers handles
  one customer writing twice. It does not handle customers who move together for a reason
  outside your product: a storm, a holiday, a news story. Those are real shifts, and they alert.
- **Scale: the database's work grows with volume.** A tick reads back a few hundred rows whatever
  the volume, and the process running it on Postgres stays near 100 MB. The counting happens in
  the database, over the 17 days the default monitors look back, every tick. Measured on a
  laptop with 125 monitors ([evaluation](evaluation.md#scale)):

  | Messages a week | Postgres | SQLite | DuckDB |
  |---|---|---|---|
  | 500k | 6.5 s | 17 s | 0.6 s |
  | 2M | 34 s | 111 s | 1.6 s |

  SQLite suits up to about 500k a week; past that, use DuckDB or Postgres. Most of a Postgres
  tick is grouping each window's events by customer, which spills to disk under the default
  `work_mem`, not reading answers. Nothing is counted ahead of time: each tick counts its
  lookback again.
- **Gates have a floor on SQLite and DuckDB.** They keep answers below their `hitFloor` (0.05)
  only in each event's JSON, which counts don't read, so a count with a lower gate throws.
  Choose the floor when the tables are created; changing it means rebuilding the hits table.
- **In-memory stores hold everything.** `memoryStore` and `jsonlStore` keep every event in one
  process: about 1 GB of heap at 500k a week. Use a database store past that, and `jsonlStore`
  only with one writer.
- **A budget per workspace.** A watch per workspace has its own alarm budget, so a hundred
  workspaces can raise a hundred times the false alerts of one. Each workspace's tick is a scan
  of its own events only when the store's `partition` names the workspace tag.
- **One writer per DuckDB file.** DuckDB lets one process write a file at a time, and the store
  sends it one statement at a time.
- **Small volume.** At a handful of messages a week, no rate test can see much: in a simulated
  inbox of 25 messages a week, a doubling of complaints was caught in 7% of weeks even with
  perfect labels ([evaluation](evaluation.md#from-the-prototype-study)). There, use one-event
  monitors for what matters on a single message, and counts in a report for the rest.
- **Exposure needs volume.** On a few hundred events a day, `exposureMonitor` sees only large
  effects. Use it beside share monitors, not instead of them; exposure is better at naming a
  change than at catching one.
- **A real OTLP backend.** The payload is valid OTLP; no backend has received it yet.
- **Most database drivers.** The stores are tested on PGlite, Postgres 17 through `pg`,
  `node:sqlite` and `@duckdb/node-api`. Cloudflare D1, libSQL/Turso, better-sqlite3, Neon and
  Vercel Postgres take the same `query` function and haven't been run. The SQLite store's hits
  rely on triggers and `json_each`; neither has been run on D1 or libSQL.
- **Seasonal baselines on real rhythms.** Tested on made-up weekly patterns only.
- **One process per watch.** Two processes ticking the same watch both alert and overwrite each
  other's state. Within one step their alerts carry the same ids, so a sink can drop the repeat
  ([guarantees](guarantees.md)).

## Not built

- **Connectors.** No helpdesk, SMS or email integrations. A connector is a function that yields
  events ([reference](reference.md#writing-your-own)); none are written.
- **Counting ahead of time.** Every tick recounts its lookback. Customers are counted once per
  window, which hourly totals can't add up to, so nothing is rolled up as events arrive.
- **Rate correction inside monitors.** `correctedRate` is for numbers you report. Monitors
  compare raw counts under one labeler, where a steady error mostly cancels.
- **Finding topics nobody asked about.** Broad questions plus splits by tag caught incidents no
  question named in testing. Clustering what lands in "other" would do it directly, and is not
  built.
- **Alert routing, on-call and dashboards.** Export to the tools that already do these
  (`otlpSink`, `webhookSink`).
