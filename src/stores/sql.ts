// The SQL every database store shares. A `Dialect` holds what differs between databases (how a
// parameter is written, how a JSON field is read, how a list arrives as one parameter, the
// tables); everything else is here, written in SQL that Postgres, SQLite and DuckDB all run.
//
// Where a database keeps JSON as text (SQLite, DuckDB), each event's answers are kept twice:
// whole, as JSON on the event, and as hits, one narrow row for each answer at or above the
// store's hit floor. Counting there reads hits and parses no JSON, so no count may use a gate
// below the floor, and an event and its hits are written and deleted together. Postgres keeps
// jsonb, which is binary and read in parallel, and counts from it directly.
//
// Every value is a parameter. Signal keys, tag keys and tag values are user data and never
// appear in SQL text; the text varies only in how many of each part a query has. Table names
// come from code and are checked.
import { groupKey } from "../counting.ts";
import type { CountQuery, CountRow, EventQuery, LabelerQuery, Labelers } from "../counting.ts";
import { eventKey } from "../store.ts";
import type { Store } from "../store.ts";
import type { Change, Json, LabeledEvent, TagFilter, Tags } from "../types.ts";

/** What a parameter can be: every driver takes these. */
export type SqlValue = string | number | null;

/** Runs one statement with positional parameters. `pg`'s `Pool.query` fits as it is. */
export type Query = (sql: string, params: SqlValue[]) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

export type ColumnType = "integer" | "double" | "text" | "json";

export interface Tables {
  events: string;
  /** One row for each answer at or above `hitFloor`: what counting reads, where the dialect keeps hits. */
  hits: string;
  changes: string;
  state: string;
  /** What index names start with: the events table's name without a schema. */
  prefix: string;
  /** True when one tag splits the store into workspaces, kept in the indexed column `part`. */
  partitioned: boolean;
  /** Answers below this probability get no hit. */
  hitFloor: number;
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
  without(column: string, keys: readonly string[], bind: (value: SqlValue) => string): string;
  /** A table read from one parameter holding a JSON array of objects, as a FROM item named `alias`. */
  rows(param: string, alias: string, columns: Readonly<Record<string, ColumnType>>): string;
  /** A parameter holding JSON text, as a value of the JSON column type. */
  json(param: string): string;
  /** A JSON column's value as the driver returns it, parsed. */
  parse(value: unknown): unknown;
  /** The smallest of some numbers. */
  least(values: readonly string[]): string;
  /** A number that is never negative, rounded down to an integer. */
  whole(value: string): string;

  /** The statements that create the tables, indexes and anything else the store needs, each run on its own. */
  ddl(tables: Tables): string[];
  /**
   * Set for a database that counts faster from hits than from each event's JSON. `together` is how
   * an event and its hits are written and deleted as one: by triggers on the events table, or in
   * a transaction (only for a `serial` dialect, on one connection). `lookup` is how a count finds
   * an event's hits: event by event through an index, or joined all at once. `each` is each key of
   * a JSON object column as a FROM item named `j`, with the key in `j.key` and the value as a
   * number in `p` (NULL when it isn't one). Left out, counts and reads use the JSON.
   */
  hits?: { together: "triggers" | "transaction"; lookup: "each" | "join"; each(column: string): { from: string; p: string } };
  /** An aggregate that ORs the bits of integers (DuckDB's `bit_or`), where it is quicker: a count per customer then keeps one integer per 60 signals instead of one per signal. */
  bitOr?(value: string): string;
  /** The most parameters one statement may take. */
  maxParams: number;
  /** Ends a subquery so it is worked out on its own, not merged into the query around it: Postgres's `OFFSET 0`. */
  fence: string;
  /** True when the database takes one statement at a time on a connection: the store then waits for each before sending the next. */
  serial?: boolean;
  /** A last change to a statement before it runs: SQLite drivers that only take `?` get one per use, in order. */
  finish?(sql: string, params: SqlValue[]): { sql: string; params: SqlValue[] };
}

export interface SqlStoreOptions {
  query: Query;
  /** Tables are `<table>_events`, `<table>_changes` and `<table>_state`, and `<table>_hits` in SQLite and DuckDB. A Postgres schema may lead: `app.sentinel`. */
  table?: string;
  /** Events per insert statement (500). */
  batch?: number;
  /** Fewer parameters per statement than the dialect allows: Cloudflare D1 takes 100. */
  maxParams?: number;
  /**
   * A tag that splits the store into workspaces, such as `workspace`. Its value is kept in a
   * column of its own, indexed, so a watch over one workspace (`where: { workspace: "acme" }`)
   * reads only that workspace's events. Set it when the tables are created: events stored
   * before it was set aren't found by it.
   */
  partition?: string;
  /**
   * SQLite and DuckDB: answers below this probability get no hit row (0.05), so a count with a
   * gate below it throws. It is fixed when `migrate()` creates the hits table: pass the same one
   * after that. Postgres counts from each event's jsonb and takes any gate.
   */
  hitFloor?: number;
}

export interface SqlStore extends Store {
  /** Creates the tables and indexes if they don't exist, and hits for events stored before there were any. Safe to run on every start. */
  migrate(): Promise<void>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}(\.[A-Za-z_][A-Za-z0-9_]{0,40})?$/;

/** The hit floor when none is given. */
export const HIT_FLOOR = 0.05;

/** Where a store keeps the hit floor its hits were written with, in its state table. */
export const FLOOR_KEY = "open-sentinel:hitFloor";

export const tablesOf = (table = "sentinel", partition?: string, hitFloor = HIT_FLOOR): Tables => {
  if (!NAME.test(table)) {
    throw new Error(`"${table}" can't name a table: use letters, digits and underscores, optionally after a schema and a dot`);
  }
  if (!(typeof hitFloor === "number" && hitFloor > 0 && hitFloor <= 1)) {
    throw new Error(`hitFloor must be above 0 and at most 1: ${hitFloor}`);
  }
  return { events: `${table}_events`, hits: `${table}_hits`, changes: `${table}_changes`, state: `${table}_state`, prefix: table.split(".").at(-1)!, partitioned: partition !== undefined, hitFloor };
};

/** The statements that create a store's tables, as one script: for a migration tool of your own. */
export const schemaSql = (dialect: Dialect, table?: string, partition?: string, hitFloor?: number): string => `${dialect.ddl(tablesOf(table, partition, hitFloor)).join(";\n")};\n`;

/** The hits table's columns, in the order `hitsOf` gives them. */
export const HIT_COLUMNS = "seq, schema_id, labeler, part, key, at_ms, p";

/**
 * The hits of the events in `source` (each named `alias`; with no source, the trigger row
 * `alias` alone): every answer that is a number at or above `floor`, as the hits table's columns.
 */
export const hitsOf = (dialect: Dialect, source: string | undefined, alias: string, floor: string): string => {
  const { from, p } = dialect.hits!.each(`${alias}.signals`);
  return `SELECT ${alias}.seq AS seq, ${alias}.schema_id AS schema_id, ${alias}.labeler AS labeler, ${alias}.part AS part, CAST(j.key AS TEXT) AS key, ${alias}.at_ms AS at_ms, ${p} AS p FROM ${source === undefined ? from : `${source} CROSS JOIN ${from}`} WHERE ${p} >= ${floor}`;
};

/** A hit floor as SQL text, for statements that take no parameters. */
export const floorSql = (floor: number): string => `CAST(${floor} AS DOUBLE PRECISION)`;

/** Collects parameters and writes their placeholders. */
const paramsOf = (dialect: Dialect) => {
  const values: SqlValue[] = [];
  const add = (value: SqlValue): string => {
    values.push(value);
    return dialect.placeholder(values.length);
  };
  return {
    values,
    add,
    key: (key: string): string => add(dialect.key(key)),
    number: (value: number): string => `CAST(${add(bound(value))} AS DOUBLE PRECISION)`,
    integer: (value: number): string => `CAST(${add(value)} AS BIGINT)`,
    text: (value: string): string => `CAST(${add(value)} AS TEXT)`,
  };
};
type Params = ReturnType<typeof paramsOf>;

/** 2 to the n, written exactly: past 2^53 a JavaScript number would print rounded. */
const bitOf = (n: number): string => (1n << BigInt(n)).toString();

/** A time as a parameter: an infinity, which JSON and some drivers can't carry, becomes the furthest whole millisecond a number holds exactly. */
const bound = (value: number): number => (value === Infinity ? Number.MAX_SAFE_INTEGER : value === -Infinity ? -Number.MAX_SAFE_INTEGER : value);

/** Keys sorted, so tags stored as text compare equal when they are equal. */
const sortedTags = (tags: Tags): Tags => Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Nothing counted in any window. */
const countedNothing = (query: CountQuery): CountRow[] => (query.groupBy ? [] : query.windows.map((_, window) => ({ window, total: 0, yes: Object.fromEntries(query.signals.map((signal) => [signal, 0])), events: 0 })));

/**
 * The windows with anything in them, by length and then time, as runs of back-to-back windows
 * of one whole-millisecond length (one window alone is a run of one), and for each window's
 * place in that order, the windows given there. An event finds its window in a run by
 * arithmetic rather than by comparison with every window: a tick's 69 baseline windows are
 * three runs.
 */
const runsOf = (windows: CountQuery["windows"]): { runs: Array<{ o: number; s: number; l: number; n: number; e: number }>; places: number[][] } => {
  const distinct = new Map<string, { from: number; to: number; given: number[] }>();
  windows.forEach((window, i) => {
    if (window.from < window.to) {
      const key = `${window.from}\n${window.to}`;
      const found = distinct.get(key) ?? { from: window.from, to: window.to, given: [] };
      found.given.push(i);
      distinct.set(key, found);
    }
  });
  const sorted = [...distinct.values()].sort((a, b) => a.to - a.from - (b.to - b.from) || a.from - b.from);
  const runs: Array<{ o: number; s: number; l: number; n: number; e: number }> = [];
  sorted.forEach((window, place) => {
    const length = window.to - window.from;
    const last = runs.at(-1);
    if (last && last.e === window.from && last.l === length && Number.isSafeInteger(window.from) && Number.isSafeInteger(length)) {
      last.n += 1;
      last.e = window.to;
    } else {
      runs.push({ o: place, s: bound(window.from), l: bound(length), n: 1, e: bound(window.to) });
    }
  });
  return { runs, places: sorted.map((window) => window.given) };
};

const belowFloor = (key: string, gate: number, floor: number): Error =>
  new Error(`The gate ${gate} for "${key}" is below this store's hitFloor of ${floor}: answers under the floor aren't kept as hits, so it can't be counted. Use a gate of at least ${floor}, or a store created with a lower hitFloor.`);

const EVENT_COLUMNS = { i: "integer", schema_id: "text", id: "text", labeler: "text", at_ms: "double", unit: "text", tags: "json", signals: "json", probability: "text", text: "text", context: "json", part: "text" } as const;

export const sqlStore = (dialect: Dialect, { query: given, table, batch = 500, maxParams = dialect.maxParams, partition, hitFloor }: SqlStoreOptions): SqlStore => {
  const tables = tablesOf(table, partition, hitFloor);
  let last: Promise<unknown> = Promise.resolve();
  /** Runs `work` once everything sent before it has finished, and holds what is sent after it until it has: for a serial dialect. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = last.then(work);
    last = next.catch(() => undefined);
    return next;
  };
  const query: Query = dialect.serial ? (sql, params) => exclusive(() => given(sql, params)) : given;
  const { events, hits, changes, state } = tables;
  const runOn =
    (via: Query) =>
    async (sql: string, params: Params | SqlValue[] = []): Promise<ReadonlyArray<Record<string, unknown>>> => {
      const values = Array.isArray(params) ? params : params.values;
      const ready = dialect.finish ? dialect.finish(sql, values) : { sql, params: values };
      return (await via(ready.sql, ready.params)).rows;
    };
  const run = runOn(query);
  type Run = typeof run;
  /** Statements that must all happen or none, in one transaction that nothing else is sent during. */
  const atomically = <T>(work: (run: Run) => Promise<T>): Promise<T> =>
    exclusive(async () => {
      const step = runOn(given);
      await step("BEGIN TRANSACTION");
      try {
        const result = await work(step);
        await step("COMMIT");
        return result;
      } catch (error) {
        await step("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });

  // The floor this store's hits were written with, read once: a store opened with another would miscount. Without hits, any gate counts.
  let recorded: Promise<number> | undefined;
  const floorOf = (): Promise<number> =>
    (recorded ??= (async () => {
      if (!dialect.hits) {
        return 0;
      }
      const [row] = await run(`SELECT value FROM ${state} WHERE key = ${dialect.placeholder(1)}`, [FLOOR_KEY]);
      const kept = row === undefined ? undefined : Number(dialect.parse(row.value));
      if (kept !== undefined && hitFloor !== undefined && kept !== hitFloor) {
        throw new Error(`This store's hits were written with a hitFloor of ${kept}, not ${hitFloor}. Pass ${kept}, or drop the ${hits} table (and on SQLite its triggers) and the "${FLOOR_KEY}" state, then run migrate() to write them again.`);
      }
      return kept ?? tables.hitFloor;
    })().catch((error: unknown) => {
      recorded = undefined;
      throw error;
    }));

  /** `where` as conditions on the events table `e`. */
  const tagged = (params: Params, where: TagFilter): string[] => Object.entries(where).map(([key, value]) => `${key === partition ? "e.part" : dialect.text("e.tags", params.key(key))} = ${params.text(value)}`);
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
    const earlier = `SELECT 1 FROM ${events} o WHERE o.schema_id = e.schema_id AND o.id = e.id AND o.at_ms >= ${params.number(rule.from)} AND o.at_ms < ${params.number(rule.to)} AND (o.labeler = ${params.text(rule.prefer)} OR o.at_ms < e.at_ms OR (o.at_ms = e.at_ms AND o.seq < e.seq))`;
    return [...conditions, `e.at_ms >= ${params.number(rule.from)}`, `e.at_ms < ${params.number(rule.to)}`, `(e.labeler = ${params.text(rule.prefer)} OR NOT EXISTS (${earlier}))`];
  };
  /** Conditions on the hits table `h` that every hit of an event the read keeps also meets, so an index narrows the hits before they meet the events. */
  const hitScope = (params: Params, query: Pick<EventQuery, "schema" | "labeler" | "oneAnswer" | "where">, from: number | undefined, to: number | undefined): string[] => {
    const lower = Math.max(from ?? -Infinity, query.labeler === undefined ? (query.oneAnswer?.from ?? -Infinity) : -Infinity);
    const upper = Math.min(to ?? Infinity, query.labeler === undefined ? (query.oneAnswer?.to ?? Infinity) : Infinity);
    const workspace = partition === undefined ? undefined : query.where?.[partition];
    return [
      ...(query.schema === undefined ? [] : [`h.schema_id = ${params.text(query.schema)}`]),
      ...(query.labeler === undefined ? [] : [`h.labeler = ${params.text(query.labeler)}`]),
      ...(workspace === undefined ? [] : [`h.part = ${params.text(workspace)}`]),
      ...(lower === -Infinity ? [] : [`h.at_ms >= ${params.number(lower)}`]),
      ...(upper === Infinity ? [] : [`h.at_ms < ${params.number(upper)}`]),
    ];
  };
  /** A signal part at its gate, read from the event's JSON, as 1 or 0: for reads whose gates are below the floor. */
  const atGate = (params: Params, key: string, gate: number): string => `CASE WHEN COALESCE(${dialect.number("e.signals", params.key(key))}, 0) >= ${params.number(gate)} THEN 1 ELSE 0 END`;

  const countOnce = async (query: CountQuery, floor: number): Promise<CountRow[]> => {
    const params = paramsOf(dialect);
    // Each signal part is one bit of a mask, 60 to a column, so the rows sorted per customer stay narrow.
    const parts = new Map<string, number>();
    const partsOf = (signal: string): number[] =>
      signal.split("&").map((key) => {
        const gate = query.gates?.[key] ?? 0.5;
        if (dialect.hits && !(gate >= floor)) {
          throw belowFloor(key, gate, floor);
        }
        const id = `${gate}\n${key}`;
        if (!parts.has(id)) {
          parts.set(id, parts.size);
        }
        return parts.get(id)!;
      });
    const signals = query.signals.map((signal) => (signal === "*" ? [] : partsOf(signal)));
    const gated = [...parts.keys()].map((id) => {
      const [gate, ...key] = id.split("\n");
      return { key: key.join("\n"), gate: Number(gate) };
    });
    const chunks = Array.from({ length: Math.ceil(gated.length / 60) }, (_, m) => gated.slice(m * 60, m * 60 + 60));
    // A mask's bits from an event's hits, as an aggregate over them: each hit sets the bits of the parts on its key that it reaches.
    const hitMask = (chunk: typeof gated): string => {
      const byKey = new Map<string, string[]>();
      chunk.forEach(({ key, gate }, n) => byKey.set(key, [...(byKey.get(key) ?? []), `CASE WHEN h.p >= ${params.number(gate)} THEN ${bitOf(n)} ELSE 0 END`]));
      return `CAST(SUM(CASE h.key ${[...byKey].map(([key, bits]) => `WHEN ${params.text(key)} THEN ${bits.join(" + ")}`).join(" ")} ELSE 0 END) AS BIGINT)`;
    };
    const bit = (n: number): string => `((m${Math.floor(n / 60)} >> ${n % 60}) & 1)`;
    const groupBy = query.groupBy;
    const groupColumns = !groupBy ? [] : "tags" in groupBy ? groupBy.tags.map((key, n) => `${dialect.text("e.tags", params.key(key))} AS g${n}`) : [`${dialect.without("e.tags", groupBy.tagsExcept, params.add)} AS g0`];
    const groups = groupColumns.map((_, n) => `g${n}`);
    const conditions = [...answers(params, query), ...(query.where ? tagged(params, query.where) : []), ...(query.exclude ? [`${matches(params, query.exclude)} = 0`] : [])];
    // Each event in reach is read once, then placed in the windows that hold it (see `runsOf`).
    const { runs, places } = runsOf(query.windows);
    if (runs.length === 0) {
      return countedNothing(query);
    }
    const from = Math.min(...runs.map((run) => run.s));
    const to = Math.max(...runs.map((run) => run.e));
    conditions.push(`e.at_ms >= ${params.number(from)}`, `e.at_ms < ${params.number(to)}`);
    let joined = "";
    let maskColumns: string[];
    if (!dialect.hits) {
      maskColumns = chunks.map((chunk, m) => `CAST(${chunk.map(({ key, gate }, n) => `${atGate(params, key, gate)} * ${bitOf(n)}`).join(" + ")} AS BIGINT) AS m${m}`);
    } else if (dialect.hits.lookup === "join" && chunks.length > 0) {
      const keys = [...new Set(gated.map(({ key }) => key))].map((key) => params.text(key));
      const scope = [...hitScope(params, query, from, to), `h.key IN (${keys.join(", ")})`];
      joined = ` LEFT JOIN (SELECT h.seq AS seq, ${chunks.map((chunk, m) => `${hitMask(chunk)} AS m${m}`).join(", ")} FROM ${hits} h WHERE ${scope.join(" AND ")} GROUP BY h.seq) hm ON hm.seq = e.seq`;
      maskColumns = chunks.map((_, m) => `COALESCE(hm.m${m}, 0) AS m${m}`);
    } else {
      maskColumns = chunks.map((chunk, m) => `COALESCE((SELECT ${hitMask(chunk)} FROM ${hits} h WHERE h.seq = e.seq), 0) AS m${m}`);
    }
    const scan = `SELECT ${["e.at_ms AS at_ms", "e.seq AS seq", "e.unit AS unit", ...groupColumns, ...maskColumns].join(", ")} FROM ${events} e${joined} WHERE ${conditions.join(" AND ")}${dialect.fence}`;
    const table = dialect.rows(params.add(JSON.stringify(runs)), "ru", { o: "integer", s: "double", l: "double", n: "integer", e: "double" });
    const product = (ids: number[]): string => (ids.length === 0 ? "1" : ids.map(bit).join(" * "));
    // Where the database can OR bits in an aggregate, each signal is one bit of a column, so a customer's row in a window carries a few integers, not one per signal.
    const said = dialect.bitOr ? Array.from({ length: Math.ceil(signals.length / 60) }, (_, k) => `CAST(${signals.slice(k * 60, k * 60 + 60).map((ids, s) => `${product(ids)} * ${bitOf(s)}`).join(" + ")} AS BIGINT) AS s${k}`) : [];
    const placed = `SELECT ru.o + CASE WHEN ru.n = 1 THEN 0 ELSE ${dialect.whole("(x.at_ms - ru.s) / ru.l")} END AS win, ${["x.at_ms", "x.seq", "x.unit", ...groups.map((g) => `x.${g}`), ...(dialect.bitOr ? said : chunks.map((_, m) => `x.m${m}`))].join(", ")} FROM ru JOIN (${scan}) x ON x.at_ms >= ru.s AND x.at_ms < ru.e`;
    const saidBit = (s: number): string => `((s${Math.floor(s / 60)} >> ${s % 60}) & 1)`;
    const keys = ["win", ...groups].join(", ");
    // The windows worked out once, not again for every event that meets them.
    const r = `ru AS MATERIALIZED (SELECT * FROM ${table}), r AS (${placed})`;
    const perUnit = dialect.bitOr
      ? `u AS (SELECT ${keys}, COUNT(*) AS n, MIN(at_ms) AS first${said.map((_, k) => `, ${dialect.bitOr!(`s${k}`)} AS s${k}`).join("")} FROM r GROUP BY ${keys}, unit, CASE WHEN unit IS NULL THEN seq END) SELECT ${keys}, COUNT(*) AS total, SUM(n) AS n, MIN(first) AS first${signals.map((_, s) => `, SUM(${saidBit(s)}) AS y${s}`).join("")} FROM u GROUP BY ${keys}`
      : `u AS (SELECT ${keys}, COUNT(*) AS n, MIN(at_ms) AS first${signals.map((ids, s) => `, MAX(${product(ids)}) AS y${s}`).join("")} FROM r GROUP BY ${keys}, unit, CASE WHEN unit IS NULL THEN seq END) SELECT ${keys}, COUNT(*) AS total, SUM(n) AS n, MIN(first) AS first${signals.map((_, s) => `, SUM(y${s}) AS y${s}`).join("")} FROM u GROUP BY ${keys}`;
    const sql =
      query.per === "event"
        ? `WITH ${r} SELECT ${keys}, COUNT(*) AS total, COUNT(*) AS n, MIN(at_ms) AS first${signals.map((ids, s) => `, SUM(${dialect.bitOr ? saidBit(s) : product(ids)}) AS y${s}`).join("")} FROM r GROUP BY ${keys}`
        : `WITH ${r}, ${perUnit}`;
    if (params.values.length > maxParams && query.signals.length > 1) {
      // Too many parameters for one statement (D1 takes 100): count the signals in two halves.
      const half = Math.ceil(query.signals.length / 2);
      const [a, b] = await Promise.all([countOnce({ ...query, signals: query.signals.slice(0, half) }, floor), countOnce({ ...query, signals: query.signals.slice(half) }, floor)]);
      return a.map((row, n) => ({ ...row, yes: { ...row.yes, ...b[n]!.yes } }));
    }
    const rows = (await run(sql, params)).flatMap((row) => {
      const yes = Object.fromEntries(query.signals.map((signal, s) => [signal, Number(row[`y${s}`] ?? 0)]));
      const group: Tags | undefined = !groupBy ? undefined : "tags" in groupBy ? Object.fromEntries(groupBy.tags.map((key, n) => [key, (row[`g${n}`] as string | null) ?? null])) : (dialect.parse(row.g0) as Tags);
      return places[Number(row.win)]!.map((window) => ({ window, first: Number(row.first), ...(group ? { group } : {}), total: Number(row.total), yes, events: Number(row.n) }));
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
      at: Number(row.at_ms),
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
      recorded = undefined;
    },
    append: async (added) => {
      // The first copy of each in this batch: a store keeps the first, and so must one insert.
      const seen = new Set<string>();
      const fresh = added.filter((event) => !seen.has(eventKey(event)) && seen.add(eventKey(event)));
      if (fresh.length === 0) {
        return;
      }
      const inOneGo = dialect.hits?.together === "transaction";
      const floor = inOneGo ? await floorOf() : 0;
      const write = async (step: Run): Promise<void> => {
        for (let start = 0; start < fresh.length; start += batch) {
          const rows = fresh.slice(start, start + batch).map((event, i) => ({ i, schema_id: event.schema, id: event.id, labeler: event.labeler, at_ms: event.at, unit: event.unit ?? null, tags: event.tags ? sortedTags(event.tags) : null, signals: event.signals, probability: event.probability, text: event.text ?? null, context: event.context ?? null, part: partition === undefined ? null : (event.tags?.[partition] ?? null) }));
          const params = paramsOf(dialect);
          const source = dialect.rows(params.add(JSON.stringify(rows)), "x", EVENT_COLUMNS);
          const columns = Object.keys(EVENT_COLUMNS).filter((column) => column !== "i");
          const insert = `INSERT INTO ${events} (${columns.join(", ")}) SELECT ${columns.map((column) => `x.${column}`).join(", ")} FROM ${source} WHERE 1 = 1 ORDER BY x.i ON CONFLICT (schema_id, id, labeler) DO NOTHING`;
          if (!inOneGo) {
            await step(insert, params);
            continue;
          }
          const inserted = (await step(`${insert} RETURNING seq`, params)).map((row) => Number(row.seq));
          if (inserted.length > 0) {
            // One writer, inside one transaction: every event between the first and last new seq is new.
            const more = paramsOf(dialect);
            const added = `(SELECT seq, schema_id, labeler, part, at_ms, signals FROM ${events} WHERE seq >= ${more.integer(Math.min(...inserted))} AND seq <= ${more.integer(Math.max(...inserted))}) e`;
            await step(`INSERT INTO ${hits} (${HIT_COLUMNS}) ${hitsOf(dialect, added, "e", more.number(floor))}`, more);
          }
        }
      };
      // In one transaction, every batch of the call is stored with its hits, or none is.
      await (inOneGo ? atomically(write) : write(run));
    },
    events: async (query = {}) => {
      if (query.limit !== undefined && query.limit <= 0) {
        return [];
      }
      const floor = query.atLeast && dialect.hits ? await floorOf() : 0;
      const params = paramsOf(dialect);
      const conditions = [...answers(params, query)];
      if (query.from !== undefined) {
        conditions.push(`e.at_ms >= ${params.number(query.from)}`);
      }
      if (query.to !== undefined) {
        conditions.push(`e.at_ms < ${params.number(query.to)}`);
      }
      if (query.where) {
        conditions.push(...tagged(params, query.where));
      }
      if (query.atLeast) {
        const entries = query.atLeast.map((entry) => {
          const gates = Object.entries(entry);
          if (gates.length === 0) {
            return "1 = 1";
          }
          // At or above the floor, the hits find the events; below it, only each event's JSON can say.
          if (dialect.hits && gates.every(([, gate]) => gate >= floor)) {
            return `(${gates.map(([key, gate]) => `e.seq IN (SELECT h.seq FROM ${hits} h WHERE ${[...hitScope(params, query, query.from, query.to), `h.key = ${params.text(key)}`, `h.p >= ${params.number(gate)}`].join(" AND ")})`).join(" AND ")})`;
          }
          return `(${gates.map(([key, gate]) => `${atGate(params, key, gate)} = 1`).join(" AND ")})`;
        });
        conditions.push(entries.length === 0 ? "1 = 0" : `(${entries.join(" OR ")})`);
      }
      // Events at the same time come in the order stored; with one answer per event, in the order their first copies were.
      const rule = query.labeler === undefined ? query.oneAnswer : undefined;
      const firstCopy = (column: "at_ms" | "seq"): string =>
        `(SELECT o.${column} FROM ${events} o WHERE o.schema_id = e.schema_id AND o.id = e.id AND o.at_ms >= ${params.number(rule!.from)} AND o.at_ms < ${params.number(rule!.to)} ORDER BY o.at_ms, o.seq LIMIT 1)`;
      // Without one answer per event, time and the order stored are the index's order, so a cut-short read stops early.
      const ranks = rule ? `${firstCopy("at_ms")} AS rank_at, ${firstCopy("seq")} AS rank_seq` : "e.seq AS rank_seq";
      const tie = rule ? ["rank_at", "rank_seq"] : ["rank_seq"];
      const order = query.order ?? "oldest";
      const surest = typeof order === "object" ? `${dialect.least(order.surest.map((key) => `COALESCE(${dialect.number("e.signals", params.key(key))}, 0)`))} AS sureness, ` : "";
      const by = typeof order === "object" ? `sureness DESC, at_ms DESC, ${tie.join(", ")}` : order === "newest" ? `at_ms DESC, ${tie.map((column) => `${column} DESC`).join(", ")}` : `at_ms, ${tie.join(", ")}`;
      const inner = `SELECT e.schema_id, e.id, e.labeler, e.at_ms, e.unit, e.tags, e.signals, e.probability, e.text, e.context, ${surest}${ranks} FROM ${events} e WHERE ${conditions.length === 0 ? "1 = 1" : conditions.join(" AND ")}`;
      const picked = query.onePerUnit ? `SELECT * FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(x.unit, x.id) ORDER BY ${by}) AS place FROM (${inner}) x) y WHERE place = 1` : `SELECT * FROM (${inner}) y`;
      const limit = query.limit === undefined ? "" : ` LIMIT ${params.add(Math.floor(query.limit))}`;
      return (await run(`${picked} ORDER BY ${by}${limit}`, params)).map(fromRow);
    },
    count: async (query) => (query.windows.length === 0 ? [] : countOnce(query, await floorOf())),
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
          const conditions = [`e.schema_id = ${params.text(schema)}`, `e.labeler = ${params.text(String(labeler))}`, ...(from === undefined ? [] : [`e.at_ms >= ${params.number(from)}`]), ...(to === undefined ? [] : [`e.at_ms < ${params.number(to)}`]), ...(where ? tagged(params, where) : [])];
          return `SELECT * FROM (SELECT '${direction}' AS side, e.labeler AS labeler, e.at_ms AS at_ms, e.seq AS seq FROM ${events} e WHERE ${conditions.join(" AND ")} ORDER BY e.at_ms ${direction}, e.seq ${direction} LIMIT 1) ${direction === "ASC" ? "f" : "l"}`;
        }),
      );
      const rows = (await run(ends.join(" UNION ALL "), params)).map((row) => ({ side: String(row.side), labeler: String(row.labeler), at: Number(row.at_ms), seq: Number(row.seq) }));
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
      const conditions = [...(before === undefined ? [] : [`at_ms < ${params.number(before)}`]), ...(unit === undefined ? [] : [`unit = ${params.text(unit)}`])].join(" AND ");
      // Counted just before, so a delete of millions doesn't send millions of rows back.
      const [counted] = await run(`SELECT COUNT(*) AS n FROM ${events} WHERE ${conditions}`, params);
      if (dialect.hits?.together !== "transaction") {
        await run(`DELETE FROM ${events} WHERE ${conditions}`, params);
      } else {
        await atomically(async (step) => {
          await step(`DELETE FROM ${hits} WHERE seq IN (SELECT seq FROM ${events} WHERE ${conditions})`, params);
          await step(`DELETE FROM ${events} WHERE ${conditions}`, params);
        });
      }
      return Number(counted?.n ?? 0);
    },
    recordChange: async (change) => {
      const params = paramsOf(dialect);
      await run(`INSERT INTO ${changes} (id, at_ms, change) VALUES (${params.text(change.id)}, ${params.number(change.at)}, ${dialect.json(params.add(JSON.stringify(change)))}) ON CONFLICT (id) DO UPDATE SET at_ms = excluded.at_ms, change = excluded.change`, params);
    },
    changes: async ({ from, to } = {}) => {
      const params = paramsOf(dialect);
      const conditions = [...(from === undefined ? [] : [`at_ms >= ${params.number(from)}`]), ...(to === undefined ? [] : [`at_ms < ${params.number(to)}`])];
      return (await run(`SELECT change FROM ${changes}${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY at_ms, seq`, params)).map((row) => dialect.parse(row.change) as Change);
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
