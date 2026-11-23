// Where labeled events, changes and the alerting loop's own state are kept. Implement `Store` to
// keep them in your own database; `memoryStore` is the reference and what tests use. A store
// counts where the data lives (`count`), so the watch never reads its lookback into memory.
import { firstAtOrAfter, keepOne, pick, runOf, tally } from "./counting.ts";
import type { CountQuery, CountRow, EventQuery, LabelerQuery, Labelers, OneAnswer, Ranked, Run } from "./counting.ts";
import { hasTags } from "./metrics.ts";
import type { Change, Json, LabeledEvent } from "./types.ts";

export interface Store {
  /**
   * Adds events. The same event may be stored once per schema and labeler, so history can be
   * labeled again under new wording or a new model without losing the old answers. An event
   * already stored under the same id, schema and labeler is left as it is.
   */
  append(events: readonly LabeledEvent[]): Promise<void>;
  /** Events with `from <= at < to`, oldest first unless `order` says otherwise, events at the same time in the order they were stored. */
  events(query?: EventQuery): Promise<LabeledEvent[]>;
  /**
   * Counts in many windows at once, without reading the events out: what monitors run on. Must
   * give exactly what `countEvents` gives over the same events in the order they were stored.
   */
  count(query: CountQuery): Promise<CountRow[]>;
  /** Which labelers answered a schema's events in a range, by first answer, and whose answer is newest. */
  labelers(query: LabelerQuery): Promise<Labelers>;
  /** Which of these ids are already stored under this schema and labeler. One call per batch. */
  known(ids: readonly string[], schema: string, labeler: string): Promise<Set<string>>;
  /**
   * Removes events for good and says how many: everything before a time (retention), everything
   * from one unit (a customer who asked to be forgotten), or both at once.
   */
  delete(query: { before?: number; unit?: string }): Promise<number>;
  /** Adds a change, or replaces the one with the same id. */
  recordChange(change: Change): Promise<void>;
  changes(query?: { from?: number; to?: number }): Promise<Change[]>;
  /**
   * A small value kept under a key. The alerting loop keeps its episodes and undelivered notices
   * here, so a process that starts fresh on every run (a cron job) carries on where it left off.
   */
  loadState(key: string): Promise<Json | undefined>;
  saveState(key: string, value: Json): Promise<void>;
}

const inRange = (at: number, from = -Infinity, to = Infinity): boolean => at >= from && at < to;

/** What makes a stored event the same event: its id, the wording asked, and who answered. */
export const eventKey = (event: Pick<LabeledEvent, "id" | "schema" | "labeler">): string => `${event.schema}\n${event.labeler}\n${event.id}`;

/** One schema's events from one labeler, sorted by time and then by the order they were stored. */
interface Column {
  events: LabeledEvent[];
  ranks: number[];
}

const atOfRanked = (ranked: Ranked): number => ranked.event.at;
const atRanked = (ranked: Ranked): LabeledEvent => ranked.event;
const byTimeThenRank = (a: Ranked, b: Ranked): number => a.event.at - b.event.at || a.rank - b.rank;
/** Where `at` first passes `time` in events sorted by time. */
const firstAfter = (sorted: readonly LabeledEvent[], time: number): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]!.at <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

/**
 * Keeps everything in memory, sorted by time per schema and labeler, so a count or a bounded
 * read touches only the events in its windows.
 */
export const memoryStore = (seed: { events?: readonly LabeledEvent[]; changes?: readonly Change[]; state?: Readonly<Record<string, Json>> } = {}): Store => {
  const stored = new Map<string, { event: LabeledEvent; rank: number }>();
  const columns = new Map<string, Map<string, Column>>();
  const changes = new Map<string, Change>();
  const state = new Map<string, Json>(Object.entries(seed.state ?? {}));
  let next = 0;
  // Bumped on every write, so what one answer per event was worked out from can be reused until then.
  let version = 0;
  let decided: { key: string; answers: Ranked[] } | undefined;

  const columnOf = (schema: string, labeler: string): Column => {
    let bySchema = columns.get(schema);
    if (!bySchema) {
      bySchema = new Map();
      columns.set(schema, bySchema);
    }
    let column = bySchema.get(labeler);
    if (!column) {
      column = { events: [], ranks: [] };
      bySchema.set(labeler, column);
    }
    return column;
  };
  const add = (added: readonly LabeledEvent[]): void => {
    const touched = new Map<Column, Ranked[]>();
    for (const event of added) {
      const key = eventKey(event);
      if (stored.has(key)) {
        continue;
      }
      const entry = { event, rank: next++ };
      stored.set(key, entry);
      const column = columnOf(event.schema, event.labeler);
      const batch = touched.get(column);
      if (batch) {
        batch.push(entry);
      } else {
        touched.set(column, [entry]);
      }
    }
    for (const [column, entries] of touched) {
      const inOrder = entries.every((entry, i) => entry.event.at >= (i === 0 ? (column.events.at(-1)?.at ?? -Infinity) : entries[i - 1]!.event.at));
      if (inOrder) {
        for (const { event, rank } of entries) {
          column.events.push(event);
          column.ranks.push(rank);
        }
      } else if (entries.length < 64) {
        // A few late events: each goes in after everything stored at or before its time.
        for (const { event, rank } of entries) {
          const place = firstAfter(column.events, event.at);
          column.events.splice(place, 0, event);
          column.ranks.splice(place, 0, rank);
        }
      } else {
        const all = [...column.events.map((event, i) => ({ event, rank: column.ranks[i]! })), ...entries].sort(byTimeThenRank);
        column.events = all.map((entry) => entry.event);
        column.ranks = all.map((entry) => entry.rank);
      }
    }
    version += 1;
  };
  const slice = (column: Column, from = -Infinity, to = Infinity): Ranked[] => {
    const out: Ranked[] = [];
    for (let i = firstAtOrAfter(column.events, from, (e) => e.at), end = firstAtOrAfter(column.events, to, (e) => e.at); i < end; i += 1) {
      out.push({ event: column.events[i]!, rank: column.ranks[i]! });
    }
    return out;
  };
  const columnsFor = (schema?: string, labeler?: string): Column[] =>
    [...columns.entries()].filter(([name]) => schema === undefined || name === schema).flatMap(([, bySchema]) => [...bySchema.entries()].filter(([name]) => labeler === undefined || name === labeler).map(([, column]) => column));
  const merged = (from: readonly Column[], range: { from?: number; to?: number }): Ranked[] => {
    const all = from.flatMap((column) => slice(column, range.from, range.to));
    return from.length > 1 ? all.sort(byTimeThenRank) : all;
  };
  /** One answer per event over a stretch: worked out once per stretch and write. */
  const oneAnswerOf = (schema: string | undefined, rule: OneAnswer): Ranked[] => {
    const key = `${schema ?? ""}\n${rule.prefer}\n${rule.from}\n${rule.to}\n${version}`;
    if (decided?.key !== key) {
      decided = { key, answers: keepOne(merged(columnsFor(schema), rule), rule.prefer) };
    }
    return decided.answers;
  };
  /** The answers a query sees, oldest first: one labeler's straight from where they are kept, without a copy. */
  const answers = (query: EventQuery): Run => {
    if (query.labeler === undefined && query.oneAnswer !== undefined) {
      const all = oneAnswerOf(query.schema, query.oneAnswer);
      const from = firstAtOrAfter(all, query.from ?? -Infinity, atOfRanked);
      return { length: Math.max(0, firstAtOrAfter(all, query.to ?? Infinity, atOfRanked) - from), at: (index) => all[from + index]! };
    }
    const mine = columnsFor(query.schema, query.labeler);
    if (mine.length !== 1) {
      return runOf(merged(mine, query));
    }
    const column = mine[0]!;
    const from = firstAtOrAfter(column.events, query.from ?? -Infinity, (e) => e.at);
    const length = Math.max(0, firstAtOrAfter(column.events, query.to ?? Infinity, (e) => e.at) - from);
    return { length, at: (index) => ({ event: column.events[from + index]!, rank: column.ranks[from + index]! }) };
  };

  add(seed.events ?? []);
  for (const change of seed.changes ?? []) {
    changes.set(change.id, change);
  }
  return {
    append: async (added) => {
      add(added);
    },
    events: async (query = {}) => pick(answers(query), query),
    count: async (query) => {
      if (query.windows.length === 0) {
        return [];
      }
      if (query.labeler === undefined && query.oneAnswer !== undefined) {
        return tally(oneAnswerOf(query.schema, query.oneAnswer), atRanked, query);
      }
      const mine = columnsFor(query.schema, query.labeler);
      return mine.length === 1 ? tally(mine[0]!.events, (event) => event, query) : tally(merged(mine, {}), atRanked, query);
    },
    labelers: async ({ schema, from, to, where }) => {
      const firsts: Array<{ labeler: string; first: Ranked; last: Ranked }> = [];
      const tagged = where ? hasTags(where) : undefined;
      for (const [labeler, column] of columns.get(schema) ?? []) {
        const within = tagged ? slice(column, from, to).filter(({ event }) => tagged(event)) : undefined;
        const lo = firstAtOrAfter(column.events, from ?? -Infinity, (e) => e.at);
        const hi = firstAtOrAfter(column.events, to ?? Infinity, (e) => e.at);
        const first = within ? within[0] : lo < hi ? { event: column.events[lo]!, rank: column.ranks[lo]! } : undefined;
        const last = within ? within.at(-1) : lo < hi ? { event: column.events[hi - 1]!, rank: column.ranks[hi - 1]! } : undefined;
        if (first && last) {
          firsts.push({ labeler, first, last });
        }
      }
      const newest = firsts.reduce<(typeof firsts)[number] | undefined>((best, one) => (!best || byTimeThenRank(one.last, best.last) > 0 ? one : best), undefined)?.labeler;
      return { labelers: firsts.sort((a, b) => byTimeThenRank(a.first, b.first)).map((one) => one.labeler), ...(newest === undefined ? {} : { newest }) };
    },
    known: async (ids, schema, labeler) => new Set(ids.filter((id) => stored.has(eventKey({ id, schema, labeler })))),
    delete: async ({ before, unit }) => {
      if (before === undefined && unit === undefined) {
        return 0;
      }
      let removed = 0;
      for (const [key, { event }] of stored) {
        if ((before === undefined || event.at < before) && (unit === undefined || event.unit === unit)) {
          stored.delete(key);
          removed += 1;
        }
      }
      if (removed > 0) {
        for (const bySchema of columns.values()) {
          for (const column of bySchema.values()) {
            const kept = column.events.flatMap((event, i) => (stored.has(eventKey(event)) ? [i] : []));
            column.events = kept.map((i) => column.events[i]!);
            column.ranks = kept.map((i) => column.ranks[i]!);
          }
        }
        version += 1;
      }
      return removed;
    },
    recordChange: async (change) => {
      changes.set(change.id, change);
    },
    changes: async ({ from, to } = {}) => [...changes.values()].filter((change) => inRange(change.at, from, to)).sort((a, b) => a.at - b.at),
    loadState: async (key) => state.get(key),
    saveState: async (key, value) => {
      state.set(key, value);
    },
  };
};
