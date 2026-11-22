// Runs the README's first example end to end, with the gateway's reply stubbed, so the sample stays
// a program that works and not only one that compiles.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quickstart } from "./readme.ts";

const reply = {
  answers: {
    area: { type: "choice", choice: "other", probabilities: { login: 0.02, billing: 0.03, other: 0.95 } },
    is_bug_report: { type: "boolean", probability: 0.4 },
    data_exposure: { type: "boolean", probability: 0.96 },
  },
};

test("the README's first example labels one message and pages on it", async (t) => {
  const asked = [];
  const printed = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    asked.push({ url, model: init.headers["ai-model-id"] });
    // A reply takes time; the watch only sees events stored before its tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify(reply));
  });
  t.mock.method(console, "log", (line) => printed.push(line));
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "open-sentinel-readme-"));
  process.chdir(dir);
  t.after(() => process.chdir(cwd));

  await quickstart();

  assert.deepEqual(asked, [{ url: "https://ai-gateway.vercel.sh/v4/ai/decision-model", model: "typesafe-ai/jev-1.14.0" }]);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /^\S+Z fired page: event: data_exposure \(event msg-1\)$/);
  assert.ok(existsSync(join(dir, "signals", "events.jsonl")));
});
