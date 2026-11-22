// Scoring for the example only: which planted item, if any, is behind each alert. Uses what the
// monitors never see (which text came from which planted item).
import { on, viewOf } from "../../src/index.ts";
import type { Alert, AlertGroup, EventView } from "../../src/index.ts";
import type { Inbox } from "./data.ts";
import { support } from "./schema.ts";

/**
 * The planted items an alert is about. An item owns an alert when its events make up at least
 * 30% of the alert's excess: what the window holds beyond what the baseline's share predicts.
 */
export const plantedBehind = (alert: Alert, inbox: Inbox, view: EventView = viewOf(inbox.events)): string[] => {
  const planted = new Set(inbox.planted.map((item) => item.id));
  if (alert.event) {
    const source = inbox.sourceOf.get(alert.event.id);
    return source !== undefined && planted.has(source) ? [source] : [];
  }
  const signal = alert.signal ?? "*";
  const behind = view.within({ from: alert.at - alert.windowMs, to: alert.at, where: alert.where }).filter(on(signal, support.gates));
  const [yes, total] = String(alert.detail.now ?? "").split("/").map(Number);
  const [baseYes, baseTotal] = String(alert.detail.baseline ?? "").split("/").map(Number);
  const excess = typeof alert.detail.before === "number" ? Number(alert.detail.now) - alert.detail.before : (yes ?? 0) - ((total ?? 0) * (baseYes ?? 0)) / Math.max(baseTotal ?? 0, 1);
  const bySource = new Map<string, number>();
  for (const event of behind) {
    const source = inbox.sourceOf.get(event.id)!;
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  return [...bySource].filter(([source, n]) => planted.has(source) && n >= 3 && n >= 0.3 * Math.max(excess, 1)).map(([source]) => source);
};

export interface Scored {
  /** For each planted item: its first alert, how it arrived, and hours from the item's start. */
  items: Array<{ id: string; kind: string; first: Alert | null; as: "page" | "digest" | "muted" | "none"; hours: number | null }>;
  /** Groups no planted item is behind. */
  falseGroups: AlertGroup[];
}

export const score = (inbox: Inbox, alerts: readonly Alert[], groups: readonly AlertGroup[]): Scored => {
  const view = viewOf(inbox.events);
  const owners = new Map(alerts.map((alert) => [alert, plantedBehind(alert, inbox, view)]));
  const rank = (alert: Alert): number => (alert.mutedBy ? 2 : alert.severity === "page" ? 0 : 1);
  return {
    items: inbox.planted.map((item) => {
      const own = alerts.filter((alert) => owners.get(alert)!.includes(item.id)).sort((a, b) => a.at - b.at || rank(a) - rank(b));
      const first = own[0] ?? null;
      return { id: item.id, kind: item.kind, first, as: first ? (first.mutedBy ? "muted" : first.severity) : "none", hours: first ? Math.round((first.at - item.from) / 3_600_000) : null };
    }),
    falseGroups: groups.filter((group) => group.alerts.every((alert) => owners.get(alert)!.length === 0)),
  };
};

