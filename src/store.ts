// Where labeled events, changes and the alerting loop's own state are kept. Implement `Store` to
// keep them in your own database; `memoryStore` is the reference and what tests use.
import type { Change, Json, LabeledEvent } from "./types.ts";

export interface EventQuery {
  from?: number;
  to?: number;
  /** Only events labeled under this schema id. */
  schema?: string;
  /** Only events answered by this labeler. */
  labeler?: string;
}

export interface Store {
  /**
   * Adds events. The same event may be stored once per schema and labeler, so history can be
   * labeled again under new wording or a new model without losing the old answers. An event
   * already stored under the same id, schema and labeler is left as it is.
   */
  append(events: readonly LabeledEvent[]): Promise<void>;
  /** Events with `from <= at < to`, oldest first. */
  events(query?: EventQuery): Promise<LabeledEvent[]>;
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

export const memoryStore = (seed: { events?: readonly LabeledEvent[]; changes?: readonly Change[]; state?: Readonly<Record<string, Json>> } = {}): Store => {
  const events = new Map<string, LabeledEvent>();
  const changes = new Map<string, Change>();
  const state = new Map<string, Json>(Object.entries(seed.state ?? {}));
  for (const event of seed.events ?? []) {
    events.set(eventKey(event), event);
  }
  for (const change of seed.changes ?? []) {
    changes.set(change.id, change);
  }
  return {
    append: async (added) => {
      for (const event of added) {
        const key = eventKey(event);
        if (!events.has(key)) {
          events.set(key, event);
        }
      }
    },
    events: async ({ from, to, schema, labeler } = {}) =>
      [...events.values()].filter((event) => inRange(event.at, from, to) && (schema === undefined || event.schema === schema) && (labeler === undefined || event.labeler === labeler)).sort((a, b) => a.at - b.at),
    known: async (ids, schema, labeler) => new Set(ids.filter((id) => events.has(eventKey({ id, schema, labeler })))),
    delete: async ({ before, unit }) => {
      if (before === undefined && unit === undefined) {
        return 0;
      }
      let removed = 0;
      for (const [key, event] of events) {
        if ((before === undefined || event.at < before) && (unit === undefined || event.unit === unit)) {
          events.delete(key);
          removed += 1;
        }
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
