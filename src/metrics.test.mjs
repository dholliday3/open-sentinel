import assert from "node:assert/strict";
import { test } from "node:test";
import { breakdown, count, countUnits, latestAnswers, movers, on, outside, series, viewOf } from "./metrics.ts";

const event = (id, at, signals, tags = {}) => ({ id, at, tags, schema: "t@1", labeler: "l", probability: "native", signals });
const events = [
  event("a", 100, { bug: 0.9, "area=login": 0.8 }, { platform: "ios" }),
  event("b", 200, { bug: 0.6, "area=login": 0.2 }, { platform: "web" }),
  event("c", 300, { bug: 0.1, "area=login": 0.9 }, { platform: "ios" }),
  event("d", 50, { bug: 0.95 }, { platform: null }),
];
const view = viewOf(events);

test("a view sorts by time and reads from <= at < to", () => {
  assert.deepEqual(view.events.map((e) => e.id), ["d", "a", "b", "c"]);
  assert.deepEqual(view.within({ from: 100, to: 300 }).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(view.within({ to: 100 }).map((e) => e.id), ["d"]);
  assert.deepEqual(view.within().length, 4);
  assert.deepEqual(view.within({ where: { platform: "ios" } }).map((e) => e.id), ["a", "c"]);
});

test("on applies each part's own gate", () => {
  assert.equal(on("bug")(events[1]), true);
  assert.equal(on("bug", { bug: 0.7 })(events[1]), false);
  assert.equal(on("bug&area=login")(events[0]), true);
  assert.equal(on("bug&area=login")(events[1]), false);
  assert.equal(on("bug&area=login", { bug: 0.95 })(events[0]), false);
  assert.equal(on("missing")(events[0]), false);
  assert.deepEqual(count(events, "*"), { yes: 4, total: 4 });
});

test("count, outside and series", () => {
  assert.deepEqual(count(events, "bug"), { yes: 3, total: 4 });
  assert.deepEqual(count(events, "bug", { bug: 0.9 }), { yes: 2, total: 4 });
  assert.deepEqual(outside(view.within(), [{ from: 90, to: 250 }]).map((e) => e.id), ["d", "c"]);
  assert.deepEqual(series(view, { signal: "bug", from: 0, to: 400, bucketMs: 200 }), [{ at: 0, yes: 2, total: 2 }, { at: 200, yes: 1, total: 2 }]);
});

test("countUnits counts each customer once, and events without a customer one by one", () => {
  const from = (id, unit, bug) => ({ ...event(id, 0, { bug }), ...(unit ? { unit } : {}) });
  const mixed = [from("1", "ann", 0.9), from("2", "ann", 0.9), from("3", "ann", 0.1), from("4", "bo", 0.1), from("5", "bo", 0.2), from("6", "cy", 0.1), from("7", "cy", 0.9), from("8", null, 0.9), from("9", null, 0.9), from("10", null, 0.1)];
  assert.deepEqual(count(mixed, "bug"), { yes: 5, total: 10 });
  assert.deepEqual(countUnits(mixed, "bug"), { yes: 4, total: 6 });
  assert.deepEqual(countUnits(events, "bug"), count(events, "bug"));
});

test("series refuses a bucket of no length", () => {
  assert.throws(() => series(view, { signal: "bug", from: 0, to: 400, bucketMs: 0 }), /longer than nothing/);
});

test("breakdown splits by a tag, counting events without it under null", () => {
  const rows = breakdown(view, { signal: "bug", by: "platform", from: 100, to: 400, baselineMs: 100 });
  assert.deepEqual(rows.find((r) => r.value === "ios"), { value: "ios", now: { yes: 1, total: 2 }, before: { yes: 0, total: 0 } });
  assert.deepEqual(rows.find((r) => r.value === null), { value: null, now: { yes: 0, total: 0 }, before: { yes: 1, total: 1 } });
});

test("movers puts the largest rise first", () => {
  const rows = movers(view, { signals: ["bug", "area=login"], from: 250, to: 400, baselineMs: 250 });
  assert.equal(rows[0].signal, "area=login");
  assert.ok(rows[0].lift > rows[1].lift);
});

test("latestAnswers keeps one set of answers per event: the labeler in use most recently", () => {
  const answered = (id, at, labeler, bug) => ({ id, at, schema: "t@1", labeler, probability: "native", signals: { bug } });
  // Three events answered by v1; history labeled again by v2, which is also what answers new events.
  const stored = [answered("a", 100, "v1", 0.9), answered("b", 200, "v1", 0.8), answered("c", 300, "v1", 0.7), answered("a", 100, "v2", 0.2), answered("b", 200, "v2", 0.3), answered("d", 400, "v2", 0.6)];
  assert.deepEqual(latestAnswers(stored).map((e) => [e.id, e.labeler, e.signals.bug]).sort(), [["a", "v2", 0.2], ["b", "v2", 0.3], ["c", "v1", 0.7], ["d", "v2", 0.6]]);
  // One labeler throughout: nothing to choose between.
  assert.equal(latestAnswers(stored.slice(0, 3)).length, 3);
  // The same id under two schemas is two different measurements, and both stay.
  assert.equal(latestAnswers([answered("a", 100, "v1", 0.9), { ...answered("a", 100, "v1", 0.4), schema: "t@2" }]).length, 2);
});
