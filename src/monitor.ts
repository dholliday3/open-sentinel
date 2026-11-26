// A monitor is one question asked of the recent past on a schedule: "is anything wrong here?"
// The runner asks every monitor at each tick, keeps false alerts within a weekly budget, raises
// one alert per episode, and mutes what a planned change predicted. Implement `Monitor` to add a
// new kind; the built-in kinds are in monitors.ts.
import type { EventView } from "./metrics.ts";
import { memoryReader, viewWithin } from "./reader.ts";
import type { Reader } from "./reader.ts";
import { alphaFor } from "./stats.ts";
import { DAY, HOUR, WEEK } from "./types.ts";
import type { Change, Gates, Interval, LabeledEvent, TagFilter } from "./types.ts";

/** A page interrupts someone now. A digest item waits for a daily read. */
export type Severity = "page" | "digest";

export interface CheckContext {
  /** The cutoff a tested monitor's p-value must beat: its own `alpha`, or its share of the alarm budget. */
  alpha: number;
  /** When the previous check ran. */
  since: number;
  /** Stretches to leave out of baselines: planned changes, and incidents already known. */
  excluded: readonly Interval[];
  gates: Gates;
  /** The changes known at this moment, oldest first. */
  changes: readonly Change[];
}

export interface CheckResult {
  /** `no_data`: too little to judge. Returned by `tick`, never alerted, and it never ends an episode. */
  state: "ok" | "firing" | "no_data";
  detail: Record<string, unknown>;
  /**
   * For monitors where each event is its own alert. A monitor may report the same event on later
   * checks (to catch one that was stored late); the runner alerts on each event once.
   */
  events?: Array<{ id: string; at: number; detail?: Record<string, unknown> }>;
}

export interface Monitor {
  /** Unique among the monitors of one runner: it identifies the monitor's episodes. */
  readonly name: string;
  readonly severity: Severity;
  /** The signal it watches, for mutes and for finding the change behind an alert. */
  readonly signal?: string;
  readonly where?: TagFilter;
  /** How far back one check reads. */
  readonly lookbackMs: number;
  /** The stretch a firing check is about. */
  readonly windowMs: number;
  /** True when a check is a statistical test. Tested monitors share the alarm budget. */
  readonly tested: boolean;
  /** A fixed cutoff, for a tested monitor that should not take its share of the budget. */
  readonly alpha?: number;
  /**
   * Reads through `reader`: counts where the events are kept, and events in small bounded
   * amounts. The checks of one tick run together, and their counts go to the store together.
   */
  check(reader: Reader, now: number, context: CheckContext): CheckResult | Promise<CheckResult>;
}

/** A monitor written for 0.1, whose `check` was handed a view of every event in the watch's lookback. */
export interface ViewMonitor extends Omit<Monitor, "check"> {
  check(view: EventView, now: number, context: CheckContext): CheckResult | Promise<CheckResult>;
}

/**
 * Runs a monitor written for 0.1 on a reader. Before each check it reads the events of the
 * monitor's own `lookbackMs` through the reader (with the reader's labeler and `where`) and hands
 * them to `check` as a view. Every event in that stretch is read into memory each check, so it
 * costs what `check` cost before 0.2; rewrite a monitor with a long lookback to count through the
 * reader instead.
 */
export const viewMonitor = (monitor: ViewMonitor): Monitor => ({
  name: monitor.name,
  severity: monitor.severity,
  ...(monitor.signal === undefined ? {} : { signal: monitor.signal }),
  ...(monitor.where === undefined ? {} : { where: monitor.where }),
  lookbackMs: monitor.lookbackMs,
  windowMs: monitor.windowMs,
  tested: monitor.tested,
  ...(monitor.alpha === undefined ? {} : { alpha: monitor.alpha }),
  check: async (reader, now, context) => monitor.check(await viewWithin(reader, { from: now - monitor.lookbackMs, to: now }), now, context),
});

export interface Alert {
  /**
   * Stable for this alert, so a sink that is told twice can tell. A one-event alert is named for
   * its monitor and event; any other for its monitor and the step it fired in (`at` rounded down
   * to `stepMs`), so a tick that runs twice in one step, by a retried or doubled cron job, raises
   * the same id.
   */
  id: string;
  monitor: string;
  severity: Severity;
  signal?: string;
  where?: TagFilter;
  /** When the check that raised it ran. */
  at: number;
  /** The stretch it is about. */
  windowMs: number;
  /** For a one-event alert, the event. */
  event?: { id: string; at: number };
  detail: Record<string, unknown>;
  /** The planned change that predicted it. A muted alert is kept on record and should not notify anyone. */
  mutedBy?: string;
}

export interface RunnerOptions {
  monitors: readonly Monitor[];
  gates?: Gates;
  /** How often `tick` is called. The alarm budget is spread over every check made in a week. */
  stepMs?: number;
  /** Expected false alerts a week you accept, from chance alone, across all tested monitors of each severity. */
  budget?: { pagesPerWeek?: number; digestsPerWeek?: number };
  /** A monitor that fired stays one episode until it has been clear this long. */
  rearmMs?: { page?: number; digest?: number };
  /**
   * Leave each page's own stretch out of later baselines, for at most this long. Off by default:
   * it lets a recurrence stand out, but a false page then lowers its own baseline.
   */
  excludePagesMs?: number;
  /** What an earlier runner's `snapshot()` returned, to carry on after a restart. */
  snapshot?: RunnerSnapshot;
}

/** Everything a runner remembers between ticks. Plain data: store it anywhere. */
export interface RunnerSnapshot {
  since: number | null;
  /**
   * Episodes still open, by monitor name, each with the alert that opened it. `lastAt` is the
   * last check that didn't find the monitor clear: it was firing, or had too little to judge.
   */
  open: Record<string, { firstAt: number; lastAt: number; alert: Alert }>;
  excluded: Interval[];
  /** One-event alerts already raised, and each event's time, so a late event is alerted once. */
  alerted: Record<string, number>;
}

export interface Tick {
  fired: Alert[];
  /** Episodes that ended: the alert that opened each. */
  resolved: Alert[];
  /** Monitors that had too little to judge. */
  noData: string[];
}

export interface Runner {
  tick(reader: Reader, now: number, changes?: readonly Change[]): Promise<Tick>;
  /** The cutoff a monitor is held to. */
  alphaOf(monitor: Monitor): number;
  /** Leaves a stretch out of every baseline from now on: an incident someone confirmed. */
  exclude(interval: Interval): void;
  snapshot(): RunnerSnapshot;
}

export const createRunner = ({ monitors, gates = {}, stepMs = HOUR, budget = {}, rearmMs = {}, excludePagesMs = 0, snapshot }: RunnerOptions): Runner => {
  const names = new Set<string>();
  for (const monitor of monitors) {
    if (names.has(monitor.name)) {
      throw new Error(`Two monitors are named "${monitor.name}". Each needs its own name: it identifies the monitor's episodes.`);
    }
    names.add(monitor.name);
  }
  const perWeek = { page: budget.pagesPerWeek ?? 0.25, digest: budget.digestsPerWeek ?? 1 };
  const rearm = { page: rearmMs.page ?? 12 * HOUR, digest: rearmMs.digest ?? 3 * DAY };
  const sharing = (severity: Severity): number => monitors.filter((m) => m.tested && m.alpha === undefined && m.severity === severity).length;
  const shared = { page: alphaFor({ perWeek: perWeek.page, checksPerWeek: WEEK / stepMs, monitors: sharing("page") }), digest: alphaFor({ perWeek: perWeek.digest, checksPerWeek: WEEK / stepMs, monitors: sharing("digest") }) };
  const alphaOf = (monitor: Monitor): number => monitor.alpha ?? shared[monitor.severity];
  // An event older than this can't be reported again by any monitor, so its alert can be forgotten.
  const forgetAfter = Math.max(0, ...monitors.map((monitor) => monitor.lookbackMs)) + 2 * stepMs;

  let since = snapshot?.since ?? null;
  const open = new Map(Object.entries(snapshot?.open ?? {}));
  const alerted = new Map(Object.entries(snapshot?.alerted ?? {}));
  const excluded: Interval[] = [...(snapshot?.excluded ?? [])];
  const ownStretch = new Map<string, Interval>();

  return {
    alphaOf,
    exclude: (interval) => {
      excluded.push(interval);
    },
    snapshot: () => ({ since, open: Object.fromEntries(open), excluded: [...excluded, ...ownStretch.values()], alerted: Object.fromEntries(alerted) }),
    tick: async (reader, now, changes = []) => {
      const planned = changes.filter((change) => change.expect !== undefined).map((change) => ({ change, from: change.at, to: change.at + change.expect!.forMs }));
      const context = { since: since ?? now - stepMs, excluded: [...excluded, ...ownStretch.values(), ...planned], gates, changes };
      const tick: Tick = { fired: [], resolved: [], noData: [] };
      const stepId = (monitor: Monitor): string => `${monitor.name}@${Math.floor(now / stepMs) * stepMs}`;
      // Muted while the stretch the alert is about overlaps the stretch a change predicted.
      const mutedBy = (monitor: Monitor): string | undefined =>
        planned.find((plan) => monitor.signal !== undefined && plan.change.expect!.signals.includes(monitor.signal) && now >= plan.from && now - monitor.windowMs < plan.to)?.change.id;
      const raise = (monitor: Monitor, alert: Pick<Alert, "id" | "detail" | "event">): Alert => {
        const muting = mutedBy(monitor);
        const raised: Alert = {
          id: alert.id,
          monitor: monitor.name,
          severity: monitor.severity,
          ...(monitor.signal === undefined ? {} : { signal: monitor.signal }),
          ...(monitor.where === undefined ? {} : { where: monitor.where }),
          at: now,
          windowMs: monitor.windowMs,
          detail: alert.detail,
          ...(alert.event ? { event: alert.event } : {}),
          ...(muting === undefined ? {} : { mutedBy: muting }),
        };
        tick.fired.push(raised);
        return raised;
      };
      // Asked together, so the counts they need reach the store as a few queries, not one each.
      const results = await Promise.all(monitors.map((monitor) => monitor.check(reader, now, { ...context, alpha: alphaOf(monitor) })));
      for (const [i, monitor] of monitors.entries()) {
        const result = results[i]!;
        if (result.state === "no_data") {
          // Not knowing is not the same as being clear: an open episode stays open, and time
          // without data doesn't count toward ending it.
          tick.noData.push(monitor.name);
          const unknown = open.get(monitor.name);
          if (unknown) {
            unknown.lastAt = now;
          }
          continue;
        }
        if (result.events) {
          for (const event of result.events) {
            const key = `${monitor.name}\n${event.id}`;
            if (!alerted.has(key)) {
              alerted.set(key, event.at);
              raise(monitor, { id: `${monitor.name}@${event.id}`, detail: { ...result.detail, ...event.detail }, event: { id: event.id, at: event.at } });
            }
          }
          continue;
        }
        const episode = open.get(monitor.name);
        if (episode && now - episode.lastAt > rearm[monitor.severity]) {
          open.delete(monitor.name);
          tick.resolved.push(episode.alert);
        }
        if (result.state !== "firing") {
          continue;
        }
        const current = open.get(monitor.name);
        if (!current) {
          open.set(monitor.name, { firstAt: now, lastAt: now, alert: raise(monitor, { id: stepId(monitor), detail: result.detail }) });
        } else {
          current.lastAt = now;
          if (current.alert.mutedBy !== undefined && mutedBy(monitor) === undefined) {
            // It opened inside a planned stretch and is still firing after it: no longer what was planned.
            current.alert = raise(monitor, { id: stepId(monitor), detail: result.detail });
          }
        }
        if (excludePagesMs > 0 && monitor.severity === "page" && monitor.tested) {
          const from = (open.get(monitor.name)?.firstAt ?? now) - monitor.windowMs;
          ownStretch.set(monitor.name, { from, to: Math.min(now, from + excludePagesMs) });
        }
      }
      for (const [key, at] of alerted) {
        if (at < now - forgetAfter) {
          alerted.delete(key);
        }
      }
      since = now;
      return tick;
    },
  };
};

/** Related alerts as one thing to look at: what on-call tools call a case. */
export interface AlertGroup {
  id: string;
  severity: Severity;
  firstAt: number;
  lastAt: number;
  alerts: Alert[];
}

/**
 * Groups alerts that fire close together: pages within `pageGapMs` of each other, digest items
 * within `digestGapMs`. A one-event alert always stands alone, and muted alerts are left out.
 */
export const groupAlerts = (alerts: readonly Alert[], { pageGapMs = 4 * HOUR, digestGapMs = DAY }: { pageGapMs?: number; digestGapMs?: number } = {}): AlertGroup[] => {
  const groups: AlertGroup[] = [];
  for (const severity of ["page", "digest"] as const) {
    const gap = severity === "page" ? pageGapMs : digestGapMs;
    // The group a share alert may join. A one-event alert in between doesn't break it up.
    let joinable: AlertGroup | undefined;
    let n = 0;
    for (const alert of alerts.filter((a) => a.severity === severity && a.mutedBy === undefined).sort((a, b) => a.at - b.at)) {
      if (!alert.event && joinable && alert.at - joinable.lastAt <= gap) {
        joinable.alerts.push(alert);
        joinable.lastAt = alert.at;
        continue;
      }
      n += 1;
      const group: AlertGroup = { id: `${severity}-${n}`, severity, firstAt: alert.at, lastAt: alert.at, alerts: [alert] };
      groups.push(group);
      if (!alert.event) {
        joinable = group;
      }
    }
  }
  return groups;
};

/** Runs the monitors over history, one tick per step: every alert they would have raised. */
export const replay = async (options: RunnerOptions, events: readonly LabeledEvent[], { from, to, changes = [] }: { from: number; to: number; changes?: readonly Change[] }): Promise<{ alerts: Alert[]; resolved: Alert[]; groups: AlertGroup[] }> => {
  const runner = createRunner({ ...options, snapshot: { since: from, open: {}, excluded: options.snapshot?.excluded ?? [], alerted: {} } });
  const reader = memoryReader(events);
  const step = options.stepMs ?? HOUR;
  const alerts: Alert[] = [];
  const resolved: Alert[] = [];
  for (let now = from + step; now <= to; now += step) {
    // A change is only known once it has happened.
    const tick = await runner.tick(reader, now, changes.filter((change) => change.at <= now));
    alerts.push(...tick.fired);
    resolved.push(...tick.resolved);
  }
  return { alerts, resolved, groups: groupAlerts(alerts) };
};
