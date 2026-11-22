# open-sentinel

[![CI](https://github.com/dholliday3/open-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/dholliday3/open-sentinel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Monitors for what people write to you: LLM labels, alerts within a false-alarm budget, and the
change that likely caused them.

**Status:** pre-1.0. Tested on synthetic data only. Not on npm yet.

Some breakage never reaches a dashboard. A PDF renderer that adds tax twice raises no error and
slows nothing down: the first sign is customers writing in to say their invoice is wrong. Nobody
reads every message. A keyword alert can't tell "I'm not disputing the bill" from a dispute. A
rate alert needs volume: in a simulated inbox of 25 messages a week, a doubling of complaints was
caught in 7% of weeks, even with perfect labels.

open-sentinel has a model answer the same typed questions about every message and keeps the
answers as probabilities. It watches their shares the way you would watch error rates, pages on
a single message when one is enough (a data leak, an account takeover), and names the change in
your change log most likely behind a shift.

It is for developers who own a stream of text from people (support chat, customer texts and
emails, reviews, an AI agent's transcripts) and want the alerts in code, next to their own
deploys and data. It is a TypeScript library with no runtime dependencies.

```ts
import { choice, consoleSink, createPipeline, createWatch, decisionLabeler, defineSchema, eventMonitor, HOUR, jsonlStore, shareMonitors, silenceMonitor, yesNo } from "open-sentinel";

const support = defineSchema({
  name: "support",
  questions: {
    area: choice("Which part of the product is the message about?", { login: "Signing in", billing: "Their plan or charges", other: "Anything else" }),
    is_bug_report: yesNo("Does the customer say something isn't working as it should?"),
    data_exposure: yesNo("Does the customer say they can see another business's information?"),
  },
});

const store = jsonlStore("./signals");
const labeler = decisionLabeler({ model: "typesafe-ai/jev-1.14.0", apiKey: process.env.AI_GATEWAY_API_KEY! });
const pipeline = createPipeline({ schema: support, labeler, store });

await pipeline.ingest([
  { id: "msg-1", at: Date.now(), text: "I can see another company's customers in my account", unit: "account-42", tags: { version: "4.12.0" } },
]);

const watch = createWatch({
  schema: support,
  store,
  monitors: [...shareMonitors({ signals: support.signals }), eventMonitor({ signal: "data_exposure" }), silenceMonitor({ windowMs: 3 * HOUR })],
  sinks: [consoleSink()],
});
await watch.tick();
```

Save it as `watch.ts` in a project with `"type": "module"`, set `AI_GATEWAY_API_KEY` to a
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key, and run `node watch.ts`. When the
model puts `data_exposure` at 0.9 or above, that one message pages:

```
2026-11-22T06:51:30.476Z fired page: event: data_exposure (event msg-1)
```

The share monitors answer `no_data` until the week before the window holds enough customers to
compare with (30 by default). Call `watch.tick()` every hour from a timer or a cron job. The
watch keeps its state in the store, so each tick can be a fresh process.

> **What to expect.** The test suite covers every module, and the monitors have been replayed over
> two synthetic support inboxes with planted incidents. Nothing has run on real traffic. Any
> release may change the API. Not built yet: connectors to helpdesks or SMS providers, a
> database store, finding topics nobody wrote a question for, and alert routing (export to the
> tools that already do it). See [docs/limits.md](docs/limits.md).

## Install

```bash
npm install github:dholliday3/open-sentinel
```

- Node 22.18 or later. Type declarations are included.
- npm builds `dist/` from the TypeScript as it installs (the `prepare` script). npm 12 refuses
  git dependencies unless you allow them: add `--allow-git=root`, or put `allow-git=root` in
  your project's `.npmrc`.
- A labeler needs a model. `decisionLabeler` calls a decision model through the Vercel AI
  Gateway, `chatLabeler` any OpenAI-compatible chat endpoint, and `ruleLabeler` plain functions,
  with no model at all.

## How it works

1. **Questions.** A schema is a fixed set of typed questions: `yesNo`, `choice` and `score`. Its
   version is a hash of the wording, so answers to a reworded question are never counted with
   the old ones.
2. **Labels.** The labeler answers every question about each message, as probabilities. Each
   answer becomes a signal: `data_exposure`, `area=login`, `frustration>=2`. The cutoff that
   makes a probability a yes is applied when counting, so it can be refitted without relabeling.
3. **Events.** Each message carries a `unit` (who wrote it) and `tags` (app version, platform,
   plan, flag state). Monitors count customers, not messages, and attribution joins on tags.
4. **Monitors.** On each tick the watch reads the recent past and asks every monitor whether
   something is wrong.
5. **Alarm budget.** You say how many false alerts a week you accept (by default 0.25 pages and 1
   digest item). The watch splits that over every check. You never pick a significance level.
6. **Suspects.** Each alert comes with the recorded changes most likely behind it, ranked by
   exposure and timing, and says when it isn't confident.

| Monitor | Fires when |
|---|---|
| `shareMonitor`, `shareMonitors` | A signal's share of customers is higher in the window than in its baseline. `shareMonitors` makes a 3-hour and a 24-hour page and a 3-day digest item per signal. |
| `eventMonitor` | One message is enough: a probability of 0.9, or lower when a second reader agreed. |
| `exposureMonitor` | Events a change reached show the signal more than the rest, and more than events like them did before. |
| `volumeMonitor` | More than twice as many messages as the same window a week earlier. |
| `silenceMonitor` | Nothing arrived where something used to. |

## Usage

These continue the first example. Import `DAY`, `backtestQuestion`, `auditSample` and `fitGates`
from `open-sentinel` too.

### Record what shipped

```ts
await store.recordChange({ id: "release-4.12.0", at: Date.parse("2026-11-20T15:00:00Z"), kind: "release", what: "mobile 4.12.0: new sign-in library", scope: { version: "4.12.0" } });
await store.recordChange({ id: "price-email", at: Date.now(), kind: "campaign", what: "email about new prices", expect: { signals: ["area=billing", "*"], forMs: 2 * DAY } });
```

`scope` names the tags of the events a change reached. Each alert's notice lists up to three
suspects with their evidence and a `confident` flag. Exposure counts only when the exposed
events rose against events like them before the change, so a group that always complained more
gets no blame. `expect` declares a planned effect: the alerts it predicts are muted, and the
stretch is left out of every baseline.

### Try a question on history before it pages anyone

```ts
const tried = await backtestQuestion({
  events: await store.events({ schema: support.id, from: Date.now() - 7 * DAY }),
  key: "total_differs",
  question: yesNo("Does the customer say an invoice their customer received shows a different total than the app?"),
  labeler,
});
console.log(tried.cost, tried.signals[0]?.byBucket, tried.signals[0]?.surest);
```

Stored events keep their text, so a new question can be asked of all of them before it goes
live. In one live run, a question like this one, asked of a week of synthetic history (1,640
messages), cost $0.025 and said yes to 44 of the planted bug's 45 messages and to nothing else.
`backtestMonitors` replays monitors over history the same way, and `upgrade` moves history to a
reworded schema by asking only the questions that changed.

### Check the labeler before trusting its numbers

```ts
const events = await store.events({ schema: support.id });
const checked = auditSample(events, { signal: "data_exposure" })
  .map(({ event, weight }) => ({ id: event.id, signal: "data_exposure", truth: reviewed(event), weight }));
const { gates } = fitGates(events, checked, { objective: { precision: 0.9 } });
```

`auditSample` picks messages for a person to check, some from each band of probability
(`reviewed` stands for their answer). `fitGates` sets each cutoff from the answers: pass `gates`
to `createWatch`. `calibration`, `correctedRate` and `compareLabelers` answer the next questions:
do the probabilities mean what they say, what true rate is behind a counted one, and which
numbers will jump when you change model versions.

## Adapters and integrations

Every stage is a small interface with built-in implementations. Replace one without touching the
others.

| Part | Built in | Your own |
|---|---|---|
| Labeler | `decisionLabeler` (decision models on the Vercel AI Gateway), `chatLabeler` (OpenAI-compatible chat), `ruleLabeler` (plain functions), `cached` | An object with `id`, `probability` and `label()` |
| Store | `memoryStore`, `jsonlStore` (files, one process) | Eight methods; `src/store.test.mjs` runs the same tests on every store |
| Source | Any iterable or async iterable of `{ id, at, text, unit?, tags? }`; `fromJsonl` | A generator over your queue or helpdesk |
| Sink | `consoleSink`, `jsonlSink`, `webhookSink`, `otlpSink` (OpenTelemetry logs over OTLP/HTTP JSON) | `labeled()`, `notify()`, or both |
| Investigation | `toolsFor` (six tools over the data), `investigate` (a chat model writes a report on a group of alerts), `mcpServer` and the `open-sentinel-mcp` command | More entries beside what `toolsFor` returns |

[docs/reference.md](docs/reference.md) covers each built-in part and how to write your own.

## Guarantees and limits

- **Nothing is lost on a bad day.** An event the labeler can't answer is not stored and comes
  back in `failed`. A sink that throws is offered the same items again later. Notices are saved
  before they're sent, so delivery is at least once, with a stable `id` to deduplicate on. A
  redelivered event is skipped at no cost.
- **Not knowing is not the same as being clear.** Too little data is its own answer
  (`no_data`). It never alerts and never ends an episode.
- **One watch per store.** Two processes ticking the same watch both alert and overwrite each
  other's state.
- **Tens of thousands of events a week, not millions.** Each tick rereads everything its
  monitors look back over (17 days with the defaults), and `jsonlStore` holds it all in memory.
  Past that, write monitors that ask your database for counts.
- **Real data hasn't been tried.** Synthetic incidents describe themselves more clearly than
  real customers do.
- **The alarm budget assumes customers act independently.** A storm or a news story moves many
  at once. That is a real shift, and it alerts.

Details: [guarantees](docs/guarantees.md), [statistics](docs/statistics.md),
[limits](docs/limits.md).

## What has been checked

Two synthetic three-week support inboxes (4,820 and 4,990 messages, written by a model and
labeled by `typesafe-ai/jev-1.14.0`), replayed with the defaults:

- All 9 planted incidents alerted, with no false pages or digest items. Sharp ones paged within
  2 hours. The invoice bug, which drew about one message an hour, paged after 23 hours. Slow
  shifts reached the digest after 2 to 6 days. Two marketing emails, declared as planned
  changes, were muted.
- With every planted item removed and the messages shuffled (20 shuffles, 37 weeks in all),
  there were 0.027 false pages a week against a budget of 0.25.
- With six unrelated deploys a day, the release behind each of the two release-caused incidents
  was the confident first suspect in 40 of 40 draws.

All numbers, their sources and how to rerun them: [docs/evaluation.md](docs/evaluation.md).

## Compared to

- **Keyword alerts** are cheap and predictable. They can't read negation, and they miss any
  problem nobody wrote a keyword for.
- **Feedback analytics and helpdesk spike detection** give support teams dashboards and spike
  alerts over the vendor's topics. Here the questions are code, the results sit beside your own
  events and change log, and each alert names the change that likely caused it.
- **APM and metric monitors** watch errors and latency, which are faster and denser signals. Keep
  them for rollbacks. This is a second net for breakage that raises no error, and `otlpSink`
  sends its events and alerts to the same backends.
- **LLM-observability evaluations** already run typed questions over AI-agent traces and alert
  on the results. If agent transcripts are your only stream, look there first.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and the example replays.

## License

[MIT](LICENSE)
