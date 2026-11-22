// The parts that call real models, end to end, on the main synthetic inbox. Costs a few cents.
// Needs AI_GATEWAY_API_KEY.
//
//   node examples/support/live.ts
import { backtestQuestion, chatLabeler, createPipeline, DAY, decisionLabeler, groupAlerts, HOUR, investigate, memoryStore, openAiChat, replay, suspectsFor, toolsFor, viewOf, yesNo } from "../../src/index.ts";
import type { Notice, TextEvent } from "../../src/index.ts";
import { loadInbox } from "./data.ts";
import { supportMonitors } from "./monitors.ts";
import { support } from "./schema.ts";
import { plantedBehind } from "./score.ts";

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) {
  throw new Error("AI_GATEWAY_API_KEY is not set");
}
const jev = decisionLabeler({ model: "typesafe-ai/jev-1.14.0", apiKey });
const haiku = chatLabeler({ model: "anthropic/claude-haiku-5.5", apiKey, baseUrl: "https://ai-gateway.vercel.sh/v1" });
const inbox = loadInbox("support");
const day = (at: number): string => `day ${Math.floor((at - inbox.start + 8 * HOUR) / DAY) + 1}`;
const asText = ({ id, at, text, tags }: (typeof inbox.events)[number]): TextEvent => ({ id, at, text: text ?? "", ...(tags ? { tags } : {}) });

// 1. The pipeline with a real decision model and a real second reader: label a few stored
//    messages again and compare with the answers on file from the same model.
const sample = [
  ...inbox.events.filter((event) => inbox.sourceOf.get(event.id) === "data_exposure"),
  ...inbox.events.filter((event) => (event.signals.data_exposure ?? 0) > 0.25 && inbox.sourceOf.get(event.id) !== "data_exposure").slice(0, 2),
  ...inbox.events.slice(100, 104),
];
const store = memoryStore();
const pipeline = createPipeline({ schema: support, labeler: jev, store, second: { labeler: haiku, bands: { data_exposure: [0.25, 0.9] } } });
const ingested = await pipeline.ingest(sample.map(asText));
const again = await store.events();
let largest = 0;
for (const event of again) {
  const filed = inbox.events.find((e) => e.id === event.id);
  for (const signal of support.signals) {
    largest = Math.max(largest, Math.abs((event.signals[signal] ?? 0) - (filed?.signals[signal] ?? 0)));
  }
}
console.log(`1. Pipeline: labeled ${ingested.labeled} events for $${ingested.cost.toFixed(5)}. Largest difference from the answers on file: ${largest.toFixed(2)}.`);
for (const event of again.filter((e) => "data_exposure.second" in e.signals)) {
  console.log(`   Second reader asked about "${(event.text ?? "").slice(0, 60)}...": first said ${event.signals.data_exposure}, second said ${event.signals["data_exposure.second"] === 1 ? "yes" : "no"}.`);
}
console.log(`   A redelivery of the same events: ${JSON.stringify(await pipeline.ingest(sample.map(asText)))}`);

// 2. Backtest a question nobody asked at the time, over the days around the invoice bug.
const around = inbox.events.filter((event) => event.at >= inbox.start + 13 * DAY && event.at < inbox.start + 20 * DAY);
const tried = await backtestQuestion({
  events: around,
  key: "total_differs",
  question: yesNo("Does the customer say an invoice or estimate their customer received shows a different total than the one in the app?"),
  labeler: jev,
  state: support.state,
  concurrency: 12,
});
const found = tried.signals[0];
if (!found) {
  throw new Error("The backtest produced no signal");
}
const isBug = (id: string): boolean => inbox.sourceOf.get(id) === "invoice_pdf_total";
console.log(`\n2. Backtest of a new question over ${tried.events.length} events ($${tried.cost.toFixed(4)}): ${found.counts.yes} yes.`);
console.log(`   By day: ${found.byBucket.map((bucket) => `${day(bucket.at)}: ${bucket.yes}`).join(", ")}`);
console.log(`   Of its yeses, ${tried.events.filter((e) => (e.signals.total_differs ?? 0) >= 0.5 && isBug(e.id)).length} are the planted bug; the bug has ${around.filter((e) => isBug(e.id)).length} messages in this stretch.`);
console.log(`   Surest: "${(found.surest[0]?.text ?? "").slice(0, 110)}"`);

// 3. Investigate the page the invoice bug raised. The investigator sees nothing after the page.
const from = inbox.start + 8 * DAY;
const { alerts } = await replay({ monitors: supportMonitors(inbox.events), gates: support.gates }, inbox.events, { from, to: inbox.start + inbox.days * DAY });
const group = groupAlerts(alerts).find((g) => g.severity === "page" && g.alerts.some((alert) => plantedBehind(alert, inbox).includes("invoice_pdf_total")));
if (!group) {
  throw new Error("No page was raised for the invoice bug");
}
const view = viewOf(inbox.events.filter((event) => event.at < group.lastAt));
const changes = inbox.changes.filter((change) => change.at < group.lastAt);
const leads = group.alerts.map((alert): Notice => {
  const behind = suspectsFor(alert, view, changes, { gates: support.gates });
  return { id: `${alert.id}#fired`, kind: "fired", at: alert.at, alert, ...(behind ? { suspects: behind.ranked.slice(0, 3), confident: behind.confident } : {}) };
});
const { report, steps, cost } = await investigate(group, {
  chat: openAiChat({ model: "anthropic/claude-sonnet-5.5", apiKey, baseUrl: "https://ai-gateway.vercel.sh/v1" }),
  tools: toolsFor({ view, changes }, { signals: support.signals, gates: support.gates }),
  about: "the support inbox of Acme, software for home-service businesses",
  leads,
});
console.log(`\n3. Investigation of ${group.id} (${group.alerts.map((alert) => alert.monitor).join("; ")}), ${day(group.firstAt)}: ${steps} rounds of tool calls, $${cost.toFixed(3)}.`);
console.log(`   The ranking's first suspect: ${leads[0]?.suspects?.[0]?.change.what ?? "none"} (confident: ${leads[0]?.confident ?? false}).`);
console.log(
  JSON.stringify(report, null, 1)
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n"),
);
