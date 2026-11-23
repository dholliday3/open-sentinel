// A store in three files in one folder: `events.jsonl` and `changes.jsonl`, appended to, and
// `state.json`. The development store: one writer at a time, one process holding everything in
// memory (as `memoryStore` does, and counting as it does). It reads the files again whenever they
// have changed since it last did, so a reader in another process (the MCP server, a long-running
// watch) sees what the writer adds. For more than a few hundred thousand events, or more than one
// writer, use a database store.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventKey, memoryStore } from "../store.ts";
import type { Store } from "../store.ts";
import type { Change, Json, LabeledEvent } from "../types.ts";

const readLines = <Row>(path: string): Row[] => {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, "utf8");
  const rows = content.split("\n").filter((line) => line.trim() !== "");
  return rows.flatMap((line, index) => {
    try {
      return [JSON.parse(line) as Row];
    } catch (error) {
      // A last line with no newline yet is still being written by another process: the next read gets it.
      if (index === rows.length - 1 && !content.endsWith("\n")) {
        return [];
      }
      throw error;
    }
  });
};

const lines = (rows: readonly unknown[]): string => (rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

/** Replaces a file in one step, so a reader never sees it half written. */
const replaceFile = (path: string, content: string): void => {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
};

export const jsonlStore = (dir: string): Store => {
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  const changesPath = join(dir, "changes.jsonl");
  const statePath = join(dir, "state.json");
  // What the three files looked like when they were last read or written here.
  const stamp = (): string =>
    [eventsPath, changesPath, statePath]
      .map((path) => {
        const stats = statSync(path, { throwIfNoEntry: false });
        return stats ? `${stats.ino}:${stats.size}:${stats.mtimeMs}` : "-";
      })
      .join(" ");
  let seen = "";
  let state: Record<string, Json> = {};
  let memory = memoryStore();
  const current = (): Store => {
    const now = stamp();
    if (now !== seen) {
      state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Json>) : {};
      memory = memoryStore({ events: readLines<LabeledEvent>(eventsPath), changes: readLines<Change>(changesPath), state });
      seen = now;
    }
    return memory;
  };
  /** Runs a write against what is on disk now, then notes the files as seen, so this store doesn't read back its own write. */
  const writing = async <Result>(write: (memory: Store) => Promise<Result>): Promise<Result> => {
    const result = await write(current());
    seen = stamp();
    return result;
  };
  return {
    events: (query) => current().events(query),
    count: (query) => current().count(query),
    labelers: (query) => current().labelers(query),
    known: (ids, schema, labeler) => current().known(ids, schema, labeler),
    changes: (query) => current().changes(query),
    loadState: (key) => current().loadState(key),
    append: (added) =>
      writing(async (memory) => {
        const fresh: LabeledEvent[] = [];
        const taken = new Set<string>();
        for (const event of added) {
          const key = eventKey(event);
          if (!taken.has(key) && !(await memory.known([event.id], event.schema, event.labeler)).has(event.id)) {
            fresh.push(event);
            taken.add(key);
          }
        }
        await memory.append(fresh);
        appendFileSync(eventsPath, lines(fresh));
      }),
    delete: (query) =>
      writing(async (memory) => {
        const removed = await memory.delete(query);
        if (removed > 0) {
          // Deleting means gone from the file too, so the file is written again without them.
          replaceFile(eventsPath, lines(await memory.events()));
        }
        return removed;
      }),
    recordChange: (change) =>
      writing(async (memory) => {
        await memory.recordChange(change);
        // The last line for an id wins when the file is read back.
        appendFileSync(changesPath, lines([change]));
      }),
    saveState: (key, value) =>
      writing(async (memory) => {
        await memory.saveState(key, value);
        state[key] = value;
        replaceFile(statePath, JSON.stringify(state));
      }),
  };
};
