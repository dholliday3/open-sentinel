# Reference

What each built-in part does, and how to write your own. The README has the overview; the
statistics behind the monitors are in [statistics.md](statistics.md). Every snippet here has a
type-checked counterpart in [`examples/readme.ts`](../examples/readme.ts).

## The parts

| Part | What it is | Built in | File |
|---|---|---|---|
| Schema | The questions, versioned by their wording | `yesNo`, `choice`, `score`, `defineSchema`, `both` | `src/schema.ts` |
| Labeler | Answers the questions about one event | `decisionLabeler`, `chatLabeler`, `ruleLabeler`, `cached` | `src/labeler.ts`, `src/labelers/` |
| Store | Keeps labeled events, the change log and the watch's state | `memoryStore`, `jsonlStore` | `src/store.ts`, `src/stores/` |
| Monitor | One question asked of the recent past on a schedule | `shareMonitor(s)`, `eventMonitor`, `exposureMonitor`, `volumeMonitor`, `silenceMonitor` | `src/monitor.ts`, `src/monitors.ts` |
| Change | Something that shipped: a deploy, a flag, a release, an email | `exposureOf`, `rankChanges`, `suspectsFor` | `src/changes.ts` |
| Sink | Where labeled events and alerts go | `consoleSink`, `jsonlSink`, `webhookSink`, `otlpSink` | `src/sinks.ts`, `src/sinks/` |
| Tool | What an investigator can ask of the data | `toolsFor`, `investigate`, `mcpServer` | `src/tools.ts`, `src/investigate.ts`, `src/mcp.ts` |

Two loops wire them together, each short enough to replace with your own (`src/pipeline.ts`):
`createPipeline` for events in, `createWatch` for alerts out. Three more modules work on stored
events and have no interface to implement: `src/quality.ts` (is the labeler right?),
`src/backtest.ts` (try it on the past first) and `src/metrics.ts` (counting).

## A labeled event

```json
{ "id": "msg-1", "at": 1795330290444, "text": "I can see another company's customers in my account",
  "unit": "account-42", "tags": { "version": "4.12.0" },
  "schema": "support@eaaa25a4e2", "labeler": "typesafe-ai/jev-1.14.0", "probability": "native",
  "signals": { "area=login": 0.02, "area=billing": 0.03, "area=other": 0.95, "is_bug_report": 0.4, "data_exposure": 0.96 } }
```

- **`unit`** is who wrote it: a customer or account id. Monitors count customers, not messages,
  so one customer sending twenty angry messages counts once. Leave it out and every message
  counts on its own.
- **`tags`** are what the event was written under: version, platform, plan, flag state
  (`flag:<key>`). Splits and change attribution join on them. Stamp them when the event is
  written; they can't be recovered later.
- **`schema`** is `<name>@<version>`, a hash of the questions' wording. **`labeler`** is the
  model and its exact version. **`probability`** says whether the numbers are the model's own
  (`native`), its guess (`prompted`) or hard answers (`none`).

## Questions and signals

- `yesNo` gives one signal: the probability of yes. `choice` gives one per option
  (`area=login`). `score` gives one per level above the lowest (`frustration>=2`).
- Join two keys with `&` for "both are yes": `is_bug_report&area=login`. `both(a, b)` makes
  every pair.
- `*` is the signal every event has. Counting it counts events.
- `parseSignal` splits a key into its parts (question, option, level, second reading);
  `describeSignal(schema, key)` reads it back in the schema's words, as notices do.
- A yes/no question is yes at 0.5 unless it has its own `gate`, or you pass fitted `gates`.
  Gates passed to `createWatch` are added to the schema's own; they don't replace them.
- `state` chooses what the labeler sees: by default the event's `context` plus its text as
  `message`. It is not part of the version. If you change it, change the schema's name too.

## Labelers

- `decisionLabeler`: any decision model on the Vercel AI Gateway (27 listed as of 2026-11-20,
  `typesafe-ai/jev-1.14.0` among them). Native probabilities. About $0.03 per 1,000 messages for
  ten questions on Jev. Give `model` an exact version: an unversioned id can change models.
- `chatLabeler`: any chat model behind an OpenAI-compatible endpoint. Hard answers, no
  probabilities.
- `ruleLabeler`: one function per question. For tests, keyword questions, and your own models.
- `cached(labeler)`: asks once for each distinct text, including when the same text arrives
  twice at the same moment.
- `second` (a pipeline option): a second reader for yes/no answers in a band, stored as
  `<key>.second`. Use it for questions that page on one event.
- `redact` (a pipeline option): runs on the text, and on every string in the event's `context`,
  before the labeler, the store or any sink sees them. `redactBasics` covers card numbers, US
  social security and phone numbers, and email addresses. It is a floor: names and addresses
  pass through.

## The pipeline (`createPipeline`)

- An event already stored under the same schema and labeler is skipped, so a source may
  deliver twice.
- An event the labeler can't answer is not stored and comes back in `failed`. The rest of the
  batch goes through. Send it again to try again.
- `run(source)` sends a batch when it holds 50 events or its first event has waited 5 seconds,
  so a quiet stream is still labeled promptly.
- `keepText: false` drops each event's text and context once it is labeled. Nothing can then be
  relabeled or backtested.

## Monitors

- `shareMonitor`: is a signal's share higher in this window than in its baseline? Counts
  customers when events carry a `unit`. The baseline is the span before the window
  (`trailing`, a week by default, rounded up to whole windows) or the same hours in earlier
  periods (`seasonal`), counted in stretches exactly as long as the window. `compare` takes
  another test in place of Fisher's. `where` watches one tag value against its own past.
- `shareMonitors`: one per signal at three windows. 3 hours (at least 5 customers) and 24 hours
  (at least 8) page; 3 days (at least 10) goes to a digest.
- `eventMonitor`: one event is enough. Pages at 0.9, or from `second.from` when a second reader
  agreed. Still pages for an event stored up to `lateMs` (6 hours) after it was written.
- `exposureMonitor`: for a change with a `scope`. Fires when the events the change reached show
  the signal more than the rest, and more than events like them did before the change.
- `volumeMonitor`: total events against the same window a period earlier (twice as many, and at
  least 20). It can't tell a launch from an outage.
- `silenceMonitor`: nothing arrived where something used to. Share monitors can't see a stream
  that stopped: with no events they have nothing to judge.

## The watch (`createWatch`, around `createRunner`)

- **Alarm budget.** False alerts you accept per week, by severity (default 0.25 pages and 1
  digest item), split over every check every tested monitor makes in a week. `watch.alphas()`
  shows the cutoff each monitor got.
- **One alert per episode.** A monitor that keeps firing raises one alert, and a `resolved`
  notice once it has been clear for the rearm time (12 hours for pages, 3 days for digests).
  An alert's id names its monitor and the step it fired in (or, for one event, the event), so a
  tick that runs twice in one step raises the same ids.
- **Planned changes.** A change with `expect` mutes the alerts it predicted and is left out of
  every baseline. An alert still firing after the planned stretch is raised then.
- **Known incidents.** `watch.exclude(interval)` leaves a confirmed incident out of later
  baselines. Any baseline stretch it touches is left out whole; a trailing baseline reaches
  further back to replace it.
- **Not enough data** is its own answer (`no_data`). `tick` returns which monitors said so. It
  never alerts and never ends an episode.
- **Mixed labelers.** The watch counts each event once and reports `mixedLabelers` when its
  window holds answers from more than one labeler. Pass `labeler` to count only one.
- `groupAlerts` groups pages within 4 hours of each other, and digest items within a day, the
  way on-call tools group alerts into cases.

## Changes and suspects

- Record deploys, flags, releases and emails with `store.recordChange`. Give a change a `scope`
  when only some events are exposed to it: `{ version: "4.12.0" }`, `{ "flag:pdf-v2": "on" }`.
  Mark it `randomized` when who got it was picked at random.
- When an alert fires, `createWatch` attaches up to three suspects, ranked by exposure and by
  timing, and a `confident` flag. How they're ranked: [statistics.md](statistics.md#suspects).

## Quality

Run these before trusting a number, and again when the labeler's version changes.

- `auditSample`: picks events for a person to check, some from each band of probability, with
  weights that undo the over-picking.
- `agreement`: precision, recall and agreement beyond chance (kappa), per signal.
- `fitGates`: sets each signal's cutoff from the checked sample, for best agreement or for a
  target precision.
- `calibration`: do the probabilities mean what they say?
- `correctedRate`: the true rate behind a counted one, with an interval.
- `compareLabelers`: the same events under two labelers. Which metrics will jump on switch day?

## Backtesting

- `backtestQuestion`: asks one new question of stored events and shows its counts by day and
  its surest examples.
- `backtestMonitors`: replays monitors over stored events. How often would they have paged?
- `relabel`: labels stored events again under a new schema or labeler.
- `upgrade`: moves stored events to a new version of their schema. It asks only the questions
  that are new or reworded and keeps every other answer.

## Sinks

- `otlpSink`: OpenTelemetry logs over OTLP/HTTP JSON. Each signal is a number attribute
  (`signal.<key>`), each tag its own attribute. Text is left out unless `includeText` is set.
- `webhookSink`: POSTs `{ notices }`, and `{ events }` with `events: true`.
- `jsonlSink`: appends every event and notice to a file. `consoleSink`: one line per notice.

Every notice carries `schema` (`<name>@<version>`) and `question`, the alert's signal in the
schema's own words. A fired notice also carries up to three `examples`, `{ id, at, text }`: for
a one-event alert the event itself, otherwise the surest yeses in the alert's window, one per
customer. Their text is as stored, so after `redact`, and absent when text isn't kept.
`createWatch({ examples: 0 })` keeps message text out of notices altogether. `webhookSink` and
`jsonlSink` pass all of it on; `otlpSink` sends the question and the examples' ids, and their
text only with `includeText`.

## Investigation

- `toolsFor`: six tools over the data: a signal over time, what moved most, a split by tag, the
  messages themselves, the change log, and ranked suspects.
- `investigate`: gives a group of alerts and those tools to a chat model and returns a report:
  a verdict (incident, watch, benign, noise or inconclusive), what people report, who is
  affected, when it started, the likely cause, and the next step. A reply without one of the
  five verdicts comes back as inconclusive.
- `mcpServer`, and the `open-sentinel-mcp` command over a `jsonlStore` folder, serve the same
  tools to any MCP client. The command sees what a pipeline writing the folder adds, because a
  `jsonlStore` reads its files again whenever they have changed:

  ```bash
  npx open-sentinel-mcp ./signals      # from an install
  node bin/mcp.ts ./signals            # from a clone
  ```

## Writing your own

**A labeler** is anything that answers typed questions about a state:

```ts
import type { Labeler } from "open-sentinel";

const mine: Labeler = {
  id: "my-classifier@2026-11-01",
  probability: "native",
  label: async (state, questions) => {
    const scores = await classify(state, Object.keys(questions));
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: scores[key] }])) };
  },
};
```

`id` is stored on every event: change it when the model changes. Use `probability: "none"` if it
only gives yes or no.

**A store** is eight methods. `memoryStore` in `src/store.ts` is the reference.
`storeContract` from `open-sentinel/testing` is what every store must do, as checks for any test
runner on Node; `make` must give an empty store each time. The built-in stores run it in
`src/store.test.mjs`.

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

```ts
import { test } from "node:test";
import { storeContract } from "open-sentinel/testing";

for (const { name, run } of storeContract(() => freshPostgresStore())) {
  test(`postgres: ${name}`, run);
}
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

**A monitor** is an object with a `check` that returns `ok`, `firing` or `no_data`. Its `name`
must be its own: it is what tells one monitor's episodes from another's. `tested: false` means
it is not a statistical test, so it takes no share of the alarm budget.

```ts
import type { Monitor } from "open-sentinel";
import { count, DAY } from "open-sentinel";

const ceiling = (signal: string, share: number): Monitor => ({
  name: `${signal} above ${share * 100}% today`,
  severity: "digest",
  signal,
  windowMs: DAY,
  lookbackMs: DAY,
  tested: false,
  check: (view, now, { gates }) => {
    const today = count(view.within({ from: now - DAY, to: now }), signal, gates);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});
```

A `check` may be asynchronous and ignore the view. That is how a monitor asks a database for
counts when the stream is too large to read into memory on every tick:

```ts
const ceilingInSql = (signal: string, share: number): Monitor => ({
  ...ceiling(signal, share),
  check: async (_view, now) => {
    const today = await sql.count("select count(*) filter (where signals ->> $1 >= '0.5') as yes, count(*) as total from events where at >= $2 and at < $3", [signal, now - DAY, now]);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});
```

**A tool** for the investigator or MCP clients is a description, its inputs, and a function. Add
entries beside what `toolsFor` returns:

```ts
import type { Tool } from "open-sentinel";

const runbook: Tool = { description: "The runbook for a product area", input: { area: { type: "string", description: "Area name" } }, run: ({ area }) => readRunbook(String(area)) };
const tools = { ...toolsFor({ view, changes }, { signals: support.signals }), runbook };
```
