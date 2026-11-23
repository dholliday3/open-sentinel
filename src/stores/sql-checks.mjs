// What every database store is tested for, whatever the database: the store contract (which
// holds counts and reads to the reference functions on random histories), parameters that
// would break SQL if they were pasted into it, and a watch over the support inbox that must say
// exactly what the same watch says over memoryStore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlans } from "../../examples/support/replay.ts";
import { loadInbox } from "../../examples/support/data.ts";
import { supportMonitors } from "../../examples/support/monitors.ts";
import { support } from "../../examples/support/schema.ts";
import { countEvents, createWatch, DAY, exposureMonitor, HOUR, memoryStore, silenceMonitor } from "../index.ts";
import { seeded, storeContract } from "../testing.ts";

/** `make(table)` gives a migrated store on tables of that name; each call a new name. */
export const checkSqlStore = (name, make, { skip = false } = {}) => {
  let n = 0;
  const fresh = () => make(`t${(n += 1)}`);
  for (const { name: check, run } of storeContract(fresh)) {
    test(`${name}: ${check}`, { skip }, run);
  }

  test(`${name}: keys, tags and values that would break SQL are only ever data`, { skip }, async () => {
    const store = await fresh();
    const hostile = `x'); DROP TABLE t; --"\\`;
    const event = { id: hostile, at: 5, schema: hostile, labeler: hostile, probability: "native", unit: hostile, text: hostile, tags: { [hostile]: hostile, "a.b": "$.x" }, context: { [hostile]: [hostile] }, signals: { [hostile]: 0.9, "$.x": 0.7, "a&b": 1 } };
    await store.append([event]);
    assert.deepEqual(await store.events({ schema: hostile, where: { [hostile]: hostile }, atLeast: [{ [hostile]: 0.9 }] }), [event]);
    assert.deepEqual(await store.count({ schema: hostile, windows: [{ from: 0, to: 10 }], signals: [hostile, "$.x", "missing"], per: "unit", groupBy: { tagsExcept: ["a.b"] } }), [{ window: 0, group: { [hostile]: hostile }, total: 1, yes: { [hostile]: 1, "$.x": 1, missing: 0 }, events: 1 }]);
    assert.deepEqual([...(await store.known([hostile], hostile, hostile))], [hostile]);
    await store.recordChange({ id: hostile, at: 1, kind: "other", what: hostile, scope: { [hostile]: hostile } });
    assert.deepEqual((await store.changes()).map((change) => change.what), [hostile]);
    await store.saveState(hostile, { [hostile]: hostile });
    assert.deepEqual(await store.loadState(hostile), { [hostile]: hostile });
    assert.equal(await store.delete({ unit: hostile }), 1);
  });

  test(`${name}: seventy signals in one count, past what one integer of bits holds, count as countEvents does`, { skip }, async () => {
    const store = await fresh();
    const keys = Array.from({ length: 70 }, (_, i) => `k${i}`);
    const random = seeded(70);
    const events = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, at: Math.floor(random() * 1000), ...(random() < 0.8 ? { unit: `u${i % 37}` } : {}), schema: "s@1", labeler: "l@1", probability: "native", signals: Object.fromEntries(keys.filter(() => random() < 0.8).map((key) => [key, random()])) }));
    await store.append(events);
    const signals = [...keys, "k1&k62", "k59&k60&k69", "*"];
    for (const per of ["unit", "event"]) {
      const query = { schema: "s@1", labeler: "l@1", windows: [{ from: 0, to: 500 }, { from: 250, to: 1000 }, { from: 0, to: 1000 }], signals, gates: { k3: 0.9, k61: 0.1 }, per };
      assert.deepEqual(await store.count(query), countEvents(events, query));
    }
  });

  test(`${name}: a table name that isn't a plain name is refused`, { skip }, async () => {
    await assert.rejects(async () => make("t; DROP TABLE x"), /can't name a table/);
  });

  test(`${name}: a watch over the support inbox says exactly what it says over memoryStore`, { skip }, async () => {
    const inbox = loadInbox("support");
    const changes = withPlans(inbox.changes);
    const monitors = [...supportMonitors(inbox.events), ...changes.filter((change) => change.scope).map((change) => exposureMonitor({ change, signal: "area=login_access" })), silenceMonitor({ windowMs: 3 * HOUR })];
    const store = await fresh();
    const memory = memoryStore();
    for (const target of [store, memory]) {
      await target.append(inbox.events);
      for (const change of changes) {
        await target.recordChange(change);
      }
    }
    // Around the Android sign-in incident and the data exposure: pages, suspects, examples, one-event alerts.
    for (const [from, to] of [[13.75, 14.75], [18, 18.5]]) {
      const [sql, mem] = [createWatch({ schema: support, store, monitors, stateKey: `w${from}` }), createWatch({ schema: support, store: memory, monitors, stateKey: `w${from}` })];
      for (let now = inbox.start + from * DAY; now <= inbox.start + to * DAY; now += HOUR) {
        assert.deepEqual(JSON.parse(JSON.stringify(await sql.tick(now))), JSON.parse(JSON.stringify(await mem.tick(now))), new Date(now).toISOString());
      }
    }
    const fired = await memory.loadState("w13.75");
    assert.ok(Object.keys(fired.runner.open).length > 0);
  });
};
