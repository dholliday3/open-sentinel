import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryReader } from "./reader.ts";
import { createRunner, groupAlerts, replay } from "./monitor.ts";
import { DAY, HOUR, WEEK } from "./types.ts";

const reader = memoryReader([]);
/** A monitor that answers by the hour, as scripted, and keeps what it was given. Hours not listed are "ok". */
const scripted = (name, hours, extra = {}) => {
  const seen = [];
  const states = Array.isArray(hours) ? Object.fromEntries(hours.map((hour) => [hour, "firing"])) : hours;
  return { name, severity: "page", signal: "bug", windowMs: 3 * HOUR, lookbackMs: WEEK, tested: true, seen, check: (_reader, now, context) => (seen.push({ now, ...context }), { state: states[now / HOUR] ?? "ok", detail: { hour: now / HOUR } }), ...extra };
};
const run = async (runner, hours, changes) => {
  const ticks = [];
  for (const hour of hours) {
    ticks.push({ hour, ...(await runner.tick(reader, hour * HOUR, changes)) });
  }
  return ticks;
};
const hoursTo = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("tested monitors share the weekly budget, per severity; a fixed cutoff stays out of it", async () => {
  const monitors = [scripted("a", []), scripted("b", []), scripted("c", [], { severity: "digest" }), scripted("d", [], { alpha: 0.01 }), scripted("e", [], { tested: false })];
  const runner = createRunner({ monitors, budget: { pagesPerWeek: 0.5, digestsPerWeek: 2 } });
  assert.equal(runner.alphaOf(monitors[0]), 0.5 / (168 * 2));
  assert.equal(runner.alphaOf(monitors[2]), 2 / (168 * 1));
  assert.equal(runner.alphaOf(monitors[3]), 0.01);
  assert.equal(createRunner({ monitors, stepMs: 15 * 60_000 }).alphaOf(monitors[0]), 0.25 / (168 * 4 * 2));
  await runner.tick(reader, HOUR);
  assert.equal(monitors[0].seen[0].alpha, 0.5 / 336);
});

test("two monitors can't share a name: it is what tells their episodes apart", () => {
  assert.throws(() => createRunner({ monitors: [scripted("a", []), scripted("a", [])] }), /Two monitors are named "a"/);
});

test("one alert per episode; the episode ends after the monitor has been clear for the rearm time", async () => {
  const monitor = scripted("a", [1, 2, 3, 10, 30]);
  const ticks = await run(createRunner({ monitors: [monitor], rearmMs: { page: 12 * HOUR } }), hoursTo(45));
  assert.deepEqual(ticks.filter((t) => t.fired.length > 0).map((t) => t.hour), [1, 30]);
  // Hour 10 was within 12 hours of hour 3, so it kept the first episode open until 12 hours after it.
  assert.deepEqual(ticks.filter((t) => t.resolved.length > 0).map((t) => [t.hour, t.resolved[0].at / HOUR]), [[23, 1], [43, 30]]);
  assert.deepEqual(ticks[0].fired[0], { id: `a@${HOUR}`, monitor: "a", severity: "page", signal: "bug", at: HOUR, windowMs: 3 * HOUR, detail: { hour: 1 } });
});

test("a check may be asynchronous, so a monitor can ask a database", async () => {
  const monitor = { ...scripted("a", []), check: async (_reader, now) => ({ state: now === HOUR ? "firing" : "ok", detail: {} }) };
  assert.equal((await createRunner({ monitors: [monitor] }).tick(reader, HOUR)).fired.length, 1);
});

test("too little data is reported, not alerted, and never ends an episode", async () => {
  const quiet = scripted("quiet", { 1: "no_data" });
  assert.deepEqual(await createRunner({ monitors: [quiet] }).tick(reader, HOUR), { fired: [], resolved: [], noData: ["quiet"] });

  // Fires at hour 1, then the stream goes quiet for a day, then it fires again: still one episode.
  const stopped = scripted("stopped", { 1: "firing", ...Object.fromEntries(hoursTo(30).slice(1).map((hour) => [hour, "no_data"])), 31: "firing" });
  const ticks = await run(createRunner({ monitors: [stopped], rearmMs: { page: 12 * HOUR } }), hoursTo(50));
  assert.deepEqual(ticks.filter((t) => t.fired.length > 0).map((t) => t.hour), [1]);
  // Clear from hour 32: the episode ends 12 hours after its last firing, at hour 31.
  assert.deepEqual(ticks.filter((t) => t.resolved.length > 0).map((t) => t.hour), [44]);
});

test("a monitor that reports events raises one alert for each event, however often it reports it", async () => {
  // Reports e1 at hours 1 and 2 (still inside its lookback), and at hour 2 an event stored late.
  const reports = { 1: [{ id: "e1", at: 10, detail: { p: 0.95 } }], 2: [{ id: "e1", at: 10, detail: { p: 0.95 } }, { id: "late", at: 5 }], 3: [] };
  const monitor = { name: "one event", severity: "page", signal: "leak", windowMs: 0, lookbackMs: 6 * HOUR, tested: false, check: (_v, now) => ({ state: "firing", detail: {}, events: reports[now / HOUR] ?? [] }) };
  const ticks = await run(createRunner({ monitors: [monitor] }), [1, 2, 3]);
  assert.deepEqual(ticks.map((t) => t.fired.map((a) => [a.id, a.event, a.detail])), [[["one event@e1", { id: "e1", at: 10 }, { p: 0.95 }]], [["one event@late", { id: "late", at: 5 }, {}]], []]);
});

test("an event alerted on is remembered across a restart, and forgotten once no monitor can report it again", async () => {
  const again = { name: "one event", severity: "page", windowMs: 0, lookbackMs: 6 * HOUR, tested: false, check: () => ({ state: "firing", detail: {}, events: [{ id: "e1", at: 10 }] }) };
  const before = createRunner({ monitors: [again] });
  assert.equal((await before.tick(reader, HOUR)).fired.length, 1);
  const after = createRunner({ monitors: [again], snapshot: JSON.parse(JSON.stringify(before.snapshot())) });
  assert.equal((await after.tick(reader, 2 * HOUR)).fired.length, 0);
  assert.deepEqual(after.snapshot().alerted, { "one event\ne1": 10 });
  // Its time is now further back than the lookback plus two steps: nothing can report it again.
  await after.tick(reader, 9 * HOUR);
  assert.deepEqual(after.snapshot().alerted, {});
});

test("each check is told when the last one ran, and the changes known", async () => {
  const monitor = scripted("a", []);
  const deploy = { id: "d", at: 0, kind: "deploy", what: "deploy" };
  await run(createRunner({ monitors: [monitor], stepMs: HOUR }), [5, 6, 9], [deploy]);
  assert.deepEqual(monitor.seen.map((s) => s.since / HOUR), [4, 5, 6]);
  assert.deepEqual(monitor.seen[0].changes, [deploy]);
});

test("a planned change mutes alerts on the signals it predicted, while their stretch overlaps it", async () => {
  const launch = { id: "launch", at: 10 * HOUR, kind: "campaign", what: "launch email", expect: { signals: ["bug"], forMs: 4 * HOUR } };
  const runner = createRunner({ monitors: [scripted("on bug", [11, 40]), scripted("on other", [11], { signal: "other" })], rearmMs: { page: HOUR } });
  const ticks = await run(runner, [11, 40], [launch]);
  assert.deepEqual(ticks[0].fired.map((a) => [a.monitor, a.mutedBy]), [["on bug", "launch"], ["on other", undefined]]);
  assert.equal(ticks[1].fired[0].mutedBy, undefined);
  // A 3-hour window ending at hour 16 still reaches back into the planned stretch (10 to 14).
  const late = createRunner({ monitors: [scripted("late", [16]), scripted("later", [17.5])] });
  assert.equal((await late.tick(reader, 16 * HOUR, [launch])).fired[0].mutedBy, "launch");
  assert.equal((await late.tick(reader, 17.5 * HOUR, [launch])).fired[0].mutedBy, undefined);
});

test("an episode that began muted raises its alert once it outlasts what was planned", async () => {
  const launch = { id: "launch", at: 10 * HOUR, kind: "campaign", what: "launch email", expect: { signals: ["bug"], forMs: 4 * HOUR } };
  // Fires from hour 11 on and never stops: the launch explains it until hour 17, not after.
  const monitor = scripted("a", hoursTo(30).slice(10));
  const ticks = await run(createRunner({ monitors: [monitor] }), hoursTo(30), [launch]);
  assert.deepEqual(ticks.filter((t) => t.fired.length > 0).map((t) => [t.hour, t.fired[0].mutedBy, t.fired[0].id]), [[11, "launch", `a@${11 * HOUR}`], [17, undefined, `a@${17 * HOUR}`]]);
});

test("baselines are told what to leave out: planned changes, confirmed incidents, and a page's own stretch when asked", async () => {
  const launch = { id: "launch", at: 10 * HOUR, kind: "campaign", what: "launch", expect: { signals: [], forMs: 2 * HOUR } };
  const plain = scripted("a", [20, 21]);
  const runner = createRunner({ monitors: [plain] });
  runner.exclude({ from: 1, to: 2 });
  await run(runner, [20, 21, 22], [launch]);
  assert.deepEqual(plain.seen[2].excluded.map((x) => [x.from, x.to]), [[1, 2], [10 * HOUR, 12 * HOUR]]);

  const own = scripted("b", [20, 21, 22, 23]);
  const excluding = createRunner({ monitors: [own], excludePagesMs: 5 * HOUR });
  await run(excluding, [20, 21, 22, 23, 24]);
  // From one window before the first firing, up to the last firing, capped at 5 hours.
  assert.deepEqual(own.seen[4].excluded.map((x) => [x.from / HOUR, x.to / HOUR]), [[17, 22]]);
});

test("a snapshot carries episodes and exclusions across a restart", async () => {
  const before = createRunner({ monitors: [scripted("a", [1])] });
  before.exclude({ from: 5, to: 6 });
  await before.tick(reader, HOUR);
  const monitor = scripted("a", [2, 20]);
  const after = createRunner({ monitors: [monitor], snapshot: JSON.parse(JSON.stringify(before.snapshot())) });
  const ticks = await run(after, [2, 20]);
  assert.equal(ticks[0].fired.length, 0);
  assert.equal(ticks[1].fired.length, 1);
  // The restored episode (opened at hour 1, last firing at hour 2) ends 12 hours later, and says which alert it was.
  assert.deepEqual(ticks[1].resolved.map((alert) => [alert.id, alert.at]), [[`a@${HOUR}`, HOUR]]);
  assert.equal(monitor.seen[0].since, HOUR);
  assert.deepEqual(monitor.seen[0].excluded, [{ from: 5, to: 6 }]);
});

test("groupAlerts joins pages that fire close together, keeps one-event alerts alone, and drops muted ones", () => {
  const alert = (monitor, hour, extra = {}) => ({ id: monitor, monitor, severity: "page", at: hour * HOUR, windowMs: 0, detail: {}, ...extra });
  const groups = groupAlerts([alert("a", 1), alert("b", 4), alert("c", 9), alert("leak", 3, { event: { id: "e", at: 1 } }), alert("d", 9.5, { mutedBy: "launch" }), alert("slow", 2, { severity: "digest" }), alert("slow 2", 20, { severity: "digest" }), alert("slow 3", 60, { severity: "digest" })]);
  // The one-event alert at hour 3 sits between a and b, and they still belong together.
  assert.deepEqual(groups.map((g) => [g.id, g.alerts.map((a) => a.monitor)]), [["page-1", ["a", "b"]], ["page-2", ["leak"]], ["page-3", ["c"]], ["digest-1", ["slow", "slow 2"]], ["digest-2", ["slow 3"]]]);
});

test("replay ticks once per step and only shows a monitor the changes that have happened", async () => {
  const launch = { id: "launch", at: 5 * HOUR, kind: "campaign", what: "launch", expect: { signals: ["bug"], forMs: DAY } };
  const monitor = scripted("a", [3, 8]);
  const { alerts, groups } = await replay({ monitors: [monitor], rearmMs: { page: 2 * HOUR } }, [], { from: 0, to: 10 * HOUR, changes: [launch] });
  assert.deepEqual(monitor.seen.map((s) => s.now / HOUR), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(monitor.seen.map((s) => s.changes.length), [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(alerts.map((a) => [a.at / HOUR, a.mutedBy]), [[3, undefined], [8, "launch"]]);
  assert.equal(groups.length, 1);
});
