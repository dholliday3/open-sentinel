// A schema is a fixed set of typed questions asked of every event. Its version is a hash of the
// wording, so answers to two different questions can never be counted as one metric.
import { createHash } from "node:crypto";
import type { Gates, Json, TextEvent } from "./types.ts";

export type Question =
  | { type: "boolean"; ask: string; yes?: string; no?: string; gate?: number }
  | { type: "choice"; ask: string; options: Readonly<Record<string, string>> }
  | { type: "score"; ask: string; levels: readonly string[] };

/** A question as decision models take it (the AI SDK's DecisionModelV4 question). */
export type WireQuestion =
  | { type: "boolean"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** One answer as decision models give it. */
export type Answer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> };

/** A yes/no question. `yes` and `no` describe each answer; `gate` is the cutoff when 0.5 is wrong. */
export const yesNo = (ask: string, options: { yes?: string; no?: string; gate?: number } = {}): Question => ({ type: "boolean", ask, ...options });

/** Pick one: option key to what it means. Add an "other" option when none may fit. */
export const choice = (ask: string, options: Record<string, string>): Question => ({ type: "choice", ask, options });

/** Ordered levels, lowest first. */
export const score = (ask: string, levels: readonly string[]): Question => ({ type: "score", ask, levels });

export interface Schema {
  readonly name: string;
  readonly version: string;
  /** `<name>@<version>`, stored on every labeled event. */
  readonly id: string;
  readonly questions: Readonly<Record<string, Question>>;
  readonly wire: Readonly<Record<string, WireQuestion>>;
  /** Every signal key the questions produce. */
  readonly signals: readonly string[];
  /** Default cutoffs: 0.5, or a yes/no question's own `gate`. */
  readonly gates: Gates;
  /** What the labeler is shown for one event. */
  state(event: TextEvent): Json;
  /** Answers to signals: `key` for yes/no, `key=option` for a choice, `key>=n` for a score. Throws on an answer outside the contract. */
  read(answers: Readonly<Record<string, unknown>>): Record<string, number>;
}

const RESERVED = /[&=>.]/;

const toWire = (question: Question): WireQuestion => {
  if (question.type === "boolean") {
    const criteria = { ...(question.yes ? { true: question.yes } : {}), ...(question.no ? { false: question.no } : {}) };
    return { type: "boolean", instructions: question.ask, ...(Object.keys(criteria).length > 0 ? { criteria } : {}) };
  }
  if (question.type === "choice") {
    return { type: "choice", instructions: question.ask, criteria: { ...question.options } };
  }
  return { type: "score", instructions: question.ask, criteria: [...question.levels] };
};

const signalsOf = (key: string, question: Question): string[] => {
  if (question.type === "boolean") {
    return [key];
  }
  if (question.type === "choice") {
    return Object.keys(question.options).map((option) => `${key}=${option}`);
  }
  return question.levels.slice(1).map((_, i) => `${key}>=${i + 1}`);
};

const probabilityOf = (key: string, value: unknown): number => {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    throw new Error(`The answer to "${key}" has no probability between 0 and 1: ${JSON.stringify(value ?? null)}`);
  }
  return value;
};

const readOne = (key: string, question: Question, answer: unknown): Array<[string, number]> => {
  const given = (answer ?? {}) as { type?: string; probability?: unknown; choice?: unknown; score?: unknown; probabilities?: Record<string, unknown> };
  if (given.type !== question.type) {
    throw new Error(`"${key}" was asked as ${question.type} and answered as ${JSON.stringify(given.type ?? null)}`);
  }
  if (question.type === "boolean") {
    return [[key, probabilityOf(key, given.probability)]];
  }
  if (question.type === "choice") {
    const options = Object.keys(question.options);
    if (typeof given.choice !== "string" || !options.includes(given.choice)) {
      throw new Error(`The answer to "${key}" isn't one of its options: ${JSON.stringify(given.choice ?? null)}`);
    }
    // A labeler with no distribution gives all its weight to the option it picked.
    return options.map((option) => [`${key}=${option}`, given.probabilities ? probabilityOf(`${key}=${option}`, given.probabilities[option] ?? 0) : option === given.choice ? 1 : 0]);
  }
  if (typeof given.score !== "number" || !(given.score >= 0 && given.score <= question.levels.length - 1)) {
    throw new Error(`The answer to "${key}" isn't one of its levels: ${JSON.stringify(given.score ?? null)}`);
  }
  const { score: level, probabilities } = given;
  return question.levels.slice(1).map((_, i) => {
    const at = i + 1;
    if (!probabilities) {
      return [`${key}>=${at}`, Math.round(level as number) >= at ? 1 : 0];
    }
    const above = Object.entries(probabilities).reduce((sum, [l, p]) => sum + (Number(l) >= at ? probabilityOf(`${key}>=${at}`, p) : 0), 0);
    return [`${key}>=${at}`, Math.min(1, above)];
  });
};

/**
 * Defines a schema. `state` chooses what the labeler sees; by default the event's context plus its
 * text as `message`. Keep it small: text the question doesn't need lowers accuracy.
 *
 * The version covers the questions' wording, not `state`. If you change what the labeler is
 * shown, change the schema's name too, or old and new answers will be counted as one metric.
 */
export const defineSchema = ({ name, questions, state }: { name: string; questions: Record<string, Question>; state?: (event: TextEvent) => Json }): Schema => {
  for (const [key, question] of Object.entries(questions)) {
    if (RESERVED.test(key)) {
      throw new Error(`Question key "${key}" uses one of & = > . which signal keys reserve`);
    }
    if (question.type === "choice" && (Object.keys(question.options).length === 0 || Object.keys(question.options).some((option) => RESERVED.test(option)))) {
      throw new Error(`"${key}" needs at least one option, and option keys can't use & = > .`);
    }
    if (question.type === "score" && question.levels.length < 2) {
      throw new Error(`"${key}" needs at least two levels`);
    }
  }
  const wire = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, toWire(question)]));
  const version = createHash("sha256").update(JSON.stringify(wire)).digest("hex").slice(0, 10);
  const signals = Object.entries(questions).flatMap(([key, question]) => signalsOf(key, question));
  const gates = Object.fromEntries(signals.map((signal) => [signal, 0.5]));
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === "boolean" && question.gate !== undefined) {
      gates[key] = question.gate;
    }
  }
  return {
    name,
    version,
    id: `${name}@${version}`,
    questions,
    wire,
    signals,
    gates,
    state: state ?? ((event) => ({ ...event.context, message: event.text })),
    read: (answers) => Object.fromEntries(Object.entries(questions).flatMap(([key, question]) => readOne(key, question, answers[key]))),
  };
};

/** Every pair of one signal from each list, as "both are yes" keys: `is_bug&area=login`. */
export const both = (left: readonly string[], right: readonly string[]): string[] => left.flatMap((a) => right.map((b) => `${a}&${b}`));
