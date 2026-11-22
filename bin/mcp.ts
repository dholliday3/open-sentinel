#!/usr/bin/env node
// An MCP server over a folder written by `jsonlStore`:
//
//   node bin/mcp.ts <store folder> [schema id]
//
// Every call sees what is in the folder at that moment (`jsonlStore` reads again whatever has
// changed), so it can sit beside a running pipeline. It serves one schema: the one named, or the
// one the newest stored event was labeled under. Signal keys are taken from the stored events, and
// every gate is 0.5; to use a schema's own gates, build the server yourself with `mcpServer` and
// `toolsFor`.
import { jsonlStore, latestAnswers, mcpServer, serveStdio, toolsFor, viewOf } from "../src/index.ts";

const [dir, named] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: node bin/mcp.ts <store folder> [schema id]");
  process.exit(1);
}

const store = jsonlStore(dir);
const schema = named ?? (await store.events()).at(-1)?.schema;
// Answers under another wording, or the same event answered twice, must not be counted together.
const read = async () => ({ view: viewOf(latestAnswers(await store.events(schema === undefined ? {} : { schema }))), changes: await store.changes() });
const { view } = await read();
const signals = [...new Set(view.events.slice(-500).flatMap((event) => Object.keys(event.signals)))].filter((key) => !key.endsWith(".second"));

await serveStdio(mcpServer({ name: "open-sentinel", tools: toolsFor(read, { signals }) }));
