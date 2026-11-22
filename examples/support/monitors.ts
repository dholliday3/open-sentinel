// The monitors the support example watches with.
import { both, eventMonitor, HOUR, shareMonitors, volumeMonitor } from "../../src/index.ts";
import type { LabeledEvent, Monitor, ShareMonitorOptions } from "../../src/index.ts";
import { support } from "./schema.ts";

const AREAS = support.signals.filter((signal) => signal.startsWith("area="));

/**
 * Every signal at three windows; bug reports and clear frustration per product area; bug reports
 * and "blocked" within each platform and app version, each against its own baseline; total
 * volume; and one-event pages for a data exposure.
 */
export const supportMonitors = (events: readonly LabeledEvent[], shared: Pick<ShareMonitorOptions, "minBaseline" | "baseline" | "compare" | "per"> = {}, alphas?: { page: number; digest: number }): Monitor[] => {
  const tagged = (["platform", "app_version"] as const).flatMap((tag) =>
    [...new Set(events.map((event) => event.tags?.[tag]).filter((value): value is string => typeof value === "string"))].map((value) => ({ [tag]: value })),
  );
  const monitors = [
    ...shareMonitors({ signals: support.signals, ...shared }),
    ...shareMonitors({ signals: both(["is_bug_report", "frustration>=2"], AREAS), ...shared }),
    ...tagged.flatMap((where) => shareMonitors({ signals: ["is_bug_report", "blocked"], where, ...shared })),
  ];
  return [
    // With `alphas`, every share monitor gets a fixed cutoff instead of a share of the alarm budget.
    ...(alphas ? monitors.map((monitor) => ({ ...monitor, alpha: alphas[monitor.severity] })) : monitors),
    volumeMonitor({ windowMs: 3 * HOUR, name: "conversation volume" }),
    eventMonitor({ signal: "data_exposure", gate: 0.9, second: { from: 0.5 } }),
  ];
};
