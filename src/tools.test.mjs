import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryReader } from "./reader.ts";
import { stream } from "./testing.ts";
import { summarize, toolsFor } from "./tools.ts";
import { DAY, HOUR } from "./types.ts";

const START = Date.UTC(2026, 10, 1);
const BROKE = START + 8 * DAY + 9 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const events = stream({ start: START, hours: 9 * 24, perHour: 20, tags: (random) => ({ platform: random() < 0.3 ? "ios" : "web" }), signals: { bug: (at, tags) => (at >= BROKE && tags.platform === "ios" ? 0.8 : 0.05), praise: 0.1 } });
const changes = [{ id: "rel", at: BROKE - HOUR / 2, kind: "release", what: "mobile 4.12.0", scope: { platform: "ios" } }, { id: "old", at: START + DAY, kind: "deploy", what: "last week" }];
const tools = toolsFor({ reader: memoryReader(events), changes }, { signals: ["bug", "praise"] });
const window = { from: iso(BROKE), to: iso(BROKE + 6 * HOUR) };

test("signal_series counts a signal per bucket, optionally for one tag value", async () => {
  const rows = await tools.signal_series.run({ signal: "bug", from: iso(BROKE - 2 * HOUR), to: iso(BROKE + 2 * HOUR) });
  assert.deepEqual(rows.map((r) => [r.at.slice(11), r.total]), [["07:00Z", 20], ["08:00Z", 20], ["09:00Z", 20], ["10:00Z", 20]]);
  assert.ok(rows[0].yes + rows[1].yes < rows[2].yes + rows[3].yes);
  const ios = await tools.signal_series.run({ signal: "bug", ...window, bucket_hours: 6, tag: "platform", tag_value: "ios" });
  assert.equal(ios.length, 1);
  assert.ok(ios[0].yes / ios[0].total > 0.6);
});

test("signal_series refuses a bucket of no length and never returns more than 200", async () => {
  for (const bucket_hours of [0, -1, "an hour"]) {
    await assert.rejects(async () => tools.signal_series.run({ signal: "bug", ...window, bucket_hours }), /"bucket_hours" must be a number, at least 0.25/);
  }
  // A year asked for by the hour comes back as its first 200 hours.
  const rows = await tools.signal_series.run({ signal: "bug", from: iso(START), to: iso(START + 365 * DAY) });
  assert.equal(rows.length, 200);
  assert.equal((await tools.signal_series.run({ signal: "bug", ...window, bucket_hours: 0.5 })).length, 12);
});

test("top_signals and breakdown show what moved and for whom", async () => {
  const movers = await tools.top_signals.run(window);
  assert.equal(movers[0].signal, "bug");
  assert.ok(movers[0].lift > 3 && movers[1].lift < 2);
  const split = await tools.breakdown.run({ signal: "bug", by: "platform", ...window });
  assert.equal(split[0].value, "ios");
  assert.match(split[0].now, /^\d+\/\d+$/);
});

test("messages returns the events themselves, newest first, with the signals that are yes", async () => {
  const rows = await tools.messages.run({ ...window, signal: "bug", limit: 4, tag: "platform", tag_value: "ios" });
  assert.equal(rows.length, 4);
  assert.ok(rows[0].at >= rows[3].at);
  assert.ok(rows.every((row) => row.tags.platform === "ios" && row.signals.bug === 0.95 && row.text.startsWith("message ")));
  assert.equal((await tools.messages.run({ ...window, limit: 500 })).length, 25);
  // A limit below one is a mistake to say so about, not a way to get everything.
  await assert.rejects(async () => tools.messages.run({ ...window, limit: -1 }), /"limit" must be a number, at least 1/);
  assert.equal((await tools.messages.run({ ...window, limit: 2.9 })).length, 2);
});

test("changes lists the change log; suspects ranks it for a signal that rose", async () => {
  assert.deepEqual((await tools.changes.run({ from: iso(BROKE - DAY), to: iso(BROKE + DAY) })).map((c) => [c.id, c.reaches]), [["rel", { platform: "ios" }]]);
  const found = await tools.suspects.run({ signal: "bug", until: iso(BROKE + 6 * HOUR) });
  assert.equal(found.suspects[0].id, "rel");
  assert.equal(found.confident, true);
  assert.ok(Math.abs(Date.parse(found.began.mostLikely) - BROKE) <= HOUR);
  // What the release reached, the rest, and events like the reached ones before it shipped.
  assert.match(found.suspects[0].reached, /^\d+\/\d+$/);
  assert.match(found.suspects[0].likeThemBefore, /^\d+\/\d+$/);
  assert.ok(found.suspects[0].exposureEvidence > 10);
  assert.deepEqual(await tools.suspects.run({ signal: "praise", until: iso(START + HOUR) }), { began: null, suspects: [], note: "No rise found in this signal before that time." });
});

test("a bad time is an error the caller can read; data may be a function read on each call", async () => {
  await assert.rejects(async () => tools.changes.run({ from: "yesterday", to: iso(BROKE) }), /"from" must be an ISO time/);
  let reads = 0;
  const live = toolsFor(() => ((reads += 1), { reader: memoryReader(events), changes }), { signals: ["bug"] });
  await live.changes.run(window);
  await live.top_signals.run(window);
  assert.equal(reads, 2);
});

test("summarize gives every signal's count in a range", async () => {
  const summary = await summarize(memoryReader(events), { signals: ["bug", "praise"], from: BROKE, to: BROKE + HOUR });
  assert.match(summary.bug, /^\d+\/20$/);
  assert.deepEqual(Object.keys(summary), ["bug", "praise"]);
});
