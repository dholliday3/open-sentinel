import assert from "node:assert/strict";
import { test } from "node:test";
import { chatLabeler } from "./chat.ts";
import { decisionLabeler } from "./gateway.ts";
import { ruleLabeler } from "./rules.ts";

/** A stand-in for fetch that replies from a list and keeps what it was sent. */
const replies = (...list) => {
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = list[Math.min(sent.length - 1, list.length - 1)];
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { send, sent };
};
const questions = { bug: { type: "boolean", instructions: "Broken?" }, area: { type: "choice", instructions: "Part?", criteria: { login: "Sign in", other: "Else" } }, mood: { type: "score", instructions: "Upset?", criteria: ["No", "Some", "Very"] } };

test("decisionLabeler asks every question in one request and passes answers through", async () => {
  const answers = { bug: { type: "boolean", probability: 0.97 }, area: { type: "choice", choice: "login", probabilities: { login: 1, other: 0 } }, mood: { type: "score", score: 1.1, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 } } };
  const { send, sent } = replies({ body: { answers, providerMetadata: { gateway: { cost: "0.0000325" } } } });
  const labeler = decisionLabeler({ model: "typesafe-ai/jev-1.14.0", apiKey: "key", fetch: send });
  const result = await labeler.label({ message: "hi" }, questions);
  assert.deepEqual(result, { answers, cost: 0.0000325 });
  assert.equal(labeler.id, "typesafe-ai/jev-1.14.0");
  assert.equal(labeler.probability, "native");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://ai-gateway.vercel.sh/v4/ai/decision-model");
  assert.equal(sent[0].headers["ai-model-id"], "typesafe-ai/jev-1.14.0");
  assert.equal(sent[0].headers.authorization, "Bearer key");
  assert.deepEqual(sent[0].body, { state: { message: "hi" }, questions });
});

test("decisionLabeler retries a busy gateway, and gives up on a refused request with the reason", async () => {
  const busy = { status: 429, body: { error: "slow down" } };
  const ok = { body: { answers: { bug: { type: "boolean", probability: 0.5 } } } };
  const twice = replies(busy, ok);
  const result = await decisionLabeler({ model: "m", apiKey: "k", fetch: twice.send }).label({}, { bug: questions.bug });
  assert.equal(twice.sent.length, 2);
  assert.equal("cost" in result, false);
  const refused = replies({ status: 401, body: { error: "bad key" } });
  await assert.rejects(decisionLabeler({ model: "m", apiKey: "k", fetch: refused.send }).label({}, questions), /answered 401: .*bad key/);
  assert.equal(refused.sent.length, 1);
  await assert.rejects(decisionLabeler({ model: "m", apiKey: "k", fetch: replies({ body: {} }).send }).label({}, questions), /returned no answers/);
});

test("chatLabeler turns a JSON reply into hard answers", async () => {
  const { send, sent } = replies({ body: { choices: [{ message: { content: 'Here you go:\n```json\n{"bug": true, "area": "login", "mood": 2}\n```' } }], usage: { market_cost: 0.0004 } } });
  const labeler = chatLabeler({ model: "anthropic/claude-haiku-5.5", apiKey: "k", baseUrl: "https://example.test/v1", fetch: send });
  const result = await labeler.label({ message: "can't log in!!" }, questions);
  assert.deepEqual(result.answers, { bug: { type: "boolean", probability: 1 }, area: { type: "choice", choice: "login" }, mood: { type: "score", score: 2 } });
  assert.equal(result.cost, 0.0004);
  assert.equal(labeler.probability, "none");
  assert.equal(sent[0].url, "https://example.test/v1/chat/completions");
  assert.equal(sent[0].body.model, "anthropic/claude-haiku-5.5");
  assert.match(sent[0].body.messages[1].content, /can't log in!!/);
});

test("chatLabeler refuses a reply that isn't JSON or skips a yes/no", async () => {
  const prose = replies({ body: { choices: [{ message: { content: "I think it's a bug." } }] } });
  await assert.rejects(chatLabeler({ model: "m", apiKey: "k", baseUrl: "https://example.test/v1", fetch: prose.send }).label({}, questions), /didn't reply with JSON/);
  const partial = replies({ body: { choices: [{ message: { content: '{"area": "login", "mood": 0}' } }] } });
  await assert.rejects(chatLabeler({ model: "m", apiKey: "k", baseUrl: "https://example.test/v1", fetch: partial.send }).label({}, questions), /"bug" wasn't answered true or false/);
  // A level left out or given as null must not be read as the lowest level.
  for (const [content, complaint] of [['{"bug": true, "area": "login", "mood": null}', /"mood" wasn't answered with a level: null/], ['{"bug": true, "area": "login"}', /"mood" wasn't answered with a level/], ['{"bug": true, "area": null, "mood": 1}', /"area" wasn't answered with one of its options/]]) {
    const reply = replies({ body: { choices: [{ message: { content } }] } });
    await assert.rejects(chatLabeler({ model: "m", apiKey: "k", baseUrl: "https://example.test/v1", fetch: reply.send }).label({}, questions), complaint);
  }
});

test("rules answers each kind and names a missing rule", async () => {
  const labeler = ruleLabeler({ id: "r@1", answer: { bug: () => 0.3, area: () => "other", mood: () => 1 }, probability: "native" });
  assert.deepEqual((await labeler.label({}, questions)).answers, { bug: { type: "boolean", probability: 0.3 }, area: { type: "choice", choice: "other" }, mood: { type: "score", score: 1 } });
  await assert.rejects(ruleLabeler({ id: "r", answer: {} }).label({}, { bug: questions.bug }), /No rule answers "bug"/);
});
