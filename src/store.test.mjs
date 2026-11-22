import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryStore } from "./store.ts";
import { jsonlStore } from "./stores/jsonl.ts";
import { storeContract } from "./testing.ts";

const event = (id, at, extra = {}) => ({ id, at, text: `text ${id}`, schema: "t@1", labeler: "l@1", probability: "native", signals: { bug: 0.9 }, ...extra });

// Every store must pass these. They are exported from open-sentinel/testing for your own.
for (const [store, make] of [["memoryStore", () => memoryStore()], ["jsonlStore", () => jsonlStore(mkdtempSync(join(tmpdir(), "signals-")))]]) {
  for (const { name, run } of storeContract(make)) {
    test(`${store}: ${name}`, run);
  }
}

test("the store checks fail a store that breaks the contract", async () => {
  // Remembers only the last append: a store that overwrites instead of adding.
  const forgetful = () => {
    const inner = memoryStore();
    let kept = [];
    return { ...inner, append: async (events) => void (kept = events), events: async () => kept };
  };
  const failed = [];
  for (const { name, run } of storeContract(forgetful)) {
    await run().catch(() => failed.push(name));
  }
  assert.ok(failed.includes("keeps the first copy of an event, per schema and labeler"), failed.join("; "));
});

test("jsonlStore: a second store on the same folder sees what the first wrote, deleted and kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signals-"));
  const first = jsonlStore(dir);
  await first.append([event("a", 10), event("a", 10), event("gone", 20, { unit: "acct-9" })]);
  await first.delete({ unit: "acct-9" });
  await first.recordChange({ id: "c1", at: 5, kind: "deploy", what: "v1" });
  await first.recordChange({ id: "c1", at: 5, kind: "deploy", what: "v1 again" });
  await first.saveState("watch:t", { since: 7 });
  const second = jsonlStore(dir);
  assert.deepEqual((await second.events()).map((e) => e.id), ["a"]);
  assert.deepEqual((await second.changes()).map((c) => c.what), ["v1 again"]);
  assert.deepEqual(await second.loadState("watch:t"), { since: 7 });
});

test("jsonlStore: a store kept open beside a writer reads what the writer adds, records, deletes and saves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signals-"));
  const reader = jsonlStore(dir);
  const writer = jsonlStore(dir);
  assert.deepEqual(await reader.events(), []);
  await writer.append([event("a", 10, { unit: "acct-1" }), event("b", 20)]);
  await writer.recordChange({ id: "c1", at: 5, kind: "deploy", what: "v1" });
  await writer.saveState("watch:t", { since: 7 });
  assert.deepEqual((await reader.events()).map((e) => e.id), ["a", "b"]);
  assert.deepEqual([...(await reader.known(["a", "b"], "t@1", "l@1"))], ["a", "b"]);
  assert.deepEqual((await reader.changes()).map((c) => c.id), ["c1"]);
  assert.deepEqual(await reader.loadState("watch:t"), { since: 7 });
  await writer.delete({ unit: "acct-1" });
  assert.deepEqual((await reader.events()).map((e) => e.id), ["b"]);
  // A line the writer hasn't finished yet is left for the next read, not an error.
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event("c", 30)).slice(0, 20));
  assert.deepEqual((await reader.events()).map((e) => e.id), ["b"]);
});
