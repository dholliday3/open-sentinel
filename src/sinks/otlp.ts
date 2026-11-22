// OpenTelemetry logs over OTLP/HTTP JSON. Each labeled event and each notice becomes one log
// record, so any backend that takes OTLP (a Collector, Datadog, Grafana, Honeycomb, PostHog) can
// chart the signals and alert on them with the tools you already have.
//
// A labeled event's record carries each signal as a number attribute, `signal.<key>`, and each
// tag under its own name. Its text is left out unless you ask for it.
import { postJson } from "../http.ts";
import type { Fetch } from "../http.ts";
import type { Notice, Sink } from "../pipeline.ts";
import type { LabeledEvent } from "../types.ts";

type AnyValue = { stringValue: string } | { doubleValue: number } | { boolValue: boolean };
interface KeyValue {
  key: string;
  value: AnyValue;
}
interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: AnyValue;
  attributes: KeyValue[];
}

const attribute = (key: string, value: string | number | boolean): KeyValue => ({
  key,
  value: typeof value === "string" ? { stringValue: value } : typeof value === "number" ? { doubleValue: value } : { boolValue: value },
});

const nanos = (ms: number): string => `${Math.round(ms)}000000`;

const eventRecord = (event: LabeledEvent, includeText: boolean): LogRecord => ({
  timeUnixNano: nanos(event.at),
  severityNumber: 9,
  severityText: "INFO",
  body: { stringValue: includeText && event.text !== undefined ? event.text : "labeled event" },
  attributes: [
    attribute("event.name", "open_sentinel.labeled"),
    attribute("open_sentinel.event.id", event.id),
    attribute("open_sentinel.schema", event.schema),
    attribute("open_sentinel.labeler", event.labeler),
    ...(event.unit === undefined ? [] : [attribute("open_sentinel.unit", event.unit)]),
    ...Object.entries(event.tags ?? {}).flatMap(([key, value]) => (value === null ? [] : [attribute(key, value)])),
    ...Object.entries(event.signals).map(([key, value]) => attribute(`signal.${key}`, value)),
  ],
});

const noticeRecord = (notice: Notice): LogRecord => {
  const { alert } = notice;
  const page = alert.severity === "page" && notice.kind === "fired";
  const lead = notice.suspects?.[0];
  return {
    timeUnixNano: nanos(notice.at),
    severityNumber: page ? 17 : 13,
    severityText: page ? "ERROR" : "WARN",
    body: { stringValue: `${notice.kind}: ${alert.monitor}` },
    attributes: [
      attribute("event.name", `open_sentinel.alert.${notice.kind}`),
      attribute("open_sentinel.notice.id", notice.id),
      attribute("open_sentinel.monitor", alert.monitor),
      attribute("open_sentinel.severity", alert.severity),
      ...(alert.signal === undefined ? [] : [attribute("open_sentinel.signal", alert.signal)]),
      ...(alert.event === undefined ? [] : [attribute("open_sentinel.event.id", alert.event.id)]),
      ...Object.entries(alert.where ?? {}).map(([key, value]) => attribute(key, value)),
      ...(lead ? [attribute("open_sentinel.suspect", lead.change.what), attribute("open_sentinel.suspect.id", lead.change.id), attribute("open_sentinel.suspect.confident", notice.confident === true)] : []),
    ],
  };
};

/** The OTLP/HTTP JSON body (an ExportLogsServiceRequest) for some records. */
export const otlpLogs = ({ events = [], notices = [], service, includeText = false }: { events?: readonly LabeledEvent[]; notices?: readonly Notice[]; service: string; includeText?: boolean }): { resourceLogs: unknown[] } => ({
  resourceLogs: [
    {
      resource: { attributes: [attribute("service.name", service)] },
      scopeLogs: [{ scope: { name: "open-sentinel" }, logRecords: [...events.map((event) => eventRecord(event, includeText)), ...notices.map(noticeRecord)] }],
    },
  ],
});

/**
 * Sends labeled events and notices as OTLP logs. `url` is the logs endpoint, usually ending in
 * `/v1/logs`. `includeText` also sends each event's text as the record's body; leave it off
 * unless the backend is allowed to hold it.
 */
export const otlpSink = ({ url, headers, service = "open-sentinel", includeText = false, fetch: send = fetch }: { url: string; headers?: Record<string, string>; service?: string; includeText?: boolean; fetch?: Fetch }): Sink => ({
  labeled: async (events) => {
    if (events.length > 0) {
      await postJson(send, url, { headers, body: otlpLogs({ events, service, includeText }) });
    }
  },
  notify: async (notices) => {
    await postJson(send, url, { headers, body: otlpLogs({ notices, service }) });
  },
});
