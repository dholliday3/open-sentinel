# Evaluation

Every number here comes from synthetic data: messages a model wrote to a brief, with incidents
planted on known days. None of it is from real customers or real traffic. Where a number comes
from a test, the test is named; the rest say how to rerun them. The replay, false-alarm and
attribution numbers were rerun on 2026-11-22 on Node 24.22.

## The data

- **`examples/support/data/`:** two support inboxes, three weeks each: 4,820 and 4,990
  messages, drawn from about 1,200 distinct messages per inbox. They were written by Claude
  Sonnet 5.5 as the inbox of Acme, a made-up software product for home-service businesses, and
  labeled by `typesafe-ai/jev-1.14.0`. `truth.json` says what was planted and when; monitors
  never see it. The second inbox (the holdout) was written after the monitors' design was set
  on the first, but the per-tag and per-area monitors were added after its first run, so it is
  not fully independent.
- **`examples/customer-messages/data/`:** labels for 390 messages, 338 from customers to a
  home-service business and 52 from its owner to the assistant in their software. Each was
  labeled by Jev 1.14.0 and by Claude Opus 5.5 as the reference a person would otherwise be. The
  messages' text is not included.

The product and its assistant (Remy) were renamed after labeling, in the questions and the
messages alike. No other word changed; `examples/support/schema.test.mjs` holds the wording.

## Detection

`node examples/support/replay.ts` replays both inboxes from day 8 (once a week of baseline
exists) with the default monitors, and the two marketing emails declared as planned changes.
`examples/support/defaults.test.mjs` asserts the outcome: every incident raised, nothing false,
the emails muted, the sharp ones within 2 hours.

| Inbox | Planted | Kind | Raised as | Hours to first alert | First monitor |
|---|---|---|---|---|---|
| main | Google sign-in broken in Android release 4.12.0 | sharp, one platform | page | 1 | 3h share of `area=login_access` |
| main | Invoice PDF adds tax twice; no question names it | about one message an hour | page | 23 | 24h share of `is_bug_report&area=invoices_estimates` |
| main | Reaction to a price increase | slow, over a week | digest | 111 | 3-day share of `frustration>=2&area=billing_plan` |
| main | One business sees another's customers | one message | page | 1 | `event: data_exposure` |
| main | Questions after a launch email | harmless | muted | | |
| main | Look-alikes of a data exposure | harmless | nothing | | |
| holdout | Texts silently not delivered | sharp, everyone | page | 1 | 3h share of `area=texting_calls` |
| holdout | The assistant double-books after a new tool | moderate | digest | 75 | 3-day share of `is_bug_report&area=scheduling_booking` |
| holdout | Payouts arriving days late | slow, over a week | digest | 132 | 3-day share of `is_bug_report&area=payments_payouts` |
| holdout | iOS 4.13.0 crashes when adding photos | sharp, one version | page | 2 | 3h share of `is_bug_report&area=other` |
| holdout | Questions after a webinar email | harmless | muted | | |
| holdout | Account taken over by an outsider | one message | page | 1 | `event: data_exposure` |
| holdout | Look-alikes of a takeover | harmless | nothing | | |

No alert on either inbox had nothing planted behind it. Without the emails declared as planned,
each email raised a page within an hour; every incident was still raised, and nothing false.

Counting baselines in whole stretches (2026-11-22) moved the three digest items. The price and
payout digests came 1 and 10 hours sooner. The double-booking digest came 20 hours later than
its earlier 55, though at 39 hours when the webinar isn't declared: the webinar's two planned
days end 2 days and 8 hours before the 3-day window that would have caught it, too short for a
whole 3-day stretch, so the baseline reaches back past them to older weeks.

`examples/support/replay.test.mjs` is a golden test: with the comparison and fixed cutoffs of the
prototype this package grew from passed in, a replay raises exactly the alerts on record,
monitor for monitor and hour for hour. The record is the prototype's, except that counting
baselines in whole stretches moved its 3-day digest alerts by 1 to 11 hours, each still behind
the same planted item, added one behind the iOS photo crash, and dropped one behind the webinar
email.

## False alarms

`node examples/support/budget.ts` takes the main inbox with every planted item removed (4,531
messages) and shuffles which answers arrived when, so any alert is false. 20 shuffles of 1.86
weeks each, 37 weeks in all:

| | Per week | Budget |
|---|---|---|
| False pages | 0.027 | 0.25 |
| False digest items | 0.162 | 1 |

`node examples/support/budget.ts 10 repeats` does the same with customers who write more than
once: three in ten arrivals are followed by one to four more from the same customer. 10
shuffles, 19 weeks:

| Counted | False pages a week | False digest items a week |
|---|---|---|
| Per customer (the default) | 0 | 0.108 |
| Per message | 8.99 (36 times the budget) | 2.32 |

## Attribution

`examples/support/suspects.test.mjs` adds six unrelated deploys a day at random times and asks
`suspectsFor` about each incident's first alert, 40 times:

- The release behind each of the two release-caused incidents (Android sign-in, iOS photo
  crash) was the confident first suspect in 40 of 40 draws.
- The invoice bug's deploy had no scope, so only timing could point to it. It came first in 14
  of 40 draws and was never called confident. The test asserts no confident wrong answer and
  between 8 and 20 right.

Every planted cause shipped within 2 hours of its incident, which flatters timing.

## Scale

A tick used to read every event of its lookback into Node (17 days with the default monitors)
and count in JavaScript. It now sends the store a few counts and reads back only the events it
alerts on and the few each notice quotes. Measured with `bench/watch.mjs` on 2026-11-22, on a
MacBook Pro with an M1 Pro (10 cores, 16 GB) that other work was also using, Node 24.22:

- **The stream:** 17 days of synthetic support messages at the volume a week shown, 21 signals,
  a customer on every message (a quarter as many customers as messages a week), two tags, 60
  unrelated deploys and one release that breaks something in the last 3 hours
  (`bench/stream.mjs`).
- **The watch:** 125 monitors (every signal at three windows, bug reports and frustration per
  area, volume, one-event leaks), one tick at the end of the stream, with suspects and examples
  for every alert it fires.
- **Before:** the same tick on the code before this change (commit `f8f2f9a`), over
  `memoryStore`. A database store then had to return every event in the lookback, as the
  memory store did.
- **Stores:** Postgres 17 (a local server, through `pg`), SQLite through `node:sqlite` (a file,
  WAL), DuckDB 1.4 through `@duckdb/node-api` (a file), and PGlite 0.5 (Postgres in
  WebAssembly, the test database). Each database tick ran in a fresh process that had done
  nothing else, as a cron job would.

One tick, in seconds:

| Messages a week | Events in store | Before: memory | After: memory | Postgres | SQLite | DuckDB | PGlite |
|---|---|---|---|---|---|---|---|
| 50k | 121,428 | 1.3 s | 0.3 s | 0.6 s | 2.5 s | 0.7 s | 3.7 s |
| 200k | 485,714 | 7.3 s | 1.4 s | 2.6 s | 12 s | 1.4 s | 18 s |
| 500k | 1,214,285 | 27 s | 4.1 s | 6.6 s | 32 s | 2.4 s | 55 s |
| 2M | 4,857,142 | not run: the events alone took 4.9 GB of heap | 29 s | 40 s | 162 s | 10 s | not run |

Memory: for the in-memory store, the heap its events take and how far the heap grew during the
tick; for the databases, the peak memory of the process that ran the tick:

| Messages a week | Before: memory heap (data / tick) | After: memory heap (data / tick) | Postgres tick process | SQLite tick process | DuckDB tick process |
|---|---|---|---|---|---|
| 50k | 122 / +17 MB | 130 / +7 MB | 102 MB | 215 MB | 391 MB |
| 200k | 460 / +165 MB | 488 / +17 MB | 98 MB | 519 MB | 918 MB |
| 500k | 1158 / +1075 MB | 1228 / +28 MB | 96 MB | 716 MB | 1613 MB |
| 2M | not run | 4927 / +300 MB | 98 MB | 627 MB | 2776 MB |

Rows the tick read back into Node, and alerts it raised:

| Messages a week | Before (any store) | After: count rows + events (any store) | Alerts fired |
|---|---|---|---|
| 50k | 121,428 | 400 + 10 | 3 |
| 200k | 485,714 | 489 + 24 | 8 |
| 500k | 1,214,285 | 489 + 57 | 21 |
| 2M | 4,857,142 (every event in the lookback) | 489 + 154 | 63 |

Filling the store, events a second, in batches of 2,000 through `append`:

| Messages a week | Postgres | SQLite | DuckDB | PGlite |
|---|---|---|---|---|
| 50k | 42k | 32k | 43k | 30k |
| 200k | 36k | 22k | 40k | 28k |
| 500k | 39k | 15k | 37k | 24k |
| 2M | 37k | 9k | 37k |  |

Every run raised the same alerts as the code before the change, with the release first among
the suspects. The number of alerts grows with volume (more messages give the tests more power on
the same planted rise), and with it the events read for examples and the counts for suspects.

The tables above were measured just before stores gained the `partition` column. Rerun after it
at 200k a week, the database ticks were within 5% of the table: Postgres 2.65 s, SQLite 12.0 s,
DuckDB 1.5 s.

**Workspaces.** The same stream at 500k a week split across 50 workspaces, in one Postgres
store, with one workspace's watch ticking (`where: { workspace }`): 1.13 s without `partition`,
when every count reads every workspace's events in its windows, and 0.47 s with it.

What this shows:

- **Rows to Node no longer grow with volume.** Before, a tick read every event of its lookback: 121,428 at
  50k messages a week, 4.86 million at 2M. Now it reads one row per counted window (400 to 489)
  and the events it alerts on or quotes (10 to 154, at most three per alert), whatever the store.
- **The process running a database tick stays small.** A fresh process ticking over Postgres peaked at
  96 to 102 MB at every volume. SQLite and DuckDB run inside the process, so their caches count
  too: up to 716 MB for SQLite, and 2.8 GB for DuckDB at 2M, which its own `memory_limit` caps.
- **The database's work grows with volume.** Each tick counts its lookback again. Postgres took 0.6 s at 50k and 40 s at 2M;
  DuckDB, which is columnar, 0.7 s and 10 s; SQLite, which reads each event's JSON in one
  thread, 2.5 s and 162 s. PGlite is Postgres compiled to WebAssembly, in one thread: 55 s at
  500k, and for tests only. SQLite and DuckDB have since stopped reading JSON to count
  ([below](#counting-from-hits)): at 2M, DuckDB now takes 1.6 s and SQLite 111 s.
- **The memory store still holds everything.** Its tick is four to seven times faster than before, but
  its events take 1.2 GB of heap at 500k a week. It is for tests and development.

### Counting from hits

SQLite and DuckDB keep JSON as text, so the counts above parsed every event's signals once per
signal, 21 times per event at every tick. Each answer at or above a floor (0.05) is now also
kept as a narrow row in a hits table, and counts read those instead
([reference](reference.md#stores)). Measured with `bench/watch.mjs` on 2026-11-25 on the same
laptop, stream and watch as above, Node 24.22, each store filled by one process and ticked by a
fresh one. Before is the code just before the change (commit `420030b`), rerun the same day:

| Store | Messages a week | Tick before | Tick after | Filling before | Filling after | On disk before | On disk after |
|---|---|---|---|---|---|---|---|
| DuckDB | 500k | 2.4 s | 0.56 s | 39.9k/s | 30.1k/s | 184 MB | 206 MB |
| DuckDB | 2M | 9.9 s | 1.6 s | 38.6k/s | 25.8k/s | 691 MB | 755 MB |
| SQLite | 500k | 29.8 s | 16.9 s | 18.6k/s | 13.8k/s | 993 MB | 1,494 MB |
| SQLite | 2M | 148.8 s | 111 s | 11.7k/s | 9.3k/s | 3,983 MB | 5,998 MB |
| Postgres | 500k | 6.3 s | 6.5 s | 43.7k/s | 44.1k/s | 1,342 MB | 1,342 MB |
| Postgres | 2M | 34.9 s | 33.9 s | 38.0k/s | 39.7k/s | 5,387 MB | 5,387 MB |

Filling is events a second through `append`; on disk is the database file (SQLite with its WAL),
or for Postgres the tables with their indexes and TOAST. Every run raised the same alerts as
before (21 at 500k, 63 at 2M), with the release first among the suspects.

- **DuckDB: 6 times faster at 2M, in less memory.** The process that ticked peaked at 1.3 GB
  against 2.7 GB. On a 2M store migrated from before hits, counting from hits took a tick from
  8.0 s (the old count, from JSON) to 3.9 s, and ORing each customer's signals into one integer
  per window (`bit_or`) instead of keeping one aggregate per signal took it to 1.8 s. Counting
  from JSON with `bit_or` took 6.3 s. Filling is slower, as each `append` is one transaction that
  also expands the new events' hits: a quarter slower at 500k, a third at 2M.
- **SQLite: 1.8 times faster at 500k and a third faster at 2M, half again as big.** At 500k, on a
  store migrated from before hits, looking each event's hits up by index took a tick from 29.8 s
  to 20.0 s (joining them all at once, 22.6 s); a count index that holds `unit`, so a count never
  reads the events themselves, to 17.4 s; and working out a count's windows once instead of once
  per event, to 12.8 s. A store filled with hits as events arrive ticked slower: 16.9 s at 500k and 111 s at 2M,
  against 12.8 s and 83 s for the same events given their hits by `migrate()` in one pass, as the
  triggers interleave the pages of the events, the hits and their indexes. `VACUUM`, which
  rewrites the file in order (28 s at 500k), took a copy of the filled 500k store from 20.5 s to
  11.9 s. What is left is SQLite sorting customers into windows in one thread. Filling is a
  quarter slower at 500k and a fifth at 2M (a trigger expands each event's hits), and the hits
  and their two indexes add half again to the file.
- **Postgres keeps jsonb, and no hits.** jsonb is stored binary and read by parallel workers, so
  hits made it slower. On the 2M store, a tick took 35.8 s from jsonb and 43.7 s with hits joined
  in, its largest count 22.5 s against 25.5 s, and the reads for a notice's examples 1.0 to 1.3 s
  each against 2.6 to 3.3 s. Of that count's 22.5 s, about 17 s is grouping 7.7 million (window,
  customer) rows into 5.3 million groups, which spills to disk under Postgres's default 4 MB
  `work_mem` (`EXPLAIN ANALYZE`); reading the answers is about 2 s across three workers. At 500k,
  looking each event's hits up by index instead of joining them was slower still (5.2 s against
  4.4 s for the largest count), and `bit_or`, which helps DuckDB, left the 2M count unchanged and
  slowed another from 6.3 s to 12.5 s. A Postgres tick costs what it did before this change.
- **DuckDB 2.0.** The same runs on DuckDB 2.0.1 (2026-11-26, the laptop busier during the 500k
  fill): ticks of 0.54 s at 500k and 1.5 s at 2M, filling at 25.8k and 23.1k events a second,
  and files of 161 MB and 641 MB, smaller than 1.4.5's 206 MB and 755 MB. A store that 1.4.5
  wrote before hits, opened by 2.0.1 and migrated, counted 200 random counts as `countEvents`
  does, and 1.4.5 could still open it after.
- **Moving a store to hits.** `migrate()` builds the hits table from the events already stored, in
  one statement: 2.3 s for DuckDB at 500k and 9.3 s at 2M; 11 s for SQLite at 500k (and 1.4 s to
  replace its count index) and 94 s at 2M, all told.
- **Deleting.** SQLite deletes each event's hits by trigger, row by row, and DuckDB in the same
  transaction as the events. At 500k, deleting the oldest day (71,430 events) took 3.8 s in SQLite
  against 3.3 s before, and 1.9 s in DuckDB as before; forgetting one customer (8 to 10 events)
  took 19 ms against 8 ms in SQLite, and 17 ms against 12 ms in DuckDB.

### Counting the same

Every store gives the same counts as the code before the change, and the watch the same alerts:

- `src/counting.test.mjs` holds the counting engine to the functions the watch used before
  (`latestAnswers`, a view, `count` and `countUnits`, and exposure's grouping by kind) on six
  random histories with customers, missing tags and signals, and copies from three labelers.
- `storeContract` (`open-sentinel/testing`) holds every store's `count`, `events` and `labelers`
  to the reference functions on random histories, with late appends, deletes and keys that break
  naive SQL, and answers and gates at, just under and just over the hit floor, alone and joined
  (`a&b`), from two labelers, in a store split by `partition`. `memoryStore`, `jsonlStore`,
  Postgres (PGlite in the tests, and Postgres 17 through `pg` by hand), SQLite and DuckDB pass it,
  and SQLite and DuckDB refuse a count below their floor.
- For SQLite and DuckDB, `src/stores/sql-checks.mjs` also requires the hits table to hold exactly
  one row for each answer at or above the floor of each stored event, and nothing else: after
  appends, after deletes by age and by customer (a forgotten customer leaves no hits), after an
  append whose hits fail to write (nothing is stored), and after `migrate()` on a store made
  before hits, which then counts as `countEvents` does.
- `src/stores/sql-checks.mjs` runs a watch over the support inbox on each database store, 36
  hourly ticks around two incidents, and requires every tick (alerts, notices, suspects,
  examples) to equal the same watch over `memoryStore`.
- The replay golden tests, the defaults replay and both false-alarm runs (`budget.ts`, 20
  shuffles; `budget.ts 10 repeats`) print exactly what they printed before the change, and a
  byte-for-byte comparison of every alert, suspect ranking, watch notice and investigator tool
  answer on both inboxes and a multi-labeler stream with customers found no difference.
- `src/pipeline.test.mjs` holds a tick over 81,600 events to bounded reads: every events read
  has a limit or a signal filter, and what comes back is the first event, the one-event hits,
  and three examples per alert.

## Labels and quality checks

`examples/customer-messages/gates.test.mjs` runs the quality checks on the 390 labeled messages,
with Claude Opus 5.5 standing in for a person:

- `fitGates` finds the same best gate for all 12 yes/no questions that an earlier study of these
  labels found with separate code. The gates range from 0.3 to 0.9, and agreement beyond chance
  (kappa) at those gates from 0.76 to 1.
- `calibration` gives the same table: of 3,484 checked answers, the 439 at 0.9 or above were
  right 99% of the time; those between 0.7 and 0.8, 53%. Expected calibration error 0.043, Brier
  score 0.034.

`src/quality.test.mjs` checks `correctedRate` on 400 simulated streams: its 95% interval covered
the true rate 93% to 97.5% of the time. On a weighted sample it errs wide, where reading the
weights as counts covered the truth less than 90% of the time.

## Interoperability and packaging

- **OTLP.** The exporter's output loads and round-trips as an `ExportLogsServiceRequest` under
  OpenTelemetry's own message definitions (`src/sinks/otlp.test.mjs`). No real backend has
  received it.
- **MCP.** The official MCP client connects to `bin/mcp.ts`, lists its tools and calls them
  (`src/mcp.test.mjs`).
- **The README's first example** runs end to end with the gateway's reply stubbed
  (`examples/readme.test.mjs`).
- **Installing from git.** Checked by hand on 2026-11-21, not by a test: installing a local
  clone as a git dependency built `dist/` through the `prepare` script, the package imported,
  and `open-sentinel-mcp` answered. npm 11.19 warned about the install script and ran it;
  npm 12.2 needed `--allow-git=root`. Not yet checked against the GitHub repository itself.

The OTLP and MCP-client tests check against two dev dependencies. Without `npm ci` they are
skipped, and say so.

## Live run against real models

`node examples/support/live.ts` calls real models through the Vercel AI Gateway (Jev for labels,
Claude Haiku 5.5 as the second reader, Claude Sonnet 5.5 as the investigator). It needs
`AI_GATEWAY_API_KEY` and costs about 10 cents. Recorded from its last run, on 2026-11-21:

- **Pipeline:** 7 events labeled for $0.00044. Answers within 0.12 of those on file from the
  same model. A redelivery was skipped at no cost.
- **Second reader:** asked about the two answers in its band, and said no to both.
- **Backtest:** a question nobody had asked ("does the invoice their customer received show a
  different total?") over a week of history, 1,640 messages, for $0.025. It said yes 44 times:
  44 of the planted bug's 45 messages and nothing else, all from the day the bug shipped.
- **Investigation:** given the page for that bug, the investigator named the deploy that caused
  it, the right start time and that the app's own totals were correct, in 2 rounds of tool
  calls for $0.07.

## From the prototype study

open-sentinel grew from a prototype tested on the same synthetic data; its code is not in this
repository. These numbers come from it, are all synthetic, and were not rerun on this package.

**Small volume.** A simpler weekly rule (at least 3 complaints, and that many less than 1%
likely at the rate of the 6 weeks before), simulated 2,000 times per volume with a 5% complaint
rate that either stays or doubles:

| Messages a week | False alarms | Doubling caught: Jev at 0.5 / Jev at 0.7 / perfect labels |
|---|---|---|
| 8 | 0 to 1% | 2% / 1% / 2% |
| 25 | 0 to 1% | 5% / 6% / 7% |
| 100 | 1% | 16% / 25% / 33% |

The gap between Jev and perfect labels is label noise. The gap between perfect labels and 100%
is volume, and it is most of it.

**Cost per 1,000 messages,** 12 questions each, on the 390-message sample:

| Labeler | Cost | p50 latency |
|---|---|---|
| Jev 1.14.0, one request | $0.033 | 135 ms |
| Claude Haiku 5.5 | $0.29 | 2.1 s |
| Claude Opus 5.5 | $10.21 | 3.3 s |

On the support inboxes, labeling every message and investigating every page came to about
$0.15 per 1,000 conversations.

**Stability.** The same 100 messages labeled twice: Jev changed 0.4% of its answers, Claude Haiku
at temperature 0 changed 1.3%. Recomputing last month should give last month's numbers.

**Investigator.** On 16 pages and digest items across both inboxes, the prototype's investigator
gave the right verdict (incident or harmless) 16 times and the right cause 15 times, graded by
an LLM judge that saw what was planted.

**Exposure on a flag rollout.** With the invoice bug shipped behind a flag to 10%, 20% and 50% of
customers, an exposed-versus-unexposed monitor caught it in 5%, 10% and 24% of 100 runs. Once a
regular monitor had fired, exposure put the flag first about 80% of the time, against 15% by
timing alone. Exposure is better at naming a change than at catching one.
