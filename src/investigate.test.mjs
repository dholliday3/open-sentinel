import assert from "node:assert/strict";
import { test } from "node:test";
import { investigate, openAiChat } from "./investigate.ts";
import { HOUR } from "./types.ts";

const group = { id: "page-1", severity: "page", firstAt: 10 * HOUR, lastAt: 11 * HOUR, alerts: [{ id: "3h share of bug@1", monitor: "3h share of bug", severity: "page", signal: "bug", at: 10 * HOUR, windowMs: 3 * HOUR, detail: { now: "30/60", baseline: "50/1000", p: 1e-12 } }] };
const tools = {
  messages: { description: "Read messages", input: { from: { type: "string", description: "Start" }, limit: { type: "number", description: "How many", optional: true } }, run: (args) => [{ id: "e7", text: "tax is doubled on the PDF", from: args.from }] },
  broken: { description: "Fails", input: {}, run: () => { throw new Error("no such table"); } },
};
const REPORT = { verdict: "incident", title: "PDF totals wrong", whatPeopleReport: "tax doubled", affected: "everyone", startedAt: "2026-11-11T16:30Z", likelyCause: "renderer v2", evidence: ["e7"], nextStep: "roll back", confidence: 0.8 };
/** A chat model that plays back turns and keeps what it was sent. */
const scripted = (...turns) => {
  const seen = [];
  const chat = async (messages, offered) => (seen.push({ messages: messages.map((m) => ({ ...m })), tools: Object.keys(offered) }), { cost: 0.01, toolCalls: [], content: "", ...turns[Math.min(seen.length - 1, turns.length - 1)] });
  return { chat, seen };
};
const call = (name, args, id = "c1") => ({ id, name, arguments: JSON.stringify(args) });

test("investigate runs the tools the model asks for and returns its report", async () => {
  const { chat, seen } = scripted({ toolCalls: [call("messages", { from: "2026-11-11T16:00Z" }), call("broken", {}, "c2"), call("missing", {}, "c3")] }, { content: `Here is my verdict:\n${JSON.stringify(REPORT)}` });
  const leads = [{ id: "3h share of bug@1#fired", kind: "fired", at: 10 * HOUR, alert: group.alerts[0], suspects: [{ change: { id: "c9", at: 9 * HOUR, kind: "deploy", what: "api: PDF renderer v2" }, time: 0.9, exposure: null, score: 0 }], confident: false }];
  const { report, steps, cost } = await investigate(group, { chat, tools, about: "a support inbox", leads });
  assert.deepEqual(report, REPORT);
  assert.equal(steps, 1);
  assert.equal(cost, 0.02);
  assert.match(seen[0].messages[0].content, /on call for a support inbox/);
  assert.match(seen[0].messages[1].content, /3h share of bug[\s\S]*api: PDF renderer v2/);
  const results = seen[1].messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, JSON.parse(m.content)]);
  assert.deepEqual(results, [["c1", [{ id: "e7", text: "tax is doubled on the PDF", from: "2026-11-11T16:00Z" }]], ["c2", { error: "no such table" }], ["c3", { error: "No tool named missing" }]]);
});

test("a model that never settles yields inconclusive, not an error", async () => {
  const looping = scripted({ toolCalls: [call("messages", { from: "x" })] });
  const stuck = await investigate(group, { chat: looping.chat, tools, about: "an inbox", maxSteps: 3 });
  assert.equal(stuck.report.verdict, "inconclusive");
  assert.match(stuck.report.nextStep, /Stopped after 3 rounds/);
  // On the last round it is told to answer and offered no tools.
  assert.deepEqual(looping.seen.map((s) => s.tools.length), [2, 2, 2, 0]);
  assert.equal(looping.seen[3].messages.at(-1).content, "Out of steps. Give your JSON verdict now.");
  const vague = await investigate(group, { chat: scripted({ content: "Hard to say." }).chat, tools, about: "an inbox" });
  assert.equal(vague.report.verdict, "inconclusive");
  assert.equal(vague.report.confidence, 0);
});

test("a reply is a report only with one of the five verdicts; the rest of it is read into shape", async () => {
  const reply = (given) => investigate(group, { chat: scripted({ content: JSON.stringify(given) }).chat, tools, about: "an inbox" });
  // A verdict of its own invention is no verdict: a pager can't route on "probably fine".
  const invented = await reply({ ...REPORT, verdict: "probably fine" });
  assert.equal(invented.report.verdict, "inconclusive");
  assert.match(invented.report.nextStep, /gave no verdict/);
  // A real verdict with the rest missing or the wrong shape still comes back as a whole report.
  const sparse = await reply({ verdict: "watch", title: "Slow rise", evidence: ["e1", 7, null], confidence: "1.4", startedAt: 5 });
  assert.deepEqual(sparse.report, { verdict: "watch", title: "Slow rise", whatPeopleReport: "", affected: "", startedAt: null, likelyCause: "", evidence: ["e1"], nextStep: "", confidence: 1 });
});

test("openAiChat speaks the chat-completions tool format both ways", async () => {
  const sent = [];
  const send = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "messages", arguments: '{"from":"a"}' } }] } }], usage: { market_cost: 0.003 } })));
  const chat = openAiChat({ model: "anthropic/claude-sonnet-5.5", apiKey: "k", baseUrl: "https://example.test/v1", fetch: send });
  const turn = await chat([{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [call("messages", { from: "a" }, "t0")] }, { role: "tool", toolCallId: "t0", content: "[]" }], tools);
  assert.deepEqual(turn, { content: "", toolCalls: [{ id: "t1", name: "messages", arguments: '{"from":"a"}' }], cost: 0.003 });
  assert.equal(sent[0].url, "https://example.test/v1/chat/completions");
  assert.deepEqual(sent[0].body.messages[1].tool_calls, [{ id: "t0", type: "function", function: { name: "messages", arguments: '{"from":"a"}' } }]);
  assert.equal(sent[0].body.messages[2].tool_call_id, "t0");
  assert.deepEqual(sent[0].body.tools[0].function, { name: "messages", description: "Read messages", parameters: { type: "object", properties: { from: { type: "string", description: "Start" }, limit: { type: "number", description: "How many" } }, required: ["from"] } });
  await chat([{ role: "user", content: "answer now" }], {});
  assert.equal("tools" in sent[1].body, false);
});
