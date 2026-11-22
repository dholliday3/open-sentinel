# open-sentinel

Ask a fixed set of typed questions of every piece of text in a stream (support messages,
customer texts, reviews, an AI agent's transcripts). Keep the answers as numbers. Count them,
watch them, and get alerted when they move, the way you would with error rates.

A cheap model reads everything. Plain statistics decide what is unusual. An expensive model
reads only what was flagged.

**Status:** early. Built and tested on synthetic data. Not yet run on real traffic, and not
published to npm. It has no runtime dependencies and runs on Node 22.18 or later. See "What is
verified" and "Limits" below.

## The idea in one page

```ts
import {
  choice, yesNo, score, defineSchema,                          // questions
  decisionLabeler,                                             // a labeler
  jsonlStore, createPipeline,                                  // events in
  shareMonitors, eventMonitor, silenceMonitor, createWatch,    // alerts out
  consoleSink, HOUR,
} from "open-sentinel";

// 1. The questions. Their wording is the schema: change a word and the version changes.
const support = defineSchema({
  name: "support",
  questions: {
    area: choice("Which part of the product is the message about?", { login: "Signing in", billing: "Their plan or charges", other: "Anything else" }),
    is_bug_report: yesNo("Does the customer say something isn't working as it should?"),
    data_exposure: yesNo("Does the customer say they can see another business's information?"),
    frustration: score("How frustrated is the customer?", ["Not at all", "A little", "Clearly", "Furious"]),
  },
});

// 2. Events in. Label each one once, keep the answers.
const store = jsonlStore("./signals");
const pipeline = createPipeline({
  schema: support,
  labeler: decisionLabeler({ model: "typesafe-ai/jev-1.14.0", apiKey: process.env.AI_GATEWAY_API_KEY! }),
  store,
});
await pipeline.ingest([{ id: "msg-1", at: Date.now(), text: "the app logs me out every time", unit: "account-42", tags: { platform: "ios", version: "4.12.0" } }]);

// 3. Alerts out. Call tick() every hour, from a timer or a cron job.
const watch = createWatch({
  schema: support,
  store,
  monitors: [...shareMonitors({ signals: support.signals }), eventMonitor({ signal: "data_exposure" }), silenceMonitor({ windowMs: 3 * HOUR })],
  sinks: [consoleSink()],
});
await watch.tick();
```

A labeled event looks like this:

```json
{ "id": "msg-1", "at": 1795068206120, "unit": "account-42", "tags": { "platform": "ios", "version": "4.12.0" },
  "schema": "support@025328c3e8", "labeler": "typesafe-ai/jev-1.14.0", "probability": "native",
  "signals": { "area=login": 0.97, "area=billing": 0, "area=other": 0.03, "is_bug_report": 0.98, "data_exposure": 0.01, "frustration>=1": 0.9, "frustration>=2": 0.4, "frustration>=3": 0.02 } }
```

Two fields on an event matter more than they look:

- **`unit`** is who wrote it: a customer or account id. Monitors count customers, not messages,
  so one customer sending twenty angry messages is one customer. Leave it out and every
  message counts on its own.
- **`tags`** are what the event was written under: version, platform, plan, flag state. Splits
  and change attribution join on them. Stamp them when the event is written; they can't be
  recovered later.

## The parts

Every stage is a small interface with a built-in implementation. Replace any one without
touching the others.

| Part | What it is | Built in | File |
|---|---|---|---|
| **Schema** | The questions, versioned by their wording | `yesNo`, `choice`, `score`, `defineSchema` | `src/schema.ts` |
| **Labeler** | Answers the questions about one event | `decisionLabeler`, `chatLabeler`, `ruleLabeler` | `src/labeler.ts`, `src/labelers/` |
| **Store** | Keeps labeled events, the change log and the alerting loop's state | `memoryStore`, `jsonlStore` | `src/store.ts`, `src/stores/` |
| **Monitor** | One question asked of the recent past on a schedule | `shareMonitor`, `eventMonitor`, `exposureMonitor`, `volumeMonitor`, `silenceMonitor` | `src/monitor.ts`, `src/monitors.ts` |
| **Change** | Something that shipped: a deploy, a flag, a release, an email | `exposureOf`, `rankChanges`, `suspectsFor` | `src/changes.ts` |
| **Sink** | Where labeled events and alerts go | `consoleSink`, `jsonlSink`, `webhookSink`, `otlpSink` | `src/sinks.ts`, `src/sinks/` |
| **Tool** | What an investigator can ask of the data | `toolsFor`, `investigate`, `mcpServer` | `src/tools.ts`, `src/investigate.ts`, `src/mcp.ts` |

Two loops wire them together, and each is short enough to replace with your own
(`src/pipeline.ts`): `createPipeline` for events in, `createWatch` for alerts out.

Three more modules have no interface to implement. They work on stored events:

- **`src/quality.ts`: is the labeler right?** Agreement with a checked sample, a cutoff per
  question, calibration, the true rate behind a counted one, and a comparison of two labelers.
- **`src/backtest.ts`: try it on the past first.** Ask a new question of stored events, replay
  monitors over them, or move history to a new version of the questions.
- **`src/metrics.ts`: counting.** Shares over time, splits by tag, what moved most.

## How to extend it

**A labeler** is anything that answers typed questions about a state. To use your own
classifier, wrap it:

```ts
import type { Labeler } from "open-sentinel";

const mine: Labeler = {
  id: "my-classifier@2026-11-01",        // stored on every event; change it when the model changes
  probability: "native",                 // "none" if it only gives yes or no
  label: async (state, questions) => {
    const scores = await classify(state, Object.keys(questions));
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: scores[key] }])) };
  },
};
```

**A store** is eight methods. `memoryStore` in `src/store.ts` is the reference, and
`src/store.test.mjs` runs the same tests against every store: add yours to its list.

```ts
import type { Store } from "open-sentinel";

const postgres: Store = {
  append: async (events) => { /* insert ... on conflict (id, schema, labeler) do nothing */ },
  events: async ({ from, to, schema, labeler } = {}) => { /* select ... order by at */ },
  known: async (ids, schema, labeler) => { /* select id ... where id = any($1) */ },
  delete: async ({ before, unit }) => { /* delete ... returning the count */ },
  recordChange: async (change) => { /* upsert by id */ },
  changes: async ({ from, to } = {}) => { /* select ... order by at */ },
  loadState: async (key) => { /* select value where key = $1 */ },
  saveState: async (key, value) => { /* upsert by key */ },
};
```

**A source** is anything you can loop over that yields `{ id, at, text, unit?, tags? }`:

```ts
async function* fromQueue() {
  for await (const job of queue) {
    yield { id: job.id, at: job.receivedAt, text: job.body, unit: job.accountId, tags: { version: job.appVersion } };
  }
}
await pipeline.run(fromQueue());
```

**A sink** has two optional methods. It may throw: what it was owed is kept and offered again,
so it can be told the same thing twice. Every notice has an `id` to tell by.

```ts
import type { Sink } from "open-sentinel";

const slack: Sink = {
  notify: async (notices) => {
    for (const { id, kind, alert, suspects } of notices) {
      await postToSlack(`${kind}: ${alert.monitor}${suspects?.[0] ? ` (possibly ${suspects[0].change.what})` : ""}`, { dedupeKey: id });
    }
  },
};
```

**A monitor** is an object with a `check`. It returns `ok`, `firing` or `no_data`. Its `name`
must be its own: it is what tells one monitor's episodes from another's.

```ts
import type { Monitor } from "open-sentinel";
import { count, DAY } from "open-sentinel";

/** Fires when more than a share of the day's events are bug reports, with no baseline at all. */
const ceiling = (signal: string, share: number): Monitor => ({
  name: `${signal} above ${share * 100}% today`,
  severity: "digest",
  signal,
  windowMs: DAY,
  lookbackMs: DAY,
  tested: false,                         // not a statistical test, so it takes no share of the alarm budget
  check: (view, now, { gates }) => {
    const today = count(view.within({ from: now - DAY, to: now }), signal, gates);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});
```

A `check` may also be asynchronous and ignore the view. That is how a monitor asks a database
for counts when the stream is too large to read into memory:

```ts
const ceilingInSql = (signal: string, share: number): Monitor => ({
  ...ceiling(signal, share),
  check: async (_view, now) => {
    const today = await sql.count("select count(*) filter (where signals ->> $1 >= '0.5') as yes, count(*) as total from events where at >= $2 and at < $3", [signal, now - DAY, now]);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});
```

**A tool** for the investigator or MCP clients is a description, its inputs, and a function.
Add entries to what `toolsFor` returns:

```ts
import type { Tool } from "open-sentinel";

const runbook: Tool = { description: "The runbook for a product area", input: { area: { type: "string", description: "Area name" } }, run: ({ area }) => readRunbook(String(area)) };
const tools = { ...toolsFor({ view, changes }, { signals: support.signals }), runbook };
```

Every snippet on this page is type-checked in `examples/readme.ts`.

## What the built-in parts do

**Questions and signals**

- `yesNo` gives one signal: the probability of yes. `choice` gives one per option
  (`area=login`). `score` gives one per level above the lowest (`frustration>=2`).
- Join two keys with `&` for "both are yes": `is_bug_report&area=login`. `both(a, b)` makes
  every pair.
- `*` is the signal every event has. Counting it counts events.
- A yes/no question is yes at 0.5 unless it has its own `gate`, or you pass fitted `gates`.
  Gates you pass to `createWatch` are added to the schema's own; they don't replace them.

**Labelers**

- `decisionLabeler`: any decision model on the Vercel AI Gateway (27 as of 2026-11-20,
  TypeSafe's Jev among them). Native probabilities, about $0.03 per 1,000 messages for ten
  questions on Jev.
- `chatLabeler`: any chat model behind an OpenAI-compatible endpoint. Hard answers, no
  probabilities.
- `ruleLabeler`: one function per question. For tests, keyword questions, and your own models.
- `cached(labeler)`: asks once for each distinct text, including when the same text arrives
  twice at the same moment.
- `second` (an option of the pipeline): a second reader for yes/no answers in a band, stored as
  `<key>.second`. Use it for questions that page on one event.
- `redact`: runs on the text, and on every string in the event's `context`, before the
  labeler, the store or any sink sees them. `redactBasics` covers card numbers, US social
  security and phone numbers, and email addresses. It is a floor: names and addresses pass.

**The pipeline** (`createPipeline`)

- An event already stored under the same schema and labeler is skipped, so a source may
  deliver twice.
- An event the labeler can't answer is not stored and comes back in `failed`. The rest of the
  batch goes through. Send it again to try again.
- `run(source)` sends a batch when it holds 50 events or its first event has waited 5 seconds,
  so a quiet stream is still labeled promptly.
- `keepText: false` drops each event's text and context once it is labeled.

**Monitors**

- `shareMonitor`: is a signal's share higher in this window than in its baseline? It counts
  customers when events carry a `unit`, and compares the two periods with Fisher's exact test.
  The baseline is the span before the window (`trailing`) or the same hours in earlier periods
  (`seasonal`, for streams where Monday mornings differ from Sundays). `compare` takes another
  test in place of Fisher's.
- `shareMonitors`: one per signal at three windows. 3 hours and 24 hours page; 3 days goes to a
  digest. Pass `where` to watch one tag value against its own past.
- `eventMonitor`: one event is enough. Pages at 0.9, or lower when a second reader agreed. It
  still pages for an event stored up to `lateMs` (6 hours) after it was written.
- `exposureMonitor`: for a change with a `scope`. Fires when the events the change reached show
  the signal more than the rest, and more than events like them did before the change.
- `volumeMonitor`: total events against the same window a period earlier.
- `silenceMonitor`: nothing arrived where something used to. The other monitors can't see a
  stream that stopped: with no events they have nothing to judge.

**The runner** (`createRunner`, or `createWatch` around it)

- **Alarm budget.** You say how many false alerts a week you accept (default: 0.25 pages,
  1 digest item). The runner splits that over every check every tested monitor makes in a
  week. You never pick a significance level.
- **One alert per episode.** A monitor that keeps firing raises one alert, and a `resolved`
  notice once it has been clear for the rearm time.
- **Planned changes.** A change with `expect` mutes the alerts it predicted and is left out of
  every baseline. Declare a launch email before you send it. An alert that is still firing
  after the planned stretch is raised then.
- **Known incidents.** `watch.exclude(interval)` leaves a confirmed incident out of later
  baselines. A baseline that loses time reaches further back to replace it.
- **Not enough data** is its own answer (`no_data`). `tick` returns which monitors said so. It
  never alerts, and it never ends an episode: not knowing is not the same as being clear.

**Changes**

- Record deploys, flags, releases and emails with `store.recordChange`. Give a change a `scope`
  when only some events are exposed to it: `{ version: "4.12.0" }`, `{ "flag:pdf-v2": "on" }`.
  Mark it `randomized` when who got it was picked at random.
- When an alert fires, `createWatch` attaches the changes most likely behind it, ranked by
  exposure and by timing. It says when it isn't confident.
- Exposure counts as evidence only when the exposed events rose against events like them
  before the change (the same other tags). A group that always complained more gets no blame.
  With no earlier events to compare with, exposure counts only for a `randomized` change.
- On both synthetic inboxes, with six unrelated deploys a day, the release that caused the
  incident was the confident first suspect in 40 of 40 draws. For an incident with no scoped
  change, timing alone put the true cause first in 14 of 40 draws, and never confidently.

**Quality** (run these before trusting a number, and again when the labeler's version changes)

- `auditSample`: picks events for a person to check, some from each band of probability.
- `agreement`: precision, recall and agreement beyond chance, per signal.
- `fitGates`: sets each signal's cutoff from the checked sample, for best agreement or for a
  target precision.
- `calibration`: do the probabilities mean what they say?
- `correctedRate`: the true rate behind a counted one, with an interval.
- `compareLabelers`: the same events under two labelers. Which metrics will jump on switch day?

**Backtesting**

- `backtestQuestion`: asks one new question of stored events and shows its counts by day and
  its surest examples.
- `backtestMonitors`: replays monitors over stored events. How often would they have paged?
- `relabel`: labels stored events again under a new schema or labeler.
- `upgrade`: moves stored events to a new version of their schema. It asks only the questions
  that are new or reworded and keeps every other answer.

**Sinks**

- `otlpSink`: OpenTelemetry logs over OTLP/HTTP JSON. Each signal is a number attribute
  (`signal.<key>`), each tag its own attribute. Text is left out unless `includeText` is set.
- `webhookSink`, `jsonlSink`, `consoleSink`.

**Investigation**

- `toolsFor`: six tools over the data: a signal over time, what moved most, a split by tag, the
  messages themselves, the change log, and ranked suspects.
- `investigate`: gives a group of alerts and those tools to a chat model and returns a report:
  verdict (incident, watch, benign, noise or inconclusive), what people report, who is
  affected, when it started, the likely cause, and the next step. A reply without one of the
  five verdicts comes back as inconclusive.
- `mcpServer` and `bin/mcp.ts`: the same tools for any MCP client.

  ```bash
  node bin/mcp.ts ./signals
  ```

## When something fails

Something that pages people has to be clear about what it does on a bad day.

| What happens | What the SDK does |
|---|---|
| The labeler can't answer one event | The event is not stored and is listed in `failed`. The rest of the batch is stored. |
| The store is down | `ingest` and `tick` throw. Send the batch again and call `tick` again: nothing is lost and nothing is stored twice. If the store fails right after a notice went out, that notice is sent again, with the same `id`. |
| A sink throws | The others still get theirs. The failed one is offered the same items again, with anything newer, on the next batch or tick. `undelivered` says which sink and why. |
| The process restarts | Open episodes, events already alerted on and undelivered notices are in the store (`saveState`). A cron job that starts fresh for every tick works. |
| The process dies while sending | A notice is saved before it is sent, so it is sent again. Delivery is at least once. |
| An event is stored late | A one-event monitor still pages for it, up to `lateMs` after it was written. Share monitors count it from the next tick. |
| The stream stops | `silenceMonitor` fires. Share monitors say `no_data`, and open episodes stay open. |
| You reword a question | The schema's version changes, and monitors on the new version start with no baseline. `upgrade` moves history across for the cost of the changed questions only. |
| You change the labeler | Run `compareLabelers` first. The watch counts each event once and tells you (`mixedLabelers`) when its window holds answers from more than one labeler. Pass `labeler` to count only one. |
| A customer asks to be forgotten | `store.delete({ unit })`. The watch reads the store fresh on every tick, so its counts drop them at once. What a sink was already sent is yours to delete. |

Undelivered labeled events are held in memory (10,000 at most), not in the store: a process
that dies loses them, and a metrics backend is then filled again from the store.

Run each watch in one place. Two processes ticking the same watch over the same store will
both alert, and will overwrite each other's state.

## Rules the design holds to

1. **The wording is the schema.** A reworded question is a new version, and the watch reads
   one version. What the labeler is shown (`state`) is not part of the version: change it and
   you must change the schema's name.
2. **Pin the labeler's version.** An alias that moves changes your metrics silently.
3. **Keep probabilities, apply cutoffs later.** Cutoffs can then be refitted without relabeling.
4. **Count customers, and compare two samples.** A baseline week is a sample too, and one
   customer's ten messages are one customer.
5. **Budget false alerts, don't pick significance levels.**
6. **One event pages only at a high cutoff.** Below 0.9, only when a second reader agrees. Text
   inside a message can sway a labeler.
7. **A suspect is a lead, not a verdict.** Ranking says when it isn't confident, never claims a
   cause from timing alone for a single event or a slow shift, and doesn't count exposure
   without a "before".
8. **Redact before anything leaves.** And keep text only if you may: without it, nothing can be
   relabeled or backtested.
9. **Not knowing is not the same as being clear.** Too little data never resolves an alert, an
   unanswered event is never stored as a no, and a sink that failed is still owed.

## What is verified

Run on 2026-11-21. All data is synthetic except where noted.

| Claim | How it was checked |
|---|---|
| Each module does what its tests say | 160 tests, `npm test`, no network. Run on Node 22.23 and 24.22 |
| Replays are stable | Replaying both synthetic inboxes raises exactly the alerts on record from the prototype this package grew from, monitor for monitor and hour for hour, with that prototype's comparison passed in (`examples/support/replay.test.mjs`) |
| Defaults work without hand-picked cutoffs | On both inboxes, with Fisher's test and budget cutoffs: every planted incident raised, no false pages or digest items, launch emails muted when declared (`examples/support/defaults.test.mjs`) |
| The alarm budget holds when customers are independent | The main inbox with every planted item removed, shuffled 20 times (37 weeks in all, where any alert is false): 0.027 false pages a week against a budget of 0.25, and 0.108 false digest items a week against a budget of 1 (`examples/support/budget.ts`) |
| Counting customers keeps the budget when they write more than once | The same data, with three in ten arrivals followed by one to four more from the same customer, shuffled 10 times (19 weeks). Counted per customer: no false pages, and 0.054 false digest items a week. Counted per message: 9 false pages a week, 36 times the budget (`node examples/support/budget.ts 10 repeats`) |
| Attribution names the right release | With six unrelated deploys a day, the release behind each of the two release-caused incidents was the confident first suspect in 40 of 40 draws. An incident with no scoped change was never pinned confidently on any deploy, right or wrong (`examples/support/suspects.test.mjs`) |
| Quality checks give real numbers | On 390 synthetic messages labeled by Jev and by Claude Opus: the same best cutoff for all 12 questions and the same calibration table that an earlier study of those labels worked out with separate code (`examples/customer-messages/gates.test.mjs`) |
| `correctedRate`'s interval is honest | A 95% interval covered the true rate in 93% to 97.5% of 400 simulated streams. On a weighted sample it errs wide, where reading the weights as counts covered the truth less than 90% of the time (`src/quality.test.mjs`) |
| The exporter's output is valid OTLP | It loads and round-trips as an `ExportLogsServiceRequest` under OpenTelemetry's own message definitions |
| The MCP server interoperates | The official MCP client connects to `bin/mcp.ts`, lists its tools and calls them |
| The package installs | Built with `npm run build` and imported from a `node_modules` folder, with the MCP server run from its built file. Checked by hand; no test holds it |
| It works against real models | `examples/support/live.ts`: see below |

The OTLP and MCP-client tests check against two dev dependencies. Without `npm install` they
are skipped, and say so.

The live run, against TypeSafe's Jev and Claude through the Vercel AI Gateway:

- **Pipeline:** 7 events labeled for $0.00044. Answers within 0.12 of those on file from the
  same model. A redelivery was skipped at no cost.
- **Second reader:** asked about the two answers in its band, and said no to both.
- **Backtest:** a question nobody had asked ("does the invoice their customer received show a
  different total?") run over a week of history, 1,640 events, for $0.025. It said yes 44
  times: 44 of the planted bug's 45 messages and nothing else, all from the day the bug shipped.
- **Investigation:** given the page for that bug, Claude Sonnet named the deploy that caused
  it, the right start time and that the app's own totals were correct, in 2 rounds of tool
  calls for $0.07.

## Limits

- **Real data.** Not tried. Synthetic incidents describe themselves more clearly than real
  customers do.
- **The alarm budget assumes the things counted are independent.** Counting customers handles
  one customer writing twice. It does not handle customers who move together for a reason
  outside your product: a storm, a holiday, a news story. Those are real shifts, and they alert.
- **Scale.** The watch reads every event its monitors look back over on each tick (17 days
  with the default monitors), and `jsonlStore` holds everything in memory. That suits tens of
  thousands of events a week. The `Store` interface has no way to ask for counts, so beyond
  that a monitor has to ask your database itself (see "A monitor").
- **Exposure needs volume.** On a few hundred events a day it sees only large effects.
- **A real OTLP backend.** The payload is valid; nothing has received it.
- **Seasonal baselines on real rhythms.** Tested on made-up weekly patterns only.

## What isn't here

- **Connectors.** No helpdesk, SMS or email integrations. A connector is a function that yields
  events (see "A source"); none are written.
- **A database store.** The interface is eight methods; only memory and files implement it.
- **Rate correction inside monitors.** `correctedRate` is for numbers you report. Monitors
  compare raw counts under one labeler, where a steady error mostly cancels.
- **Finding topics nobody asked about.** Broad questions plus splits by tag caught unnamed bugs
  in testing. Clustering what lands in "other" would do it directly, and is not built.
- **Alert routing, on-call and dashboards.** Export to the tools that already do these.

## Running it

```bash
npm install                            # dev tools only: TypeScript, and two packages the tests check against
npm test                               # every test; about 30 seconds, no network
npm run type-check
npm run build                          # JavaScript and type declarations in dist/, for publishing
node examples/support/replay.ts        # both synthetic inboxes with the defaults; no network
node examples/support/budget.ts        # false alerts on shuffled incident-free data
node examples/support/live.ts          # real models; needs AI_GATEWAY_API_KEY, costs about 10 cents
```

The tests and examples run the TypeScript in `src/` directly, which Node does for files outside
`node_modules`. An installed copy is used from `dist/`, which `npm run build` writes.

## The example data

The examples and several tests run on data in `examples/`, all of it synthetic: every message
was written by a model to a brief, and none is from a real customer.

- `examples/support/data/`: two support inboxes, three weeks and about 4,500 conversations
  each, with incidents planted on known days (`truth.json` says which). They are written as the
  inbox of Acme, a made-up software product for home-service businesses, and were labeled by
  TypeSafe's Jev 1.14.0.
- `examples/customer-messages/data/`: labels for 390 messages, 338 from customers to a
  home-service business and 52 from its owner to the assistant, each labeled by Jev and by
  Claude Opus as the reference. The messages' text is not included.

The product and its AI assistant (Remy) were renamed after labeling, in the questions and the
messages alike. No other word changed.
