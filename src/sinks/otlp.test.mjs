import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { otlpLogs, otlpSink } from "./otlp.ts";

const at = Date.UTC(2026, 10, 9, 15, 0, 0, 120);
const event = { id: "e1", at, text: "the app is broken", unit: "acct-9", tags: { platform: "ios", version: null }, schema: "support@abc", labeler: "typesafe-ai/jev-1.14.0", probability: "native", signals: { bug: 0.97, "area=login": 0.8 } };
const notice = { id: "n1#fired", kind: "fired", at, alert: { id: "n1", monitor: "3h share of bug {platform:ios}", severity: "page", signal: "bug", where: { platform: "ios" }, at, windowMs: 0, detail: {} }, schema: "support@abc", question: "Is something broken?", examples: [{ id: "e1", at, text: "the app is broken" }, { id: "e2", at }], suspects: [{ change: { id: "c1", at: 0, kind: "release", what: "mobile 4.12.0" }, time: 1, exposure: null, score: 0 }], confident: true };
const attributes = (record) => Object.fromEntries(record.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));

test("a labeled event becomes one log record: signals as numbers, tags as themselves, no text unless asked", () => {
  const body = otlpLogs({ events: [event], service: "inbox" });
  const [resource] = body.resourceLogs;
  assert.deepEqual(resource.resource.attributes, [{ key: "service.name", value: { stringValue: "inbox" } }]);
  const [record] = resource.scopeLogs[0].logRecords;
  assert.equal(record.timeUnixNano, "1794236400120000000");
  assert.deepEqual(record.body, { stringValue: "labeled event" });
  assert.deepEqual(attributes(record), {
    "event.name": "open_sentinel.labeled", "open_sentinel.event.id": "e1", "open_sentinel.schema": "support@abc", "open_sentinel.labeler": "typesafe-ai/jev-1.14.0",
    "open_sentinel.unit": "acct-9", platform: "ios", "signal.bug": 0.97, "signal.area=login": 0.8,
  });
  assert.deepEqual(otlpLogs({ events: [event], service: "inbox", includeText: true }).resourceLogs[0].scopeLogs[0].logRecords[0].body, { stringValue: "the app is broken" });
});

test("a notice becomes a record at a severity a pager can route on", () => {
  const [fired, resolved] = otlpLogs({ notices: [notice, { id: "n1#resolved", kind: "resolved", at: at + 3_600_000, alert: { ...notice.alert, severity: "digest" } }], service: "inbox" }).resourceLogs[0].scopeLogs[0].logRecords;
  assert.deepEqual([fired.severityText, fired.severityNumber, fired.body.stringValue], ["ERROR", 17, "fired: 3h share of bug {platform:ios}"]);
  assert.deepEqual(attributes(fired), {
    "event.name": "open_sentinel.alert.fired", "open_sentinel.notice.id": "n1#fired", "open_sentinel.monitor": "3h share of bug {platform:ios}", "open_sentinel.severity": "page", "open_sentinel.signal": "bug",
    "open_sentinel.schema": "support@abc", "open_sentinel.question": "Is something broken?", "open_sentinel.examples.id": { values: [{ stringValue: "e1" }, { stringValue: "e2" }] },
    platform: "ios", "open_sentinel.suspect": "mobile 4.12.0", "open_sentinel.suspect.id": "c1", "open_sentinel.suspect.confident": true,
  });
  // The examples' text only when asked for, as with events.
  assert.deepEqual(attributes(otlpLogs({ notices: [notice], service: "inbox", includeText: true }).resourceLogs[0].scopeLogs[0].logRecords[0])["open_sentinel.examples.text"], { values: [{ stringValue: "the app is broken" }] });
  assert.deepEqual([resolved.severityText, attributes(resolved)["event.name"]], ["WARN", "open_sentinel.alert.resolved"]);
  // Each record is stamped with when it happened: the resolved one an hour after the alert.
  assert.equal(BigInt(resolved.timeUnixNano) - BigInt(fired.timeUnixNano), 3_600_000_000_000n);
});

test("otlpSink posts to the logs endpoint", async () => {
  const sent = [];
  const send = async (url, init) => (sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }), new Response("{}", { status: 200 }));
  const sink = otlpSink({ url: "https://collector.test/v1/logs", headers: { "x-api-key": "k" }, fetch: send });
  await sink.labeled([event]);
  await sink.labeled([]);
  await sink.notify([notice]);
  assert.deepEqual(sent.map((s) => [s.url, s.headers["x-api-key"], s.body.resourceLogs[0].scopeLogs[0].logRecords.length]), [["https://collector.test/v1/logs", "k", 1], ["https://collector.test/v1/logs", "k", 1]]);
});

// OpenTelemetry's own message definitions, a dev dependency (skipped when it isn't installed).
// The body must load as an ExportLogsServiceRequest and survive encoding. The definitions are
// not part of that package's public API, which is why its version is pinned in package.json.
const require = createRequire(import.meta.url);
let definitions;
try {
  const main = require.resolve("@opentelemetry/otlp-transformer");
  definitions = require(`${main.slice(0, main.lastIndexOf("otlp-transformer"))}otlp-transformer/build/src/generated/root.js`);
} catch {
  definitions = undefined;
}

test("the body is a valid OTLP ExportLogsServiceRequest", { skip: definitions ? false : "@opentelemetry/otlp-transformer isn't installed: run npm install" }, () => {
  const Request = definitions.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
  const decoded = Request.decode(Request.encode(Request.fromObject(otlpLogs({ events: [event], notices: [notice], service: "inbox" }))).finish());
  const [first, second] = decoded.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(decoded.resourceLogs[0].resource.attributes[0].value.stringValue, "inbox");
  assert.equal(decoded.resourceLogs[0].scopeLogs[0].scope.name, "open-sentinel");
  assert.equal(first.timeUnixNano.toString(), "1794236400120000000");
  assert.equal(first.severityNumber, 9);
  assert.equal(first.body.stringValue, "labeled event");
  assert.equal(first.attributes.find((a) => a.key === "signal.bug").value.doubleValue, 0.97);
  assert.equal(first.attributes.length, 8);
  assert.equal(second.severityNumber, 17);
  assert.equal(second.attributes.find((a) => a.key === "open_sentinel.suspect.confident").value.boolValue, true);
  assert.deepEqual(second.attributes.find((a) => a.key === "open_sentinel.examples.id").value.arrayValue.values.map((v) => v.stringValue), ["e1", "e2"]);
});
