import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleLabeler } from "./labelers/rules.ts";
import { eventMonitor, shareMonitor } from "./monitors.ts";
import { createPipeline, createWatch } from "./pipeline.ts";
import { defineSchema, yesNo } from "./schema.ts";
import { memoryStore } from "./store.ts";
import { stream } from "./testing.ts";
import { DAY, HOUR } from "./types.ts";

const schema = defineSchema({ name: "t", questions: { bug: yesNo("Broken?") } });
const counting = () => {
  const labeler = { ...ruleLabeler({ id: "r@1", answer: { bug: (state) => /broken/.test(state.message) } }), calls: 0 };
  const inner = labeler.label;
  labeler.label = async (state, questions) => ((labeler.calls += 1), { ...(await inner(state, questions)), cost: 0.001 });
  return labeler;
};
const text = (id, body, at = 1000) => ({ id, at, text: body, tags: { platform: "web" } });
const done = (counts) => ({ failed: [], undelivered: [], ...counts });
/** Polls until `ready` is true: waiting for work another task is doing. */
const until = async (ready) => {
  for (let tries = 0; !(await ready()); tries += 1) {
    assert.ok(tries < 400, "waited too long");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
/** A sink that throws on the calls it is told to, and keeps what it took. */
const flaky = (method, failOn) => {
  const sink = { calls: 0, took: [] };
  sink[method] = (items) => {
    sink.calls += 1;
    if (failOn.includes(sink.calls)) {
      throw new Error("the endpoint is down");
    }
    sink.took.push(items.map((item) => item.id));
  };
  return sink;
};

test("the pipeline labels, stores and hands on each event once", async () => {
  const labeler = counting();
  const store = memoryStore();
  const seen = [];
  const pipeline = createPipeline({ schema, labeler, store, sinks: [{ labeled: (events) => void seen.push(events.map((e) => e.id)) }, {}] });
  assert.deepEqual(await pipeline.ingest([text("1", "it is broken"), text("2", "thanks")]), done({ labeled: 2, skipped: 0, cost: 0.002 }));
  // A redelivery of the first two, with one new event.
  assert.deepEqual(await pipeline.ingest([text("1", "it is broken"), text("2", "thanks"), text("3", "still broken")]), done({ labeled: 1, skipped: 2, cost: 0.001 }));
  assert.equal(labeler.calls, 3);
  assert.deepEqual(seen, [["1", "2"], ["3"]]);
  // The same new event twice in one batch is labeled once.
  assert.deepEqual(await pipeline.ingest([text("4", "broken again"), text("4", "broken again")]), done({ labeled: 1, skipped: 1, cost: 0.001 }));
  assert.deepEqual((await store.events({ schema: schema.id })).map((e) => [e.id, e.signals.bug, e.text]), [["1", 1, "it is broken"], ["2", 0, "thanks"], ["3", 1, "still broken"], ["4", 1, "broken again"]]);
});

test("one event the labeler can't answer doesn't hold up the rest, and is tried again when it comes back", async () => {
  const store = memoryStore();
  let down = true;
  const rules = counting();
  const labeler = { ...rules, label: async (state, questions) => (down && /unreadable/.test(state.message) ? Promise.reject(new Error("no probability")) : rules.label(state, questions)) };
  const pipeline = createPipeline({ schema, labeler, store });
  const first = await pipeline.ingest([text("1", "broken"), text("2", "unreadable"), text("3", "fine")]);
  assert.deepEqual([first.labeled, first.failed], [2, [{ id: "2", error: "no probability" }]]);
  assert.deepEqual((await store.events()).map((e) => e.id), ["1", "3"]);
  // It wasn't stored as "no": the same delivery again labels only the one that failed.
  down = false;
  assert.deepEqual(await pipeline.ingest([text("1", "broken"), text("2", "unreadable"), text("3", "fine")]), done({ labeled: 1, skipped: 2, cost: 0.001 }));
});

test("a sink that fails is offered the events again with the next batch; the store and the other sinks are not held up", async () => {
  const store = memoryStore();
  const broken = flaky("labeled", [1]);
  const healthy = flaky("labeled", []);
  const pipeline = createPipeline({ schema, labeler: counting(), store, sinks: [broken, healthy] });
  const first = await pipeline.ingest([text("1", "broken"), text("2", "fine")]);
  assert.deepEqual(first.undelivered, [{ sink: 0, error: "the endpoint is down", pending: 2 }]);
  assert.equal((await store.events()).length, 2);
  const second = await pipeline.ingest([text("3", "fine")]);
  assert.deepEqual(second.undelivered, []);
  assert.deepEqual(broken.took, [["1", "2", "3"]]);
  assert.deepEqual(healthy.took, [["1", "2"], ["3"]]);
});

test("batches labeled at the same moment each reach a sink once, and a failed send loses neither", async () => {
  // A sink that takes a moment, and fails on the calls it is told to.
  const slow = (failOn) => {
    const sink = { calls: 0, took: [] };
    sink.labeled = async (events) => {
      sink.calls += 1;
      const call = sink.calls;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (failOn.includes(call)) {
        throw new Error("the endpoint is down");
      }
      sink.took.push(...events.map((event) => event.id));
    };
    return sink;
  };
  for (const failOn of [[], [1], [2]]) {
    const sink = slow(failOn);
    const pipeline = createPipeline({ schema, labeler: counting(), store: memoryStore(), sinks: [sink] });
    const [first, second] = await Promise.all([pipeline.ingest([text("a", "broken")]), pipeline.ingest([text("b", "fine")])]);
    assert.equal(first.undelivered.length + second.undelivered.length, failOn.length, `failing on call ${failOn}`);
    await pipeline.ingest([text("c", "fine")]);
    // Every event exactly once: none sent by both batches, none dropped with the failed send.
    assert.deepEqual([...sink.took].sort(), ["a", "b", "c"], `failing on call ${failOn}`);
  }
});

test("run tells the source when it has to stop early", async () => {
  const down = { ...memoryStore(), append: async () => Promise.reject(new Error("the store is down")) };
  let released = false;
  async function* source() {
    try {
      yield text("1", "broken");
      yield text("2", "fine");
    } finally {
      released = true;
    }
  }
  await assert.rejects(createPipeline({ schema, labeler: counting(), store: down }).run(source(), { batch: 1 }), /the store is down/);
  assert.equal(released, true);
});

test("run drains any source in batches; keepText false stores neither text nor context", async () => {
  const store = memoryStore();
  const pipeline = createPipeline({ schema, labeler: counting(), store, keepText: false, redact: (body) => body.replace("secret", "[hidden]") });
  async function* source() {
    for (let i = 0; i < 7; i += 1) {
      yield { ...text(`e${i}`, i === 3 ? "secret is broken" : "fine", i), context: { replying_to: "an earlier message" } };
    }
  }
  assert.deepEqual(await pipeline.run(source(), { batch: 3 }), done({ labeled: 7, skipped: 0, cost: 0.007 }));
  const stored = await store.events();
  assert.equal(stored.length, 7);
  assert.equal(stored.every((event) => !("text" in event) && !("context" in event)), true);
  assert.equal(stored[3].signals.bug, 1);
  assert.deepEqual(await pipeline.run([text("e0", "fine", 0)]), done({ labeled: 0, skipped: 1, cost: 0 }));
});

test("run doesn't wait for a full batch: an event from a quiet source is labeled after maxWaitMs", async () => {
  const store = memoryStore();
  const pipeline = createPipeline({ schema, labeler: counting(), store });
  let more;
  const later = new Promise((resolve) => (more = resolve));
  async function* quiet() {
    yield text("first", "it is broken");
    await later;
    yield text("second", "fine");
  }
  const running = pipeline.run(quiet(), { batch: 50, maxWaitMs: 10 });
  // The source has given one event and is still open. That event must not sit in a half-full batch.
  await until(async () => (await store.events()).length === 1);
  more();
  assert.deepEqual(await running, done({ labeled: 2, skipped: 0, cost: 0.002 }));
});

const START = 8 * DAY + 9 * HOUR;
const incident = (hours) => stream({ start: 0, hours: hours * 24, perHour: 20, schema: schema.id, signals: { bug: (at) => (at >= START && at < START + 6 * HOUR ? 0.5 : 0.05) } });
const collect = () => {
  const notices = [];
  return { notices, sink: { notify: (batch) => void notices.push(...batch) } };
};
const share = () => shareMonitor({ signal: "bug", windowMs: 3 * HOUR });

test("the watch raises a notice with the likely change, once, then says when it ended", async () => {
  const store = memoryStore({ events: incident(12) });
  await store.recordChange({ id: "deploy-7", at: START - HOUR / 2, kind: "deploy", what: "api: new invoice renderer" });
  await store.recordChange({ id: "old", at: 2 * DAY, kind: "deploy", what: "last week's deploy" });
  const { notices, sink } = collect();
  const watch = createWatch({ schema, store, monitors: [share()], rearmMs: { page: 6 * HOUR }, sinks: [sink] });
  for (let now = START - 3 * HOUR; now <= START + 30 * HOUR; now += HOUR) {
    await watch.tick(now);
  }
  assert.deepEqual(notices.map((n) => n.kind), ["fired", "resolved"]);
  const [fired, resolved] = notices;
  assert.equal(fired.alert.monitor, "3h share of bug");
  assert.ok(fired.alert.at > START && fired.alert.at <= START + 3 * HOUR);
  assert.deepEqual([fired.id, fired.at], [`${fired.alert.id}#fired`, fired.alert.at]);
  assert.equal(fired.suspects[0].change.id, "deploy-7");
  assert.equal(fired.confident, true);
  // The resolved notice names the alert it closes, and carries the time it was found to be over.
  assert.equal(resolved.alert.id, fired.alert.id);
  assert.equal(resolved.id, `${fired.alert.id}#resolved`);
  assert.ok(resolved.at > fired.at + 6 * HOUR);
});

test("the watch doesn't notify about what a planned change predicted", async () => {
  const store = memoryStore({ events: incident(10), changes: [{ id: "email", at: START - HOUR, kind: "campaign", what: "launch email", expect: { signals: ["bug"], forMs: DAY } }] });
  const { notices, sink } = collect();
  const watch = createWatch({ schema, store, monitors: [share()], sinks: [sink] });
  let muted = 0;
  for (let now = START; now <= START + 8 * HOUR; now += HOUR) {
    muted += (await watch.tick(now)).fired.filter((alert) => alert.mutedBy === "email").length;
  }
  assert.equal(muted, 1);
  assert.deepEqual(notices, []);
});

test("a sink that fails once still gets the notice on the next tick; the tick doesn't throw and the other sink isn't held up", async () => {
  const store = memoryStore({ events: incident(10) });
  const pager = flaky("notify", [1]);
  const log = flaky("notify", []);
  const watch = createWatch({ schema, store, monitors: [share()], sinks: [pager, log] });
  const ticks = [];
  for (let now = START; now <= START + 5 * HOUR; now += HOUR) {
    ticks.push(await watch.tick(now));
  }
  const firedAt = ticks.findIndex((tick) => tick.notices.length > 0);
  assert.deepEqual(ticks[firedAt].undelivered.map((u) => [u.sink, u.error, u.pending]), [[0, "the endpoint is down", 1]]);
  assert.deepEqual(ticks[firedAt + 1].undelivered, []);
  // Both sinks got the one notice, once each.
  assert.deepEqual([pager.took, log.took], [[[ticks[firedAt].notices[0].id]], [[ticks[firedAt].notices[0].id]]]);
});

test("a process that starts fresh for every tick keeps its episodes and what it still owes a sink", async () => {
  const store = memoryStore({ events: incident(10) });
  let pagerUp = false;
  const took = [];
  const pager = { notify: (batch) => (pagerUp ? void took.push(...batch.map((n) => n.id)) : Promise.reject(new Error("the endpoint is down"))) };
  const fired = [];
  for (let now = START; now <= START + 5 * HOUR; now += HOUR) {
    // The pager comes back for the last tick.
    pagerUp = now === START + 5 * HOUR;
    // A new watch each time, as a cron job would make one: nothing carried over in memory.
    const tick = await createWatch({ schema, store, monitors: [share()], sinks: [pager] }).tick(now);
    fired.push(...tick.fired);
  }
  // One episode, alerted once, although no watch lived to see two ticks.
  assert.equal(fired.length, 1);
  assert.deepEqual(took, [`${fired[0].id}#fired`]);
  assert.deepEqual((await store.loadState("watch:t")).owed, {});
});

test("an event stored after the tick that covered its time still pages, once", async () => {
  const store = memoryStore();
  const { notices, sink } = collect();
  const watch = createWatch({ schema, store, monitors: [eventMonitor({ signal: "bug" })], sinks: [sink] });
  const leak = { id: "leak", at: 10 * HOUR - 10 * 60_000, text: "I can see another business", schema: schema.id, labeler: "r@1", probability: "native", signals: { bug: 0.99 } };
  // Written at 09:50; the pipeline stores it at 10:05, after the 10:00 tick.
  await watch.tick(10 * HOUR);
  await store.append([leak]);
  await watch.tick(11 * HOUR);
  await watch.tick(12 * HOUR);
  assert.deepEqual(notices.map((n) => [n.kind, n.alert.event.id]), [["fired", "leak"]]);
});

test("a schema's own gates stay in force for the signals the watch doesn't override", async () => {
  const gated = defineSchema({ name: "g", questions: { bug: yesNo("Broken?", { gate: 0.9 }), leak: yesNo("Leak?", { gate: 0.9 }) } });
  const seen = [];
  const spy = { name: "spy", severity: "digest", windowMs: 0, lookbackMs: 0, tested: false, check: (_view, _now, { gates }) => (seen.push(gates), { state: "ok", detail: {} }) };
  await createWatch({ schema: gated, store: memoryStore(), monitors: [spy], gates: { leak: 0.7 } }).tick(HOUR);
  assert.deepEqual(seen, [{ bug: 0.9, leak: 0.7 }]);
});

test("history labeled again by a second labeler isn't counted twice", async () => {
  const events = incident(10);
  const again = events.map((event) => ({ ...event, labeler: "newer@2" }));
  const store = memoryStore({ events: [...events, ...again] });
  const seen = [];
  const spy = { name: "spy", severity: "digest", windowMs: 0, lookbackMs: DAY, tested: false, check: (view) => (seen.push(view.events.map((e) => e.labeler)), { state: "ok", detail: {} }) };
  const tick = await createWatch({ schema, store, monitors: [spy] }).tick(START);
  assert.deepEqual(tick.mixedLabelers.sort(), ["newer@2", "test-labeler@1"]);
  assert.equal(seen[0].length, events.filter((e) => e.at < START && e.at >= START - 10 * DAY).length);
  // Asked for one labeler, it reads only that one and has nothing to warn about.
  const pinned = await createWatch({ schema, store, monitors: [spy], labeler: "test-labeler@1", stateKey: "pinned" }).tick(START);
  assert.equal(pinned.mixedLabelers, undefined);
  assert.equal(new Set(seen[1]).size, 1);
});

test("a confirmed incident is left out of later baselines, across restarts; cutoffs can be read", async () => {
  const store = memoryStore({ events: incident(10) });
  const seen = [];
  const spy = { name: "spy", severity: "page", windowMs: 0, lookbackMs: 0, tested: true, check: (_view, _now, { excluded }) => (seen.push(excluded), { state: "ok", detail: {} }) };
  const first = createWatch({ schema, store, monitors: [spy] });
  await first.exclude({ from: START, to: START + 6 * HOUR });
  await createWatch({ schema, store, monitors: [spy] }).tick(START + DAY);
  assert.deepEqual(seen, [[{ from: START, to: START + 6 * HOUR }]]);
  assert.deepEqual(first.alphas(), { spy: 0.25 / 168 });
  assert.throws(() => createWatch({ schema, store, monitors: [spy, spy] }), /Two monitors are named "spy"/);
});

test("a cron job that fires twice in one step sends notices with the same ids, so a sink can drop the second", async () => {
  const store = memoryStore({ events: incident(10) });
  const make = () => createWatch({ schema, store, monitors: [share()] });
  // Two invocations a minute apart, each loading the state before the other has saved it.
  const at = START + 3 * HOUR;
  const [first, second] = await Promise.all([make().tick(at), make().tick(at + 60_000)]);
  assert.equal(first.notices.length, 1);
  assert.deepEqual(second.notices.map((n) => n.id), first.notices.map((n) => n.id));
  assert.equal(first.notices[0].alert.id, `3h share of bug@${at}`);
  // The next step's alert is another one.
  const fresh = memoryStore({ events: incident(10) });
  assert.equal((await createWatch({ schema, store: fresh, monitors: [share()] }).tick(at + HOUR)).notices[0].alert.id, `3h share of bug@${at + HOUR}`);
});
