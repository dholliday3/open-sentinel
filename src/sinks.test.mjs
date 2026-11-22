import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consoleSink, fromJsonl, jsonlSink, webhookSink } from "./sinks.ts";

const event = { id: "e1", at: Date.UTC(2026, 10, 9, 15), text: "broken", schema: "t@1", labeler: "l", probability: "native", signals: { bug: 0.9 } };
const alert = { id: "3h share of bug@1", monitor: "3h share of bug", severity: "page", signal: "bug", at: Date.UTC(2026, 10, 9, 15), windowMs: 0, detail: {} };
const notice = { id: "3h share of bug@1#fired", kind: "fired", at: alert.at, alert, suspects: [{ change: { id: "c1", at: 0, kind: "deploy", what: "api: renderer v2" }, time: 0.9, exposure: null, score: 0 }], confident: true };

test("consoleSink prints one line a person can read", () => {
  const lines = [];
  // A resolved notice carries the time the episode was found to be over, not the time it began.
  consoleSink((line) => lines.push(line)).notify([notice, { id: "x#resolved", kind: "resolved", at: Date.UTC(2026, 10, 10, 3), alert: { ...alert, event: { id: "e1", at: 1 } } }]);
  assert.deepEqual(lines, ["2026-11-09T15:00:00.000Z fired page: 3h share of bug; likely api: renderer v2", "2026-11-10T03:00:00.000Z resolved page: 3h share of bug (event e1)"]);
});

test("jsonlSink appends events and notices as lines", () => {
  const path = join(mkdtempSync(join(tmpdir(), "signals-")), "out.jsonl");
  const sink = jsonlSink(path);
  sink.labeled([event]);
  sink.labeled([]);
  sink.notify([notice]);
  const rows = readFileSync(path, "utf8").trim().split("\n").map((row) => JSON.parse(row));
  assert.deepEqual(rows.map((row) => [row.type, row.id]), [["event", "e1"], ["notice", "3h share of bug@1#fired"]]);
});

test("webhookSink posts notices, and events only when asked", async () => {
  const sent = [];
  // Many webhooks answer with the word "ok", which is not JSON.
  const send = async (url, init) => (sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }), new Response("ok", { status: 200 }));
  const quiet = webhookSink({ url: "https://example.test/hook", headers: { authorization: "Bearer x" }, fetch: send });
  assert.equal(quiet.labeled, undefined);
  await quiet.notify([notice]);
  const loud = webhookSink({ url: "https://example.test/hook", events: true, fetch: send });
  await loud.labeled([event]);
  await loud.labeled([]);
  assert.deepEqual(sent.map((s) => [s.url, Object.keys(s.body), s.auth]), [["https://example.test/hook", ["notices"], "Bearer x"], ["https://example.test/hook", ["events"], undefined]]);
  assert.equal(sent[0].body.notices[0].alert.monitor, "3h share of bug");
});

test("fromJsonl maps rows to events and skips the ones mapped to null", () => {
  const path = join(mkdtempSync(join(tmpdir(), "signals-")), "in.jsonl");
  writeFileSync(path, ['{"ticket": 7, "body": "it broke", "created": 1000, "kind": "customer"}', "", '{"ticket": 8, "body": "we fixed it", "created": 2000, "kind": "agent"}'].join("\n"));
  const events = [...fromJsonl(path, (row) => (row.kind === "customer" ? { id: `ticket-${row.ticket}`, at: row.created, text: row.body } : null))];
  assert.deepEqual(events, [{ id: "ticket-7", at: 1000, text: "it broke" }]);
});
