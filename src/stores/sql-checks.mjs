// What every database store is tested for, whatever the database: the store contract (which
// holds counts and reads to the reference functions on random histories), parameters that
// would break SQL if they were pasted into it, hits that always match the events they come
// from (after appends, deletes, a failed write and a migration from before there were hits),
// and a watch over the support inbox that must say exactly what the same watch says over
// memoryStore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlans } from "../../examples/support/replay.ts";
import { loadInbox } from "../../examples/support/data.ts";
import { supportMonitors } from "../../examples/support/monitors.ts";
import { support } from "../../examples/support/schema.ts";
import { countEvents, createWatch, DAY, exposureMonitor, HOUR, memoryStore, silenceMonitor } from "../index.ts";
import { randomCountQuery, randomHistory, seeded, storeContract } from "../testing.ts";
import { FLOOR_KEY, HIT_FLOOR } from "./sql.ts";

/**
 * `make(table, partition?, query?)` gives a migrated store on tables of that name, sending its
 * statements through `query` when given; each call a new name. `query` runs SQL with no
 * parameters straight on the same database, to look at the tables, and `dialect` reads them.
 */
export const checkSqlStore = (name, make, { skip = false, query, dialect } = {}) => {
  let n = 0;
  const fresh = () => make(`t${(n += 1)}`);
  const contract = dialect.hits ? { hitFloor: HIT_FLOOR } : {};
  for (const { name: check, run } of storeContract(fresh, contract)) {
    test(`${name}: ${check}`, { skip }, run);
  }
  // Split by a tag the random histories filter on: its column must find exactly what the tag does.
  for (const { name: check, run } of storeContract(() => make(`p${(n += 1)}`, "platform"), contract).filter((check) => check.name.includes("random histories") || check.name.includes("lowest gate"))) {
    test(`${name} split by platform: ${check}`, { skip }, run);
  }
  // A dialect without hits counts from each event's JSON, and none of what follows applies.
  const hitSkip = skip || (dialect.hits ? false : `${name} keeps no hits`);

  const rowsOf = async (sql) => (await query(sql, [])).rows;
  /** The hits table holds exactly one row for each answer at or above the floor of each stored event, and nothing else. */
  const hitsAgree = async (table, floor = HIT_FLOOR) => {
    const expected = (await rowsOf(`SELECT seq, signals FROM ${table}_events`))
      .flatMap((row) => Object.entries(dialect.parse(row.signals)).filter(([, p]) => typeof p === "number" && p >= floor).map(([key, p]) => `${Number(row.seq)} ${key} ${p}`))
      .sort();
    const found = (await rowsOf(`SELECT seq, key, p FROM ${table}_hits`)).map((row) => `${Number(row.seq)} ${row.key} ${Number(row.p)}`).sort();
    assert.deepEqual(found, expected);
    return found.length;
  };

  test(`${name}: every answer at or above the floor is a hit, after appends and deletes, and a forgotten customer leaves none`, { skip: hitSkip }, async () => {
    const table = `h${(n += 1)}`;
    const store = await make(table);
    const random = seeded(31);
    const { batches, stored } = randomHistory(random);
    for (const batch of batches) {
      await store.append(batch);
    }
    assert.ok((await hitsAgree(table)) > 0);
    const seqs = async (unit) => (await rowsOf(`SELECT seq FROM ${table}_events WHERE unit = '${unit}'`)).map((row) => Number(row.seq));
    const theirs = await seqs("u3");
    assert.ok(theirs.length > 0);
    assert.equal(await store.delete({ unit: "u3" }), stored.filter((event) => event.unit === "u3").length);
    const left = (await rowsOf(`SELECT seq FROM ${table}_hits`)).map((row) => Number(row.seq));
    assert.deepEqual(left.filter((seq) => theirs.includes(seq)), []);
    await hitsAgree(table);
    await store.delete({ before: 900 });
    await hitsAgree(table);
    await store.delete({ before: Infinity });
    assert.equal(await hitsAgree(table), 0);
  });

  test(`${name}: an append whose hits can't be written stores nothing`, { skip: hitSkip }, async () => {
    const table = `f${(n += 1)}`;
    await make(table);
    const failing = await make(table, undefined, async (sql, params) => {
      if (!sql.startsWith("CREATE") && sql.includes(`INSERT INTO ${table}_hits`)) {
        throw new Error("the disk is full");
      }
      return query(sql, params);
    });
    const events = randomHistory(seeded(5)).stored.slice(0, 30);
    const outcome = await failing.append(events).then(() => "stored", (error) => error.message);
    // A database that writes hits by trigger never sends their insert on its own, so it can't fail alone.
    if (outcome !== "stored" || dialect.hits.together !== "triggers") {
      assert.match(outcome, /disk is full/);
      assert.deepEqual(await rowsOf(`SELECT seq FROM ${table}_events`), []);
    }
    await hitsAgree(table);
  });

  test(`${name}: migrate() gives a store from before hits its hits, once, and it counts as before`, { skip: hitSkip }, async () => {
    const table = `m${(n += 1)}`;
    const old = await make(table);
    const random = seeded(47);
    const { batches, stored } = randomHistory(random, 300);
    for (const batch of batches) {
      await old.append(batch);
    }
    const before = await hitsAgree(table);
    // What a store made before hits holds: the same events, changes and state, and no hits.
    await rowsOf(`DROP TABLE ${table}_hits`);
    if (dialect.hits.together === "triggers") {
      await rowsOf(`DROP TRIGGER ${table}_events_hits`);
      await rowsOf(`DROP TRIGGER ${table}_events_forget`);
    }
    await rowsOf(`DELETE FROM ${table}_state WHERE key = '${FLOOR_KEY}'`);
    // Opening it runs migrate(); running it again changes nothing.
    const store = await make(table);
    assert.equal(await hitsAgree(table), before);
    await store.migrate();
    assert.equal(await hitsAgree(table), before);
    for (let q = 0; q < 60; q += 1) {
      const counted = randomCountQuery(random, HIT_FLOOR);
      assert.deepEqual(await store.count(counted), countEvents(stored, counted), JSON.stringify(counted));
    }
    const late = { id: "late", at: 5, schema: "t@1", labeler: "l@1", probability: "native", signals: { a: 0.9, b: 0.01 } };
    await store.append([late]);
    assert.equal(await hitsAgree(table), before + 1);
  });

  test(`${name}: a store opened with another hitFloor than its hits were written with refuses to count`, { skip: hitSkip }, async () => {
    const table = `r${(n += 1)}`;
    await make(table);
    const other = await make(table, undefined, undefined, 0.2);
    await assert.rejects(async () => other.count({ schema: "t@1", windows: [{ from: 0, to: 10 }], signals: ["a"], per: "event" }), /written with a hitFloor of 0.05, not 0.2/);
  });

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
