// What monitors and suspects read through: counts, and events in small bounded amounts. Backed by
// a store (`storeReader`, what the watch uses) the counting happens where the data lives and a
// tick reads no more than it quotes; backed by an array (`memoryReader`) it is what replays and
// backtests run on. Both give the same numbers for the same events.
import { firstAtOrAfter, pick, tally } from "./counting.ts";
import type { CountQuery, CountRow, EventQuery, Labelers, Ranked } from "./counting.ts";
import { allOf, viewOf } from "./metrics.ts";
import type { EventView } from "./metrics.ts";
import type { Store } from "./store.ts";
import type { Interval, LabeledEvent, TagFilter } from "./types.ts";

/** A count through a reader: the reader knows the schema and whose answers count. */
export type ReaderCount = Omit<CountQuery, "schema" | "labeler" | "oneAnswer">;

/** A read through a reader: always a bounded range of time. */
export interface ReaderEvents extends Omit<EventQuery, "schema" | "labeler" | "oneAnswer" | "from" | "to"> {
  from: number;
  to: number;
}

export interface Reader {
  /** Counts in many windows at once (see `Store.count`). */
  count(query: ReaderCount): Promise<CountRow[]>;
  /** Events in a range, filtered, ordered and cut to `limit` where they are kept. */
  events(query: ReaderEvents): Promise<LabeledEvent[]>;
  /** When the first event this reader can see arrived: time before it was not watched, so no baseline reaches into it. */
  firstAt(): Promise<number | undefined>;
}

const later: (run: () => void) => void = typeof setImmediate === "function" ? (run) => void setImmediate(run) : (run) => void setTimeout(run, 0);
const shapeOf = (query: ReaderCount): string => JSON.stringify([query.per, query.gates ?? {}, query.where ?? null, query.exclude ?? null, query.groupBy ?? null]);

/**
 * Counts asked for together, as monitors checked at the same moment ask, go out as one: counts
 * that differ only in their windows and signals are merged, so a store scans their events once.
 */
const batched = (count: (query: ReaderCount) => Promise<CountRow[]>): ((query: ReaderCount) => Promise<CountRow[]>) => {
  let waiting: Array<{ query: ReaderCount; resolve: (rows: CountRow[]) => void; reject: (error: unknown) => void }> = [];
  const flush = (): void => {
    const batch = waiting;
    waiting = [];
    const shapes = new Map<string, typeof batch>();
    for (const item of batch) {
      const shape = shapeOf(item.query);
      const same = shapes.get(shape);
      if (same) {
        same.push(item);
      } else {
        shapes.set(shape, [item]);
      }
    }
    for (const items of shapes.values()) {
      if (items.length === 1) {
        count(items[0]!.query).then(items[0]!.resolve, items[0]!.reject);
        continue;
      }
      const windows: Interval[] = [];
      const index = new Map<string, number>();
      const places = items.map(({ query }) =>
        query.windows.map((window) => {
          const key = `${window.from}\n${window.to}`;
          let place = index.get(key);
          if (place === undefined) {
            place = windows.length;
            index.set(key, place);
            windows.push(window);
          }
          return place;
        }),
      );
      const signals = [...new Set(items.flatMap(({ query }) => query.signals))];
      count({ ...items[0]!.query, windows, signals }).then(
        (rows) => {
          const byWindow = new Map<number, CountRow[]>();
          for (const row of rows) {
            const same = byWindow.get(row.window);
            if (same) {
              same.push(row);
            } else {
              byWindow.set(row.window, [row]);
            }
          }
          items.forEach(({ query, resolve }, n) =>
            resolve(places[n]!.flatMap((place, window) => (byWindow.get(place) ?? []).map((row) => ({ ...row, window, yes: Object.fromEntries(query.signals.map((signal) => [signal, row.yes[signal]!])) })))),
          );
        },
        (error: unknown) => items.forEach(({ reject }) => reject(error)),
      );
    }
  };
  return (query) =>
    new Promise((resolve, reject) => {
      if (waiting.length === 0) {
        later(flush);
      }
      waiting.push({ query, resolve, reject });
    });
};

const byTimeThenRank = (a: Ranked, b: Ranked): number => a.event.at - b.event.at || a.rank - b.rank;
const atOf = (ranked: Ranked): number => ranked.event.at;

/** A reader over events in memory, every one counted as it is: what `replay` and `backtestMonitors` run on. */
export const memoryReader = (events: readonly LabeledEvent[]): Reader => {
  const sorted = events.map((event, rank) => ({ event, rank })).sort(byTimeThenRank);
  return {
    count: batched(async (query) => tally(sorted, (ranked) => ranked.event, query)),
    events: async (query) => {
      const from = firstAtOrAfter(sorted, query.from, atOf);
      return pick({ length: Math.max(0, firstAtOrAfter(sorted, query.to, atOf) - from), at: (index) => sorted[from + index]! }, query);
    },
    firstAt: async () => sorted[0]?.event.at,
  };
};

export interface StoreReaderOptions {
  /** The schema id whose events are read. */
  schema: string;
  /** Read only this labeler's answers. Left out: one answer per event, the newest labeler's where it answered (see `latestAnswers`). */
  labeler?: string;
  /** Nothing outside this stretch is read: the watch's lookback. Left out: all of time. */
  span?: Interval;
  /** Only events carrying these tags, as if the store held nothing else: one workspace of a shared store. */
  where?: TagFilter;
}

const noRows = (query: ReaderCount): CountRow[] => (query.groupBy ? [] : query.windows.map((_, window) => ({ window, total: 0, yes: Object.fromEntries(query.signals.map((signal) => [signal, 0])), events: 0 })));

/**
 * A reader over a store, for one schema. It asks the store once which labelers answered in the
 * span: one, and every read is that labeler's; several, and every read takes one answer per
 * event, the newest labeler's where it answered.
 */
export const storeReader = (store: Store, { schema, labeler, span = { from: -Infinity, to: Infinity }, where }: StoreReaderOptions): Reader & { labelers(): Promise<string[]> } => {
  let answered: Promise<Labelers> | undefined;
  const who = (): Promise<Labelers> => (answered ??= store.labelers({ schema, from: span.from, to: span.to, ...(where ? { where } : {}) }));
  /** Whose answers every read takes, or null when nobody answered anything in the span. */
  const answers = async (): Promise<Pick<EventQuery, "labeler" | "oneAnswer"> | null> => {
    if (labeler !== undefined) {
      return { labeler };
    }
    const { labelers, newest } = await who();
    if (labelers.length <= 1) {
      return labelers[0] === undefined ? null : { labeler: labelers[0] };
    }
    return { oneAnswer: { prefer: newest!, from: span.from, to: span.to } };
  };
  const clip = (window: Interval): Interval => ({ from: Math.max(window.from, span.from), to: Math.min(window.to, span.to) });
  let first: Promise<number | undefined> | undefined;
  return {
    labelers: async () => (labeler === undefined ? (await who()).labelers : [labeler]),
    count: batched(async (query) => {
      const rule = await answers();
      const scoped = allOf(where, query.where);
      if (!rule || !scoped.possible) {
        return noRows(query);
      }
      return store.count({ ...query, schema, ...rule, windows: query.windows.map(clip), ...(scoped.where ? { where: scoped.where } : {}) });
    }),
    events: async (query) => {
      const rule = await answers();
      const scoped = allOf(where, query.where);
      if (!rule || !scoped.possible) {
        return [];
      }
      return store.events({ ...query, schema, ...rule, ...clip(query), ...(scoped.where ? { where: scoped.where } : {}) });
    },
    firstAt: () =>
      (first ??= (async () => {
        const rule = await answers();
        return rule ? (await store.events({ schema, ...rule, ...span, ...(where ? { where } : {}), limit: 1 }))[0]?.at : undefined;
      })()),
  };
};

/** The events in a range as a view, for a monitor of your own that needs them all. Keep the range short: every event in it is read. */
export const viewWithin = async (reader: Reader, range: { from: number; to: number; where?: TagFilter }): Promise<EventView> => viewOf(await reader.events(range));
