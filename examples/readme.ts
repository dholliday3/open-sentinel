// The code in README.md, kept here so the type-check holds it to the real API. Nothing in this
// file runs: it only has to compile. When you change a snippet in the README, change it here.
import { choice, consoleSink, count, createPipeline, createWatch, DAY, decisionLabeler, defineSchema, eventMonitor, HOUR, jsonlStore, score, shareMonitors, silenceMonitor, toolsFor, viewOf, yesNo } from "../src/index.ts";
import type { Labeler, Monitor, Sink, Store, TextEvent, Tool } from "../src/index.ts";

// ---- The idea in one page -----------------------------------------------------------------
const support = defineSchema({
  name: "support",
  questions: {
    area: choice("Which part of the product is the message about?", { login: "Signing in", billing: "Their plan or charges", other: "Anything else" }),
    is_bug_report: yesNo("Does the customer say something isn't working as it should?"),
    data_exposure: yesNo("Does the customer say they can see another business's information?"),
    frustration: score("How frustrated is the customer?", ["Not at all", "A little", "Clearly", "Furious"]),
  },
});

export const quickstart = async (): Promise<void> => {
  const store = jsonlStore("./signals");
  const pipeline = createPipeline({
    schema: support,
    labeler: decisionLabeler({ model: "typesafe-ai/jev-1.14.0", apiKey: process.env.AI_GATEWAY_API_KEY! }),
    store,
  });
  await pipeline.ingest([{ id: "msg-1", at: Date.now(), text: "the app logs me out every time", unit: "account-42", tags: { platform: "ios", version: "4.12.0" } }]);

  const watch = createWatch({
    schema: support,
    store,
    monitors: [...shareMonitors({ signals: support.signals }), eventMonitor({ signal: "data_exposure" }), silenceMonitor({ windowMs: 3 * HOUR })],
    sinks: [consoleSink()],
  });
  await watch.tick();
};

// ---- How to extend it ---------------------------------------------------------------------
declare const classify: (state: unknown, keys: string[]) => Promise<Record<string, number>>;
declare const queue: AsyncIterable<{ id: string; receivedAt: number; body: string; accountId: string; appVersion: string }>;
declare const postToSlack: (text: string, options: { dedupeKey: string }) => Promise<void>;
declare const readRunbook: (area: string) => string;
declare const sql: { count(query: string, values: unknown[]): Promise<{ yes: number; total: number }> };

export const mine: Labeler = {
  id: "my-classifier@2026-11-01",
  probability: "native",
  label: async (state, questions) => {
    const scores = await classify(state, Object.keys(questions));
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: scores[key] }])) };
  },
};

export const postgres: Store = {
  append: async (_events) => {},
  events: async ({ from: _from, to: _to, schema: _schema, labeler: _labeler } = {}) => [],
  known: async (_ids, _schema, _labeler) => new Set(),
  delete: async ({ before: _before, unit: _unit }) => 0,
  recordChange: async (_change) => {},
  changes: async ({ from: _from, to: _to } = {}) => [],
  loadState: async (_key) => undefined,
  saveState: async (_key, _value) => {},
};

export async function* fromQueue(): AsyncGenerator<TextEvent> {
  for await (const job of queue) {
    yield { id: job.id, at: job.receivedAt, text: job.body, unit: job.accountId, tags: { version: job.appVersion } };
  }
}

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
  check: (view, now, { gates }) => {
    const today = count(view.within({ from: now - DAY, to: now }), signal, gates);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});

export const ceilingInSql = (signal: string, share: number): Monitor => ({
  ...ceiling(signal, share),
  check: async (_view, now) => {
    const today = await sql.count("select count(*) filter (where signals ->> $1 >= '0.5') as yes, count(*) as total from events where at >= $2 and at < $3", [signal, now - DAY, now]);
    return { state: today.total === 0 ? "no_data" : today.yes / today.total > share ? "firing" : "ok", detail: { ...today } };
  },
});

const runbook: Tool = { description: "The runbook for a product area", input: { area: { type: "string", description: "Area name" } }, run: ({ area }) => readRunbook(String(area)) };
export const tools = { ...toolsFor({ view: viewOf([]), changes: [] }, { signals: support.signals }), runbook };
