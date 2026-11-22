import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mcpServer, serveStdio } from "./mcp.ts";
import { jsonlStore } from "./stores/jsonl.ts";
import { stream } from "./testing.ts";
import { HOUR } from "./types.ts";

const tools = {
  add: { description: "Adds two numbers", input: { a: { type: "number", description: "First" }, b: { type: "number", description: "Second", optional: true } }, run: (args) => ({ sum: args.a + (args.b ?? 0) }) },
  fail: { description: "Always fails", input: {}, run: () => { throw new Error("bad time"); } },
};
const server = mcpServer({ name: "test", version: "1.2.3", tools });
const ask = (method, params, id = 1) => server.handle({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

test("initialize, list and call", async () => {
  assert.deepEqual((await ask("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "0" } })).result, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.2.3" } });
  // A version this server doesn't speak is answered with the newest it does, never echoed back.
  assert.equal((await ask("initialize", { protocolVersion: "2099-01-01" })).result.protocolVersion, "2025-06-18");
  assert.equal((await ask("initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion, "2024-11-05");
  assert.equal((await ask("initialize")).result.protocolVersion, "2025-06-18");
  assert.deepEqual((await ask("tools/list")).result.tools[0], { name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number", description: "First" }, b: { type: "number", description: "Second" } }, required: ["a"] } });
  assert.deepEqual((await ask("tools/call", { name: "add", arguments: { a: 2, b: 3 } }, "x")), { jsonrpc: "2.0", id: "x", result: { content: [{ type: "text", text: '{\n "sum": 5\n}' }] } });
  assert.deepEqual((await ask("ping")).result, {});
});

test("a failing tool is a readable result; an unknown tool or method is a protocol error; a notification gets no reply", async () => {
  assert.deepEqual((await ask("tools/call", { name: "fail" })).result, { content: [{ type: "text", text: "bad time" }], isError: true });
  assert.equal((await ask("tools/call", { name: "nope" })).error.code, -32602);
  assert.equal((await ask("resources/list")).error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
});

test("serveStdio answers one message per line and survives a line that isn't JSON", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveStdio(server, { input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { a: 1 } } })}\n`);
  input.write("not json\n\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  await done;
  const replies = output.read().toString().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => [r.id, r.error?.code ?? "ok"]), [[1, "ok"], [null, -32700], [2, "ok"]]);
});

// The official client, a dev dependency (skipped when it isn't installed): it must be able to
// connect to the command-line server, list its tools and call one.
let official;
try {
  official = { ...(await import("@modelcontextprotocol/sdk/client/index.js")), ...(await import("@modelcontextprotocol/sdk/client/stdio.js")) };
} catch {
  official = undefined;
}

test("the official MCP client can use the command-line server", { skip: official ? false : "@modelcontextprotocol/sdk isn't installed: run npm install" }, async () => {
  const { Client, StdioClientTransport } = official;
  const dir = mkdtempSync(join(tmpdir(), "signals-mcp-"));
  const store = jsonlStore(dir);
  const start = Date.UTC(2026, 10, 1);
  await store.append(stream({ start, hours: 48, perHour: 5, signals: { bug: 0.2 } }));
  await store.recordChange({ id: "c1", at: start + HOUR, kind: "deploy", what: "api: renderer v2" });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../bin/mcp.ts", import.meta.url)), dir] }));
  try {
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((tool) => tool.name), ["signal_series", "top_signals", "breakdown", "messages", "changes", "suspects"]);
    assert.match(listed[0].inputSchema.properties.signal.description, /Keys: bug/);
    const result = await client.callTool({ name: "changes", arguments: { from: new Date(start).toISOString(), to: new Date(start + 2 * HOUR).toISOString() } });
    assert.deepEqual(JSON.parse(result.content[0].text), [{ id: "c1", at: "2026-11-01T01:00Z", kind: "deploy", what: "api: renderer v2" }]);
    const bad = await client.callTool({ name: "changes", arguments: { from: "soon", to: "later" } });
    assert.equal(bad.isError, true);
    // The server keeps running beside the pipeline that writes the folder, and sees what it adds.
    await store.recordChange({ id: "c2", at: start + 47 * HOUR, kind: "flag", what: "pdf-v2 on" });
    await store.append([{ id: "late", at: start + 47 * HOUR, text: "the invoice total is wrong", schema: "test@1", labeler: "test-labeler@1", probability: "native", signals: { bug: 0.95 } }]);
    const later = await client.callTool({ name: "changes", arguments: { from: new Date(start).toISOString(), to: new Date(start + 48 * HOUR).toISOString() } });
    assert.deepEqual(JSON.parse(later.content[0].text).map((change) => change.id), ["c1", "c2"]);
    const newest = await client.callTool({ name: "messages", arguments: { signal: "bug", from: new Date(start + 46 * HOUR).toISOString(), to: new Date(start + 48 * HOUR).toISOString() } });
    assert.ok(newest.content[0].text.includes("the invoice total is wrong"), newest.content[0].text.slice(0, 300));
  } finally {
    await client.close();
  }
});
