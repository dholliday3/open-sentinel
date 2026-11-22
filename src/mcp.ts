// A small Model Context Protocol server, so any MCP client (an agent, an IDE) can use the tools in
// tools.ts. It speaks JSON-RPC 2.0, one message per line on standard input and output, and
// implements the three calls a tool server needs: initialize, tools/list and tools/call.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Tool } from "./tools.ts";

interface Request {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

type Response = { jsonrpc: "2.0"; id: string | number; result: unknown } | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

// The protocol versions this server speaks, newest first. All three share the calls it implements.
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** A server over some tools. `handle` takes one parsed message and returns the reply, or nothing for a notification. */
export const mcpServer = ({ name, version = "0.0.0", tools }: { name: string; version?: string; tools: Readonly<Record<string, Tool>> }): { handle(message: Request): Promise<Response | undefined> } => ({
  handle: async (message) => {
    if (message.id === undefined) {
      return undefined;
    }
    const reply = (result: unknown): Response => ({ jsonrpc: "2.0", id: message.id!, result });
    switch (message.method) {
      case "initialize": {
        const asked = message.params?.protocolVersion;
        // The client's version when this server speaks it, otherwise the newest it does: the client then decides whether to carry on.
        return reply({ protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name, version } });
      }
      case "ping": {
        return reply({});
      }
      case "tools/list": {
        return reply({
          tools: Object.entries(tools).map(([toolName, tool]) => ({
            name: toolName,
            description: tool.description,
            inputSchema: {
              type: "object",
              properties: Object.fromEntries(Object.entries(tool.input).map(([key, { type, description }]) => [key, { type, description }])),
              required: Object.keys(tool.input).filter((key) => !tool.input[key]!.optional),
            },
          })),
        });
      }
      case "tools/call": {
        const tool = tools[String(message.params?.name)];
        if (!tool) {
          return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `No tool named ${String(message.params?.name)}` } };
        }
        try {
          const result = await tool.run((message.params?.arguments ?? {}) as Record<string, unknown>);
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
        } catch (error) {
          // A tool that fails is a result the client can read and correct, not a protocol error.
          return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default: {
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
      }
    }
  },
});

/** Serves over standard input and output until input ends. */
export const serveStdio = async (server: ReturnType<typeof mcpServer>, { input = process.stdin, output = process.stdout }: { input?: Readable; output?: Writable } = {}): Promise<void> => {
  for await (const line of createInterface({ input })) {
    if (line.trim() === "") {
      continue;
    }
    let reply: Response | undefined;
    try {
      reply = await server.handle(JSON.parse(line) as Request);
    } catch {
      reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (reply) {
      output.write(`${JSON.stringify(reply)}\n`);
    }
  }
};
