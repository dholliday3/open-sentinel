import assert from "node:assert/strict";
import { test } from "node:test";
import { cached, labelAll, labelEvent, redactBasics } from "./labeler.ts";
import { ruleLabeler } from "./labelers/rules.ts";
import { choice, defineSchema, score, yesNo } from "./schema.ts";

const schema = defineSchema({
  name: "t",
  questions: { bug: yesNo("Broken?"), area: choice("Which part?", { login: "Sign in", other: "Else" }), mood: score("Upset?", ["No", "Some", "Very"]) },
});
const labeler = ruleLabeler({
  id: "rules@1",
  answer: { bug: (state) => /broken|crash/.test(state.message), area: (state) => (/log ?in/.test(state.message) ? "login" : "other"), mood: (state) => (state.message.includes("!!") ? 2 : 0) },
});
const event = (id, text) => ({ id, at: 1000, text, unit: "acct-1", tags: { platform: "ios" } });

test("labelEvent keeps the event and adds who answered what", async () => {
  const { event: labeled, cost } = await labelEvent(event("1", "login is broken!!"), schema, labeler);
  assert.deepEqual(labeled, {
    id: "1", at: 1000, text: "login is broken!!", unit: "acct-1", tags: { platform: "ios" },
    schema: schema.id, labeler: "rules@1", probability: "none",
    signals: { bug: 1, "area=login": 1, "area=other": 0, "mood>=1": 1, "mood>=2": 1 },
  });
  assert.equal(cost, 0);
});

test("redact runs before the labeler and before the text is kept", async () => {
  const seen = [];
  const spy = { ...labeler, label: async (state, questions) => (seen.push(state.message), labeler.label(state, questions)) };
  const { event: labeled } = await labelEvent(event("1", "call me at 401-555-0142, it crashed"), schema, spy, { redact: redactBasics });
  assert.deepEqual(seen, ["call me at [phone], it crashed"]);
  assert.equal(labeled.text, "call me at [phone], it crashed");
  assert.equal(labeled.signals.bug, 1);
});

test("a second reader is asked only inside the band, and only that question", async () => {
  const first = ruleLabeler({ id: "first", probability: "native", answer: { bug: (state) => Number(state.message), area: () => "other", mood: () => 0 } });
  const asked = [];
  const second = { id: "second", probability: "none", label: async (state, questions) => (asked.push(Object.keys(questions)), { answers: { bug: { type: "boolean", probability: 1 } }, cost: 0.002 }) };
  const options = { second: { labeler: second, bands: { bug: [0.5, 0.9] } } };
  const unsure = await labelEvent(event("1", "0.7"), schema, first, options);
  const sure = await labelEvent(event("2", "0.95"), schema, first, options);
  const no = await labelEvent(event("3", "0.2"), schema, first, options);
  assert.deepEqual(asked, [["bug"]]);
  assert.equal(unsure.event.signals["bug.second"], 1);
  assert.equal(unsure.cost, 0.002);
  assert.equal("bug.second" in sure.event.signals, false);
  assert.equal("bug.second" in no.event.signals, false);
});

test("an answer the labeler didn't give is an error, not a no", async () => {
  const partial = { id: "partial", probability: "native", label: async () => ({ answers: { bug: { type: "boolean", probability: 0.5 } } }) };
  await assert.rejects(labelEvent(event("1", "x"), schema, partial), /"area" was asked as choice/);
});

test("cached asks once for the same state and questions", async () => {
  let calls = 0;
  const counting = { ...labeler, label: async (state, questions) => ((calls += 1), { ...(await labeler.label(state, questions)), cost: 0.01 }) };
  const once = cached(counting);
  const a = await labelEvent(event("1", "it crashed"), schema, once);
  const b = await labelEvent(event("2", "it crashed"), schema, once);
  await labelEvent(event("3", "something else"), schema, once);
  assert.equal(calls, 2);
  assert.deepEqual([a.cost, b.cost], [0.01, 0]);
  assert.deepEqual(a.event.signals, b.event.signals);
});

test("redact also runs on every string in the context", async () => {
  const seen = [];
  const spy = { ...labeler, label: async (state, questions) => (seen.push(state), labeler.label(state, questions)) };
  const withContext = { ...event("1", "it crashed"), context: { replying_to: "mail me at jo@example.com", thread: ["call 401-555-0142", 3] } };
  const { event: labeled } = await labelEvent(withContext, schema, spy, { redact: redactBasics });
  assert.deepEqual(seen[0], { replying_to: "mail me at [email]", thread: ["call [phone]", 3], message: "it crashed" });
  assert.deepEqual(labeled.context, { replying_to: "mail me at [email]", thread: ["call [phone]", 3] });
});

test("cached asks once when the same text arrives twice at the same moment", async () => {
  let calls = 0;
  const slow = { ...labeler, label: async (state, questions) => ((calls += 1), await new Promise((r) => setTimeout(r, 5)), { ...(await labeler.label(state, questions)), cost: 0.01 }) };
  const once = cached(slow);
  const [a, b] = await Promise.all([labelEvent(event("1", "it crashed"), schema, once), labelEvent(event("2", "it crashed"), schema, once)]);
  assert.equal(calls, 1);
  assert.deepEqual([a.cost, b.cost], [0.01, 0]);
  assert.deepEqual(a.event.signals, b.event.signals);
});

test("labelAll reports an event the labeler couldn't answer and carries on with the rest", async () => {
  const flaky = {
    ...labeler,
    label: async (state, questions) => {
      if (state.message === "unreadable") {
        throw new Error("answered off-contract");
      }
      return { ...(await labeler.label(state, questions)), cost: 0.5 };
    },
  };
  const { events, failed, cost } = await labelAll([event("1", "a broken"), event("2", "unreadable"), event("3", "c")], schema, flaky);
  assert.deepEqual(events.map((e) => e.id), ["1", "3"]);
  assert.deepEqual(failed, [{ id: "2", error: "answered off-contract" }]);
  assert.equal(cost, 1);
});

test("labelAll keeps order and adds up cost", async () => {
  const slow = { ...labeler, label: async (state, questions) => (await new Promise((r) => setTimeout(r, state.message === "a broken" ? 15 : 1)), { ...(await labeler.label(state, questions)), cost: 0.5 }) };
  const { events, cost } = await labelAll([event("1", "a broken"), event("2", "b"), event("3", "c crash")], schema, slow, { concurrency: 3 });
  assert.deepEqual(events.map((e) => [e.id, e.signals.bug]), [["1", 1], ["2", 0], ["3", 1]]);
  assert.equal(cost, 1.5);
});

test("redactBasics replaces the obvious identifiers and leaves the rest", () => {
  assert.equal(redactBasics("mail jo.smith+x@example.co.uk or (401) 555-0142 / +1 401.555.0142"), "mail [email] or [phone] / [phone]");
  assert.equal(redactBasics("card 4242 4242 4242 4242, ssn 123-45-6789"), "card [card], ssn [ssn]");
  assert.equal(redactBasics("invoice 1182 for $487.50 on 2026-11-09 at 42 Quarry Lane"), "invoice 1182 for $487.50 on 2026-11-09 at 42 Quarry Lane");
});
