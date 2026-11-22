// Tying a shift in a signal to the change that caused it. Reads only events and a change log, so
// it works on signals from any source. Three kinds of evidence exist; this file does two of them:
//   exposure  is the signal more common among events the change reached? (needs `scope`)
//   time      did the change land just before the shift began?
// The third, whether the messages describe what the change touched, needs a reader: see
// investigate.ts.
import { count, countUnits, EVERY, hasTags, wholeStretches } from "./metrics.ts";
import type { EventView } from "./metrics.ts";
import type { Alert } from "./monitor.ts";
import { compareRates, logLik } from "./stats.ts";
import type { Counts } from "./stats.ts";
import { DAY, HOUR, WEEK } from "./types.ts";
import type { Change, Gates, LabeledEvent, TagFilter } from "./types.ts";

/** When a shift began, as far as the counts can say. */
export interface Onset {
  /** The single most likely start. */
  at: number;
  /** The earliest and latest starts nearly as likely. A slow ramp gives a wide range. */
  low: number;
  high: number;
  bucketMs: number;
  /** Every candidate start with its share of the belief. */
  splits: Array<{ at: number; weight: number }>;
}

/**
 * Finds when a signal's share stepped up: the split of the lookback that best explains the counts
 * as one rate before and a higher rate after. Null when no split shows a rise.
 */
export const estimateOnset = (view: EventView, { signal, gates, where, until, lookbackMs, bucketMs = HOUR }: { signal: string; gates?: Gates; where?: TagFilter; until: number; lookbackMs: number; bucketMs?: number }): Onset | null => {
  const buckets = [];
  for (let at = until - lookbackMs; at < until; at += bucketMs) {
    buckets.push({ at, ...count(view.within({ from: at, to: at + bucketMs, where }), signal, gates) });
  }
  const all = buckets.reduce((sum, b) => ({ yes: sum.yes + b.yes, total: sum.total + b.total }), { yes: 0, total: 0 });
  const splits = [];
  let left = { yes: 0, total: 0 };
  for (let i = 1; i < buckets.length; i += 1) {
    left = { yes: left.yes + buckets[i - 1]!.yes, total: left.total + buckets[i - 1]!.total };
    const right = { yes: all.yes - left.yes, total: all.total - left.total };
    if (left.total > 0 && right.total > 0 && right.yes / right.total > left.yes / left.total) {
      splits.push({ at: buckets[i]!.at, gain: logLik(left.yes, left.total) + logLik(right.yes, right.total) - logLik(all.yes, all.total) });
    }
  }
  if (splits.length === 0) {
    return null;
  }
  const best = splits.reduce((a, b) => (b.gain > a.gain ? b : a));
  const near = splits.filter((split) => split.gain >= best.gain - 2);
  const mass = splits.reduce((sum, split) => sum + Math.exp(split.gain - best.gain), 0);
  return {
    at: best.at,
    low: Math.min(...near.map((split) => split.at)),
    high: Math.max(...near.map((split) => split.at)),
    bucketMs,
    splits: splits.map((split) => ({ at: split.at, weight: Math.exp(split.gain - best.gain) / mass })),
  };
};

/** One event: the shift "began" when it arrived. */
export const onsetOfEvent = (at: number): Onset => ({ at, low: at, high: at, bucketMs: 0, splits: [{ at, weight: 1 }] });

/** What comparing the events a change reached with the rest shows. Counts are per customer when events carry a `unit`. */
export interface Exposure {
  /** Since the change: the events it reached, and the rest. */
  exposed: Counts;
  unexposed: Counts;
  /** Is the signal more common among the events it reached than among the rest? */
  contrast: { p: number; evidence: number };
  /**
   * Is it more common among them than among events like them before the change? Null when too
   * few earlier events are like them to say.
   */
  rise: { before: Counts; evidence: number } | null;
  /**
   * What the comparison is worth as evidence that the change is the cause: the weaker of
   * `contrast` and `rise`. With no `rise` to check, the contrast alone counts only for a change
   * marked `randomized`; otherwise 0, because the exposed group may simply be a different kind
   * of customer.
   */
  evidence: number;
}

/** Earlier events are "like" an exposed event when they share its other tags; fewer than this is too few to compare. */
const MIN_EARLIER = 5;

const kindsOf = (events: readonly LabeledEvent[], scoped: ReadonlySet<string>): Map<string, LabeledEvent[]> => {
  const kinds = new Map<string, LabeledEvent[]>();
  for (const event of events) {
    const kind = JSON.stringify(Object.entries(event.tags ?? {}).filter(([key]) => !scoped.has(key)).sort(([a], [b]) => (a < b ? -1 : 1)));
    kinds.set(kind, [...(kinds.get(kind) ?? []), event]);
  }
  return kinds;
};

/**
 * Compares the events a scoped change reached with the rest, and with their own kind before it.
 *
 * "Their own kind before": if the scope's tags existed before the change (a platform, a plan),
 * the same group's earlier events. If they didn't (a new version, a new flag), all earlier events.
 * Either way, matched on every other tag, so iOS events are compared with earlier iOS events. A
 * group that always complained more then shows no rise, and gets no blame.
 *
 * Earlier time is counted in whole stretches as long as the time since the change, each customer
 * once per stretch, so "before" and "since" count the same thing: as many as fit in `baselineMs`
 * before the change and after the first stored event. When none fit, or only a few earlier
 * events carry the scope's tags (a tester who had the flag early), there is too little to compare
 * with and the answer is that it can't say.
 */
export const exposureOf = (view: EventView, change: Change, { signal, gates, where, until, baselineMs = WEEK }: { signal: string; gates?: Gates; where?: TagFilter; until: number; baselineMs?: number }): Exposure | null => {
  if (!change.scope) {
    return null;
  }
  const reached = hasTags(change.scope);
  const scoped = new Set(Object.keys(change.scope));
  const since = view.within({ from: change.at, to: until, where });
  const after = since.filter(reached);
  const exposed = countUnits(after, signal, gates);
  const unexposed = countUnits(since.filter((event) => !reached(event)), signal, gates);
  const contrast = compareRates(exposed, unexposed);

  const start = change.at - baselineMs;
  const existed = view.within({ from: start, to: change.at, where }).some(reached);
  const span = Math.max(until - change.at, HOUR);
  const earlier = new Map<string, Counts>();
  for (const range of wholeStretches({ end: change.at, lengthMs: span, count: Infinity, earliest: Math.max(start, view.events[0]?.at ?? change.at) })) {
    const stretch = view.within({ ...range, where });
    for (const [kind, events] of kindsOf(existed ? stretch.filter(reached) : stretch, scoped)) {
      const counted = countUnits(events, signal, gates);
      const sum = earlier.get(kind) ?? { yes: 0, total: 0 };
      earlier.set(kind, { yes: sum.yes + counted.yes, total: sum.total + counted.total });
    }
  }
  const before = { yes: 0, total: 0 };
  let gain = 0;
  let matched = 0;
  for (const [kind, events] of kindsOf(after, scoped)) {
    const was = earlier.get(kind);
    if (was && was.total >= MIN_EARLIER) {
      gain += compareRates(countUnits(events, signal, gates), was).evidence;
      matched += events.length;
      before.yes += was.yes;
      before.total += was.total;
    }
  }
  // At least half the exposed events need an earlier kind to compare with, or the check says little.
  const rise = after.length > 0 && matched >= after.length / 2 ? { before, evidence: gain } : null;
  return { exposed, unexposed, contrast, rise, evidence: rise ? Math.min(contrast.evidence, rise.evidence) : change.randomized ? contrast.evidence : 0 };
};

export interface Suspect {
  change: Change;
  /** 0 to 1: how well the change's time fits when the shift began. */
  time: number;
  /** What exposure shows. Null when the change has no scope. */
  exposure: Exposure | null;
  score: number;
}

/**
 * Ranks the changes that could explain a shift.
 *   time      over every moment the shift may have begun, weighted by how likely that moment is:
 *             nothing if the change came after it, otherwise halved for every `halfLifeMs` before.
 *   exposure  see `exposureOf`: positive when the events a change reached show the signal more
 *             than the rest and more than their own kind did before.
 * `confident` needs a clear lead over the runner-up, and either exposure evidence or a sharp start
 * the change sits just before. One event, or a slow ramp, never gives a confident match on time
 * alone. Treat the top suspect as a lead to check, not a verdict.
 */
export const rankChanges = (view: EventView, changes: readonly Change[], { signal, gates, where, onset, until, halfLifeMs = 6 * HOUR, single = false }: { signal: string; gates?: Gates; where?: TagFilter; onset: Onset; until: number; halfLifeMs?: number; single?: boolean }): { ranked: Suspect[]; confident: boolean } => {
  const ranked = changes
    .map((change): Suspect => {
      const time = onset.splits.reduce((sum, split) => sum + (change.at < split.at + onset.bucketMs ? split.weight * 2 ** (-Math.max(0, split.at - change.at) / halfLifeMs) : 0), 0);
      const exposure = exposureOf(view, change, { signal, gates, where, until });
      return { change, time, exposure, score: Math.log(time) + (exposure?.evidence ?? 0) };
    })
    .filter((suspect) => suspect.time > 0)
    .sort((a, b) => b.score - a.score);
  const [top, next] = ranked;
  const sharp = !single && onset.high - onset.low <= 3 * HOUR;
  const confident = top !== undefined && top.score - (next?.score ?? -Infinity) >= Math.log(3) && ((top.exposure?.evidence ?? 0) > 2 || (sharp && top.time >= 0.5));
  return { ranked, confident };
};

/** The changes that could be behind an alert, ranked. Null for an alert with no signal to trace. */
export const suspectsFor = (alert: Alert, view: EventView, changes: readonly Change[], { gates, lookbackMs = 10 * DAY }: { gates?: Gates; lookbackMs?: number } = {}): { onset: Onset; ranked: Suspect[]; confident: boolean } | null => {
  if (alert.signal === undefined || alert.signal === EVERY) {
    return null;
  }
  const known = changes.filter((change) => change.at <= alert.at);
  if (alert.event) {
    const onset = onsetOfEvent(alert.event.at);
    return { onset, ...rankChanges(view, known, { signal: alert.signal, gates, onset, until: alert.at, single: true }) };
  }
  const first = view.events[0]?.at ?? alert.at;
  const onset = estimateOnset(view, { signal: alert.signal, gates, where: alert.where, until: alert.at, lookbackMs: Math.min(lookbackMs, alert.at - first) });
  return onset ? { onset, ...rankChanges(view, known, { signal: alert.signal, gates, where: alert.where, onset, until: alert.at }) } : null;
};
