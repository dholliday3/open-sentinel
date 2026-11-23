// The SQL every database store shares. A `Dialect` holds what differs between databases (how a
// parameter is written, how a JSON field is read, how a list arrives as one parameter, the
// tables); everything else is here, written in SQL that Postgres, SQLite and DuckDB all run.
//
// Every value is a parameter. Signal keys, tag keys and tag values are user data and never
// appear in SQL text; the text varies only in how many of each part a query has. Table names
// come from code and are checked.
import { groupKey } from "../counting.ts";
import type { CountQuery, CountRow, EventQuery, LabelerQuery, Labelers } from "../counting.ts";
import { eventKey } from "../store.ts";
import type { Store } from "../store.ts";
import type { Change, Json, LabeledEvent, TagFilter, Tags } from "../types.ts";

/** Runs one statement with positional parameters. `pg`'s `Pool.query` fits as it is. */
export type Query = (sql: string, params: unknown[]) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

export type ColumnType = "integer" | "double" | "text" | "json";

export interface Tables {
  events: string;
  changes: string;
  state: string;
  /** What index names start with: the events table's name without a schema. */
  prefix: string;
}

export interface Dialect {
  /** The n-th placeholder, counting from 1. */
  placeholder(n: number): string;
  /** What a JSON key is bound as: the key itself, or a path to it. */
  key(key: string): string;
  /** The number under a JSON key (bound with `key`), or NULL. */
  number(column: string, key: string): string;
  /** The text under a JSON key (bound with `key`), or NULL when it is absent or null. */
  text(column: string, key: string): string;
  /** The JSON column without these keys, binding them with `bind`: the same for the same tags. */
  without(column: string, keys: readonly string[], bind: (value: unknown) => string): string;
  /** A table read from one parameter holding a JSON array of objects, as a FROM item named `alias`. */
  rows(param: string, alias: string, columns: Readonly<Record<string, ColumnType>>): string;
  /** A parameter holding JSON text, as a value of the JSON column type. */
  json(param: string): string;
  /** A JSON column's value as the driver returns it, parsed. */
  parse(value: unknown): unknown;
  /** The smallest of some numbers. */
  least(values: readonly string[]): string;
  /** The statements that create the tables and indexes, each run on its own. */
  ddl(tables: Tables): string[];
  /** The most parameters one statement may take. */
  maxParams: number;
}

export interface SqlStoreOptions {
  query: Query;
  /** Tables are `<table>_events`, `<table>_changes` and `<table>_state`. A Postgres schema may lead: `app.sentinel`. */
  table?: string;
  /** Events per insert statement (500). */
  batch?: number;
  /** Fewer parameters per statement than the dialect allows: Cloudflare D1 takes 100. */
  maxParams?: number;
}

export interface SqlStore extends Store {
  /** Creates the tables and indexes if they don't exist. Safe to run on every start. */
  migrate(): Promise<void>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}(\.[A-Za-z_][A-Za-z0-9_]{0,40})?$/;

export const tablesOf = (table = "sentinel"): Tables => {
  if (!NAME.test(table)) {
    throw new Error(`"${table}" can't name a table: use letters, digits and underscores, optionally after a schema and a dot`);
  }
  return { events: `${table}_events`, changes: `${table}_changes`, state: `${table}_state`, prefix: table.split(".").at(-1)! };
};

/** The statements that create a store's tables, as one script: for a migration tool of your own. */
export const schemaSql = (dialect: Dialect, table?: string): string => `${dialect.ddl(tablesOf(table)).join(";\n")};\n`;

/** Collects parameters and writes their placeholders. */
const paramsOf = (dialect: Dialect) => {
  const values: unknown[] = [];
  const add = (value: unknown): string => {
    values.push(value);
    return dialect.placeholder(values.length);
  };
  return {
    values,
    add,
    key: (key: string): string => add(dialect.key(key)),
    number: (value: number): string => `CAST(${add(bound(value))} AS DOUBLE PRECISION)`,
    text: (value: string): string => `CAST(${add(value)} AS TEXT)`,
  };
};
type Params = ReturnType<typeof paramsOf>;

/** A time as a parameter: infinities, which JSON and some drivers can't carry, become the largest finite numbers. */
const bound = (value: number): number => (value === Infinity ? Number.MAX_VALUE : value === -Infinity ? -Number.MAX_VALUE : value);

/** Keys sorted, so tags stored as text compare equal when they are equal. */
const sortedTags = (tags: Tags): Tags => Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : 1)));

const EVENT_COLUMNS = { i: "integer", schema_id: "text", id: "text", labeler: "text", at: "double", unit: "text", tags: "json", signals: "json", probability: "text", text: "text", context: "json" } as const;

export const sqlStore = (dialect: Dialect, { query, table, batch = 500, maxParams = dialect.maxParams }: SqlStoreOptions): SqlStore => {
  const tables = tablesOf(table);
  const { events, changes, state } = tables;
  const run = async (sql: string, params: Params | unknown[] = []): Promise<ReadonlyArray<Record<string, unknown>>> => (await query(sql, Array.isArray(params) ? params : params.values)).rows;

  /** `where` as conditions on the events table `e`. */
  const tagged = (params: Params, where: TagFilter): string[] => Object.entries(where).map(([key, value]) => `${dialect.text("e.tags", params.key(key))} = ${params.text(value)}`);
  /** All of `filter`'s tags at once, as 1 or 0. */
  const matches = (params: Params, filter: TagFilter): string => {
    const conditions = tagged(params, filter);
    return conditions.length === 0 ? "1" : `CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END`;
  };
  /** Whose answers are read: one labeler's, one per event, or all. */
  const answers = (params: Params, query: Pick<EventQuery, "schema" | "labeler" | "oneAnswer">): string[] => {
    const conditions = query.schema === undefined ? [] : [`e.schema_id = ${params.text(query.schema)}`];
    if (query.labeler !== undefined) {
      return [...conditions, `e.labeler = ${params.text(query.labeler)}`];
    }
    const rule = query.oneAnswer;
    if (rule === undefined) {
      return conditions;
    }
    // Kept: the preferred labeler's copy, or the first copy when it has none, among copies in the stretch.
    const earlier = `SELECT 1 FROM ${events} o WHERE o.schema_id = e.schema_id AND o.id = e.id AND o.at >= ${params.number(rule.from)} AND o.at < ${params.number(rule.to)} AND (o.labeler = ${params.text(rule.prefer)} OR o.at < e.at OR (o.at = e.at AND o.seq < e.seq))`;
    return [...conditions, `e.at >= ${params.number(rule.from)}`, `e.at < ${params.number(rule.to)}`, `(e.labeler = ${params.text(rule.prefer)} OR NOT EXISTS (${earlier}))`];
  };
  /** A signal part at its gate, as 1 or 0. */
  const atGate = (params: Params, key: string, gate: number): string => `CASE WHEN COALESCE(${dialect.number("e.signals", params.key(key))}, 0) >= ${params.number(gate)} THEN 1 ELSE 0 END`;

  const countOnce = async (query: CountQuery): Promise<CountRow[]> => {
    const params = paramsOf(dialect);
    const windows = dialect.rows(params.add(JSON.stringify(query.windows.map((w, i) => ({ i, lo: bound(w.from), hi: bound(w.to) })))), "w", { i: "integer", lo: "double", hi: "double" });
    // Each part of each signal once, as a column of 1s and 0s; a signal is the product of its parts.
    const parts = new Map<string, number>();
    const partsOf = (signal: string): number[] =>
      signal.split("&").map((key) => {
        const gate = query.gates?.[key] ?? 0.5;
        const id = `${gate}\n${key}`;
        if (!parts.has(id)) {
          parts.set(id, parts.size);
        }
        return parts.get(id)!;
      });
    const signals = query.signals.map((signal) => (signal === "*" ? [] : partsOf(signal)));
    const partColumns = [...parts.keys()].map((id, n) => {
      const [gate, ...key] = id.split("\n");
      return `${atGate(params, key.join("\n"), Number(gate))} AS p${n}`;
    });
    const groupBy = query.groupBy;
    const groupColumns = !groupBy ? [] : "tags" in groupBy ? groupBy.tags.map((key, n) => `${dialect.text("e.tags", params.key(key))} AS g${n}`) : [`${dialect.without("e.tags", groupBy.tagsExcept, params.add)} AS g0`];
    const groups = groupColumns.map((_, n) => `g${n}`);
    const conditions = [...answers(params, query), ...(query.where ? tagged(params, query.where) : []), ...(query.exclude ? [`${matches(params, query.exclude)} = 0`] : [])];
    const scanned = [`w.i AS win`, "e.at AS at", "e.seq AS seq", "e.unit AS unit", ...groupColumns, ...partColumns].join(", ");
    const product = (ids: number[]): string => (ids.length === 0 ? "1" : ids.map((id) => `p${id}`).join(" * "));
    const keys = ["win", ...groups].join(", ");
    const r = `r AS (SELECT ${scanned} FROM ${windows} JOIN ${events} e ON e.at >= w.lo AND e.at < w.hi WHERE ${conditions.length === 0 ? "1 = 1" : conditions.join(" AND ")})`;
    const sql =
      query.per === "event"
        ? `WITH ${r} SELECT ${keys}, COUNT(*) AS total, COUNT(*) AS n, MIN(at) AS first${signals.map((ids, s) => `, SUM(${product(ids)}) AS y${s}`).join("")} FROM r GROUP BY ${keys}`
        : `WITH ${r}, u AS (SELECT ${keys}, COUNT(*) AS n, MIN(at) AS first${signals.map((ids, s) => `, MAX(${product(ids)}) AS y${s}`).join("")} FROM r GROUP BY ${keys}, unit, CASE WHEN unit IS NULL THEN seq END) SELECT ${keys}, COUNT(*) AS total, SUM(n) AS n, MIN(first) AS first${signals.map((_, s) => `, SUM(y${s}) AS y${s}`).join("")} FROM u GROUP BY ${keys}`;
    if (params.values.length > maxParams && query.signals.length > 1) {
      // Too many parameters for one statement (D1 takes 100): count the signals in two halves.
      const half = Math.ceil(query.signals.length / 2);
      const [a, b] = await Promise.all([countOnce({ ...query, signals: query.signals.slice(0, half) }), countOnce({ ...query, signals: query.signals.slice(half) })]);
      return a.map((row, n) => ({ ...row, yes: { ...row.yes, ...b[n]!.yes } }));
    }
    const rows = (await run(sql, params)).map((row) => {
      const yes = Object.fromEntries(query.signals.map((signal, s) => [signal, Number(row[`y${s}`] ?? 0)]));
      const group: Tags | undefined = !groupBy ? undefined : "tags" in groupBy ? Object.fromEntries(groupBy.tags.map((key, n) => [key, (row[`g${n}`] as string | null) ?? null])) : (dialect.parse(row.g0) as Tags);
      return { window: Number(row.win), first: Number(row.first), ...(group ? { group } : {}), total: Number(row.total), yes, events: Number(row.n) };
    });
    if (!groupBy) {
      const byWindow = new Map(rows.map((row) => [row.window, row]));
      return query.windows.map((_, window) => {
        const row = byWindow.get(window);
        return { window, total: row?.total ?? 0, yes: row?.yes ?? Object.fromEntries(query.signals.map((signal) => [signal, 0])), events: row?.events ?? 0 };
      });
    }
    // Groups in the order their first event came, then by their tags: the order `tally` gives.
    const key = (row: (typeof rows)[number]): string => groupKey(groupBy, row.group!);
    return rows
      .sort((a, b) => a.window - b.window || a.first - b.first || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .map(({ first: _first, ...row }) => row);
  };

  const fromRow = (row: Record<string, unknown>): LabeledEvent => {
    const tags = dialect.parse(row.tags) as Tags | null;
    const context = dialect.parse(row.context) as Record<string, Json> | null;
    return {
      id: String(row.id),
      at: Number(row.at),
      ...(row.text === null || row.text === undefined ? {} : { text: String(row.text) }),
      ...(context === null || context === undefined ? {} : { context }),
      ...(row.unit === null || row.unit === undefined ? {} : { unit: String(row.unit) }),
      ...(tags === null || tags === undefined ? {} : { tags }),
      schema: String(row.schema_id),
      labeler: String(row.labeler),
      probability: row.probability as LabeledEvent["probability"],
      signals: dialect.parse(row.signals) as Record<string, number>,
    };
  };

  return {
    migrate: async () => {
      for (const statement of dialect.ddl(tables)) {
        await run(statement);
      }
    },
    append: async (added) => {
      // The first copy of each in this batch: a store keeps the first, and so must one insert.
      const seen = new Set<string>();
      const fresh = added.filter((event) => !seen.has(eventKey(event)) && seen.add(eventKey(event)));
      for (let start = 0; start < fresh.length; start += batch) {
        const rows = fresh.slice(start, start + batch).map((event, i) => ({ i, schema_id: event.schema, id: event.id, labeler: event.labeler, at: event.at, unit: event.unit ?? null, tags: event.tags ? sortedTags(event.tags) : null, signals: event.signals, probability: event.probability, text: event.text ?? null, context: event.context ?? null }));
        const params = paramsOf(dialect);
        const source = dialect.rows(params.add(JSON.stringify(rows)), "x", EVENT_COLUMNS);
        const columns = Object.keys(EVENT_COLUMNS).filter((column) => column !== "i");
        await run(`INSERT INTO ${events} (${columns.join(", ")}) SELECT ${columns.map((column) => `x.${column}`).join(", ")} FROM ${source} WHERE 1 = 1 ORDER BY x.i ON CONFLICT (schema_id, id, labeler) DO NOTHING`, params);
      }
    },
    events: async (query = {}) => {
      if (query.limit !== undefined && query.limit <= 0) {
        return [];
      }
      const params = paramsOf(dialect);
      const conditions = [...answers(params, query)];
      if (query.from !== undefined) {
        conditions.push(`e.at >= ${params.number(query.from)}`);
      }
      if (query.to !== undefined) {
        conditions.push(`e.at < ${params.number(query.to)}`);
      }
      if (query.where) {
        conditions.push(...tagged(params, query.where));
      }
      if (query.atLeast) {
        const entries = query.atLeast.map((entry) => {
          const parts = Object.entries(entry).map(([key, gate]) => `${atGate(params, key, gate)} = 1`);
          return parts.length === 0 ? "1 = 1" : `(${parts.join(" AND ")})`;
        });
        conditions.push(entries.length === 0 ? "1 = 0" : `(${entries.join(" OR ")})`);
      }
      // Events at the same time come in the order stored; with one answer per event, in the order their first copies were.
      const rule = query.labeler === undefined ? query.oneAnswer : undefined;
      const firstCopy = (column: "at" | "seq"): string =>
        `(SELECT o.${column} FROM ${events} o WHERE o.schema_id = e.schema_id AND o.id = e.id AND o.at >= ${params.number(rule!.from)} AND o.at < ${params.number(rule!.to)} ORDER BY o.at, o.seq LIMIT 1)`;
      const ranks = rule ? `${firstCopy("at")} AS rank_at, ${firstCopy("seq")} AS rank_seq` : "0 AS rank_at, e.seq AS rank_seq";
      const order = query.order ?? "oldest";
      const surest = typeof order === "object" ? `${dialect.least(order.surest.map((key) => `COALESCE(${dialect.number("e.signals", params.key(key))}, 0)`))} AS sureness, ` : "";
      const by = typeof order === "object" ? "sureness DESC, at DESC, rank_at, rank_seq" : order === "newest" ? "at DESC, rank_at DESC, rank_seq DESC" : "at, rank_at, rank_seq";
      const inner = `SELECT e.schema_id, e.id, e.labeler, e.at, e.unit, e.tags, e.signals, e.probability, e.text, e.context, ${surest}${ranks} FROM ${events} e WHERE ${conditions.length === 0 ? "1 = 1" : conditions.join(" AND ")}`;
      const picked = query.onePerUnit ? `SELECT * FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(x.unit, x.id) ORDER BY ${by}) AS place FROM (${inner}) x) y WHERE place = 1` : `SELECT * FROM (${inner}) y`;
      const limit = query.limit === undefined ? "" : ` LIMIT ${params.add(Math.floor(query.limit))}`;
      return (await run(`${picked} ORDER BY ${by}${limit}`, params)).map(fromRow);
    },
    count: async (query) => (query.windows.length === 0 ? [] : countOnce(query)),
    labelers: async ({ schema, from, to, where }: LabelerQuery): Promise<Labelers> => {
      // Each labeler found by one index lookup from the last, however many events each has.
      const found = await run(
        `WITH RECURSIVE l(labeler) AS (SELECT MIN(labeler) FROM ${events} WHERE schema_id = ${dialect.placeholder(1)} UNION ALL SELECT (SELECT MIN(e.labeler) FROM ${events} e WHERE e.schema_id = ${dialect.placeholder(2)} AND e.labeler > l.labeler) FROM l WHERE l.labeler IS NOT NULL) SELECT labeler FROM l WHERE labeler IS NOT NULL`,
        [schema, schema],
      );
      if (found.length === 0) {
        return { labelers: [] };
      }
      const params = paramsOf(dialect);
      const ends = found.flatMap(({ labeler }) =>
        (["ASC", "DESC"] as const).map((direction) => {
          const conditions = [`e.schema_id = ${params.text(schema)}`, `e.labeler = ${params.text(String(labeler))}`, ...(from === undefined ? [] : [`e.at >= ${params.number(from)}`]), ...(to === undefined ? [] : [`e.at < ${params.number(to)}`]), ...(where ? tagged(params, where) : [])];
          return `SELECT * FROM (SELECT '${direction}' AS side, e.labeler AS labeler, e.at AS at, e.seq AS seq FROM ${events} e WHERE ${conditions.join(" AND ")} ORDER BY e.at ${direction}, e.seq ${direction} LIMIT 1) ${direction === "ASC" ? "f" : "l"}`;
        }),
      );
      const rows = (await run(ends.join(" UNION ALL "), params)).map((row) => ({ side: String(row.side), labeler: String(row.labeler), at: Number(row.at), seq: Number(row.seq) }));
      const order = (a: { at: number; seq: number }, b: { at: number; seq: number }): number => a.at - b.at || a.seq - b.seq;
      const firsts = rows.filter((row) => row.side === "ASC").sort(order);
      const newest = rows.filter((row) => row.side === "DESC").sort(order).at(-1)?.labeler;
      return { labelers: firsts.map((row) => row.labeler), ...(newest === undefined ? {} : { newest }) };
    },
    known: async (ids, schema, labeler) => {
      if (ids.length === 0) {
        return new Set();
      }
      const params = paramsOf(dialect);
      const list = dialect.rows(params.add(JSON.stringify(ids.map((id) => ({ id })))), "x", { id: "text" });
      const rows = await run(`SELECT e.id FROM ${events} e WHERE e.schema_id = ${params.text(schema)} AND e.labeler = ${params.text(labeler)} AND e.id IN (SELECT x.id FROM ${list})`, params);
      return new Set(rows.map((row) => String(row.id)));
    },
    delete: async ({ before, unit }) => {
      if (before === undefined && unit === undefined) {
        return 0;
      }
      const params = paramsOf(dialect);
      const conditions = [...(before === undefined ? [] : [`at < ${params.number(before)}`]), ...(unit === undefined ? [] : [`unit = ${params.text(unit)}`])].join(" AND ");
      // Counted just before, so a delete of millions doesn't send millions of rows back.
      const [counted] = await run(`SELECT COUNT(*) AS n FROM ${events} WHERE ${conditions}`, params);
      await run(`DELETE FROM ${events} WHERE ${conditions}`, params);
      return Number(counted?.n ?? 0);
    },
    recordChange: async (change) => {
      const params = paramsOf(dialect);
      await run(`INSERT INTO ${changes} (id, at, change) VALUES (${params.text(change.id)}, ${params.number(change.at)}, ${dialect.json(params.add(JSON.stringify(change)))}) ON CONFLICT (id) DO UPDATE SET at = excluded.at, change = excluded.change`, params);
    },
    changes: async ({ from, to } = {}) => {
      const params = paramsOf(dialect);
      const conditions = [...(from === undefined ? [] : [`at >= ${params.number(from)}`]), ...(to === undefined ? [] : [`at < ${params.number(to)}`])];
      return (await run(`SELECT change FROM ${changes}${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY at, seq`, params)).map((row) => dialect.parse(row.change) as Change);
    },
    loadState: async (key) => {
      const [row] = await run(`SELECT value FROM ${state} WHERE key = ${dialect.placeholder(1)}`, [key]);
      return row === undefined ? undefined : (dialect.parse(row.value) as Json);
    },
    saveState: async (key, value) => {
      const params = paramsOf(dialect);
      await run(`INSERT INTO ${state} (key, value) VALUES (${params.text(key)}, ${dialect.json(params.add(JSON.stringify(value)))}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, params);
    },
  };
};
