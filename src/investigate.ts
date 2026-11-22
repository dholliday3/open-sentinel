// The on-call step: a group of alerts goes to a chat model that can use the tools in tools.ts,
// and comes back as a report a person can act on. The cheap labeler read everything; this reads
// only what it flagged.
import { postJson } from "./http.ts";
import type { Fetch } from "./http.ts";
import type { AlertGroup } from "./monitor.ts";
import type { Notice } from "./pipeline.ts";
import type { Tool } from "./tools.ts";

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as a JSON string, as chat models give them. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** One turn of a chat model that can call tools. Wrap any provider's API to fit. */
export type ChatModel = (messages: readonly ChatMessage[], tools: Readonly<Record<string, Tool>>) => Promise<{ content: string; toolCalls: ToolCall[]; cost?: number }>;

/** A chat model behind an OpenAI-compatible endpoint. `baseUrl` is the root with `/chat/completions` under it. */
export const openAiChat = ({ model, apiKey, baseUrl, fetch: send = fetch, maxTokens = 3000 }: { model: string; apiKey: string; baseUrl: string; fetch?: Fetch; maxTokens?: number }): ChatModel => {
  return async (messages, tools) => {
    const reply = (await postJson(send, `${baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        })),
        // Left out when there are none: some providers refuse an empty list.
        ...(Object.keys(tools).length === 0
          ? {}
          : {
              tools: Object.entries(tools).map(([name, tool]) => ({
                type: "function",
                function: {
                  name,
                  description: tool.description,
                  parameters: { type: "object", properties: Object.fromEntries(Object.entries(tool.input).map(([key, { type, description }]) => [key, { type, description }])), required: Object.keys(tool.input).filter((key) => !tool.input[key]!.optional) },
                },
              })),
            }),
      },
    })) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; usage?: { market_cost?: number; cost?: number } } | null;
    const message = reply?.choices?.[0]?.message;
    const cost = Number(reply?.usage?.market_cost ?? reply?.usage?.cost);
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      ...(Number.isFinite(cost) ? { cost } : {}),
    };
  };
};

export interface Report {
  /**
   * incident: broken or harming people, act now. watch: a real shift someone should own.
   * benign: explained and harmless. noise: no real change. inconclusive: the data doesn't say.
   */
  verdict: "incident" | "watch" | "benign" | "noise" | "inconclusive";
  title: string;
  whatPeopleReport: string;
  affected: string;
  startedAt: string | null;
  likelyCause: string;
  /** Event ids the report rests on. */
  evidence: string[];
  nextStep: string;
  confidence: number;
}

const INSTRUCTIONS = `A monitor alerted. Investigate as an on-call engineer would: look at the signals, split them by tag, read the actual messages, check the change log over the whole period the shift could have started in, and decide.
Verdicts: "incident" (something is broken or harming people and needs action now), "watch" (a real shift in what people say that someone should own, not an outage), "benign" (explained and harmless, such as questions after an announcement), "noise" (no real change), "inconclusive" (the data doesn't settle it; say what would).
Be specific: what people report in their own words, who is affected (which tags), when it started, and the most likely cause. Use only what the tools show. A change that shipped near the time is a lead, not a cause, until the messages match what it touched. If two separate things are going on, say so.
When done, reply with only JSON:
{"verdict": "...", "title": "...", "whatPeopleReport": "...", "affected": "...", "startedAt": "ISO time or null", "likelyCause": "...", "evidence": ["event ids"], "nextStep": "...", "confidence": 0 to 1}`;

const VERDICTS: ReadonlyArray<Report["verdict"]> = ["incident", "watch", "benign", "noise", "inconclusive"];

/** Reads the model's reply into a report. Null unless it gave one of the five verdicts. */
const parseReport = (text: string): Report | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  let given: Record<string, unknown>;
  try {
    given = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = VERDICTS.find((known) => known === given.verdict);
  if (!verdict) {
    return null;
  }
  const words = (value: unknown): string => (typeof value === "string" ? value : "");
  const confidence = Number(given.confidence);
  return {
    verdict,
    title: words(given.title),
    whatPeopleReport: words(given.whatPeopleReport),
    affected: words(given.affected),
    startedAt: typeof given.startedAt === "string" ? given.startedAt : null,
    likelyCause: words(given.likelyCause),
    evidence: Array.isArray(given.evidence) ? given.evidence.filter((id): id is string => typeof id === "string") : [],
    nextStep: words(given.nextStep),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  };
};

const unsettled = (why: string): Report => ({ verdict: "inconclusive", title: "The investigation didn't finish", whatPeopleReport: "", affected: "", startedAt: null, likelyCause: "", evidence: [], nextStep: why, confidence: 0 });

/**
 * Investigates one group of alerts. `about` says what the stream is, in a sentence. `leads` are
 * the notices `createWatch` produced for these alerts, whose ranked changes give the model a
 * head start. Stops after `maxSteps` rounds of tool calls; a model that never reaches a verdict
 * yields "inconclusive" rather than an error.
 */
export const investigate = async (group: AlertGroup, { chat, tools, about, leads = [], maxSteps = 12 }: { chat: ChatModel; tools: Readonly<Record<string, Tool>>; about: string; leads?: readonly Notice[]; maxSteps?: number }): Promise<{ report: Report; steps: number; cost: number }> => {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const fired = group.alerts.map((alert) => ({ monitor: alert.monitor, at: iso(alert.at), ...(alert.signal ? { signal: alert.signal } : {}), ...(alert.where ? { where: alert.where } : {}), ...(alert.event ? { event: alert.event.id } : {}), ...alert.detail }));
  const suspects = leads.flatMap((notice) => (notice.suspects?.[0] ? [{ for: notice.alert.monitor, change: notice.suspects[0].change.what, at: iso(notice.suspects[0].change.at), confident: notice.confident === true }] : []));
  const messages: ChatMessage[] = [
    { role: "system", content: `You are on call for ${about}. Every event in it is labeled with typed signals.\n${INSTRUCTIONS}` },
    { role: "user", content: `Alert group ${group.id} (${group.severity}), first alert ${iso(group.firstAt)}.\nAlerts:\n${JSON.stringify(fired.slice(0, 20), null, 1)}${suspects.length > 0 ? `\nChanges ranked as possibly related (leads only):\n${JSON.stringify(suspects.slice(0, 5), null, 1)}` : ""}` },
  ];
  let cost = 0;
  for (let steps = 0; ; steps += 1) {
    const turn = await chat(messages, steps < maxSteps ? tools : {});
    cost += turn.cost ?? 0;
    messages.push({ role: "assistant", content: turn.content, ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}) });
    if (turn.toolCalls.length === 0) {
      return { report: parseReport(turn.content) ?? unsettled("The model gave no verdict. Read the alerts and messages yourself."), steps, cost };
    }
    if (steps >= maxSteps) {
      return { report: unsettled(`Stopped after ${maxSteps} rounds of tool calls without a verdict.`), steps, cost };
    }
    for (const call of turn.toolCalls) {
      let result: unknown;
      try {
        const tool = tools[call.name];
        result = tool ? await tool.run(JSON.parse(call.arguments || "{}") as Record<string, unknown>) : { error: `No tool named ${call.name}` };
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result).slice(0, 12_000) });
    }
    if (steps + 1 >= maxSteps) {
      messages.push({ role: "user", content: "Out of steps. Give your JSON verdict now." });
    }
  }
};
