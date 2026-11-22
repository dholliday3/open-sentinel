// The plain sinks and the file source. Anything vendor-specific is a few lines over `webhookSink`
// or a `Sink` of your own; the OpenTelemetry exporter is in sinks/otlp.ts.
import { appendFileSync, readFileSync } from "node:fs";
import { postJson } from "./http.ts";
import type { Fetch } from "./http.ts";
import type { Notice, Sink } from "./pipeline.ts";
import type { TextEvent } from "./types.ts";

const line = (notice: Notice): string => {
  const about = notice.alert.event ? ` (event ${notice.alert.event.id})` : "";
  const lead = notice.suspects?.[0] ? `; ${notice.confident ? "likely" : "possibly"} ${notice.suspects[0].change.what}` : "";
  return `${new Date(notice.at).toISOString()} ${notice.kind} ${notice.alert.severity}: ${notice.alert.monitor}${about}${lead}`;
};

/** Prints one line per notice. */
export const consoleSink = (write: (text: string) => void = console.log): Sink => ({
  notify: (notices) => {
    for (const notice of notices) {
      write(line(notice));
    }
  },
});

/** Appends every labeled event and every notice to a file, one JSON object per line. */
export const jsonlSink = (path: string): Sink => ({
  labeled: (events) => {
    if (events.length > 0) {
      appendFileSync(path, `${events.map((event) => JSON.stringify({ type: "event", ...event })).join("\n")}\n`);
    }
  },
  notify: (notices) => {
    appendFileSync(path, `${notices.map((notice) => JSON.stringify({ type: "notice", ...notice })).join("\n")}\n`);
  },
});

/**
 * POSTs notices as JSON: `{ notices: [...] }`. Enough for Slack-style incoming webhooks behind a
 * small adapter, a paging tool's events API, or your own endpoint. Pass `events: true` to also
 * POST labeled events as `{ events: [...] }`.
 */
export const webhookSink = ({ url, headers, events = false, fetch: send = fetch }: { url: string; headers?: Record<string, string>; events?: boolean; fetch?: Fetch }): Sink => ({
  ...(events
    ? {
        labeled: async (batch) => {
          if (batch.length > 0) {
            await postJson(send, url, { headers, body: { events: batch } });
          }
        },
      }
    : {}),
  notify: async (notices) => {
    await postJson(send, url, { headers, body: { notices } });
  },
});

/**
 * Reads events from a file with one JSON object per line. `toEvent` maps each row to a
 * `TextEvent`; return null to skip a row. This is the whole shape of a connector: something that
 * yields `TextEvent`s.
 */
export function* fromJsonl(path: string, toEvent: (row: Record<string, unknown>) => TextEvent | null = (row) => row as unknown as TextEvent): Generator<TextEvent> {
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (text.trim() === "") {
      continue;
    }
    const event = toEvent(JSON.parse(text) as Record<string, unknown>);
    if (event) {
      yield event;
    }
  }
}
