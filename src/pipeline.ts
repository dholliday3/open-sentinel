// Wiring. Two loops, each small enough to replace with your own:
//   createPipeline  events in: redact, label, store, hand to sinks. Run it wherever text arrives.
//   createWatch     alerts out: on a timer, read the recent past, run the monitors, find the
//                   changes that may be behind each new alert, hand notices to sinks.
import { suspectsFor } from "./changes.ts";
import type { Suspect } from "./changes.ts";
import { labelAll } from "./labeler.ts";
import type { LabelFailure, LabelOptions, Labeler } from "./labeler.ts";
import { atLeastOf, EVERY } from "./metrics.ts";
import { createRunner } from "./monitor.ts";
import type { Alert, Runner, RunnerOptions, RunnerSnapshot, Tick } from "./monitor.ts";
import { storeReader } from "./reader.ts";
import type { Reader } from "./reader.ts";
import { describeSignal, parseSignal } from "./schema.ts";
import type { Schema } from "./schema.ts";
import type { Store } from "./store.ts";
import { DAY, HOUR } from "./types.ts";
import type { Gates, Interval, Json, LabeledEvent, TagFilter, TextEvent } from "./types.ts";

/** Anything that yields events to label: an array, a generator reading a queue, a file reader. */
export type Source = Iterable<TextEvent> | AsyncIterable<TextEvent>;

/** A message behind an alert, as stored: its text has been through the pipeline's `redact`, and is absent when text isn't kept. */
export interface Example {
  id: string;
  at: number;
  text?: string;
}

/** What a sink is told about an alert. */
export interface Notice {
  /** The same every time this notice is sent, so a sink that is told twice can tell. */
  id: string;
  kind: "fired" | "resolved";
  /** When it happened: when the alert was raised, or when its episode was found to be over. */
  at: number;
  alert: Alert;
  /** The schema the watch reads, `<name>@<version>`: the exact wording behind `question`. */
  schema?: string;
  /** The alert's signal in the schema's own words (see `describeSignal`). Absent when the monitor watches no question. */
  question?: string;
  /**
   * On a fired notice, up to `examples` (3) messages behind the alert: for a one-event alert, the
   * event itself; otherwise events in the stretch the alert is about that say yes to its signal,
   * one per customer, surest first.
   */
  examples?: Example[];
  /** The changes most likely behind it, best first, when any fit. Leads to check, not verdicts. */
  suspects?: Suspect[];
  /** True when the top suspect has a clear lead and real evidence. */
  confident?: boolean;
}

/** The messages behind an alert, for a notice: see `Notice.examples`. Read where they are kept, at most `limit` of them. */
const examplesOf = async (alert: Alert, reader: Reader, gates: Gates, limit: number): Promise<Example[]> => {
  const asExample = ({ id, at, text }: LabeledEvent): Example => ({ id, at, ...(text === undefined ? {} : { text }) });
  if (limit <= 0) {
    return [];
  }
  if (alert.event) {
    const { id, at } = alert.event;
    return (await reader.events({ from: at, to: at + 1 })).filter((event) => event.id === id).slice(0, limit).map(asExample);
  }
  if (alert.signal === undefined || alert.signal === EVERY) {
    return [];
  }
  const keys = parseSignal(alert.signal).map((part) => part.key);
  const surest = await reader.events({ from: alert.at - alert.windowMs, to: alert.at, ...(alert.where ? { where: alert.where } : {}), atLeast: atLeastOf(alert.signal, gates)!, order: { surest: keys }, onePerUnit: true, limit });
  return surest.map(asExample);
};

/**
 * Where results go: a log, a webhook, your metrics backend. Implement either method or both.
 * A sink may throw. What it was owed is kept and offered again, together with anything newer, the
 * next time there is something to send, so a sink can be told the same thing twice: use the ids.
 */
export interface Sink {
  labeled?(events: readonly LabeledEvent[]): void | Promise<void>;
  notify?(notices: readonly Notice[]): void | Promise<void>;
}

/** A sink that threw: its place in `sinks`, what it said, and how much it is still owed. */
export interface Undelivered {
  sink: number;
  error: string;
  pending: number;
}

/** What each sink is still owed. Nothing here throws: a sink that fails must not stop the others. */
const createOutbox = <Item>(sinks: readonly Sink[], deliver: (sink: Sink) => ((items: readonly Item[]) => void | Promise<void>) | undefined, limit: number, owed: Record<string, Item[]> = {}) => ({
  owed,
  queue: (items: readonly Item[]): void => {
    if (items.length === 0) {
      return;
    }
    sinks.forEach((sink, index) => {
      if (deliver(sink)) {
        // Past the limit the oldest are dropped: a sink that is down for good must not fill memory.
        owed[index] = [...(owed[index] ?? []), ...items].slice(-limit);
      }
    });
  },
  flush: async (): Promise<Undelivered[]> => {
    const failed: Undelivered[] = [];
    for (const [index, sink] of sinks.entries()) {
      const items = owed[index];
      const send = deliver(sink);
      if (!items || items.length === 0 || !send) {
        continue;
      }
      // Taken before the send, so a flush running beside this one can't send the same items too.
      delete owed[index];
      try {
        await send(items);
      } catch (error) {
        // Put back ahead of anything queued while the send was under way.
        owed[index] = [...items, ...(owed[index] ?? [])].slice(-limit);
        failed.push({ sink: index, error: error instanceof Error ? error.message : String(error), pending: owed[index].length });
      }
    }
    return failed;
  },
});

export interface PipelineOptions extends LabelOptions {
  schema: Schema;
  labeler: Labeler;
  store: Store;
  sinks?: readonly Sink[];
  concurrency?: number;
  /**
   * False drops each event's text and context once it is labeled. Nothing can then be relabeled
   * or backtested, and an investigator has no messages to read.
   */
  keepText?: boolean;
  /** How many labeled events to hold, in memory, for a sink that is failing. */
  maxPending?: number;
}

export interface Ingested {
  labeled: number;
  /** Events already stored under this schema and labeler: a redelivery costs nothing. */
  skipped: number;
  /** Events the labeler couldn't answer. They are not stored, so sending them again tries again. */
  failed: LabelFailure[];
  cost: number;
  /** Sinks that threw. The events are stored either way; the sink is offered them again on the next batch. */
  undelivered: Undelivered[];
}

/** One batch `run` sent: its events as the source gave them, and what came of them. */
export interface Batch extends Ingested {
  events: readonly TextEvent[];
}

export interface RunOptions {
  /** Send a batch once it holds this many events (50). */
  batch?: number;
  /** Or once its first event has waited this long (5 seconds). */
  maxWaitMs?: number;
  /**
   * Called after each batch is stored, with its events and what came of them: where a queue
   * worker acks what was stored and sees what failed. With it, `run`'s total keeps the counts but
   * not the failures, so a source that never ends doesn't fill memory. If it throws, `run` stops
   * and rejects.
   */
  onBatch?: (batch: Batch) => void | Promise<void>;
}

export interface Pipeline {
  ingest(events: readonly TextEvent[]): Promise<Ingested>;
  /**
   * Labels everything a source yields, in batches. A batch is sent when it holds `batch` events
   * or when its first event has waited `maxWaitMs`, so a quiet stream is still labeled promptly.
   * Returns once the source ends; for one that doesn't, pass `onBatch`.
   */
  run(source: Source, options?: RunOptions): Promise<Ingested>;
}

export const createPipeline = ({ schema, labeler, store, sinks = [], concurrency = 8, keepText = true, maxPending = 10_000, ...options }: PipelineOptions): Pipeline => {
  const outbox = createOutbox<LabeledEvent>(sinks, (sink) => sink.labeled?.bind(sink), maxPending);
  const ingest = async (events: readonly TextEvent[]): Promise<Ingested> => {
    const known = await store.known([...new Set(events.map((event) => event.id))], schema.id, labeler.id);
    const fresh = events.filter((event) => {
      // New to the store, and not a repeat inside this batch.
      const isNew = !known.has(event.id);
      known.add(event.id);
      return isNew;
    });
    const { events: labeled, failed, cost } = await labelAll(fresh, schema, labeler, { ...options, concurrency });
    const kept = keepText ? labeled : labeled.map(({ text: _text, context: _context, ...event }) => event);
    await store.append(kept);
    outbox.queue(kept);
    return { labeled: kept.length, skipped: events.length - fresh.length, failed, cost, undelivered: await outbox.flush() };
  };
  return {
    ingest,
    run: async (source, { batch = 50, maxWaitMs = 5000, onBatch } = {}) => {
      const total: Ingested = { labeled: 0, skipped: 0, failed: [], cost: 0, undelivered: [] };
      const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
      let pending: TextEvent[] = [];
      let sendBy = Infinity;
      const flush = async (): Promise<void> => {
        const events = pending;
        const done = await ingest(events);
        pending = [];
        sendBy = Infinity;
        total.labeled += done.labeled;
        total.skipped += done.skipped;
        if (!onBatch) {
          total.failed.push(...done.failed);
        }
        total.cost += done.cost;
        total.undelivered = done.undelivered;
        await onBatch?.({ ...done, events });
      };
      let next: Promise<IteratorResult<TextEvent>> | undefined;
      let ended = false;
      try {
        for (;;) {
          next ??= Promise.resolve(iterator.next());
          let timer: ReturnType<typeof setTimeout> | undefined;
          // With events waiting, the source gets only until the oldest has waited long enough.
          const result = pending.length === 0 ? await next : await Promise.race([next, new Promise<"waited">((resolve) => (timer = setTimeout(() => resolve("waited"), Math.max(0, sendBy - Date.now()))))]);
          clearTimeout(timer);
          if (result === "waited") {
            await flush();
            continue;
          }
          next = undefined;
          if (result.done) {
            ended = true;
            break;
          }
          if (pending.length === 0) {
            sendBy = Date.now() + maxWaitMs;
          }
          pending.push(result.value);
          if (pending.length >= batch) {
            await flush();
          }
        }
        if (pending.length > 0) {
          await flush();
        }
        return total;
      } finally {
        // Stopped by an error (the store is down): tell the source, so it can release what it holds.
        if (!ended) {
          await iterator.return?.();
        }
      }
    },
  };
};

export interface WatchOptions extends Omit<RunnerOptions, "snapshot"> {
  schema: Schema;
  store: Store;
  sinks?: readonly Sink[];
  /**
   * Count only this labeler's answers. Left out, every event counts once, and where two labelers
   * answered the same event the one in use most recently wins (see `latestAnswers`).
   */
  labeler?: string;
  /** How far back to look for the changes behind an alert. */
  suspectLookbackMs?: number;
  /** Where in the store this watch keeps its state. Two watches over one store need a key each. */
  stateKey?: string;
  /** How many notices to hold for a sink that is failing. */
  maxPending?: number;
  /** How many messages a fired notice quotes (`Notice.examples`). 0 keeps message text out of notices. */
  examples?: number;
  /**
   * Watch only events carrying these tags, as if the store held nothing else: one workspace of
   * a store shared by many. Give each such watch its own `stateKey`. Each has its own alarm
   * budget, so a hundred workspaces can raise a hundred times the false alerts of one.
   */
  where?: TagFilter;
}

export interface WatchTick extends Tick {
  /** The notices raised by this tick. */
  notices: Notice[];
  /** Sinks that threw. Their notices are kept in the store and offered again on the next tick. */
  undelivered: Undelivered[];
  /** The labelers whose answers were in the window, when more than one: their numbers are not the same measurement. */
  mixedLabelers?: string[];
}

export interface Watch {
  tick(now?: number): Promise<WatchTick>;
  /** Leaves a stretch out of every baseline from now on: an incident someone confirmed. */
  exclude(interval: Interval): Promise<void>;
  /** The cutoff each tested monitor is held to, by monitor name. */
  alphas(): Record<string, number>;
}

/**
 * The alerting loop. Call `tick()` every `stepMs` (an hour by default) from a timer, a cron job or
 * a queue. Open episodes, events already alerted on and notices a sink hasn't taken yet are kept
 * in the store, so a process that starts fresh for every tick carries on where the last one left
 * off. Delivery is at least once: a notice is on record before it is sent.
 *
 * A tick reads no events in bulk. Monitors count through the store (`Store.count`); what a tick
 * reads out is the events a one-event monitor alerts on and the few a notice quotes.
 */
export const createWatch = ({ schema, store, sinks = [], labeler, suspectLookbackMs = 10 * DAY, stateKey = `watch:${schema.name}`, maxPending = 1000, examples = 3, where, ...options }: WatchOptions): Watch => {
  const gates = { ...schema.gates, ...options.gates };
  const lookback = Math.max(suspectLookbackMs, options.stepMs ?? HOUR, ...options.monitors.map((monitor) => monitor.lookbackMs));
  // Built now so a mistake in the monitors (two with one name) fails here, not on the first tick.
  const fresh = createRunner({ ...options, gates });
  let ready: Promise<{ runner: Runner; outbox: ReturnType<typeof createOutbox<Notice>> }> | undefined;
  const load = (): NonNullable<typeof ready> =>
    (ready ??= (async () => {
      const saved = (await store.loadState(stateKey)) as unknown as { runner?: RunnerSnapshot; owed?: Record<string, Notice[]> } | undefined;
      return {
        runner: saved?.runner ? createRunner({ ...options, gates, snapshot: saved.runner }) : fresh,
        outbox: createOutbox<Notice>(sinks, (sink) => sink.notify?.bind(sink), maxPending, saved?.owed ?? {}),
      };
    })());
  const save = async (): Promise<void> => {
    const { runner, outbox } = await load();
    // Alerts and notices are plain data: numbers, strings and what monitors put in `detail`.
    await store.saveState(stateKey, JSON.parse(JSON.stringify({ runner: runner.snapshot(), owed: outbox.owed })) as Json);
  };
  return {
    alphas: () => Object.fromEntries(options.monitors.filter((monitor) => monitor.tested).map((monitor) => [monitor.name, fresh.alphaOf(monitor)])),
    exclude: async (interval) => {
      (await load()).runner.exclude(interval);
      await save();
    },
    tick: async (now = Date.now()) => {
      const { runner, outbox } = await load();
      const reader = storeReader(store, { schema: schema.id, span: { from: now - lookback, to: now }, ...(labeler === undefined ? {} : { labeler }), ...(where ? { where } : {}) });
      const changes = await store.changes({ from: now - lookback, to: now + 1 });
      const tick = await runner.tick(reader, now, changes);
      const about = (alert: Alert): Pick<Notice, "schema" | "question"> => ({ schema: schema.id, ...(alert.signal === undefined || alert.signal === EVERY ? {} : { question: describeSignal(schema, alert.signal) }) });
      // Suspects and examples only for alerts that fired: a quiet tick reads nothing more.
      const fired = await Promise.all(
        tick.fired
          .filter((alert) => alert.mutedBy === undefined)
          .map(async (alert): Promise<Notice> => {
            const [behind, quoted] = await Promise.all([suspectsFor(alert, reader, changes, { gates, lookbackMs: suspectLookbackMs }), examplesOf(alert, reader, gates, examples)]);
            return { id: `${alert.id}#fired`, kind: "fired", at: alert.at, alert, ...about(alert), ...(quoted.length > 0 ? { examples: quoted } : {}), ...(behind && behind.ranked.length > 0 ? { suspects: behind.ranked.slice(0, 3), confident: behind.confident } : {}) };
          }),
      );
      const labelers = labeler === undefined ? await reader.labelers() : [];
      const notices: Notice[] = [
        ...fired,
        ...tick.resolved.filter((alert) => alert.mutedBy === undefined).map((alert): Notice => ({ id: `${alert.id}#resolved`, kind: "resolved", at: now, alert, ...about(alert) })),
      ];
      outbox.queue(notices);
      // On record before anything is sent: a process that dies mid-send still owes the notice.
      await save();
      const owing = Object.keys(outbox.owed).length > 0;
      const undelivered = await outbox.flush();
      if (owing) {
        await save();
      }
      return { ...tick, notices, undelivered, ...(labelers.length > 1 ? { mixedLabelers: labelers } : {}) };
    },
  };
};
