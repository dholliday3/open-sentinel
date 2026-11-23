// Trying a question or a set of monitors on the past before it goes live. Possible because the
// stored events keep their text and a labeler is cheap: a new question can be asked of all history
// in minutes, and a monitor replayed over it, before either pages anyone.
import { labelAll } from "./labeler.ts";
import type { LabelFailure, LabelOptions, Labeler } from "./labeler.ts";
import { count, series, viewOf } from "./metrics.ts";
import { memoryReader } from "./reader.ts";
import { replay } from "./monitor.ts";
import type { Alert, AlertGroup, RunnerOptions } from "./monitor.ts";
import { defineSchema, parseSignal } from "./schema.ts";
import type { Question, Schema } from "./schema.ts";
import type { Counts } from "./stats.ts";
import { DAY, WEEK } from "./types.ts";
import type { Change, Json, LabeledEvent, TextEvent } from "./types.ts";

type Options = LabelOptions & { concurrency?: number };

export interface Relabeled {
  events: LabeledEvent[];
  /** Events the labeler couldn't answer this time. */
  failed: LabelFailure[];
  cost: number;
  /** Events whose text wasn't kept: they can't be asked anything again. */
  skipped: number;
}

const textOf = ({ schema: _schema, labeler: _labeler, probability: _probability, signals: _signals, ...event }: LabeledEvent & { text: string }): TextEvent => event;
const hasText = (event: LabeledEvent): event is LabeledEvent & { text: string } => typeof event.text === "string";

/**
 * Labels stored events again, under another schema or another labeler. Nothing is written:
 * append the result to a store to keep it. The old answers stay beside the new ones.
 */
export const relabel = async (events: readonly LabeledEvent[], schema: Schema, labeler: Labeler, options: Options = {}): Promise<Relabeled> => {
  const withText = events.filter(hasText);
  return { ...(await labelAll(withText.map(textOf), schema, labeler, options)), skipped: events.length - withText.length };
};

/** The question a stored signal key belongs to: `area` for `area=login`, `area>=2` and `area.second`. */
const questionOf = (signal: string): string => parseSignal(signal)[0]!.question;

/**
 * Moves stored events to a new version of their schema without asking everything again. A
 * question whose wording is the same in both keeps its answers; only new and reworded questions
 * are asked. Without this, a changed schema starts every monitor from an empty baseline.
 *
 * Only an event answered under `from` by this same labeler can keep answers. Any other is asked
 * every question.
 */
export const upgrade = async (events: readonly LabeledEvent[], from: Schema, to: Schema, labeler: Labeler, options: Options = {}): Promise<Relabeled & { asked: string[] }> => {
  const asked = Object.keys(to.wire).filter((key) => JSON.stringify(to.wire[key]) !== JSON.stringify(from.wire[key]));
  const withText = events.filter(hasText);
  const keeps = (event: LabeledEvent): boolean => event.schema === from.id && event.labeler === labeler.id;
  const rest = await labelAll(withText.filter((event) => !keeps(event)).map(textOf), to, labeler, options);
  const same = withText.filter(keeps);
  const fresh =
    asked.length === 0
      ? { events: [], failed: [], cost: 0 }
      : await labelAll(same.map(textOf), defineSchema({ name: to.name, questions: Object.fromEntries(asked.map((key) => [key, to.questions[key]!])), state: (event) => to.state(event) }), labeler, options);
  const answered = new Map(fresh.events.map((event) => [event.id, event.signals]));
  const moved = same.flatMap((event) => {
    const added = asked.length === 0 ? {} : answered.get(event.id);
    if (!added) {
      return [];
    }
    const held = Object.entries(event.signals).filter(([signal]) => to.questions[questionOf(signal)] !== undefined && !asked.includes(questionOf(signal)));
    return [{ ...event, schema: to.id, signals: { ...Object.fromEntries(held), ...added } }];
  });
  return { events: [...moved, ...rest.events], failed: [...fresh.failed, ...rest.failed], cost: fresh.cost + rest.cost, skipped: events.length - withText.length, asked };
};

/**
 * Asks one new question of stored events and shows what it would have counted: each signal's
 * total, its counts per bucket of time, and the events it is surest about. Read the examples
 * before adopting the question; a question that counts the wrong thing shows it there first.
 */
export const backtestQuestion = async ({ events, key, question, labeler, state, bucketMs = DAY, examples = 5, ...options }: { events: readonly LabeledEvent[]; key: string; question: Question; labeler: Labeler; state?: (event: TextEvent) => Json; bucketMs?: number; examples?: number } & Options): Promise<
  Relabeled & {
    schema: Schema;
    signals: Array<{ signal: string; counts: Counts; byBucket: Array<Counts & { at: number }>; surest: LabeledEvent[] }>;
  }
> => {
  const schema = defineSchema({ name: `backtest-${key}`, questions: { [key]: question }, ...(state ? { state } : {}) });
  const result = await relabel(events, schema, labeler, options);
  const view = viewOf(result.events);
  const reader = memoryReader(result.events);
  const from = view.events[0]?.at ?? 0;
  const to = (view.events.at(-1)?.at ?? 0) + 1;
  return {
    schema,
    ...result,
    signals: await Promise.all(
      schema.signals.map(async (signal) => ({
        signal,
        counts: count(view.events, signal, schema.gates),
        byBucket: await series(reader, { signal, gates: schema.gates, from, to, bucketMs }),
        surest: [...view.events].sort((a, b) => (b.signals[signal] ?? 0) - (a.signals[signal] ?? 0)).slice(0, examples),
      })),
    ),
  };
};

/**
 * Replays monitors over stored events and says how often they would have alerted. Muted alerts
 * are in `alerts` but not in the groups or the weekly rates.
 */
export const backtestMonitors = async (options: RunnerOptions, events: readonly LabeledEvent[], range: { from: number; to: number; changes?: readonly Change[] }): Promise<{ alerts: Alert[]; groups: AlertGroup[]; pagesPerWeek: number; digestsPerWeek: number }> => {
  const { alerts, groups } = await replay(options, events, range);
  const weeks = (range.to - range.from) / WEEK;
  return { alerts, groups, pagesPerWeek: groups.filter((group) => group.severity === "page").length / weeks, digestsPerWeek: groups.filter((group) => group.severity === "digest").length / weeks };
};
