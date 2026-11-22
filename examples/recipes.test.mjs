// Runs the README's real-world examples end to end: synthetic messages, labeled by rules in place
// of a model, stored, watched, and the alert each recipe promises.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPipeline, createWatch, DAY, eventMonitor, HOUR, memoryStore, ruleLabeler, shareMonitors } from "../src/index.ts";
import { seeded } from "../src/testing.ts";
import { support } from "./readme.ts";
import { announcePrices, billing, pagerDuty, texts, transcripts, watchAgent, watchAndroidSignIn, watchInvoices, watchTexts, workQueue } from "./recipes.ts";

const RELEASE = Date.parse("2026-11-20T15:00:00Z");

/** `perHour` messages an hour from `from` to `to`, from 300 accounts, each written by `write(random, at)`. */
const inbox = ({ from, to, perHour, write, seed = 1 }) => {
  const random = seeded(seed);
  const events = [];
  for (let hour = from; hour < to; hour += HOUR) {
    for (let i = 0; i < perHour; i += 1) {
      const at = hour + Math.floor(random() * HOUR);
      events.push({ id: `m${events.length}`, at, unit: `account-${Math.floor(random() * 300)}`, ...write(random, at) });
    }
  }
  return events;
};

/** Labels and stores messages the way the quickstart's pipeline does, with rules for a model. */
const ingest = async (store, schema, answer, events) => {
  const result = await createPipeline({ schema, labeler: ruleLabeler({ id: "rules@1", answer }), store }).ingest(events);
  assert.deepEqual(result.failed, []);
};

/** Ticks a watch every hour and keeps what it raised. */
const watchOver = async (watch, from, to) => {
  const seen = { fired: [], notices: [] };
  for (let now = from; now <= to; now += HOUR) {
    const tick = await watch.tick(now);
    seen.fired.push(...tick.fired);
    seen.notices.push(...tick.notices);
  }
  return seen;
};

const quickstartRules = {
  area: (state) => (/price|charge/.test(state.message) ? "billing" : /sign in/.test(state.message) ? "login" : "other"),
  is_bug_report: (state) => /isn't working/.test(state.message),
  data_exposure: (state) => /another company/.test(state.message),
};

test("1. a silent billing bug: the share pages, and the release is the top suspect", async (t) => {
  const printed = [];
  t.mock.method(console, "log", (line) => printed.push(line));
  const store = memoryStore();
  await ingest(store, billing, { invoice_wrong: (state) => /total is wrong/.test(state.message) }, inbox({
    from: RELEASE - 8 * DAY,
    to: RELEASE + 12 * HOUR,
    perHour: 30,
    write: (random, at) => {
      const version = at >= RELEASE && random() < 0.5 ? "4.12.0" : "4.11.3";
      return { text: random() < (version === "4.12.0" ? 0.3 : 0.02) ? "My invoice total is wrong" : "How do I add a client?", tags: { version } };
    },
  }));
  // An unrelated deploy lands at nearly the same moment: timing alone can't tell them apart.
  await store.recordChange({ id: "api-deploy", at: RELEASE + 20 * 60_000, kind: "deploy", what: "api: faster search" });
  const { notices } = await watchOver(await watchInvoices(store), RELEASE, RELEASE + 12 * HOUR);
  const fired = notices.filter((notice) => notice.kind === "fired");
  assert.ok(fired.some((notice) => notice.alert.monitor === "3h share of invoice_wrong"), fired.map((n) => n.alert.monitor).join("; "));
  assert.deepEqual([...new Set(fired.map((notice) => notice.suspects?.[0]?.change.id))], ["invoices-4.12.0"]);
  assert.ok(printed.some((line) => /fired page: 3h share of invoice_wrong; likely invoices 4\.12\.0: new PDF renderer$/.test(line)), printed.join("\n"));
});

test("2. one customer sees another company's data: one PagerDuty incident with the question and the message", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response("{}", { status: 202 })));
  process.env.PAGERDUTY_ROUTING_KEY = "routing-key";
  t.after(() => delete process.env.PAGERDUTY_ROUTING_KEY);
  const store = memoryStore();
  const now = RELEASE;
  await ingest(store, support, quickstartRules, [
    { id: "msg-1", at: now - 10 * 60_000, text: "I can see another company's customers in my account", unit: "account-42" },
    { id: "msg-2", at: now - 5 * 60_000, text: "How do I change my price list?", unit: "account-7" },
  ]);
  const watch = createWatch({ schema: support, store, monitors: [eventMonitor({ signal: "data_exposure" })], sinks: [pagerDuty] });
  await watch.tick(now);
  await watch.tick(now + HOUR);
  assert.deepEqual(sent.map((s) => [s.url, s.body.routing_key, s.body.event_action, s.body.dedup_key]), [["https://events.pagerduty.com/v2/enqueue", "routing-key", "trigger", "event: data_exposure@msg-1"]]);
  assert.equal(sent[0].body.payload.summary, `Does the customer say they can see another business's information? "I can see another company's customers in my account"`);
});

test("3. Android sign-in broken: the Android share pages and the Android release is the top suspect", async (t) => {
  t.mock.method(console, "log", () => {});
  const store = memoryStore();
  await ingest(store, support, quickstartRules, inbox({
    from: RELEASE - 8 * DAY,
    to: RELEASE + 12 * HOUR,
    perHour: 30,
    seed: 3,
    write: (random, at) => {
      const platform = random() < 0.4 ? "android" : random() < 0.5 ? "ios" : "web";
      const version = platform === "android" ? (at >= RELEASE && random() < 0.5 ? "4.12.0" : "4.11.3") : platform === "ios" ? "4.11.3" : "web";
      const login = random() < (version === "4.12.0" ? 0.4 : 0.05);
      return { text: login ? "I can't sign in, it just spins" : "How do I add a client?", tags: { platform, version } };
    },
  }));
  const monitors = await watchAndroidSignIn(store);
  const { notices } = await watchOver(createWatch({ schema: support, store, monitors }), RELEASE, RELEASE + 12 * HOUR);
  const fired = notices.filter((notice) => notice.kind === "fired");
  assert.ok(fired.some((notice) => notice.alert.monitor === "3h share of area=login {platform:android}"), fired.map((n) => n.alert.monitor).join("; "));
  assert.deepEqual([...new Set(fired.map((notice) => notice.suspects?.[0]?.change.id))], ["android-4.12.0"]);
  assert.ok(fired.every((notice) => notice.question === "Which part of the product is the message about? (Signing in)"));
});

test("4. a pricing email: the billing wave is raised muted, with no notice; unannounced, it pages", async () => {
  const EMAIL = Date.parse("2026-12-01T14:00:00Z");
  const messages = inbox({
    from: EMAIL - 8 * DAY,
    to: EMAIL + 8 * HOUR,
    perHour: 30,
    seed: 4,
    write: (random, at) => ({ text: random() < (at >= EMAIL ? 0.5 : 0.08) ? "Why did my price go up?" : "How do I add a client?" }),
  });
  const run = async (announced) => {
    const store = memoryStore();
    await ingest(store, support, quickstartRules, messages);
    if (announced) {
      await announcePrices(store);
    }
    return watchOver(createWatch({ schema: support, store, monitors: shareMonitors({ signals: support.signals }) }), EMAIL, EMAIL + 8 * HOUR);
  };
  const announced = await run(true);
  const billingAlerts = announced.fired.filter((alert) => alert.signal === "area=billing");
  assert.ok(billingAlerts.length > 0);
  assert.ok(billingAlerts.every((alert) => alert.mutedBy === "price-email"));
  assert.deepEqual(announced.notices.filter((notice) => notice.alert.signal === "area=billing"), []);
  const unannounced = await run(false);
  assert.ok(unannounced.notices.some((notice) => notice.kind === "fired" && notice.alert.signal === "area=billing"));
});

test("5. an AI agent after a prompt change: conversations on the new prompt alert, and the prompt is the top suspect", async (t) => {
  t.mock.method(console, "log", () => {});
  const store = memoryStore();
  await ingest(store, transcripts, { off_policy: (state) => /full refund/.test(state.message), wants_human: (state) => /a person/.test(state.message) }, inbox({
    from: RELEASE - 8 * DAY,
    to: RELEASE + 12 * HOUR,
    perHour: 30,
    seed: 5,
    write: (random, at) => {
      const prompt = at >= RELEASE && random() < 0.2 ? "v13" : "v12";
      const off = random() < (prompt === "v13" ? 0.25 : 0.03);
      return { text: off ? "Customer: it broke. Assistant: I'll give you a full refund for the year." : random() < 0.05 ? "Customer: can I talk to a person?" : "Customer: how do I export? Assistant: Use Settings.", tags: { prompt } };
    },
  }));
  const { notices } = await watchOver(await watchAgent(store), RELEASE, RELEASE + 12 * HOUR);
  const fired = notices.filter((notice) => notice.kind === "fired");
  assert.ok(fired.some((notice) => notice.alert.monitor === "off_policy among events exposed to prompt-v13"), fired.map((n) => n.alert.monitor).join("; "));
  assert.deepEqual([...new Set(fired.map((notice) => notice.alert.signal))], ["off_policy"]);
  assert.deepEqual([...new Set(fired.map((notice) => notice.suspects?.[0]?.change.id))], ["prompt-v13"]);
});

test("6. text replies stop arriving: the silence monitor pages", async (t) => {
  const printed = [];
  t.mock.method(console, "log", (line) => printed.push(line));
  const STOP = Date.parse("2026-11-20T15:00:00Z");
  const store = memoryStore();
  await ingest(store, texts, { wants_stop: (state) => /STOP/.test(state.message) }, inbox({ from: STOP - 3 * DAY, to: STOP, perHour: 10, seed: 6, write: () => ({ text: "Yes, Tuesday works" }) }));
  const watch = watchTexts(store);
  assert.deepEqual((await watch.tick(STOP)).notices, []);
  const { notices } = await watchOver(watch, STOP + HOUR, STOP + HOUR);
  assert.deepEqual(notices.map((notice) => [notice.kind, notice.alert.monitor, notice.alert.detail.now]), [["fired", "no events", 0]]);
  assert.match(printed.at(-1), /fired page: no events$/);
});

test("7. a queue worker acks what was stored and puts back what the labeler couldn't read", async () => {
  const messages = ["fine", "fine", "unreadable", "fine", "fine"].map((text, i) => ({ id: `q${i}`, at: RELEASE + i, text }));
  const acked = [];
  const retried = [];
  const queue = {
    messages: async function* () {
      yield* messages;
    },
    ack: async (events) => void acked.push(...events.map((event) => event.id)),
    retryLater: async (events) => void retried.push(...events.map((event) => event.id)),
  };
  const rules = ruleLabeler({ id: "rules@1", answer: { wants_stop: () => false } });
  const labeler = { ...rules, label: async (state, questions) => (/unreadable/.test(state.message) ? Promise.reject(new Error("no answer")) : rules.label(state, questions)) };
  const store = memoryStore();
  await workQueue(createPipeline({ schema: texts, labeler, store }), queue);
  assert.deepEqual([acked, retried], [["q0", "q1", "q3", "q4"], ["q2"]]);
  assert.deepEqual((await store.events()).map((event) => event.id), ["q0", "q1", "q3", "q4"]);
});
