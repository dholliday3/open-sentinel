import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateOnset, exposureOf, onsetOfEvent, rankChanges, suspectsFor } from "./changes.ts";
import { viewOf } from "./metrics.ts";
import { stream } from "./testing.ts";
import { DAY, HOUR } from "./types.ts";

const START = 6 * DAY + 10 * HOUR;
const stepped = viewOf(stream({ start: 0, hours: 8 * 24, perHour: 25, signals: { bug: (at) => (at >= START ? 0.5 : 0.05) } }));
const change = (id, at, extra = {}) => ({ id, at, kind: "deploy", what: id, ...extra });

test("estimateOnset finds when a share stepped up", () => {
  const onset = estimateOnset(stepped, { signal: "bug", until: START + 6 * HOUR, lookbackMs: 5 * DAY });
  assert.ok(Math.abs(onset.at - START) <= HOUR, `off by ${(onset.at - START) / HOUR} hours`);
  assert.ok(onset.high - onset.low <= 2 * HOUR);
  assert.ok(Math.abs(onset.splits.reduce((sum, s) => sum + s.weight, 0) - 1) < 1e-9);
});

test("estimateOnset gives a slow ramp a wide range, and nothing when there is no rise", () => {
  const ramp = viewOf(stream({ start: 0, hours: 8 * 24, perHour: 25, signals: { bug: (at) => 0.05 + 0.25 * Math.max(0, (at - 4 * DAY) / (4 * DAY)) } }));
  const onset = estimateOnset(ramp, { signal: "bug", until: 8 * DAY, lookbackMs: 7 * DAY });
  assert.ok(onset.high - onset.low >= 6 * HOUR, `range ${(onset.high - onset.low) / HOUR} hours`);
  const falling = viewOf(stream({ start: 0, hours: 48, perHour: 25, signals: { bug: (at) => (at < DAY ? 1 : 0) } }));
  assert.equal(estimateOnset(falling, { signal: "bug", until: 2 * DAY, lookbackMs: 2 * DAY }), null);
});

test("by time alone: the change just before a sharp start leads, unless another sits beside it", () => {
  const onset = estimateOnset(stepped, { signal: "bug", until: START + 6 * HOUR, lookbackMs: 5 * DAY });
  const options = { signal: "bug", onset, until: START + 6 * HOUR };
  const alone = rankChanges(stepped, [change("cause", START - HOUR / 2), change("yesterday", START - 26 * HOUR), change("after", START + 4 * HOUR)], options);
  // A change after the likely start stays on the list with almost no weight: the start is an estimate.
  assert.deepEqual(alone.ranked.map((s) => s.change.id), ["cause", "yesterday", "after"]);
  assert.ok(alone.ranked[0].time > 0.9 && alone.ranked[1].time < 0.1 && alone.ranked[2].time < 1e-6);
  assert.equal(alone.confident, true);
  assert.equal(alone.ranked[0].exposure, null);
  const crowded = rankChanges(stepped, [change("cause", START - HOUR / 2), change("neighbour", START - HOUR)], options);
  assert.equal(crowded.confident, false);
});

test("exposure outranks time: the change whose events carry the signal wins from a day away", () => {
  const view = viewOf(stream({ start: 0, hours: 8 * 24, perHour: 25, tags: (random, at) => ({ version: at >= 5 * DAY && random() < 0.4 ? "2.0" : "1.9" }), signals: { bug: (at, tags) => (tags.version === "2.0" && at >= START ? 0.6 : 0.05) } }));
  const until = START + 8 * HOUR;
  const onset = estimateOnset(view, { signal: "bug", until, lookbackMs: 5 * DAY });
  const { ranked, confident } = rankChanges(view, [change("config tweak", START - HOUR / 2), change("release 2.0", 5 * DAY, { scope: { version: "2.0" } })], { signal: "bug", onset, until });
  assert.equal(ranked[0].change.id, "release 2.0");
  assert.ok(ranked[0].exposure.evidence > 10 && ranked[0].exposure.contrast.p < 1e-6, JSON.stringify(ranked[0].exposure));
  assert.equal(confident, true);
  // A scoped change whose events look like everyone else's is pushed down, not up.
  const innocent = rankChanges(stepped, [change("cause", START - HOUR / 2), change("flag", START - HOUR, { scope: { version: "9" } })], { signal: "bug", onset: estimateOnset(stepped, { signal: "bug", until, lookbackMs: 5 * DAY }), until });
  assert.equal(innocent.ranked[0].change.id, "cause");
});

test("one event never gives a confident match on time alone", () => {
  const { ranked, confident } = rankChanges(stepped, [change("an hour before", START - HOUR)], { signal: "bug", onset: onsetOfEvent(START), until: START + HOUR, single: true });
  assert.equal(ranked.length, 1);
  assert.equal(confident, false);
});

test("suspectsFor reads the alert: a share alert, a one-event alert, or nothing to trace", () => {
  const changes = [change("cause", START - HOUR / 2), change("later", START + 30 * HOUR)];
  const share = suspectsFor({ id: "m@1", monitor: "m", severity: "page", signal: "bug", at: START + 6 * HOUR, windowMs: 3 * HOUR, detail: {} }, stepped, changes);
  assert.equal(share.ranked[0].change.id, "cause");
  assert.equal(share.ranked.length, 1);
  const single = suspectsFor({ id: "m@e", monitor: "m", severity: "page", signal: "bug", at: START + 6 * HOUR, windowMs: 0, event: { id: "e", at: START + 5 * HOUR }, detail: {} }, stepped, changes);
  assert.equal(single.confident, false);
  assert.equal(single.onset.at, START + 5 * HOUR);
  assert.equal(suspectsFor({ id: "v@1", monitor: "volume", severity: "page", at: START, windowMs: 0, detail: {} }, stepped, changes), null);
  // Total volume has no share to trace a rise in.
  assert.equal(suspectsFor({ id: "v@2", monitor: "volume", severity: "page", signal: "*", at: START, windowMs: 0, detail: {} }, stepped, changes), null);
});

test("exposure counts only when the events a change reached rose against their own kind before", () => {
  // iOS customers always report more bugs. A release reaches them (only they can be on it), and breaks nothing.
  const release = change("ios 4.12", 5 * DAY, { scope: { app_version: "4.12.0" } });
  const tags = (random, at) => (random() < 0.3 ? { platform: "ios", app_version: at >= 5 * DAY ? "4.12.0" : "4.11.3" } : { platform: "web" });
  const always = viewOf(stream({ start: 0, hours: 7 * 24, perHour: 30, tags, signals: { bug: (_at, own) => (own.platform === "ios" ? 0.3 : 0.05) } }));
  const blameless = exposureOf(always, release, { signal: "bug", until: 7 * DAY });
  // Against the rest it looks damning; against iOS the week before, nothing moved.
  assert.ok(blameless.contrast.evidence > 20);
  assert.ok(Math.abs(blameless.rise.evidence) < 3, `rise ${blameless.rise.evidence}`);
  assert.ok(blameless.evidence < 3);
  // Whole 2-day stretches back from the release, as far as the stored events reach: days 1 to 5.
  assert.equal(blameless.rise.before.total, always.within({ from: DAY, to: 5 * DAY, where: { platform: "ios" } }).length);

  const broke = viewOf(stream({ start: 0, hours: 7 * 24, perHour: 30, tags, signals: { bug: (_at, own) => (own.app_version === "4.12.0" ? 0.6 : own.platform === "ios" ? 0.3 : 0.05) } }));
  assert.ok(exposureOf(broke, release, { signal: "bug", until: 7 * DAY }).evidence > 20);
});

test("exposure with no earlier events to compare with is worth nothing, unless the change was randomized", () => {
  const flag = change("flag", 0, { scope: { "flag:new": "on" } });
  const view = viewOf(stream({ start: 0, hours: 48, perHour: 30, tags: (random) => ({ "flag:new": random() < 0.3 ? "on" : "off" }), signals: { bug: (_at, own) => (own["flag:new"] === "on" ? 0.3 : 0.05) } }));
  const blind = exposureOf(view, flag, { signal: "bug", until: 2 * DAY });
  assert.equal(blind.rise, null);
  assert.equal(blind.evidence, 0);
  const randomized = exposureOf(view, { ...flag, randomized: true }, { signal: "bug", until: 2 * DAY });
  assert.equal(randomized.evidence, randomized.contrast.evidence);
  assert.ok(randomized.evidence > 20);
  assert.equal(exposureOf(view, change("unscoped", 0), { signal: "bug", until: 2 * DAY }), null);
});

test("exposure counts a customer once, however many messages they send", () => {
  const flag = change("flag", DAY, { scope: { "flag:new": "on" } });
  const quiet = stream({ start: 0, hours: 48, perHour: 20, tags: (random, at) => ({ "flag:new": at >= DAY && random() < 0.3 ? "on" : "off" }), signals: { bug: 0.05 } }).map((event) => ({ ...event, unit: `customer-${event.id}` }));
  // One customer on the flag sends thirty bug reports.
  const angry = Array.from({ length: 30 }, (_, i) => ({ id: `angry${i}`, at: DAY + HOUR + i, unit: "customer-angry", tags: { "flag:new": "on" }, schema: "test@1", labeler: "test-labeler@1", probability: "native", signals: { bug: 0.95 } }));
  const found = exposureOf(viewOf([...quiet, ...angry]), flag, { signal: "bug", until: 2 * DAY });
  assert.ok(found.evidence < 3, `evidence ${found.evidence}`);
});

test("exposure counts earlier time the way it counts the time since, so accounts that write every day still show a rise", () => {
  // Forty accounts writing about six times a day; a flag reaches half of them on day 7 and breaks something.
  const random = () => Math.floor(pick() * 40);
  const pick = (() => { let state = 9; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0), state / 4294967296); })();
  const flag = change("flag", 7 * DAY, { scope: { "flag:new": "on" } });
  const events = stream({ start: 0, hours: 8 * 24, perHour: 10, signals: { bug: 0.05 } }).map((event) => {
    const account = random();
    const on = event.at >= 7 * DAY && account % 2 === 0;
    return { ...event, unit: `account-${account}`, tags: { "flag:new": on ? "on" : "off" }, signals: { bug: on && pick() < 0.5 ? 0.95 : event.signals.bug } };
  });
  const found = exposureOf(viewOf(events), flag, { signal: "bug", until: 8 * DAY });
  // "Before" is seven one-day stretches, each account once a day: about 280, not 40.
  assert.ok(found.rise.before.total > 200, `before ${found.rise.before.total}`);
  assert.ok(found.rise.evidence > 2 && found.evidence > 2, JSON.stringify(found));
});
