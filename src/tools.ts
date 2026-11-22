// What an investigator can ask of the data, as plain functions with described inputs. The same
// tools serve an LLM investigator (investigate.ts) and any MCP client (mcp.ts). Add your own by
// adding entries: a runbook lookup, a query against your orders table.
import { estimateOnset, rankChanges } from "./changes.ts";
import { breakdown, count, movers, on, series } from "./metrics.ts";
import type { EventView } from "./metrics.ts";
import { DAY, HOUR, WEEK } from "./types.ts";
import type { Change, Gates } from "./types.ts";

export interface Tool {
  description: string;
  /** The arguments, each with what it is. Times are ISO 8601 strings. */
  input: Record<string, { type: "string" | "number"; description: string; optional?: boolean }>;
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface ToolData {
  view: EventView;
  changes: readonly Change[];
}

const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const time = (value: unknown, name: string): number => {
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) {
    throw new Error(`"${name}" must be an ISO time such as 2026-11-09T14:00Z`);
  }
  return ms;
};
/** A number argument, or its default when left out. Throws on anything that isn't a number in range. */
const number = (value: unknown, name: string, { fallback, min, max }: { fallback: number; min: number; max: number }): number => {
  if (value === undefined || value === null) {
    return fallback;
  }
  const given = Number(value);
  if (!Number.isFinite(given) || given < min) {
    throw new Error(`"${name}" must be a number, at least ${min}`);
  }
  return Math.min(given, max);
};
const MAX_BUCKETS = 200;
const counts = ({ yes, total }: { yes: number; total: number }): string => `${yes}/${total}`;
const round = (x: number): number => Math.round(x * 100) / 100;

/**
 * The standard tools over some data. Pass the data itself, or a function that reads it fresh on
 * each call (for a server that outlives one question).
 */
export const toolsFor = (data: ToolData | (() => ToolData | Promise<ToolData>), { signals, gates = {} }: { signals: readonly string[]; gates?: Gates }): Record<string, Tool> => {
  const read = async (): Promise<ToolData> => (typeof data === "function" ? data() : data);
  const where = (args: Record<string, unknown>): Record<string, string> | undefined => (typeof args.tag === "string" && typeof args.tag_value === "string" ? { [args.tag]: args.tag_value } : undefined);
  const range = { from: { type: "string", description: "Start, ISO time" }, to: { type: "string", description: "End, ISO time" } } as const;
  const tagFilter = {
    tag: { type: "string", description: "Only events with this tag...", optional: true },
    tag_value: { type: "string", description: "...set to this value", optional: true },
  } as const;
  return {
    signal_series: {
      description: "One signal over time: in each bucket, how many events had it and how many events there were.",
      input: { signal: { type: "string", description: `A signal key. Join two with & for "both". Keys: ${signals.join(", ")}` }, ...range, bucket_hours: { type: "number", description: `Bucket size in hours (default 1, at least 0.25). At most ${MAX_BUCKETS} buckets come back.`, optional: true }, ...tagFilter },
      run: async (args) => {
        const { view } = await read();
        const bucketMs = number(args.bucket_hours, "bucket_hours", { fallback: 1, min: 0.25, max: 24 * 7 }) * HOUR;
        const from = time(args.from, "from");
        // No more buckets than a reader can use, however long the range asked for.
        const to = Math.min(time(args.to, "to"), from + MAX_BUCKETS * bucketMs);
        return series(view, { signal: String(args.signal), gates, from, to, bucketMs, where: where(args) }).map((row) => ({ at: iso(row.at), yes: row.yes, total: row.total }));
      },
    },
    top_signals: {
      description: "Every signal's share in a window against the 7 days before it, largest rise first. Use it to see what else moved.",
      input: { ...range },
      run: async (args) => {
        const { view } = await read();
        return movers(view, { signals, gates, from: time(args.from, "from"), to: time(args.to, "to"), baselineMs: WEEK })
          .slice(0, 12)
          .map((row) => ({ signal: row.signal, now: counts(row.now), before: counts(row.before), lift: round(row.lift) }));
      },
    },
    breakdown: {
      description: "One signal split by a tag (such as platform, version or plan): its count in a window and in the 7 days before.",
      input: { signal: { type: "string", description: "A signal key" }, by: { type: "string", description: "The tag to split by" }, ...range },
      run: async (args) => {
        const { view } = await read();
        return breakdown(view, { signal: String(args.signal), gates, by: String(args.by), from: time(args.from, "from"), to: time(args.to, "to"), baselineMs: WEEK }).map((row) => ({ value: row.value, now: counts(row.now), before: counts(row.before) }));
      },
    },
    messages: {
      description: "The events themselves in a time range, newest first: text, tags and the signals that are yes. Read these before concluding anything.",
      input: { ...range, signal: { type: "string", description: "Only events where this signal is yes", optional: true }, limit: { type: "number", description: "How many, at most 25 (default 15)", optional: true }, ...tagFilter },
      run: async (args) => {
        const { view } = await read();
        const isOn = typeof args.signal === "string" ? on(args.signal, gates) : () => true;
        return view
          .within({ from: time(args.from, "from"), to: time(args.to, "to"), where: where(args) })
          .filter(isOn)
          .reverse()
          .slice(0, Math.trunc(number(args.limit, "limit", { fallback: 15, min: 1, max: 25 })))
          .map((event) => ({
            id: event.id,
            at: iso(event.at),
            tags: event.tags ?? {},
            text: event.text ?? "(text not kept)",
            signals: Object.fromEntries(Object.entries(event.signals).filter(([key, p]) => p >= (gates[key] ?? 0.5)).map(([key, p]) => [key, round(p)])),
          }));
      },
    },
    changes: {
      description: "The change log in a time range: deploys, flags, releases, emails to customers. Search the whole period a shift could have started in, not only the hours before the alert.",
      input: { ...range },
      run: async (args) => {
        const { changes } = await read();
        return changes.filter((change) => change.at >= time(args.from, "from") && change.at < time(args.to, "to")).map((change) => ({ id: change.id, at: iso(change.at), kind: change.kind, what: change.what, ...(change.scope ? { reaches: change.scope } : {}), ...(change.ref ? { ref: change.ref } : {}) }));
      },
    },
    suspects: {
      description: "For a signal that rose: when the rise began, and the changes that could be behind it, ranked by timing and by whether the events a change reached show the signal more than the rest and more than events like them did before. Leads to check against the messages, not verdicts.",
      input: { signal: { type: "string", description: "The signal that rose" }, until: { type: "string", description: "When it was noticed, ISO time" }, ...tagFilter },
      run: async (args) => {
        const { view, changes } = await read();
        const until = time(args.until, "until");
        const first = view.events[0]?.at ?? until;
        const onset = estimateOnset(view, { signal: String(args.signal), gates, where: where(args), until, lookbackMs: Math.min(10 * DAY, until - first) });
        if (!onset) {
          return { began: null, suspects: [], note: "No rise found in this signal before that time." };
        }
        const { ranked, confident } = rankChanges(view, changes.filter((change) => change.at <= until), { signal: String(args.signal), gates, where: where(args), onset, until });
        return {
          began: { mostLikely: iso(onset.at), earliest: iso(onset.low), latest: iso(onset.high) },
          confident,
          suspects: ranked.slice(0, 5).map((suspect) => ({ id: suspect.change.id, at: iso(suspect.change.at), what: suspect.change.what, timeFit: round(suspect.time), ...(suspect.exposure ? { reached: counts(suspect.exposure.exposed), notReached: counts(suspect.exposure.unexposed), ...(suspect.exposure.rise ? { likeThemBefore: counts(suspect.exposure.rise.before) } : {}), exposureEvidence: round(suspect.exposure.evidence) } : {}) })),
        };
      },
    },
  };
};

/** How many events have each signal in a range: a quick summary for a prompt or a status line. */
export const summarize = (view: EventView, { signals, gates = {}, from, to }: { signals: readonly string[]; gates?: Gates; from: number; to: number }): Record<string, string> => {
  const events = view.within({ from, to });
  return Object.fromEntries(signals.map((signal) => [signal, counts(count(events, signal, gates))]));
};
