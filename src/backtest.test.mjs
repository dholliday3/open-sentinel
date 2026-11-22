import assert from "node:assert/strict";
import { test } from "node:test";
import { backtestMonitors, backtestQuestion, relabel, upgrade } from "./backtest.ts";
import { ruleLabeler } from "./labelers/rules.ts";
import { shareMonitor } from "./monitors.ts";
import { defineSchema, yesNo } from "./schema.ts";
import { stream } from "./testing.ts";
import { DAY, HOUR, WEEK } from "./types.ts";

// A week of messages; from day 5 on, a third of them mention tax.
const history = stream({ start: 0, hours: 7 * 24, perHour: 6, signals: { old_question: 0.5 } }).map((event, i) => ({ ...event, text: event.at >= 4 * DAY && i % 3 === 0 ? `the tax on invoice ${i} is doubled` : `how do I add customer ${i}` }));
const mentionsTax = ruleLabeler({ id: "tax-rule@1", answer: { tax_wrong: (state) => /tax/.test(state.message) } });

test("relabel asks a new schema of stored events and skips the ones whose text wasn't kept", async () => {
  const schema = defineSchema({ name: "v2", questions: { tax_wrong: yesNo("Does it say the tax is wrong?") } });
  const { text: _dropped, ...withoutText } = history[0];
  const { events, skipped, failed, cost } = await relabel([withoutText, ...history.slice(1, 40)], schema, mentionsTax);
  assert.equal(skipped, 1);
  assert.deepEqual(failed, []);
  assert.equal(events.length, 39);
  assert.deepEqual([events[0].schema, events[0].labeler, events[0].id, events[0].tags], [schema.id, "tax-rule@1", history[1].id, history[1].tags]);
  assert.deepEqual(Object.keys(events[0].signals), ["tax_wrong"]);
  assert.equal(cost, 0);
});

test("backtestQuestion shows what a new question would have counted, day by day, with its surest examples", async () => {
  const result = await backtestQuestion({ events: history, key: "tax_wrong", question: yesNo("Does it say the tax is wrong?"), labeler: mentionsTax, examples: 3 });
  const [signal] = result.signals;
  assert.equal(signal.signal, "tax_wrong");
  assert.equal(signal.counts.total, history.length);
  assert.deepEqual(signal.byBucket.slice(0, 4).map((bucket) => bucket.yes), [0, 0, 0, 0]);
  assert.ok(signal.byBucket.slice(4).every((bucket) => bucket.yes > 30 && bucket.yes < 70));
  assert.ok(signal.surest.length === 3 && signal.surest.every((event) => /tax/.test(event.text)));
  assert.equal(result.schema.name, "backtest-tax_wrong");
});

test("backtestMonitors says how often monitors would have alerted", async () => {
  const events = stream({ start: 0, hours: 3 * 7 * 24, perHour: 20, signals: { bug: (at) => (at >= 2 * WEEK + 3 * DAY && at < 2 * WEEK + 3 * DAY + 6 * HOUR ? 0.5 : 0.05) } });
  const { groups, pagesPerWeek, digestsPerWeek, alerts } = await backtestMonitors({ monitors: [shareMonitor({ signal: "bug", windowMs: 3 * HOUR })] }, events, { from: WEEK, to: 3 * WEEK });
  assert.equal(groups.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(pagesPerWeek, 0.5);
  assert.equal(digestsPerWeek, 0);
  assert.ok(alerts[0].at > 2 * WEEK + 3 * DAY && alerts[0].at <= 2 * WEEK + 3 * DAY + 4 * HOUR);
});

test("upgrade asks only the questions that are new or reworded, and keeps the other answers", async () => {
  const asked = [];
  const rules = ruleLabeler({ id: "rules@1", answer: { bug: (state) => /broken/.test(state.message), tax_wrong: (state) => /tax/.test(state.message), urgent: () => false } });
  const labeler = { ...rules, label: async (state, questions) => (asked.push(Object.keys(questions)), rules.label(state, questions)) };
  const v1 = defineSchema({ name: "inbox", questions: { bug: yesNo("Is something broken?"), urgent: yesNo("Is it urgent?"), dropped: yesNo("A question v2 no longer asks") } });
  const v2 = defineSchema({ name: "inbox", questions: { bug: yesNo("Is something broken?"), urgent: yesNo("Does the customer need an answer today?"), tax_wrong: yesNo("Does it say the tax is wrong?") } });
  const stored = (id, text, extra = {}) => ({ id, at: 1, text, schema: v1.id, labeler: "rules@1", probability: "none", signals: { bug: 0.25, "bug.second": 1, urgent: 1, dropped: 1 }, ...extra });
  const { text: _dropped, ...noText } = stored("gone", "x");
  const result = await upgrade([stored("a", "the tax is broken"), stored("b", "hello"), stored("other", "broken", { labeler: "someone-else@1" }), noText], v1, v2, labeler);

  assert.deepEqual(result.asked, ["urgent", "tax_wrong"]);
  assert.equal(result.skipped, 1);
  const byId = Object.fromEntries(result.events.map((e) => [e.id, e]));
  // The unchanged question keeps its stored answer (and its second reader's), the reworded and
  // the new one are asked, and the question v2 dropped is gone.
  assert.deepEqual(byId.a.signals, { bug: 0.25, "bug.second": 1, urgent: 0, tax_wrong: 1 });
  assert.deepEqual([byId.a.schema, byId.a.labeler, byId.a.text], [v2.id, "rules@1", "the tax is broken"]);
  assert.deepEqual(byId.b.signals, { bug: 0.25, "bug.second": 1, urgent: 0, tax_wrong: 0 });
  // Another labeler's answers can't be kept beside this one's: that event is asked everything.
  assert.deepEqual(byId.other.signals, { bug: 1, urgent: 0, tax_wrong: 0 });
  assert.deepEqual(asked.map((keys) => keys.join()).sort(), ["bug,urgent,tax_wrong", "urgent,tax_wrong", "urgent,tax_wrong"]);

  // Only the gate changed, not the wording: nothing to ask.
  asked.length = 0;
  const same = await upgrade([stored("a", "x")], v1, v1, labeler);
  assert.deepEqual([same.asked, asked, same.events[0].signals], [[], [], stored("a", "x").signals]);
});
