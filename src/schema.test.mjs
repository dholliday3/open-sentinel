import assert from "node:assert/strict";
import { test } from "node:test";
import { both, choice, defineSchema, score, yesNo } from "./schema.ts";

const questions = {
  bug: yesNo("Is something broken?"),
  wants_more: yesNo("Is this a feature request?", { gate: 0.7, yes: "Asks for something new", no: "Anything else" }),
  area: choice("Which part?", { login: "Signing in", billing: "Money" }),
  mood: score("How upset?", ["Not", "A little", "Very"]),
};
const schema = defineSchema({ name: "t", questions });

test("signals and default gates", () => {
  assert.deepEqual(schema.signals, ["bug", "wants_more", "area=login", "area=billing", "mood>=1", "mood>=2"]);
  assert.equal(schema.gates.bug, 0.5);
  assert.equal(schema.gates.wants_more, 0.7);
  assert.equal(schema.id, `t@${schema.version}`);
});

test("the wire format is what decision models take", () => {
  assert.deepEqual(schema.wire.bug, { type: "boolean", instructions: "Is something broken?" });
  assert.deepEqual(schema.wire.wants_more, { type: "boolean", instructions: "Is this a feature request?", criteria: { true: "Asks for something new", false: "Anything else" } });
  assert.deepEqual(schema.wire.area, { type: "choice", instructions: "Which part?", criteria: { login: "Signing in", billing: "Money" } });
  assert.deepEqual(schema.wire.mood, { type: "score", instructions: "How upset?", criteria: ["Not", "A little", "Very"] });
});

test("the version follows the wording, not the gates", () => {
  const reworded = defineSchema({ name: "t", questions: { ...questions, bug: yesNo("Is anything broken?") } });
  const regated = defineSchema({ name: "t", questions: { ...questions, bug: yesNo("Is something broken?", { gate: 0.9 }) } });
  assert.notEqual(reworded.version, schema.version);
  assert.equal(regated.version, schema.version);
});

test("read flattens each kind of answer", () => {
  const signals = schema.read({
    bug: { type: "boolean", probability: 0.9 },
    wants_more: { type: "boolean", probability: 0.1 },
    area: { type: "choice", choice: "login", probabilities: { login: 0.8, billing: 0.2 } },
    mood: { type: "score", score: 1.2, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } },
  });
  assert.equal(signals.bug, 0.9);
  assert.equal(signals["area=login"], 0.8);
  assert.equal(signals["area=billing"], 0.2);
  assert.ok(Math.abs(signals["mood>=1"] - 0.9) < 1e-9);
  assert.ok(Math.abs(signals["mood>=2"] - 0.3) < 1e-9);
});

test("read gives hard answers all their weight", () => {
  const signals = schema.read({ bug: { type: "boolean", probability: 1 }, wants_more: { type: "boolean", probability: 0 }, area: { type: "choice", choice: "billing" }, mood: { type: "score", score: 2 } });
  assert.deepEqual([signals["area=login"], signals["area=billing"], signals["mood>=1"], signals["mood>=2"]], [0, 1, 1, 1]);
});

test("read refuses an answer outside the contract", () => {
  const good = { bug: { type: "boolean", probability: 0.5 }, wants_more: { type: "boolean", probability: 0.5 }, area: { type: "choice", choice: "login" }, mood: { type: "score", score: 0 } };
  assert.throws(() => schema.read({ ...good, bug: undefined }), /"bug" was asked as boolean/);
  assert.throws(() => schema.read({ ...good, bug: { type: "refusal" } }), /answered as "refusal"/);
  assert.throws(() => schema.read({ ...good, bug: { type: "boolean", probability: 1.2 } }), /no probability between 0 and 1/);
  assert.throws(() => schema.read({ ...good, bug: { type: "boolean", probability: Number.NaN } }), /no probability/);
  assert.throws(() => schema.read({ ...good, area: { type: "choice", choice: "elsewhere" } }), /isn't one of its options/);
  assert.throws(() => schema.read({ ...good, mood: { type: "score", score: 3 } }), /isn't one of its levels/);
});

test("keys that would collide with signal keys are refused", () => {
  assert.throws(() => defineSchema({ name: "t", questions: { "a&b": yesNo("?") } }), /reserve/);
  assert.throws(() => defineSchema({ name: "t", questions: { a: choice("?", { "x=y": "bad" }) } }), /option keys/);
  assert.throws(() => defineSchema({ name: "t", questions: { a: score("?", ["only"]) } }), /two levels/);
});

test("the default state is the event's context and its text", () => {
  assert.deepEqual(schema.state({ id: "1", at: 0, text: "hi", context: { channel: "sms" } }), { channel: "sms", message: "hi" });
});

test("both pairs every signal from each list", () => {
  assert.deepEqual(both(["bug", "mood>=2"], ["area=login", "area=billing"]), ["bug&area=login", "bug&area=billing", "mood>=2&area=login", "mood>=2&area=billing"]);
});
