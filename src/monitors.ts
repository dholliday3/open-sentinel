// The built-in monitor kinds. Each is a plain object that satisfies `Monitor`; write your own the
// same way.
import { exposureOf } from "./changes.ts";
import { count, countUnits, EVERY, outside } from "./metrics.ts";
import type { Monitor, Severity } from "./monitor.ts";
import { compareRates } from "./stats.ts";
import type { Counts } from "./stats.ts";
import { DAY, HOUR, WEEK } from "./types.ts";
import type { Change, Interval, TagFilter } from "./types.ts";

/**
 * What a window is compared with.
 *   trailing  the span just before the window. Simple; right when the stream has no daily or
 *             weekly rhythm in what people write about.
 *   seasonal  the same window one period ago, two periods ago, and so on: the same hours last
 *             week, or the same hours yesterday. Right when Monday mornings differ from Sundays.
 */
export type Baseline = { kind: "trailing"; spanMs: number } | { kind: "seasonal"; periodMs: number; cycles: number };

const spanLabel = (ms: number): string => (ms <= DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}-day`);
const tagLabel = (where?: TagFilter): string => (where ? ` {${Object.entries(where).map(([key, value]) => `${key}:${value}`).join(",")}}` : "");

/** How much of a stretch the excluded intervals cover. Overlapping intervals are counted once. */
const covered = (range: Interval, excluded: readonly Interval[]): number => {
  let total = 0;
  let reached = range.from;
  for (const gap of [...excluded].sort((a, b) => a.from - b.from)) {
    const from = Math.max(gap.from, reached);
    const to = Math.min(gap.to, range.to);
    if (to > from) {
      total += to - from;
      reached = to;
    }
  }
  return total;
};

/**
 * The stretches a window is compared with. A trailing baseline that loses time to exclusions
 * reaches further back to make it up, by at most its own span, so leaving out a known incident
 * doesn't leave the monitor with less to compare against.
 */
const baselineRanges = (baseline: Baseline, now: number, windowMs: number, excluded: readonly Interval[]): Interval[] => {
  if (baseline.kind === "seasonal") {
    return Array.from({ length: baseline.cycles }, (_, i) => ({ from: now - (i + 1) * baseline.periodMs - windowMs, to: now - (i + 1) * baseline.periodMs }));
  }
  const range = { from: now - windowMs - baseline.spanMs, to: now - windowMs };
  for (let pass = 0; pass < 3; pass += 1) {
    const from = now - windowMs - baseline.spanMs - Math.min(baseline.spanMs, covered(range, excluded));
    if (from === range.from) {
      break;
    }
    range.from = from;
  }
  return [range];
};

export interface ShareMonitorOptions {
  signal: string;
  windowMs: number;
  baseline?: Baseline;
  /** Fewer yeses than this in the window never fires, whatever the test says. */
  minCount?: number;
  /** Fewer in the baseline than this is `no_data`. */
  minBaseline?: number;
  /**
   * What is counted. "unit" (the default) counts each customer once per window when events carry
   * a `unit` (and once per window-long stretch of the baseline), and falls back to events when
   * they don't. "event" always counts events; use it only when one writer's messages really are
   * independent of each other.
   */
  per?: "unit" | "event";
  /** The test that compares the window with its baseline. Defaults to Fisher's exact test (`compareRates`). */
  compare?: (window: Counts, baseline: Counts) => { p: number };
  severity?: Severity;
  where?: TagFilter;
  alpha?: number;
  name?: string;
}

/**
 * Is a signal's share higher in this window than in its baseline? Shares, not volumes, so a busy
 * day doesn't fire it. Both periods are treated as samples, so a quiet baseline doesn't make an
 * ordinary week look significant.
 */
export const shareMonitor = ({ signal, windowMs, baseline = { kind: "trailing", spanMs: WEEK }, minCount = 5, minBaseline = 30, per = "unit", compare = compareRates, severity = "page", where, alpha, name }: ShareMonitorOptions): Monitor => {
  const tally = per === "unit" ? countUnits : count;
  return {
    name: name ?? `${spanLabel(windowMs)} share of ${signal}${tagLabel(where)}${baseline.kind === "seasonal" ? " (seasonal)" : ""}`,
    severity,
    signal,
    ...(where ? { where } : {}),
    windowMs,
    // Twice a trailing span: it may reach that far back to replace excluded time.
    lookbackMs: windowMs + (baseline.kind === "trailing" ? 2 * baseline.spanMs : baseline.cycles * baseline.periodMs),
    tested: true,
    ...(alpha === undefined ? {} : { alpha }),
    check: (view, now, { alpha: cutoff, excluded, gates }) => {
      const current = tally(view.within({ from: now - windowMs, to: now, where }), signal, gates);
      // The baseline is counted the way the window is: in stretches the window's length, each
      // customer once per stretch. Counted once over a whole week, an account that writes every
      // day would look far more likely to say yes than it does in any one window.
      const base = { yes: 0, total: 0 };
      for (const range of baselineRanges(baseline, now, windowMs, excluded)) {
        for (let to = range.to; to > range.from; to -= windowMs) {
          const stretch = tally(outside(view.within({ from: Math.max(range.from, to - windowMs), to, where }), excluded), signal, gates);
          base.yes += stretch.yes;
          base.total += stretch.total;
        }
      }
      const detail = { now: `${current.yes}/${current.total}`, baseline: `${base.yes}/${base.total}` };
      if (current.total === 0 || base.total < minBaseline) {
        return { state: "no_data", detail };
      }
      const { p } = compare(current, base);
      return { state: current.yes >= minCount && p < cutoff ? "firing" : "ok", detail: { ...detail, p } };
    },
  };
};

/** The windows a signal is watched at by default: two that page, one for a daily digest. */
export const TIERS: ReadonlyArray<Pick<ShareMonitorOptions, "windowMs" | "severity" | "minCount">> = [
  { windowMs: 3 * HOUR, severity: "page", minCount: 5 },
  { windowMs: DAY, severity: "page", minCount: 8 },
  { windowMs: 3 * DAY, severity: "digest", minCount: 10 },
];

/** A share monitor per signal per tier. Pass `where` to watch one tag value against its own baseline. */
export const shareMonitors = ({ signals, tiers = TIERS, ...shared }: { signals: readonly string[]; tiers?: typeof TIERS } & Omit<ShareMonitorOptions, "signal" | "windowMs" | "severity" | "minCount" | "name">): Monitor[] =>
  signals.flatMap((signal) => tiers.map((tier) => shareMonitor({ signal, ...shared, ...tier })));

/**
 * One event is enough. Reports each event at or above `gate`. With `second`, an event from
 * `second.from` up to the gate also counts when a second reader agreed (see `LabelOptions.second`):
 * a decision model's answers between 0.5 and 0.9 are right too rarely to page on alone.
 *
 * It keeps reporting an event for `lateMs` after the event's own time, and the runner alerts on
 * each event once. So an event that is stored late, after the check that covered its time, still
 * pages. An event stored more than `lateMs` late does not: a backfill of old history stays quiet.
 */
export const eventMonitor = ({ signal, gate = 0.9, second, lateMs = 6 * HOUR, severity = "page", name }: { signal: string; gate?: number; second?: { from: number; gate?: number }; lateMs?: number; severity?: Severity; name?: string }): Monitor => ({
  name: name ?? `event: ${signal}`,
  severity,
  signal,
  windowMs: 0,
  lookbackMs: lateMs,
  tested: false,
  check: (view, now, { since }) => {
    const hits = view.within({ from: since - lateMs, to: now }).filter((event) => {
      const p = event.signals[signal] ?? 0;
      return p >= gate || (second !== undefined && p >= second.from && (event.signals[`${signal}.second`] ?? 0) >= (second.gate ?? 0.5));
    });
    return { state: hits.length > 0 ? "firing" : "ok", detail: {}, events: hits.map((event) => ({ id: event.id, at: event.at, detail: { p: event.signals[signal] ?? 0 } })) };
  },
});

/**
 * A guarded rollout: from the moment a scoped change ships, is the signal more common among
 * events it reached than among the rest, and more common than among their own kind before
 * (see `exposureOf`)? The alert names the change.
 *
 * Without earlier events to compare with, it answers only for a change marked `randomized`. It
 * needs volume: on a few hundred events a day it sees only large effects, so use it beside share
 * monitors, not instead.
 */
export const exposureMonitor = ({ change, signal, forMs = WEEK, minCount = 3, severity = "page", alpha, name }: { change: Change; signal: string; forMs?: number; minCount?: number; severity?: Severity; alpha?: number; name?: string }): Monitor => {
  if (!change.scope) {
    throw new Error(`Change "${change.id}" has no scope, so nothing says which events it reached`);
  }
  return {
    name: name ?? `${signal} among events exposed to ${change.id}`,
    severity,
    signal,
    windowMs: forMs,
    lookbackMs: forMs + WEEK,
    tested: true,
    ...(alpha === undefined ? {} : { alpha }),
    check: (view, now, { alpha: cutoff, gates }) => {
      if (now < change.at || now > change.at + forMs) {
        return { state: "ok", detail: {} };
      }
      const found = exposureOf(view, change, { signal, gates, until: now });
      if (!found) {
        return { state: "ok", detail: {} };
      }
      const { exposed, unexposed, contrast, rise } = found;
      const detail = { change: change.id, exposed: `${exposed.yes}/${exposed.total}`, unexposed: `${unexposed.yes}/${unexposed.total}`, ...(rise ? { before: `${rise.before.yes}/${rise.before.total}` } : {}), p: contrast.p };
      if (exposed.total === 0 || unexposed.total === 0) {
        return { state: "no_data", detail };
      }
      if (!rise && !change.randomized) {
        return { state: "no_data", detail: { ...detail, why: "No earlier events like the exposed ones to compare with, and the change isn't marked randomized." } };
      }
      const rose = rise === null || rise.evidence > 2;
      return { state: exposed.yes >= minCount && contrast.p < cutoff && rose ? "firing" : "ok", detail };
    },
  };
};

/**
 * Total events in a window against the same window one period earlier. Not a statistical test,
 * and it can't tell a launch from an outage; it is here for the case shares can't see, when
 * everything rises together. It watches the signal `*`, so a planned change can expect it.
 */
export const volumeMonitor = ({ windowMs, factor = 2, minCount = 20, periodMs = WEEK, severity = "page", name }: { windowMs: number; factor?: number; minCount?: number; periodMs?: number; severity?: Severity; name?: string }): Monitor => ({
  name: name ?? "event volume",
  severity,
  signal: EVERY,
  windowMs,
  lookbackMs: periodMs + windowMs,
  tested: false,
  check: (view, now) => {
    const current = view.within({ from: now - windowMs, to: now }).length;
    const before = view.within({ from: now - periodMs - windowMs, to: now - periodMs }).length;
    return { state: current >= minCount && current > factor * Math.max(before, 1) ? "firing" : "ok", detail: { now: current, before } };
  },
});

/**
 * Nothing arrived. Fires when a window has no events at all and the same window one period
 * earlier had at least `minBefore`. Share monitors can't see this: with no events they have
 * nothing to judge, and say `no_data`. A stream that stops is its own alert.
 */
export const silenceMonitor = ({ windowMs, minBefore = 5, periodMs = WEEK, severity = "page", name }: { windowMs: number; minBefore?: number; periodMs?: number; severity?: Severity; name?: string }): Monitor => ({
  name: name ?? "no events",
  severity,
  signal: EVERY,
  windowMs,
  lookbackMs: periodMs + windowMs,
  tested: false,
  check: (view, now) => {
    const current = view.within({ from: now - windowMs, to: now }).length;
    const before = view.within({ from: now - periodMs - windowMs, to: now - periodMs }).length;
    return { state: current === 0 && before >= minBefore ? "firing" : "ok", detail: { now: current, before } };
  },
});
