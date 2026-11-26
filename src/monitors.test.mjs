import assert from "node:assert/strict";
import { test } from "node:test";
import { loadInbox } from "../examples/support/data.ts";
import { withPlans } from "../examples/support/replay.ts";
import { countUnits, wholeStretches } from "./metrics.ts";
import { memoryReader } from "./reader.ts";
import { replay, viewMonitor } from "./monitor.ts";
import { eventMonitor, exposureMonitor, shareMonitor, shareMonitors, silenceMonitor, TIERS, volumeMonitor } from "./monitors.ts";
import { binomTail, compareRates } from "./stats.ts";
import { seeded, stream } from "./testing.ts";
import { DAY, HOUR, WEEK } from "./types.ts";

const context = { alpha: 1e-5, since: 0, excluded: [], gates: {}, changes: [] };
const check = (monitor, events, now, extra = {}) => monitor.check(memoryReader(events), now, { ...context, ...extra });

test("shareMonitor fires when a signal's share rises, and says what it compared", async () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: 20, signals: { bug: (at) => (at >= 8 * DAY + 9 * HOUR ? 0.4 : 0.05) } });
  const monitor = shareMonitor({ signal: "bug", windowMs: 3 * HOUR });
  assert.equal(monitor.name, "3h share of bug");
  // Twice the baseline's span: it may reach that far back to replace excluded time.
  assert.equal(monitor.lookbackMs, 3 * HOUR + 2 * WEEK);
  assert.equal((await check(monitor, events, 8 * DAY + 9 * HOUR)).state, "ok");
  const after = await check(monitor, events, 8 * DAY + 12 * HOUR);
  assert.equal(after.state, "firing");
  assert.match(after.detail.now, /^\d+\/60$/);
  assert.ok(after.detail.p < 1e-8);
  // A window of no length has no stretches to count its baseline in.
  assert.throws(() => shareMonitor({ signal: "bug", windowMs: 0 }), /longer than nothing/);
});

test("shareMonitor doesn't fire when everything doubles together", async () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: (at) => (at >= 8 * DAY ? 60 : 20), signals: { bug: 0.05 } });
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: DAY, minCount: 8 }), events, 9 * DAY)).state, "ok");
});

test("shareMonitor needs minCount yeses and a baseline worth comparing with", async () => {
  const few = stream({ start: 0, hours: 9 * 24, perHour: 1, signals: { bug: (at) => (at >= 8 * DAY + 21 * HOUR ? 1 : 0) } });
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, minCount: 5 }), few, 9 * DAY)).state, "ok");
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, minCount: 3 }), few, 9 * DAY)).state, "firing");
  const young = stream({ start: 8 * DAY + 20 * HOUR, hours: 4, perHour: 5, signals: { bug: 1 } });
  // A stream four hours old has no whole three hours before the window to judge fifteen against.
  assert.deepEqual((await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), young, 9 * DAY)), { state: "no_data", detail: { now: "15/15", baseline: "0/0" } });
});

test("shareMonitor compares a tag value with its own past", async () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: 30, tags: (random) => ({ platform: random() < 0.3 ? "ios" : "web" }), signals: { bug: (at, tags) => (tags.platform === "ios" && at >= 8 * DAY + 12 * HOUR ? 0.5 : 0.05) } });
  const now = 9 * DAY;
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: 12 * HOUR, where: { platform: "ios" } }), events, now)).state, "firing");
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: 12 * HOUR, where: { platform: "web" } }), events, now)).state, "ok");
  assert.equal(shareMonitor({ signal: "bug", windowMs: 12 * HOUR, where: { platform: "ios" } }).name, "12h share of bug {platform:ios}");
});

test("shareMonitor counts customers, not messages: one customer writing twenty times is one", async () => {
  // A steady week: 10 customers an hour, one message each, 5% of them bug reports.
  const steady = stream({ start: 0, hours: 9 * 24, perHour: 10, signals: { bug: 0.05 } }).map((event) => ({ ...event, unit: `customer-${event.id}` }));
  // Then one customer sends twenty bug reports inside three hours.
  const angry = Array.from({ length: 20 }, (_, i) => ({ id: `angry${i}`, at: 9 * DAY - HOUR + i, unit: "customer-angry", schema: "test@1", labeler: "test-labeler@1", probability: "native", signals: { bug: 0.95 } }));
  const events = [...steady, ...angry];
  const perCustomer = await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), events, 9 * DAY, { alpha: 1e-3 });
  assert.equal(perCustomer.state, "ok");
  assert.match(perCustomer.detail.now, /\/31$/);
  // Counted per message, the same hour looks like an incident.
  const perMessage = await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, per: "event" }), events, 9 * DAY, { alpha: 1e-3 });
  assert.equal(perMessage.state, "firing");
  assert.match(perMessage.detail.now, /\/50$/);
  // Twenty customers each reporting it once is an incident either way.
  const many = [...steady, ...angry.map((event, i) => ({ ...event, unit: `customer-angry-${i}` }))];
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), many, 9 * DAY, { alpha: 1e-3 })).state, "firing");
});

test("shareMonitor counts the baseline the way it counts the window, so accounts that write every day don't hide a rise", async () => {
  // Forty accounts, each writing about six times a day. Over a week nearly every account has
  // reported a bug at least once; in any three hours, about one in twenty has.
  const random = seeded(4);
  const events = stream({ start: 0, hours: 9 * 24, perHour: 10, signals: { bug: (at) => (at >= 9 * DAY - 3 * HOUR ? 0.5 : 0.05) } }).map((event) => ({ ...event, unit: `account-${Math.floor(random() * 40)}` }));
  const result = await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR }), events, 9 * DAY);
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
  const digest = await check(shareMonitor({ signal: "bug", windowMs: 3 * DAY }), events, now);
  // A week rounded up to three whole 3-day stretches: three times the window's customers, at about the window's share.
  const [windowTotal, baselineTotal] = [digest.detail.now, digest.detail.baseline].map((counts) => Number(counts.split("/")[1]));
  assert.ok(Math.abs(baselineTotal / windowTotal - 3) < 0.03, `${digest.detail.baseline} against ${digest.detail.now}`);
  assert.ok(Math.abs(shareOf(digest.detail.baseline) - shareOf(digest.detail.now)) < 0.03, `${digest.detail.baseline} against ${digest.detail.now}`);
});

test("a store younger than the baseline doesn't make it read low: stretches before the first event are left out", async () => {
  // Eight days of history; the 3-day tier would reach back twelve.
  const events = regulars(8);
  const digest = await check(shareMonitor({ signal: "bug", windowMs: 3 * DAY }), events, 8 * DAY, { alpha: 1e-3 });
  assert.equal(digest.state, "ok");
  // One whole 3-day stretch fits after the first event: about as many customers as the window.
  const [windowTotal, baselineTotal] = [digest.detail.now, digest.detail.baseline].map((counts) => Number(counts.split("/")[1]));
  assert.ok(Math.abs(baselineTotal / windowTotal - 1) < 0.02, `${digest.detail.baseline} against ${digest.detail.now}`);
  assert.ok(Math.abs(shareOf(digest.detail.baseline) - shareOf(digest.detail.now)) < 0.04, `${digest.detail.baseline} against ${digest.detail.now}`);
});

test("excluded time doesn't make a baseline read low: a stretch it touches is left out whole", async () => {
  const events = regulars(17);
  const monitor = shareMonitor({ signal: "bug", windowMs: DAY, minCount: 8 });
  const now = 17 * DAY;
  // Planned changes covering the second half of three baseline days.
  const excluded = [12, 13, 14].map((day) => ({ from: day * DAY + 12 * HOUR, to: (day + 1) * DAY }));
  const plain = await check(monitor, events, now);
  const holed = await check(monitor, events, now, { excluded });
  assert.equal(holed.state, "ok");
  // Still seven whole days, reached for further back, counted the way the window is.
  assert.ok(Math.abs(Number(holed.detail.baseline.split("/")[1]) / Number(plain.detail.baseline.split("/")[1]) - 1) < 0.01, `${holed.detail.baseline} against ${plain.detail.baseline}`);
  assert.ok(Math.abs(shareOf(holed.detail.baseline) - shareOf(plain.detail.baseline)) < 0.01, `${holed.detail.baseline} against ${plain.detail.baseline}`);
});

test("shareMonitor takes another test in place of Fisher's", async () => {
  const events = stream({ start: 0, hours: 9 * 24, perHour: 20, signals: { bug: (at) => (at >= 8 * DAY + 21 * HOUR ? 0.4 : 0.05) } });
  const seen = [];
  const binomial = (a, b) => (seen.push([a, b]), { p: binomTail(a.yes + b.yes, a.yes, a.total / (a.total + b.total)) });
  const result = await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, compare: binomial }), events, 9 * DAY);
  assert.equal(result.state, "firing");
  assert.equal(seen[0][0].total, 60);
  assert.equal(seen[0][1].total, 7 * 24 * 20);
  assert.equal((await check(shareMonitor({ signal: "bug", windowMs: 3 * HOUR, compare: () => ({ p: 1 }) }), events, 9 * DAY)).state, "ok");
});

test("a seasonal baseline compares Monday morning with Monday mornings", async () => {
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
  assert.equal((await check(trailing, normal, now)).state, "firing");
  assert.equal((await check(seasonal, normal, now)).state, "ok");
  // Four earlier Monday mornings: a smaller baseline than a whole week, so it needs a bigger effect.
  assert.match((await check(seasonal, normal, now)).detail.baseline, /\/1200$/);
  // A real problem that Monday still stands out against other Mondays.
  const broken = stream({ start: 0, hours: 6 * 7 * 24, perHour: 100, signals: { how_to: (at) => (at >= 5 * WEEK + 9 * HOUR && at < now ? 0.95 : usual(at)) } });
  assert.equal((await check(seasonal, broken, now)).state, "firing");
});

test("leaving a flooded day out of the baseline stops other signals from seeming to rise", async () => {
  // Day 3 brings a flood about something else: ten times the events, none of them bug reports.
  const flood = (at) => at >= 2 * DAY && at < 3 * DAY;
  const events = [
    ...stream({ start: -DAY, hours: 10 * 24, perHour: 20, signals: { bug: 0.1 } }),
    ...stream({ start: 2 * DAY, hours: 24, perHour: 200, signals: { bug: 0 }, prefix: "flood", random: seeded(2) }),
  ];
  const monitor = shareMonitor({ signal: "bug", windowMs: DAY, minCount: 8 });
  const now = 9 * DAY;
  const diluted = await check(monitor, events, now, { alpha: 1e-3 });
  const corrected = await check(monitor, events, now, { alpha: 1e-3, excluded: [{ from: 2 * DAY, to: 3 * DAY }] });
  assert.equal(diluted.state, "firing");
  assert.match(diluted.detail.baseline, /\/8160$/);
  assert.equal(corrected.state, "ok");
  // Still seven days of baseline: the excluded day is made up from the day before the usual span.
  assert.match(corrected.detail.baseline, /\/3360$/);
  assert.ok(corrected.detail.p > 0.1 && diluted.detail.p < 1e-3);
  assert.equal(events.filter((e) => flood(e.at)).length, 480 + 4800);
});

test("a baseline replaces excluded time with earlier history, up to its own span and no further", async () => {
  const events = stream({ start: 0, hours: 30 * 24, perHour: 10, signals: { bug: 0.1 } });
  const monitor = shareMonitor({ signal: "bug", windowMs: DAY });
  const total = async (excluded) => Number((await check(monitor, events, 30 * DAY, { excluded })).detail.baseline.split("/")[1]);
  assert.equal(await total([]), 7 * 240);
  assert.equal(await total([{ from: 25 * DAY, to: 27 * DAY }]), 7 * 240);
  // Two intervals that overlap are one stretch of three days, not four.
  assert.equal(await total([{ from: 24 * DAY, to: 26 * DAY }, { from: 25 * DAY, to: 27 * DAY }]), 7 * 240);
  // Reaching back runs into more excluded time, and reaches back again for that.
  assert.equal(await total([{ from: 25 * DAY, to: 27 * DAY }, { from: 20 * DAY, to: 21 * DAY }]), 7 * 240);
  // Everything recent is excluded: it goes back one more span and stops.
  assert.equal(await total([{ from: 10 * DAY, to: 29 * DAY }]), 0);
});

test("shareMonitors makes one monitor per signal per tier", async () => {
  const monitors = shareMonitors({ signals: ["a", "b"], where: { plan: "pro" }, minBaseline: 0 });
  assert.deepEqual(monitors.map((m) => [m.name, m.severity]), [
    ["3h share of a {plan:pro}", "page"], ["24h share of a {plan:pro}", "page"], ["3-day share of a {plan:pro}", "digest"],
    ["3h share of b {plan:pro}", "page"], ["24h share of b {plan:pro}", "page"], ["3-day share of b {plan:pro}", "digest"],
  ]);
  assert.equal(TIERS.length, 3);
});

test("eventMonitor reports each event at the gate, or below it when a second reader agreed", async () => {
  const event = (id, at, p, second) => ({ id, at, schema: "t@1", labeler: "l", probability: "native", signals: { leak: p, ...(second === undefined ? {} : { "leak.second": second }) } });
  const events = [event("old", 5, 0.99), event("sure", 15, 0.95), event("agreed", 16, 0.7, 1), event("refused", 17, 0.7, 0), event("unasked", 18, 0.7), event("no", 19, 0.2, 1)];
  const monitor = eventMonitor({ signal: "leak", gate: 0.9, second: { from: 0.5 }, lateMs: 0 });
  const result = await check(monitor, events, 20, { since: 10 });
  assert.equal(result.state, "firing");
  assert.deepEqual(result.events, [{ id: "sure", at: 15, detail: { p: 0.95 } }, { id: "agreed", at: 16, detail: { p: 0.7 } }]);
  assert.deepEqual((await check(eventMonitor({ signal: "leak", lateMs: 0 }), events, 20, { since: 10 })).events.map((e) => e.id), ["sure"]);
  assert.equal((await check(monitor, events, 30, { since: 20 })).state, "ok");
});

test("eventMonitor still reports an event stored after the check that covered its time", async () => {
  const event = (id, at) => ({ id, at, schema: "t@1", labeler: "l", probability: "native", signals: { leak: 0.99 } });
  const monitor = eventMonitor({ signal: "leak" });
  assert.equal(monitor.lookbackMs, 6 * HOUR);
  // Written at 09:50, stored at 10:05. The 10:00 check ran without it; the 11:00 check reads back far enough to find it.
  const at = 10 * HOUR - 10 * 60_000;
  assert.deepEqual((await check(monitor, [], 10 * HOUR, { since: 9 * HOUR })).events, []);
  assert.deepEqual((await check(monitor, [event("late", at)], 11 * HOUR, { since: 10 * HOUR })).events.map((e) => e.id), ["late"]);
  // Up to six hours late by default; a backfill of older history stays quiet.
  assert.deepEqual((await check(monitor, [event("late", at), event("backfilled", 2 * HOUR)], 17 * HOUR, { since: 16 * HOUR })).events, []);
  assert.deepEqual((await check(eventMonitor({ signal: "leak", lateMs: DAY }), [event("backfilled", 2 * HOUR)], 17 * HOUR, { since: 16 * HOUR })).events.map((e) => e.id), ["backfilled"]);
});

test("exposureMonitor compares events a change reached with the rest and with before, for a while after it ships", async () => {
  const change = { id: "pdf-v2", at: DAY, kind: "flag", what: "PDF renderer v2", scope: { "flag:pdf-v2": "on" } };
  const events = stream({ start: -HOUR, hours: 73, perHour: 30, tags: (random, at) => ({ "flag:pdf-v2": at >= DAY && random() < 0.3 ? "on" : "off" }), signals: { bug: (at, tags) => (tags["flag:pdf-v2"] === "on" ? 0.3 : 0.05) } });
  const monitor = exposureMonitor({ change, signal: "bug", forMs: 2 * DAY });
  assert.equal(monitor.name, "bug among events exposed to pdf-v2");
  assert.equal((await check(monitor, events, DAY - HOUR)).state, "ok");
  const during = await check(monitor, events, 2 * DAY);
  assert.equal(during.state, "firing");
  assert.equal(during.detail.change, "pdf-v2");
  // Nobody had the flag before it shipped, so "before" is everyone, the day before.
  assert.match(during.detail.before, /\/720$/);
  assert.equal((await check(monitor, events, 3 * DAY + HOUR)).state, "ok");
  const harmless = stream({ start: -HOUR, hours: 73, perHour: 30, tags: (random, at) => ({ "flag:pdf-v2": at >= DAY && random() < 0.3 ? "on" : "off" }), signals: { bug: 0.05 } });
  assert.equal((await check(monitor, harmless, 2 * DAY)).state, "ok");
  assert.throws(() => exposureMonitor({ change: { id: "x", at: 0, kind: "deploy", what: "x" }, signal: "bug" }), /no scope/);
});

test("exposureMonitor doesn't blame a release for a group that always complained more", async () => {
  // iOS customers report bugs six times as often as web customers, before the release and after.
  const release = { id: "ios-4.12", at: 7 * DAY, kind: "release", what: "mobile 4.12.0", scope: { app_version: "4.12.0" } };
  const tags = (random, at) => (random() < 0.3 ? { platform: "ios", app_version: at >= 7 * DAY ? "4.12.0" : "4.11.3" } : { platform: "web" });
  const always = stream({ start: 0, hours: 9 * 24, perHour: 30, tags, signals: { bug: (_at, own) => (own.platform === "ios" ? 0.3 : 0.05) } });
  const monitor = exposureMonitor({ change: release, signal: "bug" });
  const quiet = await check(monitor, always, 9 * DAY);
  // The 4.12.0 events do carry the signal far more than the rest, and no more than iOS did before.
  assert.ok(quiet.detail.p < 1e-10);
  assert.equal(quiet.state, "ok");
  // The same release, when it really does break something for the people on it.
  const broke = stream({ start: 0, hours: 9 * 24, perHour: 30, tags, signals: { bug: (_at, own) => (own.app_version === "4.12.0" ? 0.6 : own.platform === "ios" ? 0.3 : 0.05) } });
  assert.equal((await check(monitor, broke, 9 * DAY)).state, "firing");
});

test("exposureMonitor with nothing earlier to compare with answers only for a randomized change", async () => {
  // The stream begins when the flag ships: there is no "before".
  const change = { id: "pdf-v2", at: 0, kind: "flag", what: "PDF renderer v2", scope: { "flag:pdf-v2": "on" } };
  const events = stream({ start: 0, hours: 48, perHour: 30, tags: (random) => ({ "flag:pdf-v2": random() < 0.3 ? "on" : "off" }), signals: { bug: (_at, tags) => (tags["flag:pdf-v2"] === "on" ? 0.3 : 0.05) } });
  const unknown = await check(exposureMonitor({ change, signal: "bug" }), events, 2 * DAY);
  assert.equal(unknown.state, "no_data");
  assert.match(unknown.detail.why, /isn't marked randomized/);
  assert.equal((await check(exposureMonitor({ change: { ...change, randomized: true }, signal: "bug" }), events, 2 * DAY)).state, "firing");
});

test("volumeMonitor compares a window with the same window one period earlier", async () => {
  const events = stream({ start: 0, hours: 8 * 24, perHour: (at) => (at >= 7 * DAY + 9 * HOUR && at < 7 * DAY + 12 * HOUR ? 50 : 10), signals: {} });
  const monitor = volumeMonitor({ windowMs: 3 * HOUR });
  assert.deepEqual((await check(monitor, events, 7 * DAY + 12 * HOUR)), { state: "firing", detail: { now: 150, before: 30 } });
  assert.equal((await check(monitor, events, 7 * DAY + 9 * HOUR)).state, "ok");
  assert.equal(monitor.signal, "*");
});

test("silenceMonitor fires when nothing arrives where something used to", async () => {
  // Ten an hour for eight days, then nothing after 09:00 on day 8.
  const stopped = stream({ start: 0, hours: 8 * 24, perHour: (at) => (at >= 7 * DAY + 9 * HOUR ? 0 : 10), signals: {} });
  const monitor = silenceMonitor({ windowMs: 3 * HOUR });
  assert.deepEqual((await check(monitor, stopped, 7 * DAY + 12 * HOUR)), { state: "firing", detail: { now: 0, before: 30 } });
  assert.equal((await check(monitor, stopped, 7 * DAY + 9 * HOUR)).state, "ok");
  // A stream that is always empty at this hour is not an alert.
  const nights = stream({ start: 0, hours: 8 * 24, perHour: (at) => (at % DAY < 6 * HOUR ? 0 : 10), signals: {} });
  assert.equal((await check(monitor, nights, 7 * DAY + 3 * HOUR)).state, "ok");
  assert.equal(monitor.tested, false);
});

// Monitors as they were written for 0.1, when `check` was handed a view of the watch's lookback.
const oldShare = ({ signal, windowMs, where, minCount }) => {
  const reach = Math.max(2 * WEEK, Math.max(1, Math.ceil(WEEK / windowMs)) * windowMs);
  const tally = (events, gates) => countUnits(events, signal, gates);
  return {
    name: `${signal} ${windowMs}${where ? JSON.stringify(where) : ""}`,
    severity: "page",
    signal,
    ...(where ? { where } : {}),
    windowMs,
    lookbackMs: windowMs + reach,
    tested: true,
    check: (view, now, { alpha, excluded, gates }) => {
      const current = tally(view.within({ from: now - windowMs, to: now, where }), gates);
      const base = { yes: 0, total: 0 };
      const earliest = Math.max(now - windowMs - reach, view.events[0]?.at ?? now);
      for (const stretch of wholeStretches({ end: now - windowMs, lengthMs: windowMs, count: Math.ceil(WEEK / windowMs), earliest, excluded })) {
        const counted = tally(view.within({ ...stretch, where }), gates);
        base.yes += counted.yes;
        base.total += counted.total;
      }
      const detail = { now: `${current.yes}/${current.total}`, baseline: `${base.yes}/${base.total}` };
      if (current.total === 0 || base.total < 30) {
        return { state: "no_data", detail };
      }
      const { p } = compareRates(current, base);
      return { state: current.yes >= minCount && p < alpha ? "firing" : "ok", detail: { ...detail, p } };
    },
  };
};
const oldEvent = ({ signal, gate, lateMs = 6 * HOUR }) => ({
  name: `event: ${signal}`,
  severity: "page",
  signal,
  windowMs: 0,
  lookbackMs: lateMs,
  tested: false,
  check: (view, now, { since }) => {
    const hits = view.within({ from: since - lateMs, to: now }).filter((event) => (event.signals[signal] ?? 0) >= gate);
    return { state: hits.length > 0 ? "firing" : "ok", detail: {}, events: hits.map((event) => ({ id: event.id, at: event.at, detail: { p: event.signals[signal] ?? 0 } })) };
  },
});
const oldVolume = ({ windowMs, name }) => ({
  name,
  severity: "page",
  signal: "*",
  windowMs,
  lookbackMs: WEEK + windowMs,
  tested: false,
  check: (view, now) => {
    const current = view.within({ from: now - windowMs, to: now }).length;
    const before = view.within({ from: now - WEEK - windowMs, to: now - WEEK }).length;
    return { state: current >= 20 && current > 2 * Math.max(before, 1) ? "firing" : "ok", detail: { now: current, before } };
  },
});

test("viewMonitor runs a monitor written for 0.1 on a reader, reading only its own lookback, and it says what the built-in monitor says", async () => {
  const inbox = loadInbox("support");
  const kinds = [
    ...["is_bug_report", "area=login_access", "frustration>=2"].flatMap((signal) => TIERS.slice(0, 2).map(({ windowMs, minCount }) => ({ signal, windowMs, minCount }))),
    { signal: "is_bug_report", windowMs: 3 * HOUR, minCount: 5, where: { platform: "android" } },
  ];
  const builtIn = [...kinds.map((kind) => shareMonitor({ ...kind, name: oldShare(kind).name })), eventMonitor({ signal: "data_exposure", gate: 0.9 }), volumeMonitor({ windowMs: 3 * HOUR, name: "volume" })];
  const adapted = [...kinds.map((kind) => viewMonitor(oldShare(kind))), viewMonitor(oldEvent({ signal: "data_exposure", gate: 0.9 })), viewMonitor(oldVolume({ windowMs: 3 * HOUR, name: "volume" }))];
  const span = { from: inbox.start + 8 * DAY, to: inbox.start + 21 * DAY, changes: withPlans(inbox.changes) };
  const expected = await replay({ monitors: builtIn }, inbox.events, span);
  const got = await replay({ monitors: adapted }, inbox.events, span);
  assert.ok(expected.alerts.length > 5, `${expected.alerts.length} alerts`);
  assert.deepEqual(got.alerts, expected.alerts);
  assert.deepEqual(got.resolved, expected.resolved);

  // Each check reads its own lookback and no more, through the reader it is given.
  const reads = [];
  const reader = memoryReader(inbox.events);
  const watched = { ...reader, events: async (query) => (reads.push(query), reader.events(query)) };
  const now = inbox.start + 14 * DAY;
  await viewMonitor(oldEvent({ signal: "data_exposure", gate: 0.9 })).check(watched, now, { ...context, since: now - HOUR });
  assert.deepEqual(reads, [{ from: now - 6 * HOUR, to: now }]);
});
