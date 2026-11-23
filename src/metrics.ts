// Counting signals over events: the layer between labeled events and anything that watches them.
import type { Reader } from "./reader.ts";
import type { Counts } from "./stats.ts";
import type { Gates, Interval, LabeledEvent, TagFilter } from "./types.ts";

export interface Range {
  from?: number;
  to?: number;
  /** Only events carrying every one of these tags. */
  where?: TagFilter;
}

/** Events sorted by time, with fast time-range reads. */
export interface EventView {
  readonly events: readonly LabeledEvent[];
  /** Events with `from <= at < to`. */
  within(range?: Range): LabeledEvent[];
}

export const viewOf = (events: readonly LabeledEvent[]): EventView => {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const firstAtOrAfter = (time: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid]!.at < time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  };
  return {
    events: sorted,
    within: ({ from = -Infinity, to = Infinity, where } = {}) => {
      const slice = sorted.slice(firstAtOrAfter(from), firstAtOrAfter(to));
      return where ? slice.filter(hasTags(where)) : slice;
    },
  };
};

/**
 * One set of answers per event. A store may hold the same event answered by several labelers
 * (history labeled again under a new model); counted together, each such event would count twice.
 * Where an event has several, the answers of the labeler behind the newest event are kept.
 */
export const latestAnswers = (events: readonly LabeledEvent[]): LabeledEvent[] => {
  const current = events.reduce<LabeledEvent | undefined>((newest, event) => (newest === undefined || event.at >= newest.at ? event : newest), undefined)?.labeler;
  const byId = new Map<string, LabeledEvent>();
  for (const event of events) {
    const key = `${event.schema}\n${event.id}`;
    if (!byId.has(key) || event.labeler === current) {
      byId.set(key, event);
    }
  }
  return byId.size === events.length ? [...events] : [...byId.values()];
};

export const hasTags =
  (where: TagFilter) =>
  (event: LabeledEvent): boolean =>
    Object.entries(where).every(([key, value]) => event.tags?.[key] === value);

/** Both filters at once, as one. Not possible when they ask one tag for two values. */
export const allOf = (a: TagFilter | undefined, b: TagFilter | undefined): { possible: boolean; where?: TagFilter } => {
  if (!a || !b) {
    const where = a ?? b;
    return { possible: true, ...(where ? { where } : {}) };
  }
  const possible = Object.entries(b).every(([key, value]) => !(key in a) || a[key] === value);
  return { possible, ...(possible ? { where: { ...a, ...b } } : {}) };
};

/** The signal every event has. Counting it counts events, so a monitor on it watches volume. */
export const EVERY = "*";

/**
 * Whether a signal is yes for an event. A key joined with `&` is yes when every part is, each at
 * its own gate: `is_bug&area=login`.
 */
export const on = (signal: string, gates: Gates = {}): ((event: LabeledEvent) => boolean) => {
  if (signal === EVERY) {
    return () => true;
  }
  const parts = signal.split("&").map((key) => [key, gates[key] ?? 0.5] as const);
  if (parts.length === 1) {
    const [key, gate] = parts[0]!;
    return (event) => (event.signals[key] ?? 0) >= gate;
  }
  return (event) => parts.every(([key, gate]) => (event.signals[key] ?? 0) >= gate);
};

/**
 * The signal as an `atLeast` filter for a read (see `EventQuery`): every part at its gate.
 * Undefined for `*`, which every event has.
 */
export const atLeastOf = (signal: string, gates: Gates = {}): Array<Record<string, number>> | undefined =>
  signal === EVERY ? undefined : [Object.fromEntries(signal.split("&").map((key) => [key, gates[key] ?? 0.5]))];

/** How many of these events have the signal, and how many there are. */
export const count = (events: readonly LabeledEvent[], signal: string, gates: Gates = {}): Counts => {
  const isOn = on(signal, gates);
  let yes = 0;
  for (const event of events) {
    if (isOn(event)) {
      yes += 1;
    }
  }
  return { yes, total: events.length };
};

/**
 * The same count with each customer counted once: a `unit` is one yes if any of its events is
 * yes, and one in the total however often it wrote. Events without a unit count on their own.
 * One customer sending five angry messages is one customer, and treating it as five makes a
 * monitor see shifts that aren't there.
 */
export const countUnits = (events: readonly LabeledEvent[], signal: string, gates: Gates = {}): Counts => {
  const isOn = on(signal, gates);
  const units = new Map<string, boolean>();
  let yes = 0;
  let total = 0;
  for (const event of events) {
    if (event.unit === undefined) {
      total += 1;
      yes += isOn(event) ? 1 : 0;
    } else if (!units.get(event.unit)) {
      units.set(event.unit, isOn(event));
    }
  }
  for (const any of units.values()) {
    total += 1;
    yes += any ? 1 : 0;
  }
  return { yes, total };
};

/** Events outside every excluded interval. */
export const outside = (events: LabeledEvent[], excluded: readonly Interval[]): LabeledEvent[] =>
  excluded.length === 0 ? events : events.filter((event) => !excluded.some((gap) => event.at >= gap.from && event.at < gap.to));

/**
 * Stretches exactly `lengthMs` long, laid back to back from `end` toward the past: at most
 * `count` of them, none starting before `earliest`, and none that an excluded interval touches.
 * Where one would, the next ends where that interval begins.
 *
 * A baseline counted per customer has to be cut this way. A customer has fewer chances to say
 * yes in a shorter stretch, so a stretch cut short, by the end of the span or by excluded time,
 * reads low and makes an unchanged window look like a rise.
 */
export const wholeStretches = ({ end, lengthMs, count, earliest, excluded = [] }: { end: number; lengthMs: number; count: number; earliest: number; excluded?: readonly Interval[] }): Interval[] => {
  if (!(lengthMs > 0)) {
    throw new Error("A stretch must be longer than nothing");
  }
  const stretches: Interval[] = [];
  let to = end;
  while (stretches.length < count && to - lengthMs >= earliest) {
    const from = to - lengthMs;
    const touching = excluded.filter((gap) => gap.from < to && gap.to > from);
    if (touching.length === 0) {
      stretches.push({ from, to });
      to = from;
    } else {
      // Any stretch ending between the earliest touching interval's start and `to` would touch it too.
      to = Math.min(...touching.map((gap) => gap.from));
    }
  }
  return stretches;
};

/** One signal's counts in equal buckets of time. */
export const series = async (reader: Reader, { signal, gates, from, to, bucketMs, where }: { signal: string; gates?: Gates; from: number; to: number; bucketMs: number; where?: TagFilter }): Promise<Array<Counts & { at: number }>> => {
  if (!(bucketMs > 0)) {
    throw new Error("A bucket must be longer than nothing");
  }
  const windows: Interval[] = [];
  for (let at = from; at < to; at += bucketMs) {
    windows.push({ from: at, to: Math.min(at + bucketMs, to) });
  }
  const rows = await reader.count({ windows, signals: [signal], ...(gates ? { gates } : {}), per: "event", ...(where ? { where } : {}) });
  return rows.map((row, i) => ({ at: windows[i]!.from, yes: row.yes[signal]!, total: row.total }));
};

/** One signal split by a tag: its counts in a window and in the span before it. */
export const breakdown = async (reader: Reader, { signal, gates, by, from, to, baselineMs }: { signal: string; gates?: Gates; by: string; from: number; to: number; baselineMs: number }): Promise<Array<{ value: string | null; now: Counts; before: Counts }>> => {
  const rows = await reader.count({ windows: [{ from, to }, { from: from - baselineMs, to: from }], signals: [signal], ...(gates ? { gates } : {}), per: "event", groupBy: { tags: [by] } });
  const valueOf = (row: (typeof rows)[number]): string | null => row.group?.[by] ?? null;
  const countsIn = (window: number, value: string | null): Counts => {
    const row = rows.find((one) => one.window === window && valueOf(one) === value);
    return { yes: row?.yes[signal] ?? 0, total: row?.total ?? 0 };
  };
  return [...new Set(rows.map(valueOf))].map((value) => ({ value, now: countsIn(0, value), before: countsIn(1, value) })).sort((a, b) => b.now.yes - a.now.yes);
};

/** Every signal's share in a window against the span before it, largest rise first. */
export const movers = async (reader: Reader, { signals, gates, from, to, baselineMs }: { signals: readonly string[]; gates?: Gates; from: number; to: number; baselineMs: number }): Promise<Array<{ signal: string; now: Counts; before: Counts; lift: number }>> => {
  const [now, before] = await reader.count({ windows: [{ from, to }, { from: from - baselineMs, to: from }], signals, ...(gates ? { gates } : {}), per: "event" });
  return signals
    .map((signal) => {
      const a = { yes: now!.yes[signal]!, total: now!.total };
      const b = { yes: before!.yes[signal]!, total: before!.total };
      // A floor on the earlier share keeps a signal that was absent from dividing by zero.
      return { signal, now: a, before: b, lift: a.yes / Math.max(a.total, 1) / Math.max(b.yes / Math.max(b.total, 1), 0.002) };
    })
    .sort((a, b) => b.lift - a.lift);
};
