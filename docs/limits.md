# Limits

What open-sentinel can't do yet, and what hasn't been tested.

## Limits

- **Real data.** Not tried. Every message it has been tested on was written by a model to a
  brief. Synthetic incidents describe themselves more clearly than real customers do, and each
  planted cause shipped within 2 hours of its incident, which flatters attribution.
- **The alarm budget assumes the things counted are independent.** Counting customers handles
  one customer writing twice. It does not handle customers who move together for a reason
  outside your product: a storm, a holiday, a news story. Those are real shifts, and they alert.
- **Scale.** The watch reads every event its monitors look back over on each tick (17 days with
  the default monitors), and `jsonlStore` holds everything in memory. That suits tens of
  thousands of events a week, not millions. The `Store` interface has no way to ask for counts,
  so past that, a monitor has to ask your database itself
  ([reference](reference.md#writing-your-own)).
- **Small volume.** At a handful of messages a week, no rate test can see much: in a simulated
  inbox of 25 messages a week, a doubling of complaints was caught in 7% of weeks even with
  perfect labels ([evaluation](evaluation.md#from-the-prototype-study)). There, use one-event
  monitors for what matters on a single message, and counts in a report for the rest.
- **Exposure needs volume.** On a few hundred events a day, `exposureMonitor` sees only large
  effects. Use it beside share monitors, not instead of them; exposure is better at naming a
  change than at catching one.
- **A real OTLP backend.** The payload is valid OTLP; no backend has received it yet.
- **Seasonal baselines on real rhythms.** Tested on made-up weekly patterns only.
- **One process per watch.** Two processes ticking the same watch both alert and overwrite each
  other's state ([guarantees](guarantees.md)).

## Not built

- **Connectors.** No helpdesk, SMS or email integrations. A connector is a function that yields
  events ([reference](reference.md#writing-your-own)); none are written.
- **A database store.** The interface is eight methods; only memory and files implement it.
- **Rate correction inside monitors.** `correctedRate` is for numbers you report. Monitors
  compare raw counts under one labeler, where a steady error mostly cancels.
- **Finding topics nobody asked about.** Broad questions plus splits by tag caught incidents no
  question named in testing. Clustering what lands in "other" would do it directly, and is not
  built.
- **Alert routing, on-call and dashboards.** Export to the tools that already do these
  (`otlpSink`, `webhookSink`).
