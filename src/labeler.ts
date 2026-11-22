// A labeler answers a schema's questions about one state. Anything that can do that plugs in:
// a decision model, a chat model, a small trained classifier, a set of rules.
import { createHash } from "node:crypto";
import type { Answer, Schema, WireQuestion } from "./schema.ts";
import type { Json, LabeledEvent, ProbabilitySource, TextEvent } from "./types.ts";

export interface LabelResult {
  answers: Record<string, Answer>;
  /** What the call cost in dollars, when the provider says. */
  cost?: number;
}

export interface Labeler {
  /** The model and its exact version. Stored on every event, so pin a version: an alias that moves changes your metrics silently. */
  readonly id: string;
  readonly probability: ProbabilitySource;
  label(state: Json, questions: Readonly<Record<string, WireQuestion>>): Promise<LabelResult>;
}

export interface LabelOptions {
  /**
   * Runs on the event's text, and on every string in its context, before anything else sees
   * them: the labeler, the store, the sinks.
   */
  redact?: (text: string) => string;
  /**
   * A second reader for yes/no questions whose first answer falls in a band: `{ data_exposure:
   * [0.5, 0.9] }`. Its answer is stored beside the first as `<key>.second`. For questions that can
   * page someone on one event, where the first reader's middle answers run high.
   */
  second?: { labeler: Labeler; bands: Readonly<Record<string, readonly [number, number]>> };
}

const redactJson = (value: Json, redact: (text: string) => string): Json => {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, redact));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, redact)]));
  }
  return value;
};

/** Labels one event. Throws when the labeler can't answer or answers off-contract: unread is not clean. */
export const labelEvent = async (event: TextEvent, schema: Schema, labeler: Labeler, options: LabelOptions = {}): Promise<{ event: LabeledEvent; cost: number }> => {
  const { redact } = options;
  const shown: TextEvent = redact ? { ...event, text: redact(event.text), ...(event.context ? { context: redactJson(event.context, redact) as Record<string, Json> } : {}) } : event;
  const state = schema.state(shown);
  const first = await labeler.label(state, schema.wire);
  const signals = schema.read(first.answers);
  let cost = first.cost ?? 0;
  if (options.second) {
    const unsure = Object.entries(options.second.bands).filter(([key, [low, high]]) => schema.questions[key]?.type === "boolean" && signals[key]! >= low && signals[key]! < high);
    if (unsure.length > 0) {
      const again = await options.second.labeler.label(state, Object.fromEntries(unsure.map(([key]) => [key, schema.wire[key]!])));
      cost += again.cost ?? 0;
      for (const [key] of unsure) {
        const answer = again.answers[key];
        if (answer?.type !== "boolean" || !(answer.probability >= 0 && answer.probability <= 1)) {
          throw new Error(`The second reader didn't answer "${key}": ${JSON.stringify(answer ?? null)}`);
        }
        signals[`${key}.second`] = answer.probability;
      }
    }
  }
  return { event: { ...shown, schema: schema.id, labeler: labeler.id, probability: labeler.probability, signals }, cost };
};

/** Runs `work` over items with at most `limit` in flight, keeping order. */
export const pool = async <Item, Result>(items: readonly Item[], limit: number, work: (item: Item, index: number) => Promise<Result>): Promise<Result[]> => {
  const results = new Array<Result>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/** An event that could not be labeled, and why. It is not stored: unread is not clean. */
export interface LabelFailure {
  id: string;
  error: string;
}

/**
 * Labels many events, a few at a time. One event the labeler can't answer doesn't stop the rest:
 * it comes back in `failed`, and what was spent on it is still counted.
 */
export const labelAll = async (events: readonly TextEvent[], schema: Schema, labeler: Labeler, options: LabelOptions & { concurrency?: number } = {}): Promise<{ events: LabeledEvent[]; failed: LabelFailure[]; cost: number }> => {
  const results = await pool(events, options.concurrency ?? 8, async (event) => {
    try {
      return await labelEvent(event, schema, labeler, options);
    } catch (error) {
      return { failure: { id: event.id, error: error instanceof Error ? error.message : String(error) } };
    }
  });
  const labeled = results.flatMap((result) => ("event" in result ? [result] : []));
  return {
    events: labeled.map((result) => result.event),
    failed: results.flatMap((result) => ("failure" in result ? [result.failure] : [])),
    cost: labeled.reduce((sum, result) => sum + result.cost, 0),
  };
};

/** A place to keep answers: a `Map`, or anything with the same two methods. */
export interface AnswerCache {
  get(key: string): LabelResult | undefined | Promise<LabelResult | undefined>;
  set(key: string, value: LabelResult): unknown;
}

/**
 * The same labeler, asking each distinct state and question set only once, including when the
 * same text arrives several times at the same moment. A repeated answer costs nothing.
 */
export const cached = (labeler: Labeler, cache: AnswerCache = new Map<string, LabelResult>()): Labeler => {
  const asking = new Map<string, Promise<{ result: LabelResult; fresh: boolean }>>();
  return {
    id: labeler.id,
    probability: labeler.probability,
    label: async (state, questions) => {
      const key = createHash("sha256").update(JSON.stringify([labeler.id, state, questions])).digest("hex");
      // Looked up and set with no await in between, so two calls at once can't both go on to ask.
      const underway = asking.get(key);
      if (underway) {
        return { answers: (await underway).result.answers, cost: 0 };
      }
      const ask = (async () => {
        const kept = await cache.get(key);
        if (kept) {
          return { result: kept, fresh: false };
        }
        const result = await labeler.label(state, questions);
        await cache.set(key, result);
        return { result, fresh: true };
      })();
      asking.set(key, ask);
      try {
        const { result, fresh } = await ask;
        return fresh ? result : { answers: result.answers, cost: 0 };
      } finally {
        asking.delete(key);
      }
    },
  };
};

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:\d[ -]?){13,19}\b/g, "[card]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[phone]"],
];

/**
 * Replaces card numbers, US social security numbers, email addresses and US phone numbers with
 * placeholders. A floor, not a guarantee: names and addresses pass through.
 */
export const redactBasics = (text: string): string => PATTERNS.reduce((out, [pattern, label]) => out.replace(pattern, label), text);
