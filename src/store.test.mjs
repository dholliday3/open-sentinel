import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryStore } from "./store.ts";
import { jsonlStore } from "./stores/jsonl.ts";

const event = (id, at, extra = {}) => ({ id, at, text: `text ${id}`, schema: "t@1", labeler: "l@1", probability: "native", signals: { bug: 0.9 }, ...extra });

// Every store must pass these: run them against your own to check it.
for (const [name, make] of [["memoryStore", () => memoryStore()], ["jsonlStore", () => jsonlStore(mkdtempSync(join(tmpdir(), "signals-")))]]) {
  test(`${name}: keeps the first copy of an event, per schema and labeler`, async () => {
    const store = make();
    await store.append([event("a", 10), event("b", 20)]);
    // The same event again is ignored; under other wording or from another labeler it is a new record.
    await store.append([event("a", 10, { signals: { bug: 0.1 } }), event("a", 10, { schema: "t@2", signals: { bug: 0.3 } }), event("a", 10, { labeler: "l@2", signals: { bug: 0.6 } })]);
    assert.deepEqual((await store.events({ schema: "t@1", labeler: "l@1" })).map((e) => [e.id, e.signals.bug]), [["a", 0.9], ["b", 0.9]]);
    assert.deepEqual((await store.events({ schema: "t@2" })).map((e) => e.signals.bug), [0.3]);
    assert.deepEqual((await store.events({ labeler: "l@2" })).map((e) => e.signals.bug), [0.6]);
    assert.equal((await store.events()).length, 4);
  });

  test(`${name}: says which of a batch it already has, in one call`, async () => {
    const store = make();
    await store.append([event("a", 10), event("b", 20), event("c", 30, { labeler: "l@2" })]);
    assert.deepEqual([...(await store.known(["a", "b", "c", "d"], "t@1", "l@1"))].sort(), ["a", "b"]);
    assert.deepEqual([...(await store.known(["a", "c"], "t@1", "l@2"))], ["c"]);
    assert.deepEqual([...(await store.known(["a"], "t@2", "l@1"))], []);
  });

  test(`${name}: reads from <= at < to, oldest first`, async () => {
    const store = make();
    await store.append([event("c", 30), event("a", 10), event("b", 20)]);
    assert.deepEqual((await store.events({ from: 10, to: 30 })).map((e) => e.id), ["a", "b"]);
  });

  test(`${name}: deletes by age, by customer, or both, and says how many`, async () => {
    const store = make();
    await store.append([event("a", 10, { unit: "acct-1" }), event("b", 20, { unit: "acct-2" }), event("c", 30, { unit: "acct-1" }), event("d", 40)]);
    // Nothing named, nothing deleted.
    assert.equal(await store.delete({}), 0);
    assert.equal(await store.delete({ before: 25, unit: "acct-1" }), 1);
    assert.deepEqual((await store.events()).map((e) => e.id), ["b", "c", "d"]);
    assert.equal(await store.delete({ unit: "acct-1" }), 1);
    assert.equal(await store.delete({ before: 40 }), 1);
    assert.deepEqual((await store.events()).map((e) => e.id), ["d"]);
    // A deleted event can be stored again.
    assert.deepEqual([...(await store.known(["a"], "t@1", "l@1"))], []);
  });

  test(`${name}: a change recorded again replaces the first`, async () => {
    const store = make();
    await store.recordChange({ id: "c1", at: 5, kind: "deploy", what: "v1" });
    await store.recordChange({ id: "c2", at: 15, kind: "flag", what: "on", scope: { "flag:x": "on" } });
    await store.recordChange({ id: "c1", at: 6, kind: "deploy", what: "v1, corrected" });
    assert.deepEqual((await store.changes()).map((c) => [c.id, c.what]), [["c1", "v1, corrected"], ["c2", "on"]]);
    assert.deepEqual((await store.changes({ from: 10 })).map((c) => c.id), ["c2"]);
  });

  test(`${name}: keeps a small value under a key`, async () => {
    const store = make();
    assert.equal(await store.loadState("watch:t"), undefined);
    await store.saveState("watch:t", { since: 5, open: {} });
    await store.saveState("other", [1, 2]);
    await store.saveState("watch:t", { since: 6, open: { a: { firstAt: 1 } } });
    assert.deepEqual(await store.loadState("watch:t"), { since: 6, open: { a: { firstAt: 1 } } });
    assert.deepEqual(await store.loadState("other"), [1, 2]);
  });
}

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
