// Helpers for tests and examples: a repeatable random source and made-up labeled streams.
import { HOUR } from "./types.ts";
import type { LabeledEvent, Tags } from "./types.ts";

/** A random source that gives the same numbers for the same seed. */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

type Over<Value> = Value | ((at: number, tags: Tags) => Value);
const at = <Value>(value: Over<Value>, time: number, tags: Tags): Value => (typeof value === "function" ? (value as (at: number, tags: Tags) => Value)(time, tags) : value);

/**
 * A labeled stream: `perHour` events in each hour, each signal yes with its own share. A yes is
 * stored as 0.95 and a no as 0.02. Shares, volume and tags may depend on the time.
 */
export const stream = ({ start, hours, perHour, signals, tags = () => ({}), random = seeded(1), schema = "test@1", prefix = "e" }: { start: number; hours: number; perHour: Over<number>; signals: Record<string, Over<number>>; tags?: (random: () => number, at: number) => Tags; random?: () => number; schema?: string; prefix?: string }): LabeledEvent[] => {
  const events: LabeledEvent[] = [];
  for (let hour = 0; hour < hours; hour += 1) {
    const from = start + hour * HOUR;
    for (let i = 0; i < at(perHour, from, {}); i += 1) {
      const time = from + Math.floor(random() * HOUR);
      const own = tags(random, time);
      events.push({
        id: `${prefix}${events.length}`,
        at: time,
        text: `message ${events.length}`,
        tags: own,
        schema,
        labeler: "test-labeler@1",
        probability: "native",
        signals: Object.fromEntries(Object.entries(signals).map(([key, share]) => [key, random() < at(share, time, own) ? 0.95 : 0.02])),
      });
    }
  }
  return events;
};
