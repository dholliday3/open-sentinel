// The counts and reads a store answers must equal what the watch computed when it read every
// event into memory: one answer per event (`latestAnswers`), a view, and `count`/`countUnits`
// over it. These hold the reference functions to that, on random histories; `storeContract`
// then holds every store to the reference functions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countEvents, labelersOf, readEvents } from "./counting.ts";
import { atLeastOf, count, countUnits, hasTags, latestAnswers, on, viewOf } from "./metrics.ts";
import { memoryReader } from "./reader.ts";
import { randomCountQuery, randomHistory, seeded } from "./testing.ts";

// How exposure grouped events before it counted through stores: kept here as the oracle.
const kindsOf = (events, scoped) => {
  const kinds = new Map();
  for (const event of events) {
    const kind = JSON.stringify(Object.entries(event.tags ?? {}).filter(([key]) => !scoped.has(key)).sort(([a], [b]) => (a < b ? -1 : 1)));
    kinds.set(kind, [...(kinds.get(kind) ?? []), event]);
  }
  return kinds;
};
const byValue = (events, by) => {
  const values = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.tags?.[by] ?? null]);
    values.set(key, [...(values.get(key) ?? []), event]);
  }
  return values;
};

/** A watch's lookback the way it was read: the schema's events in the span, one answer each, as a view. */
const lookback = (stored, { schema, labeler, span }) => {
  const read = stored.filter((event) => event.schema === schema && (labeler === undefined || event.labeler === labeler) && event.at >= span.from && event.at < span.to);
  return viewOf(latestAnswers(read.map((event, rank) => ({ event, rank })).sort((a, b) => a.event.at - b.event.at || a.rank - b.rank).map(({ event }) => event)));
};
/** The same answers as a store is asked for them: one labeler's, or one per event, the newest labeler's where it answered. */
const answersFor = (stored, { schema, labeler, span }) => {
  if (labeler !== undefined) {
    return { labeler };
  }
  const { newest } = labelersOf(stored, { schema, ...span });
  return { oneAnswer: { prefer: newest ?? "nobody", ...span } };
};

for (const seed of [1, 2, 3, 4, 5, 6]) {
  test(`counts equal what the watch counted over a view, history ${seed}`, () => {
    const random = seeded(seed);
    const { stored } = randomHistory(random, 220);
    for (let n = 0; n < 120; n += 1) {
      const query = randomCountQuery(random);
      const from = Math.floor(random() * 1500) - 100;
      const scope = { schema: query.schema, labeler: random() < 0.25 ? "l@2" : undefined, span: { from, to: from + 300 + Math.floor(random() * 2000) } };
      const view = lookback(stored, scope);
      const windows = query.windows.map((w) => ({ from: Math.max(w.from, scope.span.from), to: Math.min(w.to, scope.span.to) }));
      const { labeler: _labeler, oneAnswer: _oneAnswer, ...rest } = query;
      const rows = countEvents(stored, { ...rest, ...answersFor(stored, scope), windows });
      const tallyOf = query.per === "unit" ? countUnits : count;
      const keep = (event) => (!query.where || hasTags(query.where)(event)) && (!query.exclude || !hasTags(query.exclude)(event));
      windows.forEach((window, i) => {
        const events = view.within(window).filter(keep);
        const mine = rows.filter((row) => row.window === i);
        if (!query.groupBy) {
          assert.equal(mine.length, 1);
          for (const signal of query.signals) {
            assert.deepEqual({ yes: mine[0].yes[signal], total: mine[0].total }, tallyOf(events, signal, query.gates), `${signal} ${JSON.stringify(query)}`);
          }
          assert.equal(mine[0].events, events.length);
          return;
        }
        const groups = "tagsExcept" in query.groupBy ? kindsOf(events, new Set(query.groupBy.tagsExcept)) : query.groupBy.tags.length === 1 ? byValue(events, query.groupBy.tags[0]) : undefined;
        if (!groups) {
          return;
        }
        assert.equal(mine.length, groups.size, JSON.stringify(query));
        for (const row of mine) {
          const key = "tagsExcept" in query.groupBy ? JSON.stringify(Object.entries(row.group).sort(([a], [b]) => (a < b ? -1 : 1))) : JSON.stringify([row.group[query.groupBy.tags[0]]]);
          const members = groups.get(key);
          assert.ok(members, key);
          assert.equal(row.events, members.length);
          for (const signal of query.signals) {
            assert.deepEqual({ yes: row.yes[signal], total: row.total }, tallyOf(members, signal, query.gates));
          }
        }
      });
    }
  });
}

test("a memory reader counts every event it is given, as a view did, copies and all", async () => {
  const random = seeded(11);
  const { stored } = randomHistory(random, 220);
  const reader = memoryReader(stored);
  const view = viewOf(stored);
  for (let n = 0; n < 100; n += 1) {
    const { windows, signals, gates, per, where } = randomCountQuery(random);
    const rows = await reader.count({ windows, signals, gates, per, ...(where ? { where } : {}) });
    windows.forEach((window, i) => {
      for (const signal of signals) {
        assert.deepEqual({ yes: rows[i].yes[signal], total: rows[i].total }, (per === "unit" ? countUnits : count)(view.within({ ...window, where }), signal, gates));
      }
    });
  }
  assert.equal(await reader.firstAt(), view.events[0].at);
});

test("bounded reads equal what the watch read from a view: examples, one-event hits, the newest messages, the first event", () => {
  for (const seed of [21, 22, 23, 24]) {
    const random = seeded(seed);
    const { stored } = randomHistory(random, 220);
    for (let n = 0; n < 80; n += 1) {
      const from = Math.floor(random() * 1200);
      const scope = { schema: "t@1", labeler: random() < 0.25 ? "l@3" : undefined, span: { from, to: from + 400 + Math.floor(random() * 1500) } };
      const view = lookback(stored, scope);
      const read = (query) => readEvents(stored, { schema: scope.schema, ...answersFor(stored, scope), ...query });
      const window = { from: scope.span.from + Math.floor(random() * 300), to: scope.span.to - Math.floor(random() * 300) };
      const where = random() < 0.4 ? { platform: random() < 0.5 ? "ios" : "web" } : undefined;
      const signal = ["a", "a&area=x", "f>=2", "b&a"][n % 4];
      const gates = random() < 0.5 ? { a: 0.7 } : {};
      const limit = Math.floor(random() * 5);

      // A notice's examples: the surest yeses, one per customer.
      const keys = signal.split("&");
      const sureness = (event) => Math.min(...keys.map((key) => event.signals[key] ?? 0));
      const customers = new Set();
      const examples = view
        .within({ ...window, where })
        .filter(on(signal, gates))
        .sort((a, b) => sureness(b) - sureness(a) || b.at - a.at)
        .filter((event) => !customers.has(event.unit ?? event.id) && customers.add(event.unit ?? event.id))
        .slice(0, limit);
      assert.deepEqual(read({ ...window, ...(where ? { where } : {}), atLeast: atLeastOf(signal, gates), order: { surest: keys }, onePerUnit: true, limit }), examples);

      // A one-event monitor's hits, with a second reader.
      const hits = view.within(window).filter((event) => (event.signals.a ?? 0) >= 0.9 || ((event.signals.a ?? 0) >= 0.5 && (event.signals["a.second"] ?? 0) >= 0.5));
      assert.deepEqual(read({ ...window, atLeast: [{ a: 0.9 }, { a: 0.5, "a.second": 0.5 }] }), hits);

      // The investigator's newest messages.
      assert.deepEqual(read({ ...window, atLeast: atLeastOf(signal, gates), order: "newest", limit }), view.within(window).filter(on(signal, gates)).reverse().slice(0, limit));

      // Where baselines may begin.
      assert.equal(read({ ...scope.span, limit: 1 })[0]?.at, view.events[0]?.at);
    }
  }
});

test("the labelers a watch saw, in the order it saw them, and the one behind the newest event", () => {
  for (const seed of [31, 32, 33]) {
    const random = seeded(seed);
    const { stored } = randomHistory(random, 220);
    for (let n = 0; n < 40; n += 1) {
      const from = Math.floor(random() * 1500);
      const span = { from, to: from + Math.floor(random() * 1500) };
      const read = stored.filter((event) => event.schema === "t@1" && event.at >= span.from && event.at < span.to).map((event, rank) => ({ event, rank })).sort((a, b) => a.event.at - b.event.at || a.rank - b.rank).map(({ event }) => event);
      const newest = read.reduce((last, event) => (last === undefined || event.at >= last.at ? event : last), undefined)?.labeler;
      assert.deepEqual(labelersOf(stored, { schema: "t@1", ...span }), { labelers: [...new Set(read.map((event) => event.labeler))], ...(newest === undefined ? {} : { newest }) });
    }
  }
});
