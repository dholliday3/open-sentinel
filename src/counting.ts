// Counting stored answers without reading them all: the queries every `Store` answers, and how
// they are answered over an array. `countEvents`, `readEvents` and `labelersOf` are the
// reference: a store of your own may call them on what it holds, and the built-in stores are
// tested against them. `tally` and `pick` are the engine the in-memory stores and readers share.
import { hasTags, on } from "./metrics.ts";
import type { Counts } from "./stats.ts";
import type { Gates, Interval, LabeledEvent, TagFilter, Tags } from "./types.ts";

/**
 * One answer per event, for a read that leaves `labeler` out. Where an event was answered by
 * several labelers, `prefer`'s answer is the one read, or else the first stored; only copies
 * from `from` up to `to` are considered, and nothing outside that stretch is read. This is the
 * rule `latestAnswers` applies to an array, with `prefer` the labeler behind the newest event.
 */
export interface OneAnswer {
  prefer: string;
  from: number;
  to: number;
}

/**
 * Which events, and which of their answers, a read sees. With neither `labeler` nor `oneAnswer`
 * every stored answer is read: an event answered by two labelers is read twice.
 */
export interface AnswerQuery {
  /** Only events labeled under this schema id. */
  schema?: string;
  /** Only this labeler's answers. */
  labeler?: string;
  oneAnswer?: OneAnswer;
}

export interface EventQuery extends AnswerQuery {
  from?: number;
  to?: number;
  /** Only events carrying every one of these tags. */
  where?: TagFilter;
  /**
   * Only events where, for at least one entry, every signal named is at least its number (a
   * missing signal is 0): `[{ leak: 0.9 }, { leak: 0.5, "leak.second": 0.5 }]`.
   */
  atLeast?: ReadonlyArray<Readonly<Record<string, number>>>;
  /**
   * The order they come in, and so which are kept when `limit` cuts: oldest first (the
   * default), newest first, or `{ surest }`: highest first by the lowest of these signals'
   * probabilities, then newest. Events at the same time keep the order they were stored in.
   */
  order?: "oldest" | "newest" | { surest: readonly string[] };
  /** Only the first, in that order, of each `unit`. An event without one is its own. */
  onePerUnit?: boolean;
  limit?: number;
}

/** Group counts by tags: by the values of these tags, or by every tag but these. */
export type GroupBy = { tags: readonly string[] } | { tagsExcept: readonly string[] };

/** Counts in many windows of time at once: one row per window, or per group within a window. */
export interface CountQuery extends AnswerQuery {
  schema: string;
  /** Each from <= at < to. They may overlap; each is counted on its own. */
  windows: readonly Interval[];
  /** Signal keys to count yeses of, joined keys (`is_bug&area=login`) and `*` included. */
  signals: readonly string[];
  gates?: Gates;
  /**
   * "unit": each customer once per window (per group), and yes for a signal if any of its events
   * is; an event without a unit counts on its own (see `countUnits`). "event": every event.
   */
  per: "unit" | "event";
  /** Only events carrying every one of these tags. */
  where?: TagFilter;
  /** Leaves out events carrying every one of these tags. */
  exclude?: TagFilter;
  groupBy?: GroupBy;
}

export interface CountRow {
  /** The window's place in `windows`. */
  window: number;
  /** The group's tags, with `groupBy`: a tag an event lacks is null for `tags`, absent for `tagsExcept`. */
  group?: Tags;
  /** Customers, or events with `per: "event"`. */
  total: number;
  /** How many of `total` said yes, for each signal asked. */
  yes: Record<string, number>;
  /** Events counted, whatever `per` is. */
  events: number;
}

/** One signal's counts in one row of a count: nothing counted when there is no row. */
export const countsOf = (row: CountRow | undefined, signal: string): Counts => ({ yes: row?.yes[signal] ?? 0, total: row?.total ?? 0 });

/** Which labelers answered events in a range, in the order of their first answer there, and whose answer is the newest. */
export interface LabelerQuery {
  schema: string;
  from?: number;
  to?: number;
  where?: TagFilter;
}

export interface Labelers {
  labelers: string[];
  newest?: string;
}

/** An event as read, with its place in the order stored events are read in. */
export interface Ranked {
  event: LabeledEvent;
  /** Breaks ties between events at the same time: the order they were stored in. */
  rank: number;
}

/** Where `at` first reaches `time` in events sorted by time. */
export const firstAtOrAfter = <Item>(sorted: readonly Item[], time: number, atOf: (item: Item) => number): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (atOf(sorted[mid]!) < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

const byTimeThenRank = (a: Ranked, b: Ranked): number => a.event.at - b.event.at || a.rank - b.rank;
const inRange = (at: number, from = -Infinity, to = Infinity): boolean => at >= from && at < to;

/** The answers a query sees, oldest first, from events in the order they were stored. */
export const answersOf = (stored: readonly LabeledEvent[], query: AnswerQuery & { from?: number; to?: number }): Ranked[] => {
  const mine = stored.flatMap((event, rank) => ((query.schema === undefined || event.schema === query.schema) && (query.labeler === undefined || event.labeler === query.labeler) ? [{ event, rank }] : []));
  const { oneAnswer } = query;
  if (query.labeler !== undefined || oneAnswer === undefined) {
    return mine.filter(({ event }) => inRange(event.at, query.from, query.to)).sort(byTimeThenRank);
  }
  return keepOne(mine.filter(({ event }) => inRange(event.at, oneAnswer.from, oneAnswer.to)).sort(byTimeThenRank), oneAnswer.prefer).filter(({ event }) => inRange(event.at, query.from, query.to));
};

/**
 * One answer per event from copies sorted by time: `prefer`'s copy, or else the first. An event
 * keeps the place of its first copy among events at the same time, as `latestAnswers` and a view
 * of what it returns would put it.
 */
export const keepOne = (copies: readonly Ranked[], prefer: string): Ranked[] => {
  const kept = new Map<string, Ranked>();
  copies.forEach((copy, place) => {
    const key = `${copy.event.schema}\n${copy.event.id}`;
    const first = kept.get(key);
    if (!first) {
      kept.set(key, { event: copy.event, rank: place });
    } else if (copy.event.labeler === prefer) {
      kept.set(key, { event: copy.event, rank: first.rank });
    }
  });
  return [...kept.values()].sort(byTimeThenRank);
};

/** The extent of some windows: where one answer per event is decided when a count doesn't say. */
export const extentOf = (windows: readonly Interval[]): Interval => ({ from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) });

const groupKeyOf = (groupBy: GroupBy | undefined): ((event: LabeledEvent) => { key: string; group: Tags }) | undefined => {
  if (!groupBy) {
    return undefined;
  }
  if ("tags" in groupBy) {
    const keys = groupBy.tags;
    return (event) => {
      const values = keys.map((key) => event.tags?.[key] ?? null);
      return { key: JSON.stringify(values), group: Object.fromEntries(keys.map((key, i) => [key, values[i]!])) };
    };
  }
  const except = new Set(groupBy.tagsExcept);
  return (event) => {
    const entries = Object.entries(event.tags ?? {})
      .filter(([key]) => !except.has(key))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return { key: JSON.stringify(entries), group: Object.fromEntries(entries) };
  };
};

/** The key a group is told apart by: the same for the same tags, whatever their order. */
export const groupKey = (groupBy: GroupBy, group: Tags): string =>
  "tags" in groupBy ? JSON.stringify(groupBy.tags.map((key) => group[key] ?? null)) : JSON.stringify(Object.entries(group).sort(([a], [b]) => (a < b ? -1 : 1)));

interface Tally {
  group?: Tags;
  key: string;
  first: number;
  total: number;
  events: number;
  yes: number[];
  /** Per customer, which signals it has said yes to, for a grouped count. */
  units?: Map<string, Uint8Array>;
}

/**
 * Counts events already chosen and sorted by time: the engine behind `countEvents` and the
 * in-memory stores and readers. Rows are in window order; within a window, groups in the order
 * their first event came, groups whose first events came at the same time by their tags.
 */
export const tally = <Item>(sorted: readonly Item[], eventOf: (item: Item) => LabeledEvent, query: Pick<CountQuery, "windows" | "signals" | "gates" | "per" | "where" | "exclude" | "groupBy">): CountRow[] => {
  const tests = query.signals.map((signal) => on(signal, query.gates));
  const k = tests.length;
  const where = query.where ? hasTags(query.where) : undefined;
  const exclude = query.exclude ? hasTags(query.exclude) : undefined;
  const grouping = groupKeyOf(query.groupBy);
  const perUnit = query.per === "unit";
  // Customers of an ungrouped count, numbered once per call: a stamp says which window last saw each.
  const ids = new Map<string, number>();
  let seen = new Int32Array(64);
  let said = new Uint8Array(64 * Math.max(k, 1));
  let stamp = 0;
  const idOf = (unit: string): number => {
    let id = ids.get(unit);
    if (id === undefined) {
      id = ids.size;
      ids.set(unit, id);
      if (id >= seen.length) {
        const grown = new Int32Array(seen.length * 2);
        grown.set(seen);
        seen = grown;
        const more = new Uint8Array(grown.length * Math.max(k, 1));
        more.set(said);
        said = more;
      }
    }
    return id;
  };
  const rows: CountRow[] = [];
  const atOf = (item: Item): number => eventOf(item).at;
  query.windows.forEach(({ from, to }, window) => {
    stamp += 1;
    const groups = new Map<string, Tally>();
    const single: Tally = { key: "", first: Infinity, total: 0, events: 0, yes: new Array<number>(k).fill(0) };
    for (let i = firstAtOrAfter(sorted, from, atOf), end = firstAtOrAfter(sorted, to, atOf); i < end; i += 1) {
      const event = eventOf(sorted[i]!);
      if ((where && !where(event)) || (exclude && exclude(event))) {
        continue;
      }
      let into = single;
      if (grouping) {
        const { key, group } = grouping(event);
        let found = groups.get(key);
        if (!found) {
          found = { group, key, first: event.at, total: 0, events: 0, yes: new Array<number>(k).fill(0), units: new Map() };
          groups.set(key, found);
        }
        into = found;
      }
      into.events += 1;
      if (!perUnit || event.unit == null) {
        into.total += 1;
        for (let s = 0; s < k; s += 1) {
          if (tests[s]!(event)) {
            into.yes[s]! += 1;
          }
        }
      } else if (into.units) {
        let marks = into.units.get(event.unit);
        if (!marks) {
          marks = new Uint8Array(k);
          into.units.set(event.unit, marks);
          into.total += 1;
        }
        for (let s = 0; s < k; s += 1) {
          if (marks[s] === 0 && tests[s]!(event)) {
            marks[s] = 1;
            into.yes[s]! += 1;
          }
        }
      } else {
        const id = idOf(event.unit);
        if (seen[id] !== stamp) {
          seen[id] = stamp;
          into.total += 1;
          said.fill(0, id * k, id * k + k);
        }
        for (let s = 0; s < k; s += 1) {
          if (said[id * k + s] === 0 && tests[s]!(event)) {
            said[id * k + s] = 1;
            into.yes[s]! += 1;
          }
        }
      }
    }
    const yesOf = (counted: Tally): Record<string, number> => Object.fromEntries(query.signals.map((signal, s) => [signal, counted.yes[s]!]));
    if (!grouping) {
      rows.push({ window, total: single.total, yes: yesOf(single), events: single.events });
      return;
    }
    for (const counted of [...groups.values()].sort((a, b) => a.first - b.first || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      rows.push({ window, group: counted.group!, total: counted.total, yes: yesOf(counted), events: counted.events });
    }
  });
  return rows;
};

/** The reference for `Store.count`, over every stored event in the order they were stored. */
export const countEvents = (stored: readonly LabeledEvent[], query: CountQuery): CountRow[] =>
  tally(answersOf(stored, query), (ranked) => ranked.event, query);

const surenessOf = (keys: readonly string[]) => (event: LabeledEvent): number => Math.min(...keys.map((key) => event.signals[key] ?? 0));

/** Whether an event passes `where` and `atLeast`. */
export const filterOf = ({ where, atLeast }: Pick<EventQuery, "where" | "atLeast">): ((event: LabeledEvent) => boolean) => {
  const tagged = where ? hasTags(where) : undefined;
  return (event) => (!tagged || tagged(event)) && (!atLeast || atLeast.some((entry) => Object.entries(entry).every(([key, gate]) => (event.signals[key] ?? 0) >= gate)));
};

/** Answers sorted oldest first, read one at a time: a store can hand over a stretch of what it keeps without copying it. */
export interface Run {
  length: number;
  at(index: number): Ranked;
}

export const runOf = (sorted: readonly Ranked[]): Run => ({ length: sorted.length, at: (index) => sorted[index]! });

/**
 * Applies `where`, `atLeast`, `order`, `onePerUnit` and `limit` to answers already chosen and
 * sorted oldest first. Stops early when the order allows.
 */
export const pick = (sorted: Run, query: Pick<EventQuery, "where" | "atLeast" | "order" | "onePerUnit" | "limit">): LabeledEvent[] => {
  const passes = filterOf(query);
  const limit = query.limit ?? Infinity;
  const order = query.order ?? "oldest";
  const units = new Set<string>();
  const first = (event: LabeledEvent): boolean => {
    if (!query.onePerUnit) {
      return true;
    }
    const who = event.unit ?? event.id;
    if (units.has(who)) {
      return false;
    }
    units.add(who);
    return true;
  };
  const out: LabeledEvent[] = [];
  if (typeof order === "object") {
    const sureness = surenessOf(order.surest);
    const passing: Ranked[] = [];
    for (let n = 0; n < sorted.length; n += 1) {
      const ranked = sorted.at(n);
      if (passes(ranked.event)) {
        passing.push(ranked);
      }
    }
    passing.sort((a, b) => sureness(b.event) - sureness(a.event) || b.event.at - a.event.at || a.rank - b.rank);
    for (const { event } of passing) {
      if (out.length >= limit) {
        break;
      }
      if (first(event)) {
        out.push(event);
      }
    }
    return out;
  }
  const newest = order === "newest";
  for (let n = 0; n < sorted.length && out.length < limit; n += 1) {
    const { event } = sorted.at(newest ? sorted.length - 1 - n : n);
    if (passes(event) && first(event)) {
      out.push(event);
    }
  }
  return out;
};

/** The reference for `Store.events`, over every stored event in the order they were stored. */
export const readEvents = (stored: readonly LabeledEvent[], query: EventQuery = {}): LabeledEvent[] => pick(runOf(answersOf(stored, query)), query);

/** The reference for `Store.labelers`. */
export const labelersOf = (stored: readonly LabeledEvent[], { schema, from, to, where }: LabelerQuery): Labelers => {
  const tagged = where ? hasTags(where) : () => true;
  const mine = answersOf(stored, { schema, from, to }).filter(({ event }) => tagged(event));
  const newest = mine.at(-1)?.event.labeler;
  return { labelers: [...new Set(mine.map(({ event }) => event.labeler))], ...(newest === undefined ? {} : { newest }) };
};
