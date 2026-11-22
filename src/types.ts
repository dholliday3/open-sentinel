// The shapes everything else passes around. Times are epoch milliseconds.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * What an event was written under: `version`, `platform`, `plan`, `env`, `service`, and flag state
 * as `flag:<key>`. Monitors split by tags and attribution joins on them, so stamp them when the
 * event is written; they can't be recovered later.
 */
export type Tags = Record<string, string | null>;

/** One piece of text to label: a message, a review, a transcript turn. */
export interface TextEvent {
  id: string;
  at: number;
  text: string;
  /** Anything else the labeler should see beside the text: the message being replied to, the channel. */
  context?: Record<string, Json>;
  /** Who it is from: the customer or account id that exposure and experiments join on. */
  unit?: string;
  tags?: Tags;
}

/** Where a labeler's probabilities come from: the model itself, a model's own guess, or hard labels only. */
export type ProbabilitySource = "native" | "prompted" | "none";

/**
 * A text event with its answers. `signals` holds one probability per signal key: `blocked`,
 * `area=login`, `frustration>=2`. `text` may be dropped by a store that must not keep it; an
 * event without text can't be relabeled.
 */
export interface LabeledEvent extends Omit<TextEvent, "text"> {
  text?: string;
  /** `<schema name>@<version>`: the exact wording that was asked. */
  schema: string;
  /** The model and exact version that answered. */
  labeler: string;
  probability: ProbabilitySource;
  signals: Record<string, number>;
}

/** Tags an event must carry, each with this exact value, to be included. */
export type TagFilter = Readonly<Record<string, string>>;

/** The cutoff at which each signal counts as yes. Missing keys use 0.5. */
export type Gates = Record<string, number>;

export interface Interval {
  from: number;
  to: number;
}

/**
 * Something that changed: a deploy, a flag, a config edit, an app release, an email to customers.
 */
export interface Change {
  id: string;
  at: number;
  kind: "deploy" | "flag" | "config" | "release" | "campaign" | "other";
  what: string;
  /** Where to look: repository, commit range, pull request, flag key. */
  ref?: Record<string, string>;
  /** Which events are exposed, as tags they carry: `{ version: "4.12.0" }`, `{ "flag:pdf-v2": "on" }`. */
  scope?: TagFilter;
  /**
   * True when who is exposed was picked at random (a percentage rollout). Exposed and unexposed
   * events are then comparable as they are. Otherwise the exposed group is also checked against
   * events like it from before the change, because a group can differ for reasons of its own.
   */
  randomized?: boolean;
  /**
   * A planned effect: these signals are expected to rise for this long. Their alerts are muted and
   * the stretch is left out of every baseline. Include `*` when total volume will rise too.
   */
  expect?: { signals: string[]; forMs: number };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
