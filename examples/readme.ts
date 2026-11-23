// The code in README.md and docs/reference.md, kept here so the type-check holds it to the real
// API. readme.test.mjs runs `quickstart` with the model's reply stubbed; the rest only has to
// compile. When you change a snippet in either file, change it here. The README's real-world
// examples are in recipes.ts.
import { test } from "node:test";
import { auditSample, backtestQuestion, choice, consoleSink, countEvents, countsOf, createPipeline, createWatch, DAY, decisionLabeler, defineSchema, eventMonitor, fitGates, HOUR, jsonlStore, labelersOf, memoryReader, readEvents, shareMonitors, silenceMonitor, toolsFor, yesNo } from "../src/index.ts";
import type { Change, Json, LabeledEvent, Labeler, Monitor, Sink, Store, TextEvent, Tool } from "../src/index.ts";
import { DatabaseSync } from "node:sqlite";
import { duckdbStore } from "../src/stores/duckdb.ts";
import { postgresStore } from "../src/stores/postgres.ts";
import { sqliteStore } from "../src/stores/sqlite.ts";
import { storeContract } from "../src/testing.ts";

// ---- README: the first example ------------------------------------------------------------
export const support = defineSchema({
  name: "support",
  questions: {
    area: choice("Which part of the product is the message about?", {
      login: "Signing in",
      billing: "Their plan or charges",
      other: "Anything else",
    }),
    is_bug_report: yesNo("Does the customer say something isn't working as it should?"),
    data_exposure: yesNo("Does the customer say they can see another business's information?"),
  },
});

export const quickstart = async (): Promise<void> => {
  const store = jsonlStore("./signals");
  const labeler = decisionLabeler({
  model: "typesafe-ai/jev-1.14.0",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
});
  const pipeline = createPipeline({ schema: support, labeler, store });

  await pipeline.ingest([
    {
    id: "msg-1",
    at: Date.now(),
    text: "I can see another company's customers in my account",
    unit: "account-42",
    tags: { version: "4.12.0" },
  },
  ]);

  const watch = createWatch({
    schema: support,
    store,
    monitors: [
    ...shareMonitors({ signals: support.signals }),
    eventMonitor({ signal: "data_exposure" }),
    silenceMonitor({ windowMs: 3 * HOUR }),
  ],
    sinks: [consoleSink()],
  });
  await watch.tick();
};

// ---- README: usage ------------------------------------------------------------------------
declare const reviewed: (event: LabeledEvent) => boolean;

export const recordChanges = async (store: Store): Promise<void> => {
  await store.recordChange({
  id: "release-4.12.0",
  at: Date.parse("2026-11-20T15:00:00Z"),
  kind: "release",
  what: "mobile 4.12.0: new sign-in library",
  scope: { version: "4.12.0" },
});
  await store.recordChange({
  id: "price-email",
  at: Date.now(),
  kind: "campaign",
  what: "email about new prices",
  expect: { signals: ["area=billing", "*"], forMs: 2 * DAY },
});
};

export const tryQuestion = async (store: Store, labeler: Labeler): Promise<void> => {
  const tried = await backtestQuestion({
    events: await store.events({ schema: support.id, from: Date.now() - 7 * DAY }),
    key: "total_differs",
    question: yesNo(
    "Does the customer say an invoice their customer received shows a different total than the app?",
  ),
    labeler,
  });
  console.log(tried.cost, tried.signals[0]?.byBucket, tried.signals[0]?.surest);
};

export const checkLabeler = async (store: Store): Promise<void> => {
  const events = await store.events({ schema: support.id });
  const checked = auditSample(events, { signal: "data_exposure" })
    .map(({ event, weight }) => ({
      id: event.id,
      signal: "data_exposure",
      truth: reviewed(event),
      weight,
    }));
  const { gates } = fitGates(events, checked, { objective: { precision: 0.9 } });
  createWatch({ schema: support, store, gates, monitors: [eventMonitor({ signal: "data_exposure" })] });
};

// ---- docs/reference.md: stores ------------------------------------------------------------
declare const pool: { query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
declare const env: { DB: { prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results: Array<Record<string, unknown>> }> } } } };

export const databaseStores = async (): Promise<Store[]> => {
  const store = postgresStore({ query: (sql, params) => pool.query(sql, params) });
  await store.migrate();

  const db = new DatabaseSync("signals.db");
  const local = sqliteStore({ query: async (sql, params) => ({ rows: db.prepare(sql).all(...params) }) });

  const edge = sqliteStore({
    query: async (sql, params) => ({ rows: (await env.DB.prepare(sql).bind(...params).all()).results }),
    maxParams: 100,
  });

  const { DuckDBInstance } = await import("@duckdb/node-api");
  const connection = await (await DuckDBInstance.create("signals.duckdb")).connect();
  const duck = duckdbStore({ query: async (sql, params) => ({ rows: (await connection.runAndReadAll(sql, params)).getRowObjectsJS() }) });
  return [store, local, edge, duck];
};

// ---- docs/reference.md: writing your own --------------------------------------------------
declare const classify: (state: unknown, keys: string[]) => Promise<Record<string, number>>;
declare const queue: AsyncIterable<{ id: string; receivedAt: number; body: string; accountId: string; appVersion: string }>;
declare const postToSlack: (text: string, options: { dedupeKey: string }) => Promise<void>;
declare const readRunbook: (area: string) => string;
declare const sql: { count(query: string, values: unknown[]): Promise<{ yes: number; total: number }> };
declare const pipeline: ReturnType<typeof createPipeline>;
declare const freshPostgresStore: () => Store;
declare const stored: {
  push(events: readonly LabeledEvent[]): Promise<void>;
  all(): Promise<LabeledEvent[]>;
  has(id: string, schema: string, labeler: string): boolean;
  remove(query: { before?: number; unit?: string }): Promise<number>;
  putChange(change: Change): Promise<void>;
  changesBetween(from?: number, to?: number): Promise<Change[]>;
  get(key: string): Promise<Json | undefined>;
  put(key: string, value: Json): Promise<void>;
};

export const mine: Labeler = {
  id: "my-classifier@2026-11-01",
  probability: "native",
  label: async (state, questions) => {
    const scores = await classify(state, Object.keys(questions));
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: scores[key] }])) };
  },
};

export const kv: Store = {
  append: async (events) => { await stored.push(events); },
  events: async (query) => readEvents(await stored.all(), query),
  count: async (query) => countEvents(await stored.all(), query),
  labelers: async (query) => labelersOf(await stored.all(), query),
  known: async (ids, schema, labeler) => new Set(ids.filter((id) => stored.has(id, schema, labeler))),
  delete: async ({ before, unit }) => stored.remove({ before, unit }),
  recordChange: async (change) => { await stored.putChange(change); },
  changes: async ({ from, to } = {}) => stored.changesBetween(from, to),
  loadState: async (key) => stored.get(key),
  saveState: async (key, value) => { await stored.put(key, value); },
};

export const checkPostgres = (): void => {
  for (const { name, run } of storeContract(() => freshPostgresStore())) {
    test(`postgres: ${name}`, run);
  }
};

export async function* fromQueue(): AsyncGenerator<TextEvent> {
  for await (const job of queue) {
    yield { id: job.id, at: job.receivedAt, text: job.body, unit: job.accountId, tags: { version: job.appVersion } };
  }
}

export const runQueue = async (): Promise<void> => {
  await pipeline.run(fromQueue());
};

export const slack: Sink = {
  notify: async (notices) => {
    for (const { id, kind, alert, suspects } of notices) {
      await postToSlack(`${kind}: ${alert.monitor}${suspects?.[0] ? ` (possibly ${suspects[0].change.what})` : ""}`, { dedupeKey: id });
    }
  },
};

export const ceiling = (signal: string, share: number): Monitor => ({
  name: `${signal} above ${share * 100}% today`,
  severity: "digest",
  signal,
  windowMs: DAY,
  lookbackMs: DAY,
  tested: false,
  check: async (reader, now, { gates }) => {
    const [row] = await reader.count({ windows: [{ from: now - DAY, to: now }], signals: [signal], gates, per: "event" });
    const today = countsOf(row, signal);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});

export const ceilingInSql = (signal: string, share: number): Monitor => ({
  ...ceiling(signal, share),
  check: async (_reader, now) => {
    const today = await sql.count("select count(*) filter (where signals ->> $1 >= '0.5') as yes, count(*) as total from events where at >= $2 and at < $3", [signal, now - DAY, now]);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});

const runbook: Tool = { description: "The runbook for a product area", input: { area: { type: "string", description: "Area name" } }, run: ({ area }) => readRunbook(String(area)) };
export const withRunbook = (events: LabeledEvent[], changes: Change[]): Record<string, Tool> => {
  const tools = { ...toolsFor({ reader: memoryReader(events), changes }, { signals: support.signals }), runbook };
  return tools;
};
