// Loads one of the two synthetic support inboxes in ./data/ as SDK events and changes. Every
// message in them was written by a model to a brief; nothing is from a real customer. They were
// labeled by typesafe-ai/jev-1.14.0 with the questions in schema.ts. The product and its
// assistant were renamed afterwards, in the questions and the messages alike; no other word
// changed. schema.test.mjs holds that the wording hasn't changed since.
import { readFileSync } from "node:fs";
import type { Change, LabeledEvent } from "../../src/index.ts";
import { support } from "./schema.ts";

export type InboxName = "support" | "support-holdout";

export interface Inbox {
  events: LabeledEvent[];
  changes: Change[];
  /** When the three weeks begin (8am local on day 1) and how many days they run. */
  start: number;
  days: number;
  /** What was planted, for scoring only. Monitors and investigators never see it. */
  planted: Array<{ id: string; kind: string; from: number; to: number; truth: string }>;
  /** Which planted item (or background kind) each event's text came from. */
  sourceOf: Map<string, string>;
}

export const loadInbox = (name: InboxName): Inbox => {
  const dir = new URL(`./data/${name}/`, import.meta.url);
  const lines = <Row>(file: string): Row[] =>
    readFileSync(new URL(file, dir), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Row);
  const json = <Value>(file: string): Value => JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Value;

  // An inbox is a timeline of arrivals, each pointing at one of a few hundred distinct messages.
  const messages = new Map(lines<{ id: string; source: string; text: string }>("messages.jsonl").map((m) => [m.id, m]));
  const signals = new Map(lines<{ id: string; signals: Record<string, number> }>("labels.jsonl").map((l) => [l.id, l.signals]));
  // The second reader's answers for the few messages whose data_exposure answer fell between 0.5 and 0.9.
  const second = json<Record<string, boolean>>("second-reader.json");
  const truth = json<{ start: number; days: number; planted: Inbox["planted"] }>("truth.json");

  const sourceOf = new Map<string, string>();
  const events = lines<{ id: string; at: number; messageId: string; tags: Record<string, string | null> }>("timeline.jsonl").map((row): LabeledEvent => {
    const message = messages.get(row.messageId)!;
    sourceOf.set(row.id, message.source);
    return {
      id: row.id,
      at: row.at,
      text: message.text,
      tags: row.tags,
      schema: support.id,
      labeler: "typesafe-ai/jev-1.14.0",
      probability: "native",
      signals: { ...signals.get(row.messageId)!, ...(row.messageId in second ? { "data_exposure.second": second[row.messageId] ? 1 : 0 } : {}) },
    };
  });

  const changes = json<Array<{ at: number; what: string }>>("changes.json").map((deploy, i): Change => {
    const version = deploy.what.match(/^mobile (\d+\.\d+\.\d+)/)?.[1];
    const kind = version ? "release" : /^(marketing|billing)/.test(deploy.what) ? "campaign" : "deploy";
    // A mobile release reaches only the events written on that app version.
    return { id: `change-${i + 1}`, at: deploy.at, kind, what: deploy.what, ...(version ? { scope: { app_version: version } } : {}) };
  });

  return { events, changes, start: truth.start, days: truth.days, planted: truth.planted, sourceOf };
};
