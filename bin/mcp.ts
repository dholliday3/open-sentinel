#!/usr/bin/env node
// An MCP server over a folder written by `jsonlStore`:
//
//   node bin/mcp.ts <store folder> [schema id]
//
// Every call sees what is in the folder at that moment (`jsonlStore` reads again whatever has
// changed), so it can sit beside a running pipeline. It serves one schema: the one named, or the
// one the newest stored event was labeled under. Signal keys are taken from the newest stored
// events, and every gate is 0.5; to use a schema's own gates, or a database store, build the
// server yourself with `mcpServer`, `toolsFor` and `storeReader`.
import { jsonlStore, mcpServer, serveStdio, storeReader, toolsFor } from "../src/index.ts";

const [dir, named] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: node bin/mcp.ts <store folder> [schema id]");
  process.exit(1);
}

const store = jsonlStore(dir);
const schema = named ?? (await store.events({ order: "newest", limit: 1 }))[0]?.schema ?? "";
// One answer per event, under one wording: a new reader each call, so it sees what was added since.
const read = async () => ({ reader: storeReader(store, { schema }), changes: await store.changes() });
const newest = await (await read()).reader.events({ from: -Infinity, to: Infinity, order: "newest", limit: 500 });
const signals = [...new Set(newest.reverse().flatMap((event) => Object.keys(event.signals)))].filter((key) => !key.endsWith(".second"));

await serveStdio(mcpServer({ name: "open-sentinel", tools: toolsFor(read, { signals }) }));
