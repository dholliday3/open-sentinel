// Helpers for tests and examples: a repeatable random source, made-up labeled streams, and the
// checks every store must pass.
import assert from "node:assert/strict";
import { countEvents, labelersOf, readEvents } from "./counting.ts";
import type { CountQuery, EventQuery, GroupBy, LabelerQuery } from "./counting.ts";
import { eventKey } from "./store.ts";
import type { Store } from "./store.ts";
import { HOUR } from "./types.ts";
import type { Gates, Interval, LabeledEvent, TagFilter, Tags } from "./types.ts";

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

const choose = <Value>(random: () => number, values: readonly Value[]): Value => values[Math.floor(random() * values.length)]!;
const some = <Value>(random: () => number, values: readonly Value[], p = 0.5): Value[] => values.filter(() => random() < p);

// Keys and values that are awkward in SQL and JSON paths: dots, quotes, `=`, `>=`, backslashes.
const SIGNAL_KEYS = ["a", "b", "area=x", "f>=2", 'say "hi"', "a.second", "back\\slash"] as const;
const TAG_VALUES: Record<string, ReadonlyArray<string | null>> = { platform: ["ios", "web", null], plan: ["pro", "free"], "v.x": ["1", "2"], 'it\'s "q"': ["o'k", 'say "x"'] };
// Around 0.5, the default gate, and around 0.05, the database stores' default hit floor.
const PROBABILITIES = [0, 0.03, 0.05, 0.05000000000000001, 0.3, 0.5, 0.5000000000000001, 0.7, 0.9, 1];
const GATES = [0, 0.05, 0.05000000000000001, 0.5, 0.7, 0.9, 1];

/**
 * A made-up store history that exercises every rule a count must keep: two schemas, three
 * labelers answering the same events (mostly at the same time, sometimes not), customers who
 * write often, events with no customer, missing tags and signals, and awkward keys. Appended in
 * batches, some late; `stored` is what a store keeps, in the order it keeps it.
 */
export const randomHistory = (random: () => number, size = 160): { batches: LabeledEvent[][]; stored: LabeledEvent[] } => {
  const events: LabeledEvent[] = [];
  const relabeled: LabeledEvent[] = [];
  for (let n = 0; n < size; n += 1) {
    const id = `e${Math.floor(random() * size * 0.6)}`;
    const at = random() < 0.5 ? Math.floor(random() * 20) * 100 : Math.floor(random() * 2000);
    const tags = Object.fromEntries(some(random, Object.keys(TAG_VALUES), 0.6).map((key) => [key, choose(random, TAG_VALUES[key]!)]));
    const signals = Object.fromEntries(some(random, SIGNAL_KEYS, 0.7).map((key) => [key, choose(random, PROBABILITIES)]));
    const schema = random() < 0.8 ? "t@1" : "t@2";
    const base: LabeledEvent = { id, at, schema, labeler: choose(random, ["l@1", "l@1", "l@2", "l@3"]), probability: "native", signals, ...(random() < 0.7 ? { unit: `u${Math.floor(random() * 8)}` } : {}), ...(random() < 0.8 ? { tags } : {}), ...(random() < 0.5 ? { text: `text ${n} "quoted" ${choose(random, ["", "\n", "é"])}` } : {}), ...(random() < 0.2 ? { context: { channel: "chat", n, nested: [1, { a: null }] } } : {}) };
    events.push(base);
    // The same event answered again by another labeler: at the same time, or now and then not;
    // straight away, or later, as a relabel of history would.
    if (random() < 0.3) {
      (random() < 0.5 ? events : relabeled).push({ ...base, labeler: choose(random, ["l@2", "l@3"]), at: random() < 0.15 ? Math.floor(random() * 2000) : at, signals: Object.fromEntries(Object.entries(signals).map(([key, p]) => [key, random() < 0.3 ? choose(random, PROBABILITIES) : p])) });
    }
  }
  events.push(...relabeled);
  const batches: LabeledEvent[][] = [];
  for (let i = 0; i < events.length; ) {
    const size = 1 + Math.floor(random() * 40);
    // Mostly in time order, with late ones: the order a pipeline stores them in.
    const batch = events.slice(i, i + size);
    batches.push(random() < 0.5 ? batch.sort((a, b) => a.at - b.at) : batch);
    i += size;
  }
  const seen = new Set<string>();
  const stored = batches.flat().filter((event) => !seen.has(eventKey(event)) && seen.add(eventKey(event)));
  return { batches, stored };
};

const randomWindow = (random: () => number): Interval => {
  const from = Math.floor(random() * 2200) - 100;
  return random() < 0.1 ? { from, to: from } : { from, to: from + Math.floor(random() * 900) };
};
const randomTags = (random: () => number): TagFilter => Object.fromEntries(some(random, Object.keys(TAG_VALUES), 0.4).flatMap((key) => TAG_VALUES[key]!.filter((value): value is string => value !== null).slice(0, 1 + Math.floor(random() * 2)).slice(-1).map((value) => [key, value])));
const randomGates = (random: () => number, floor = 0): Gates => Object.fromEntries(some(random, SIGNAL_KEYS, 0.3).map((key) => [key, choose(random, GATES.filter((gate) => gate >= floor))]));
const randomAnswers = (random: () => number): Pick<EventQuery, "labeler" | "oneAnswer"> => {
  const roll = random();
  if (roll < 0.3) {
    return { labeler: choose(random, ["l@1", "l@2", "l@3", "l@9"]) };
  }
  if (roll < 0.85) {
    const from = Math.floor(random() * 1500) - 100;
    return { oneAnswer: { prefer: choose(random, ["l@1", "l@2", "l@3", "l@9"]), from, to: random() < 0.2 ? Infinity : from + Math.floor(random() * 2200) } };
  }
  return {};
};

/** A count to check a store's `count` with: every option, in every combination, now and then. Its gates are at or above `floor`. */
export const randomCountQuery = (random: () => number, floor = 0): CountQuery => {
  const signals = some(random, ["a", "b", "a&b", "*", "area=x", "f>=2", 'say "hi"', "missing", "a&area=x&f>=2", "back\\slash"], 0.4);
  const groupBy = choose<GroupBy | undefined>(random, [undefined, undefined, { tags: ["platform"] }, { tags: ["platform", 'it\'s "q"'] }, { tagsExcept: ["v.x"] }, { tagsExcept: [] }, { tagsExcept: ["platform", "plan"] }]);
  const where = random() < 0.3 ? randomTags(random) : undefined;
  const exclude = random() < 0.25 ? randomTags(random) : undefined;
  return {
    schema: random() < 0.85 ? "t@1" : "t@2",
    ...randomAnswers(random),
    windows: Array.from({ length: Math.floor(random() * 5) }, () => randomWindow(random)),
    signals,
    ...(random() < 0.6 ? { gates: randomGates(random, floor) } : {}),
    per: random() < 0.6 ? "unit" : "event",
    ...(where ? { where } : {}),
    ...(exclude ? { exclude } : {}),
    ...(groupBy ? { groupBy } : {}),
  };
};

/** A read to check a store's `events` with. */
export const randomEventQuery = (random: () => number): EventQuery => {
  const window = randomWindow(random);
  const where = random() < 0.3 ? randomTags(random) : undefined;
  const atLeast = random() < 0.4 ? Array.from({ length: Math.floor(random() * 3) }, () => Object.fromEntries(some(random, SIGNAL_KEYS, 0.3).map((key) => [key, choose(random, [0, 0.03, 0.05, 0.5, 0.9, 1])]))) : undefined;
  const order = choose<EventQuery["order"]>(random, [undefined, "oldest", "newest", { surest: ["a"] }, { surest: ["a", "area=x"] }, { surest: ["missing"] }]);
  return {
    ...(random() < 0.8 ? { from: window.from } : {}),
    ...(random() < 0.8 ? { to: window.to } : {}),
    ...(random() < 0.85 ? { schema: random() < 0.85 ? "t@1" : "t@2" } : {}),
    ...randomAnswers(random),
    ...(where ? { where } : {}),
    ...(atLeast ? { atLeast } : {}),
    ...(order ? { order } : {}),
    ...(random() < 0.3 ? { onePerUnit: true } : {}),
    ...(random() < 0.5 ? { limit: Math.floor(random() * 6) } : {}),
  };
};

/** One check a store must pass: run it with any test runner, `test(check.name, check.run)`. */
export interface StoreCheck {
  name: string;
  run(): Promise<void>;
}

export interface StoreContractOptions {
  /**
   * The lowest gate the store counts at, for a store that keeps only answers at or above it (the
   * database stores' `hitFloor`). Counts are then checked with gates at or above it, and a count
   * with a gate below it must throw. Reads with `atLeast` must still answer any gate.
   */
  hitFloor?: number;
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
export const storeContract = (make: () => Store | Promise<Store>, { hitFloor = 0 }: StoreContractOptions = {}): StoreCheck[] => {
  const event = (id: string, at: number, extra: Partial<LabeledEvent> = {}): LabeledEvent => ({ id, at, text: `text ${id}`, schema: "t@1", labeler: "l@1", probability: "native", signals: { bug: 0.9 }, ...extra });
  /** A store filled with a random history, and the history as it should be kept. */
  const filled = async (store: Store, seed: number): Promise<{ stored: LabeledEvent[]; random: () => number }> => {
    const random = seeded(seed);
    const { batches, stored } = randomHistory(random);
    for (const batch of batches) {
      await store.append(batch);
    }
    return { stored, random };
  };
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
    "counts answers just under, at and just over its lowest gate, alone and joined, from each labeler": async (store) => {
      const floor = hitFloor > 0 ? hitFloor : 0.05;
      const near = [floor - 1e-9, floor, floor + 1e-9];
      const events = near.flatMap((a, i) =>
        near.flatMap((b, j) => ["l@1", "l@2"].map((labeler, k) => event(`e${i}${j}`, 10 * (i * 3 + j) + k, { labeler, unit: `u${(i + j) % 4}`, tags: { platform: k === 0 ? "ios" : "web" }, signals: k === 0 ? { a, b } : { a: b, b: a } }))),
      );
      await store.append(events);
      const query: CountQuery = { schema: "t@1", windows: [{ from: 0, to: 100 }, { from: 0, to: 45 }], signals: ["a", "b", "a&b", "*"], gates: { a: floor, b: floor + 1e-9 }, per: "unit" };
      for (const answers of [{ labeler: "l@1" }, { labeler: "l@2" }, { oneAnswer: { prefer: "l@2", from: 0, to: 100 } }]) {
        for (const per of ["unit", "event"] as const) {
          const asked = { ...query, ...answers, per, ...(per === "event" ? { groupBy: { tags: ["platform"] } } : { where: { platform: "web" } }) };
          assert.deepEqual(await store.count(asked), countEvents(events, asked), JSON.stringify(asked));
        }
      }
      const read: EventQuery = { schema: "t@1", labeler: "l@1", atLeast: [{ a: floor, b: floor }], order: { surest: ["a", "b"] } };
      assert.deepEqual(await store.events(read), readEvents(events, read));
      if (hitFloor > 0) {
        await assert.rejects(async () => store.count({ ...query, gates: { b: hitFloor / 2 } }), new RegExp(`gate ${hitFloor / 2} for "b" is below this store's hitFloor of ${hitFloor}`));
        // A read may go below the floor: it reads each event's answers instead.
        const below: EventQuery = { schema: "t@1", labeler: "l@1", atLeast: [{ a: 0, b: hitFloor / 2 }] };
        assert.deepEqual(await store.events(below), readEvents(events, below));
      }
    },
    "a change recorded again replaces the first": async (store) => {
      await store.recordChange({ id: "c1", at: 5, kind: "deploy", what: "v1" });
      await store.recordChange({ id: "c2", at: 15, kind: "flag", what: "on", scope: { "flag:x": "on" } });
      await store.recordChange({ id: "c1", at: 6, kind: "deploy", what: "v1, corrected" });
      assert.deepEqual((await store.changes()).map((c) => [c.id, c.what]), [["c1", "v1, corrected"], ["c2", "on"]]);
      assert.deepEqual((await store.changes({ from: 10 })).map((c) => c.id), ["c2"]);
      assert.deepEqual((await store.changes({ to: 15 })).map((c) => c.id), ["c1"]);
    },
    "says which labelers answered, as labelersOf does, and counts the same after a delete": async (store) => {
      const { stored, random } = await filled(store, 9);
      for (let n = 0; n < 40; n += 1) {
        const from = Math.floor(random() * 2200) - 100;
        const where = random() < 0.3 ? randomTags(random) : undefined;
        const query: LabelerQuery = { schema: random() < 0.85 ? "t@1" : "t@2", ...(random() < 0.8 ? { from, to: from + Math.floor(random() * 1200) } : {}), ...(where ? { where } : {}) };
        assert.deepEqual(await store.labelers(query), labelersOf(stored, query), JSON.stringify(query));
      }
      assert.equal(await store.delete({ unit: "u3" }), stored.filter((event) => event.unit === "u3").length);
      assert.equal(await store.delete({ before: 300 }), stored.filter((event) => event.unit !== "u3" && event.at < 300).length);
      const left = stored.filter((event) => event.unit !== "u3" && event.at >= 300);
      for (let n = 0; n < 40; n += 1) {
        const query = randomCountQuery(random, hitFloor);
        assert.deepEqual(await store.count(query), countEvents(left, query), JSON.stringify(query));
      }
      // An event deleted and stored again goes after everything stored before it.
      const again = stored.filter((event) => event.unit === "u3").slice(0, 5);
      await store.append(again);
      const query: EventQuery = { schema: "t@1" };
      assert.deepEqual(await store.events(query), readEvents([...left, ...again], query));
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
  // Each on a few histories, each in a store of its own: one history can miss a rule that only some orders of events test.
  const histories: Record<string, (make: () => Promise<Store>) => Promise<void>> = {
    "counts exactly what countEvents counts, on random histories": async (fresh) => {
      for (const seed of [7, 17, 29]) {
        // One event at a time this time: every late one goes in among those already kept.
        const random = seeded(seed);
        const { stored } = randomHistory(random);
        const store = await fresh();
        for (const event of stored) {
          await store.append([event]);
        }
        for (let n = 0; n < 100; n += 1) {
          const query = randomCountQuery(random, hitFloor);
          assert.deepEqual(await store.count(query), countEvents(stored, query), JSON.stringify(query));
        }
      }
    },
    "reads exactly what readEvents reads, on random histories": async (fresh) => {
      for (const seed of [7, 17, 29]) {
        const store = await fresh();
        const { stored, random } = await filled(store, seed);
        for (let n = 0; n < 100; n += 1) {
          const query = randomEventQuery(random);
          assert.deepEqual(await store.events(query), readEvents(stored, query), JSON.stringify(query));
        }
      }
    },
  };
  return [
    ...Object.entries(checks).map(([name, check]) => ({ name, run: async () => check(await make()) })),
    ...Object.entries(histories).map(([name, check]) => ({ name, run: async () => check(async () => make()) })),
  ];
};
