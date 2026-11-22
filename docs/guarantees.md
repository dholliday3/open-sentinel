# Guarantees

Something that pages people has to be clear about what it does on a bad day. This page says
what open-sentinel does when a part fails, and the rules the design holds to.

## When something fails

| What happens | What open-sentinel does |
|---|---|
| The labeler can't answer one event | The event is not stored and is listed in `failed`. The rest of the batch is stored. |
| The store is down | `ingest` and `tick` throw. Send the batch again and call `tick` again: nothing is lost and nothing is stored twice. If the store fails right after a notice went out, that notice is sent again, with the same `id`. |
| A sink throws | The others still get theirs. The failed one is offered the same items again, with anything newer, on the next batch or tick. `undelivered` says which sink and why. |
| The process restarts | Open episodes, events already alerted on and undelivered notices are in the store (`saveState`). A cron job that starts fresh for every tick works. |
| The process dies while sending | A notice is saved before it is sent, so it is sent again. Delivery is at least once. |
| A cron job fires twice | Both runs alert. Within one step (`stepMs`) they raise the same alert and notice ids, because an alert is named for its monitor and the step it fired in, so a sink that drops an id it has seen (PagerDuty's `dedup_key`) pages once. |
| An event is stored late | A one-event monitor still pages for it, up to `lateMs` after it was written. Share monitors count it from the next tick. |
| The stream stops | `silenceMonitor` fires. Share monitors say `no_data`, and open episodes stay open. |
| You reword a question | The schema's version changes, and monitors on the new version start with no baseline. `upgrade` moves history across for the cost of the changed questions only. |
| You change the labeler | Run `compareLabelers` first. The watch counts each event once and tells you (`mixedLabelers`) when its window holds answers from more than one labeler. Pass `labeler` to count only one. |
| A customer asks to be forgotten | `store.delete({ unit })`. The watch reads the store fresh on every tick, so its counts drop them at once. What a sink was already sent is yours to delete. |

Two limits on these guarantees:

- **Undelivered labeled events are held in memory**, up to 10,000 per sink, not in the store. A
  process that dies loses them; fill the metrics backend again from the store. Undelivered
  notices are kept in the store, up to 1,000 per sink.
- **Run each watch in one place.** Two processes ticking the same watch over the same store both
  alert (with the same ids within a step, as above) and overwrite each other's state: the last
  save wins. `Store` has no compare-and-set, so the watch can't refuse a stale save; a check
  that reads the state back before saving would still let two ticks through. Two different
  watches over one store need a `stateKey` each.

## Rules the design holds to

1. **The wording is the schema.** A reworded question is a new version, and the watch reads one
   version. What the labeler is shown (`state`) is not part of the version: change it and you
   must change the schema's name.
2. **Pin the labeler's version.** An alias that moves changes your metrics silently.
3. **Keep probabilities, apply cutoffs later.** Cutoffs can then be refitted without relabeling.
4. **Count customers, and compare two samples.** A baseline week is a sample too, and one
   customer's ten messages are one customer.
5. **Budget false alerts; don't pick significance levels.**
6. **One event pages only at a high cutoff.** Below 0.9, only when a second reader agrees. Text
   inside a message can sway a labeler.
7. **A suspect is a lead, not a verdict.** Ranking says when it isn't confident, never claims a
   cause from timing alone for a single event or a slow shift, and doesn't count exposure
   without a "before".
8. **Redact before anything leaves.** Keep text only if you may: without it, nothing can be
   relabeled or backtested. Notices quote stored text, already redacted; `examples: 0` quotes
   none.
9. **Not knowing is not the same as being clear.** Too little data never resolves an alert, an
   unanswered event is never stored as a no, and a sink that failed is still owed.
