// The code in README.md's real-world examples, kept here so the type-check holds it to the real
// API. Each recipe's snippet is the body of one function below, which takes what the snippet
// borrows from the quickstart (the store, the pipeline). recipes.test.mjs runs them end to end
// with rules in place of a model. When you change a snippet in the README, change it here.
import { consoleSink, createWatch, DAY, defineSchema, exposureMonitor, HOUR, shareMonitors, silenceMonitor, yesNo } from "../src/index.ts";
import type { Change, Monitor, Pipeline, Sink, Store, TextEvent, Watch } from "../src/index.ts";

// ---- 1. A silent billing bug after a release ----------------------------------------------
export const billing = defineSchema({
  name: "billing",
  questions: { invoice_wrong: yesNo("Does the customer say an invoice total is wrong?") },
});

export const watchInvoices = async (store: Store): Promise<Watch> => {
  const release: Change = {
    id: "invoices-4.12.0", at: Date.parse("2026-11-20T15:00:00Z"), kind: "release",
    what: "invoices 4.12.0: new PDF renderer", scope: { version: "4.12.0" },
  };
  await store.recordChange(release);
  const watch = createWatch({
    schema: billing,
    store,
    monitors: [
      ...shareMonitors({ signals: ["invoice_wrong"] }),
      exposureMonitor({ change: release, signal: "invoice_wrong" }),
    ],
    sinks: [consoleSink()],
  });
  return watch;
};

// ---- 2. One customer sees another company's data ------------------------------------------
export const pagerDuty: Sink = {
  notify: async (notices) => {
    for (const { kind, alert, question, examples } of notices) {
      const quote = examples?.[0]?.text ?? "";
      const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routing_key: process.env.PAGERDUTY_ROUTING_KEY,
          event_action: kind === "fired" ? "trigger" : "resolve",
          dedup_key: alert.id,
          payload: { summary: `${question} "${quote}"`, source: "support", severity: "critical" },
        }),
      });
      if (!response.ok) {
        throw new Error(`PagerDuty answered ${response.status}`);
      }
    }
  },
};

// ---- 3. Android sign-in broken after an app update ----------------------------------------
export const watchAndroidSignIn = async (store: Store): Promise<Monitor[]> => {
  const android: Change = {
    id: "android-4.12.0", at: Date.parse("2026-11-20T15:00:00Z"), kind: "release",
    what: "Android 4.12.0: new sign-in library", scope: { version: "4.12.0" },
  };
  await store.recordChange(android);
  const monitors = [
    ...shareMonitors({ signals: ["area=login"], where: { platform: "android" } }),
    exposureMonitor({ change: android, signal: "area=login" }),
  ];
  return monitors;
};

// ---- 4. A pricing email that shouldn't page -----------------------------------------------
export const announcePrices = async (store: Store): Promise<void> => {
  await store.recordChange({
    id: "price-email",
    at: Date.parse("2026-12-01T14:00:00Z"),
    kind: "campaign",
    what: "email to every customer about new prices",
    expect: { signals: ["area=billing", "*"], forMs: 2 * DAY },
  });
};

// ---- 5. An AI support agent after a prompt change -----------------------------------------
export const transcripts = defineSchema({
  name: "agent",
  questions: {
    off_policy: yesNo("Did the assistant promise something the refund policy doesn't allow?"),
    wants_human: yesNo("Did the customer ask to talk to a person?"),
  },
});

export const watchAgent = async (store: Store): Promise<Watch> => {
  const prompt: Change = {
    id: "prompt-v13", at: Date.parse("2026-11-20T15:00:00Z"), kind: "config",
    what: "support agent prompt v13", scope: { prompt: "v13" }, randomized: true,
  };
  await store.recordChange(prompt);
  const watch = createWatch({
    schema: transcripts,
    store,
    monitors: [
      ...shareMonitors({ signals: transcripts.signals }),
      ...transcripts.signals.map((signal) => exposureMonitor({ change: prompt, signal })),
    ],
    sinks: [consoleSink()],
  });
  return watch;
};

// ---- 6. Inbound text replies stop arriving ------------------------------------------------
export const texts = defineSchema({
  name: "texts",
  questions: { wants_stop: yesNo("Does the customer ask to stop getting texts?") },
});

export const watchTexts = (store: Store): Watch => {
  const watch = createWatch({
    schema: texts,
    store,
    monitors: [silenceMonitor({ windowMs: HOUR, periodMs: DAY, minBefore: 5 })],
    sinks: [consoleSink()],
  });
  return watch;
};

// ---- 7. A queue worker that loses nothing -------------------------------------------------
/** The shape of a queue client: enough to type-check the recipe. */
export interface Queue {
  messages(): AsyncIterable<TextEvent>;
  ack(events: readonly TextEvent[]): Promise<void>;
  retryLater(events: readonly TextEvent[]): Promise<void>;
}

export const workQueue = async (pipeline: Pipeline, queue: Queue): Promise<void> => {
  await pipeline.run(queue.messages(), {
    onBatch: async ({ events, failed }) => {
      const unread = new Set(failed.map((failure) => failure.id));
      await queue.ack(events.filter((event) => !unread.has(event.id)));
      await queue.retryLater(events.filter((event) => unread.has(event.id)));
    },
  });
};
