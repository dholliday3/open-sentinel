import assert from "node:assert/strict";
import { test } from "node:test";
import { viewOf } from "./metrics.ts";
import { replay } from "./monitor.ts";
import { eventMonitor, exposureMonitor, shareMonitor, shareMonitors, silenceMonitor, TIERS, volumeMonitor } from "./monitors.ts";
import { binomTail } from "./stats.ts";
import { seeded, stream } from "./testing.ts";
import { DAY, HOUR, WEEK } from "./types.ts";

const context = { alpha: 1e-5, since: 0, excluded: [], gates: {}, changes: [] };
const check = (monitor, events, now, extra = {}) => monitor.check(viewOf(events), now, { ...context, ...extra });

test("shareMonitor fires when a signal's share rises, and says what it compared", () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: 20, signals: { bug: (at) => (at >= 8 * DAY + 9 * HOUR ? 0.4 : 0.05) } });
  const monitor = shareMonitor({ signal: "bug", windowMs: 3 * HOUR });
  assert.equal(monitor.name, "3h share of bug");
  // Twice the baseline's span: it may reach that far back to replace excluded time.
  assert.equal(monitor.lookbackMs, 3 * HOUR + 2 * WEEK);
  assert.equal(check(monitor, events, 8 * DAY + 9 * HOUR).state, "ok");
  const after = check(monitor, events, 8 * DAY + 12 * HOUR);
  assert.equal(after.state, "firing");
  assert.match(after.detail.now, /^\d+\/60$/);
  assert.ok(after.detail.p < 1e-8);
  // A window of no length has no stretches to count its baseline in.
  assert.throws(() => shareMonitor({ signal: "bug", windowMs: 0 }), /longer than nothing/);
});

test("shareMonitor doesn't fire when everything doubles together", () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: (at) => (at >= 8 * DAY ? 60 : 20), signals: { bug: 0.05 } });
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: DAY, minCount: 8 }), events, 9 * DAY).state, "ok");
});

test("shareMonitor needs minCount yeses and a baseline worth comparing with", () => {
  const few = stream({ start: 0, hours: 9 * 24, perHour: 1, signals: { bug: (at) => (at >= 8 * DAY + 21 * HOUR ? 1 : 0) } });
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, minCount: 5 }), few, 9 * DAY).state, "ok");
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, minCount: 3 }), few, 9 * DAY).state, "firing");
  const young = stream({ start: 8 * DAY + 20 * HOUR, hours: 4, perHour: 5, signals: { bug: 1 } });
  // Five events before the window is no baseline to judge fifteen against.
  assert.deepEqual(check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), young, 9 * DAY), { state: "no_data", detail: { now: "15/15", baseline: "5/5" } });
});

test("shareMonitor compares a tag value with its own past", () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: 30, tags: (random) => ({ platform: random() < 0.3 ? "ios" : "web" }), signals: { bug: (at, tags) => (tags.platform === "ios" && at >= 8 * DAY + 12 * HOUR ? 0.5 : 0.05) } });
  const now = 9 * DAY;
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: 12 * HOUR, where: { platform: "ios" } }), events, now).state, "firing");
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: 12 * HOUR, where: { platform: "web" } }), events, now).state, "ok");
  assert.equal(shareMonitor({ signal: "bug", windowMs: 12 * HOUR, where: { platform: "ios" } }).name, "12h share of bug {platform:ios}");
});

test("shareMonitor counts customers, not messages: one customer writing twenty times is one", () => {
  // A steady week: 10 customers an hour, one message each, 5% of them bug reports.
  const steady = stream({ start: 0, hours: 9 * 24, perHour: 10, signals: { bug: 0.05 } }).map((event) => ({ ...event, unit: `customer-${event.id}` }));
  // Then one customer sends twenty bug reports inside three hours.
  const angry = Array.from({ length: 20 }, (_, i) => ({ id: `angry${i}`, at: 9 * DAY - HOUR + i, unit: "customer-angry", schema: "test@1", labeler: "test-labeler@1", probability: "native", signals: { bug: 0.95 } }));
  const events = [...steady, ...angry];
  const perCustomer = check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), events, 9 * DAY, { alpha: 1e-3 });
  assert.equal(perCustomer.state, "ok");
  assert.match(perCustomer.detail.now, /\/31$/);
  // Counted per message, the same hour looks like an incident.
  const perMessage = check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, per: "event" }), events, 9 * DAY, { alpha: 1e-3 });
  assert.equal(perMessage.state, "firing");
  assert.match(perMessage.detail.now, /\/50$/);
  // Twenty customers each reporting it once is an incident either way.
  const many = [...steady, ...angry.map((event, i) => ({ ...event, unit: `customer-angry-${i}` }))];
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), many, 9 * DAY, { alpha: 1e-3 }).state, "firing");
});

test("shareMonitor counts the baseline the way it counts the window, so accounts that write every day don't hide a rise", () => {
  // Forty accounts, each writing about six times a day. Over a week nearly every account has
  // reported a bug at least once; in any three hours, about one in twenty has.
  const random = seeded(4);
  const events = stream({ start: 0, hours: 9 * 24, perHour: 10, signals: { bug: (at) => (at >= 9 * DAY - 3 * HOUR ? 0.5 : 0.05) } }).map((event) => ({ ...event, unit: `account-${Math.floor(random() * 40)}` }));
  const result = check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), events, 9 * DAY);
  assert.equal(result.state, "firing");
  // 56 three-hour stretches of baseline, each account once per stretch: far more than 40.
  const [yes, total] = result.detail.baseline.split("/").map(Number);
  assert.ok(total > 800 && yes / total < 0.1, result.detail.baseline);
  const [, now] = result.detail.now.split("/").map(Number);
  assert.ok(now <= 30);
});

/** A thousand accounts, each writing about five times a day, 5% of messages a bug report, and nothing ever changing. */
const regulars = (days) => {
  const random = seeded(101);
  return stream({ start: 0, hours: days * 24, perHour: 200, signals: { bug: 0.05 }, random: seeded(201) }).map((event) => ({ ...event, unit: `account-${Math.floor(random() * 1000)}` }));
};
const shareOf = (counts) => {
  const [yes, total] = counts.split("/").map(Number);
  return yes / total;
};

test("an unchanged stream of customers who write every day raises nothing at any tier", async () => {
  // Counted once per stretch, a customer is likelier to have said yes in three days than in one.
  // A 3-day window against a week once left a one-day stub in the baseline, which read low.
  const events = regulars(17);
  const now = 17 * DAY;
  const { alerts } = await replay({ monitors: shareMonitors({ signals: ["bug"] }) }, events, { from: now - DAY, to: now });
  assert.deepEqual(alerts.map((alert) => alert.monitor), []);
  const digest = check(shareMonitor({ signal: "bug", windowMs: 3 * DAY }), events, now);
  // A week rounded up to three whole 3-day stretches: three times the window's customers, at about the window's share.
  const [windowTotal, baselineTotal] = [digest.detail.now, digest.detail.baseline].map((counts) => Number(counts.split("/")[1]));
  assert.ok(Math.abs(baselineTotal / windowTotal - 3) < 0.03, `${digest.detail.baseline} against ${digest.detail.now}`);
  assert.ok(Math.abs(shareOf(digest.detail.baseline) - shareOf(digest.detail.now)) < 0.03, `${digest.detail.baseline} against ${digest.detail.now}`);
});

test("excluded time doesn't make a baseline read low: a stretch it touches is left out whole", () => {
  const events = regulars(17);
  const monitor = shareMonitor({ signal: "bug", windowMs: DAY, minCount: 8 });
  const now = 17 * DAY;
  // Planned changes covering the second half of three baseline days.
  const excluded = [12, 13, 14].map((day) => ({ from: day * DAY + 12 * HOUR, to: (day + 1) * DAY }));
  const plain = check(monitor, events, now);
  const holed = check(monitor, events, now, { excluded });
  assert.equal(holed.state, "ok");
  // Still seven whole days, reached for further back, counted the way the window is.
  assert.ok(Math.abs(Number(holed.detail.baseline.split("/")[1]) / Number(plain.detail.baseline.split("/")[1]) - 1) < 0.01, `${holed.detail.baseline} against ${plain.detail.baseline}`);
  assert.ok(Math.abs(shareOf(holed.detail.baseline) - shareOf(plain.detail.baseline)) < 0.01, `${holed.detail.baseline} against ${plain.detail.baseline}`);
});

test("shareMonitor takes another test in place of Fisher's", () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: 20, signals: { bug: (at) => (at >= 8 * DAY + 21 * HOUR ? 0.4 : 0.05) } });
  const seen = [];
  const binomial = (a, b) => (seen.push([a, b]), { p: binomTail(a.yes + b.yes, a.yes, a.total / (a.total + b.total)) });
  const result = check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, compare: binomial }), events, 9 * DAY);
  assert.equal(result.state, "firing");
  assert.equal(seen[0][0].total, 60);
  assert.equal(seen[0][1].total, 7 * 24 * 20);
  assert.equal(check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, compare: () => ({ p: 1 }) }), events, 9 * DAY).state, "ok");
});

test("a seasonal baseline compares Monday morning with Monday mornings", () => {
  // Every Monday from 9 to 12, how-to questions are 60% of the inbox; the rest of the week, 10%.
  const mondayMorning = (at) => at % WEEK >= 9 * HOUR && at % WEEK < 12 * HOUR;
  const usual = (at) => (mondayMorning(at) ? 0.6 : 0.1);
  const now = 5 * WEEK + 12 * HOUR;
  const normal = stream({ start: 0, hours: 6 * 7 * 24, perHour: 100, signals: { how_to: usual } });
  const trailing = shareMonitor({ signal: "how_to", windowMs: 3 * HOUR });
  const seasonal = shareMonitor({ signal: "how_to", windowMs: 3 * HOUR, baseline: { kind: "seasonal", periodMs: WEEK, cycles: 4 } });
  assert.equal(seasonal.lookbackMs, 4 * WEEK + 3 * HOUR);
  // Its own name, so the same signal can be watched both ways by one runner.
  assert.equal(seasonal.name, "3h share of how_to (seasonal)");
  assert.equal(check(trailing, normal, now).state, "firing");
  assert.equal(check(seasonal, normal, now).state, "ok");
  // Four earlier Monday mornings: a smaller baseline than a whole week, so it needs a bigger effect.
  assert.match(check(seasonal, normal, now).detail.baseline, /\/1200$/);
  // A real problem that Monday still stands out against other Mondays.
  const broken = stream({ start: 0, hours: 6 * 7 * 24, perHour: 100, signals: { how_to: (at) => (at >= 5 * WEEK + 9 * HOUR && at < now ? 0.95 : usual(at)) } });
  assert.equal(check(seasonal, broken, now).state, "firing");
});

test("leaving a flooded day out of the baseline stops other signals from seeming to rise", () => {
  // Day 3 brings a flood about something else: ten times the events, none of them bug reports.
  const flood = (at) => at >= 2 * DAY && at < 3 * DAY;
  const events = [
    ...stream({ start: 0, hours: 9 * 24, perHour: 20, signals: { bug: 0.1 } }),
    ...stream({ start: 2 * DAY, hours: 24, perHour: 200, signals: { bug: 0 }, prefix: "flood", random: seeded(2) }),
  ];
  const monitor = shareMonitor({ signal: "bug", windowMs: DAY, minCount: 8 });
  const now = 9 * DAY;
  const diluted = check(monitor, events, now, { alpha: 1e-3 });
  const corrected = check(monitor, events, now, { alpha: 1e-3, excluded: [{ from: 2 * DAY, to: 3 * DAY }] });
  assert.equal(diluted.state, "firing");
  assert.match(diluted.detail.baseline, /\/8160$/);
  assert.equal(corrected.state, "ok");
  // Still seven days of baseline: the excluded day is made up from the day before the usual span.
  assert.match(corrected.detail.baseline, /\/3360$/);
  assert.ok(corrected.detail.p > 0.1 && diluted.detail.p < 1e-3);
  assert.equal(events.filter((e) => flood(e.at)).length, 480 + 4800);
});

test("a baseline replaces excluded time with earlier history, up to its own span and no further", () => {
  const events = stream({ start: 0, hours: 30 * 24, perHour: 10, signals: { bug: 0.1 } });
  const monitor = shareMonitor({ signal: "bug", windowMs: DAY });
  const total = (excluded) => Number(check(monitor, events, 30 * DAY, { excluded }).detail.baseline.split("/")[1]);
  assert.equal(total([]), 7 * 240);
  assert.equal(total([{ from: 25 * DAY, to: 27 * DAY }]), 7 * 240);
  // Two intervals that overlap are one stretch of three days, not four.
  assert.equal(total([{ from: 24 * DAY, to: 26 * DAY }, { from: 25 * DAY, to: 27 * DAY }]), 7 * 240);
  // Reaching back runs into more excluded time, and reaches back again for that.
  assert.equal(total([{ from: 25 * DAY, to: 27 * DAY }, { from: 20 * DAY, to: 21 * DAY }]), 7 * 240);
  // Everything recent is excluded: it goes back one more span and stops.
  assert.equal(total([{ from: 10 * DAY, to: 29 * DAY }]), 0);
});

test("shareMonitors makes one monitor per signal per tier", () => {
  const monitors = shareMonitors({ signals: ["a", "b"], where: { plan: "pro" }, minBaseline: 0 });
  assert.deepEqual(monitors.map((m) => [m.name, m.severity]), [
    ["3h share of a {plan:pro}", "page"], ["24h share of a {plan:pro}", "page"], ["3-day share of a {plan:pro}", "digest"],
    ["3h share of b {plan:pro}", "page"], ["24h share of b {plan:pro}", "page"], ["3-day share of b {plan:pro}", "digest"],
  ]);
  assert.equal(TIERS.length, 3);
});

test("eventMonitor reports each event at the gate, or below it when a second reader agreed", () => {
  const event = (id, at, p, second) => ({ id, at, schema: "t@1", labeler: "l", probability: "native", signals: { leak: p, ...(second === undefined ? {} : { "leak.second": second }) } });
  const events = [event("old", 5, 0.99), event("sure", 15, 0.95), event("agreed", 16, 0.7, 1), event("refused", 17, 0.7, 0), event("unasked", 18, 0.7), event("no", 19, 0.2, 1)];
  const monitor = eventMonitor({ signal: "leak", gate: 0.9, second: { from: 0.5 }, lateMs: 0 });
  const result = check(monitor, events, 20, { since: 10 });
  assert.equal(result.state, "firing");
  assert.deepEqual(result.events, [{ id: "sure", at: 15, detail: { p: 0.95 } }, { id: "agreed", at: 16, detail: { p: 0.7 } }]);
  assert.deepEqual(check(eventMonitor({ signal: "leak", lateMs: 0 }), events, 20, { since: 10 }).events.map((e) => e.id), ["sure"]);
  assert.equal(check(monitor, events, 30, { since: 20 }).state, "ok");
});

test("eventMonitor still reports an event stored after the check that covered its time", () => {
  const event = (id, at) => ({ id, at, schema: "t@1", labeler: "l", probability: "native", signals: { leak: 0.99 } });
  const monitor = eventMonitor({ signal: "leak" });
  assert.equal(monitor.lookbackMs, 6 * HOUR);
  // Written at 09:50, stored at 10:05. The 10:00 check ran without it; the 11:00 check reads back far enough to find it.
  const at = 10 * HOUR - 10 * 60_000;
  assert.deepEqual(check(monitor, [], 10 * HOUR, { since: 9 * HOUR }).events, []);
  assert.deepEqual(check(monitor, [event("late", at)], 11 * HOUR, { since: 10 * HOUR }).events.map((e) => e.id), ["late"]);
  // Up to six hours late by default; a backfill of older history stays quiet.
  assert.deepEqual(check(monitor, [event("late", at), event("backfilled", 2 * HOUR)], 17 * HOUR, { since: 16 * HOUR }).events, []);
  assert.deepEqual(check(eventMonitor({ signal: "leak", lateMs: DAY }), [event("backfilled", 2 * HOUR)], 17 * HOUR, { since: 16 * HOUR }).events.map((e) => e.id), ["backfilled"]);
});

test("exposureMonitor compares events a change reached with the rest and with before, for a while after it ships", () => {
  const change = { id: "pdf-v2", at: DAY, kind: "flag", what: "PDF renderer v2", scope: { "flag:pdf-v2": "on" } };
  const events = stream({ start: 0, hours: 72, perHour: 30, tags: (random, at) => ({ "flag:pdf-v2": at >= DAY && random() < 0.3 ? "on" : "off" }), signals: { bug: (at, tags) => (tags["flag:pdf-v2"] === "on" ? 0.3 : 0.05) } });
  const monitor = exposureMonitor({ change, signal: "bug", forMs: 2 * DAY });
  assert.equal(monitor.name, "bug among events exposed to pdf-v2");
  assert.equal(check(monitor, events, DAY - HOUR).state, "ok");
  const during = check(monitor, events, 2 * DAY);
  assert.equal(during.state, "firing");
  assert.equal(during.detail.change, "pdf-v2");
  // Nobody had the flag before it shipped, so "before" is everyone, the day before.
  assert.match(during.detail.before, /\/720$/);
  assert.equal(check(monitor, events, 3 * DAY + HOUR).state, "ok");
  const harmless = stream({ start: 0, hours: 72, perHour: 30, tags: (random, at) => ({ "flag:pdf-v2": at >= DAY && random() < 0.3 ? "on" : "off" }), signals: { bug: 0.05 } });
  assert.equal(check(monitor, harmless, 2 * DAY).state, "ok");
  assert.throws(() => exposureMonitor({ change: { id: "x", at: 0, kind: "deploy", what: "x" }, signal: "bug" }), /no scope/);
});

test("exposureMonitor doesn't blame a release for a group that always complained more", () => {
  // iOS customers report bugs six times as often as web customers, before the release and after.
  const release = { id: "ios-4.12", at: 7 * DAY, kind: "release", what: "mobile 4.12.0", scope: { app_version: "4.12.0" } };
  const tags = (random, at) => (random() < 0.3 ? { platform: "ios", app_version: at >= 7 * DAY ? "4.12.0" : "4.11.3" } : { platform: "web" });
  const always = stream({ start: 0, hours: 9 * 24, perHour: 30, tags, signals: { bug: (_at, own) => (own.platform === "ios" ? 0.3 : 0.05) } });
  const monitor = exposureMonitor({ change: release, signal: "bug" });
  const quiet = check(monitor, always, 9 * DAY);
  // The 4.12.0 events do carry the signal far more than the rest, and no more than iOS did before.
  assert.ok(quiet.detail.p < 1e-10);
  assert.equal(quiet.state, "ok");
  // The same release, when it really does break something for the people on it.
  const broke = stream({ start: 0, hours: 9 * 24, perHour: 30, tags, signals: { bug: (_at, own) => (own.app_version === "4.12.0" ? 0.6 : own.platform === "ios" ? 0.3 : 0.05) } });
  assert.equal(check(monitor, broke, 9 * DAY).state, "firing");
});

test("exposureMonitor with nothing earlier to compare with answers only for a randomized change", () => {
  // The stream begins when the flag ships: there is no "before".
  const change = { id: "pdf-v2", at: 0, kind: "flag", what: "PDF renderer v2", scope: { "flag:pdf-v2": "on" } };
  const events = stream({ start: 0, hours: 48, perHour: 30, tags: (random) => ({ "flag:pdf-v2": random() < 0.3 ? "on" : "off" }), signals: { bug: (_at, tags) => (tags["flag:pdf-v2"] === "on" ? 0.3 : 0.05) } });
  const unknown = check(exposureMonitor({ change, signal: "bug" }), events, 2 * DAY);
  assert.equal(unknown.state, "no_data");
  assert.match(unknown.detail.why, /isn't marked randomized/);
  assert.equal(check(exposureMonitor({ change: { ...change, randomized: true }, signal: "bug" }), events, 2 * DAY).state, "firing");
});

test("volumeMonitor compares a window with the same window one period earlier", () => {
  const events = stream({ start: 0, hours: 8 * 24, perHour: (at) => (at >= 7 * DAY + 9 * HOUR && at < 7 * DAY + 12 * HOUR ? 50 : 10), signals: {} });
  const monitor = volumeMonitor({ windowMs: 3 * HOUR });
  assert.deepEqual(check(monitor, events, 7 * DAY + 12 * HOUR), { state: "firing", detail: { now: 150, before: 30 } });
  assert.equal(check(monitor, events, 7 * DAY + 9 * HOUR).state, "ok");
  assert.equal(monitor.signal, "*");
});

test("silenceMonitor fires when nothing arrives where something used to", () => {
  // Ten an hour for eight days, then nothing after 09:00 on day 8.
  const stopped = stream({ start: 0, hours: 8 * 24, perHour: (at) => (at >= 7 * DAY + 9 * HOUR ? 0 : 10), signals: {} });
  const monitor = silenceMonitor({ windowMs: 3 * HOUR });
  assert.deepEqual(check(monitor, stopped, 7 * DAY + 12 * HOUR), { state: "firing", detail: { now: 0, before: 30 } });
  assert.equal(check(monitor, stopped, 7 * DAY + 9 * HOUR).state, "ok");
  // A stream that is always empty at this hour is not an alert.
  const nights = stream({ start: 0, hours: 8 * 24, perHour: (at) => (at % DAY < 6 * HOUR ? 0 : 10), signals: {} });
  assert.equal(check(monitor, nights, 7 * DAY + 3 * HOUR).state, "ok");
  assert.equal(monitor.tested, false);
});
