// A store in three files in one folder: `events.jsonl` and `changes.jsonl`, appended to, and
// `state.json`. For one process at a time: a small deployment, a backfill, an example. It keeps
// everything in memory.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventKey, memoryStore } from "../store.ts";
import type { Store } from "../store.ts";
import type { Change, Json, LabeledEvent } from "../types.ts";

const readLines = <Row>(path: string): Row[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Row)
    : [];

const lines = (rows: readonly unknown[]): string => (rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

export const jsonlStore = (dir: string): Store => {
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  const changesPath = join(dir, "changes.jsonl");
  const statePath = join(dir, "state.json");
  const state: Record<string, Json> = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Json>) : {};
  const memory = memoryStore({ events: readLines<LabeledEvent>(eventsPath), changes: readLines<Change>(changesPath), state });
  return {
    ...memory,
    append: async (added) => {
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
    },
    delete: async (query) => {
      const removed = await memory.delete(query);
      if (removed > 0) {
        // Deleting means gone from the file too, so the file is written again without them.
        writeFileSync(eventsPath, lines(await memory.events()));
      }
      return removed;
    },
    recordChange: async (change) => {
      await memory.recordChange(change);
      // The last line for an id wins when the file is read back.
      appendFileSync(changesPath, lines([change]));
    },
    saveState: async (key, value) => {
      await memory.saveState(key, value);
      state[key] = value;
      writeFileSync(statePath, JSON.stringify(state));
    },
  };
};
