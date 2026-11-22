// Helpers for tests and examples: a repeatable random source, made-up labeled streams, and the
// checks every store must pass.
import assert from "node:assert/strict";
import type { Store } from "./store.ts";
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

/** One check a store must pass: run it with any test runner, `test(check.name, check.run)`. */
export interface StoreCheck {
  name: string;
  run(): Promise<void>;
}

/**
 * What every `Store` must do, as checks to hand to your test runner. `make` is called once per
 * check and must give an empty store each time. The built-in stores run these in
 * `src/store.test.mjs`; run them against your own:
 *
 *   for (const { name, run } of storeContract(() => postgresStore(freshSchema()))) test(name, run);
 *
 * They throw node:assert errors, which every test runner on Node reports as a failure.
 */
export const storeContract = (make: () => Store | Promise<Store>): StoreCheck[] => {
  const event = (id: string, at: number, extra: Partial<LabeledEvent> = {}): LabeledEvent => ({ id, at, text: `text ${id}`, schema: "t@1", labeler: "l@1", probability: "native", signals: { bug: 0.9 }, ...extra });
  const checks: Record<string, (store: Store) => Promise<void>> = {
    "keeps the first copy of an event, per schema and labeler": async (store) => {
      await store.append([event("a", 10), event("b", 20)]);
      // The same event again is ignored; under other wording or from another labeler it is a new record.
      await store.append([event("a", 10, { signals: { bug: 0.1 } }), event("a", 10, { schema: "t@2", signals: { bug: 0.3 } }), event("a", 10, { labeler: "l@2", signals: { bug: 0.6 } })]);
      assert.deepEqual((await store.events({ schema: "t@1", labeler: "l@1" })).map((e) => [e.id, e.signals.bug]), [["a", 0.9], ["b", 0.9]]);
      assert.deepEqual((await store.events({ schema: "t@2" })).map((e) => e.signals.bug), [0.3]);
      assert.deepEqual((await store.events({ labeler: "l@2" })).map((e) => e.signals.bug), [0.6]);
      assert.equal((await store.events()).length, 4);
    },
    "says which of a batch it already has, in one call": async (store) => {
      await store.append([event("a", 10), event("b", 20), event("c", 30, { labeler: "l@2" })]);
      assert.deepEqual([...(await store.known(["a", "b", "c", "d"], "t@1", "l@1"))].sort(), ["a", "b"]);
      assert.deepEqual([...(await store.known(["a", "c"], "t@1", "l@2"))], ["c"]);
      assert.deepEqual([...(await store.known(["a"], "t@2", "l@1"))], []);
    },
    "reads from <= at < to, oldest first": async (store) => {
      await store.append([event("c", 30), event("a", 10), event("b", 20)]);
      assert.deepEqual((await store.events({ from: 10, to: 30 })).map((e) => e.id), ["a", "b"]);
    },
    "deletes by age, by customer, or both, and says how many": async (store) => {
      await store.append([event("a", 10, { unit: "acct-1" }), event("b", 20, { unit: "acct-2" }), event("c", 30, { unit: "acct-1" }), event("d", 40)]);
      // Nothing named, nothing deleted.
      assert.equal(await store.delete({}), 0);
      assert.equal(await store.delete({ before: 25, unit: "acct-1" }), 1);
      assert.deepEqual((await store.events()).map((e) => e.id), ["b", "c", "d"]);
      assert.equal(await store.delete({ unit: "acct-1" }), 1);
      assert.equal(await store.delete({ before: 40 }), 1);
      assert.deepEqual((await store.events()).map((e) => e.id), ["d"]);
      // A deleted event can be stored again.
      assert.deepEqual([...(await store.known(["a"], "t@1", "l@1"))], []);
    },
    "a change recorded again replaces the first": async (store) => {
      await store.recordChange({ id: "c1", at: 5, kind: "deploy", what: "v1" });
      await store.recordChange({ id: "c2", at: 15, kind: "flag", what: "on", scope: { "flag:x": "on" } });
      await store.recordChange({ id: "c1", at: 6, kind: "deploy", what: "v1, corrected" });
      assert.deepEqual((await store.changes()).map((c) => [c.id, c.what]), [["c1", "v1, corrected"], ["c2", "on"]]);
      assert.deepEqual((await store.changes({ from: 10 })).map((c) => c.id), ["c2"]);
      assert.deepEqual((await store.changes({ to: 15 })).map((c) => c.id), ["c1"]);
    },
    "keeps a small value under a key": async (store) => {
      assert.equal(await store.loadState("watch:t"), undefined);
      await store.saveState("watch:t", { since: 5, open: {} });
      await store.saveState("other", [1, 2]);
      await store.saveState("watch:t", { since: 6, open: { a: { firstAt: 1 } } });
      assert.deepEqual(await store.loadState("watch:t"), { since: 6, open: { a: { firstAt: 1 } } });
      assert.deepEqual(await store.loadState("other"), [1, 2]);
    },
  };
  return Object.entries(checks).map(([name, check]) => ({ name, run: async () => check(await make()) }));
};
