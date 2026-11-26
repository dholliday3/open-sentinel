# Statistics

How a probability becomes a count, how a count becomes an alert, and how an alert gets a
suspect. The code is in `src/stats.ts`, `src/monitors.ts`, `src/monitor.ts`, `src/changes.ts`
and `src/quality.ts`. Numbers called synthetic come from the data described in
[evaluation.md](evaluation.md).

## From probability to count

The store keeps each answer as a probability. A signal counts as yes for an event when its
probability is at or above the signal's gate: 0.5 by default, a question's own `gate`, or a gate
fitted from a checked sample (`fitGates`). Keeping the probabilities means a gate can be moved
later without asking the model again: on a SQLite or DuckDB store, down to its hit floor (0.05
by default), below which answers aren't kept in a form counts read. A joined key (`a&b`) is yes when
both parts are yes at their own gates.

Gates should be set per question. On 390 synthetic messages checked against a stronger model,
Jev's answers at 0.9 or above were right 99% of the time, while answers between 0.7 and 0.8 were
right 53% of the time (`examples/customer-messages/gates.test.mjs`). The best gate ranged from
0.3 to 0.9 across twelve questions.

## Customers, not messages

When events carry a `unit`, share monitors count each customer once per window: a customer is a
yes if any of their events in the window is. The baseline is counted the same way, in stretches
as long as the window, each customer once per stretch. Counted once over a whole week, a
customer who writes every day would look far more likely to say yes than in any one window.

Every stretch is exactly as long as the window. A customer has fewer chances to say yes in a
shorter stretch, so one cut short reads low and makes an unchanged window look like a rise. A
trailing baseline is therefore its span rounded up to whole windows: a week is 56 three-hour
stretches or seven days, and against a 3-day window it is three 3-day stretches, nine days.
Before this rule the 3-day tier compared with two 3-day stretches and a one-day stub, and a
stream with nothing in it, from a thousand customers who each write every day, raised a digest
item (`src/monitors.test.mjs`). Excluded time cut stretches short the same way, in every tier.

This matters for the alarm budget, which assumes the things counted are independent. One
customer's five messages about one problem are not five independent observations. On shuffled
synthetic data where three in ten arrivals were followed by more from the same customer,
counting messages gave 9 false pages a week against a budget of 0.25. Counting customers gave
none ([evaluation.md](evaluation.md#false-alarms)).

`per: "event"` counts messages instead. Use it only when one writer's messages really are
independent of each other.

## The share test

`shareMonitor` asks: is the signal's share in this window higher than in its baseline? It
compares the two with Fisher's exact test, one-sided. Neither period's rate is treated as known:
a baseline week is a sample too. An earlier version of this design treated the baseline as
exact, and on the synthetic inbox that produced a false digest item a real incident had been
hiding.

- **Window and baseline.** `trailing` compares with the span just before the window (a week by
  default). `seasonal` compares with the same hours one period ago, two periods ago, and so on,
  for streams where Monday mornings differ from Sundays. Seasonal baselines have been tested on
  made-up weekly patterns only.
- **Minimums.** A window with fewer yeses than `minCount` never fires. A baseline with fewer than
  `minBaseline` (30) customers is `no_data`.
- **Exclusions.** Planned changes, confirmed incidents (`watch.exclude`) and, if you turn on
  `excludePagesMs`, a page's own stretch are left out of baselines. A stretch they touch is
  left out whole, not trimmed, for the reason above. So is one that begins before the first
  stored event: a store younger than the baseline hasn't watched that time. A trailing baseline replaces the stretches
  it loses from further back, never reaching more than twice its span; a seasonal baseline
  drops the cycles they touch.

## The alarm budget

You choose how many false alerts a week you accept from chance, per severity. The default is
0.25 pages and 1 digest item. The runner turns that into one cutoff per check:

```
alpha = budget per week / (checks per week × tested monitors of that severity)
```

With hourly ticks there are 168 checks a week, so 100 page monitors each get
0.25 / (168 × 100) ≈ 0.000015. This is a union bound: it holds however the checks overlap and
however the signals correlate. It is conservative, so adding monitors makes each one stricter.
A monitor with its own `alpha` keeps it and takes no share.

What it doesn't cover: counted things that move together for a reason outside your product (a
storm, a holiday, a news story). Those are real shifts, and they alert.

## Episodes

A monitor that keeps firing is one episode and raises one alert. The episode ends when the
monitor has been clear for the rearm time: 12 hours for pages, 3 days for digest items. Then a
`resolved` notice goes out.

`no_data` is neither firing nor clear. It never raises an alert, and time without data doesn't
count toward ending an episode.

## One-event pages

`eventMonitor` pages on a single event at 0.9. Below that, a decision model's answers run high:
on the synthetic sample above, answers between 0.5 and 0.9 were right less often than their
probability said. So an event between `second.from` and 0.9 pages only when a second reader,
asked about that question alone, agreed. Text inside a message can also sway a labeler, which
is another reason one message must clear a high bar.

The runner alerts on each event once. The monitor keeps looking back `lateMs` (6 hours), so an
event stored after the check that covered its time still pages. A backfill of older history
stays quiet.

## Exposure

`exposureOf` compares the events a scoped change reached with the rest, since the change:

- **Contrast.** Is the signal more common among exposed events than unexposed ones? Fisher's
  test again, counting customers.
- **Rise.** Is it more common among exposed events than among events like them before the
  change? "Like them" means sharing every other tag, so iOS events are compared with earlier iOS
  events. If the scope's tags existed before (a platform), the comparison is with that group's
  own past; if not (a new version), with all earlier events. Earlier time is counted in whole
  stretches as long as the time since the change, as many as fit in the week before it, so a
  change more than a week old has no "before". Kinds with fewer than 5 earlier events are
  skipped, and at least half the exposed events need a kind to compare with.

The evidence is the weaker of the two. Without a rise to check, contrast counts only for a
change marked `randomized`, because otherwise the exposed group may simply be a different kind
of customer. A group that always complained more shows no rise and gets no blame.

## Suspects

When an alert fires, `suspectsFor` ranks the recorded changes:

1. **When did the shift begin?** `estimateOnset` tries every hour in the lookback as a split
   point and scores how well "one rate before, a higher rate after" explains the counts. The
   result is a spread of likely start times, wide for a slow ramp. For a one-event alert, the
   start is the event.
2. **Time.** Each change scores by how much of that spread it precedes, halved for every 6
   hours it came before.
3. **Exposure.** A scoped change adds its exposure evidence.

A change's score is the log of its time weight plus its exposure evidence. The top suspect is
`confident` only when its score is at least log 3 above the runner-up's, and it has either
exposure evidence above 2 or a sharp start (the likely starts span 3 hours or less) with a time
weight of at least 0.5. One event, or a slow ramp, never gives a confident match on time alone.

On the synthetic inboxes with six unrelated deploys a day, exposure put the right release first,
confidently, in 40 of 40 draws. For a bug with no scoped change, timing alone put the right
deploy first in 14 of 40 draws and was never confident.

## Rates you report

Monitors compare raw counts under one labeler, where a steady error mostly cancels. A number
shown as a fact ("3% of conversations report a bug") does not cancel. `correctedRate` undoes a
labeler's misses and false yeses using a checked sample (the Rogan-Gladen correction), with an
interval that covers both the stream's sampling and the checked sample's. It marks itself
unusable when the labeler barely beats chance. In simulation, its 95% interval covered the true
rate in 93% to 97.5% of 400 streams (`src/quality.test.mjs`); on a weighted sample it errs wide.
