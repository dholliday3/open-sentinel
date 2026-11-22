// Any chat model behind an OpenAI-compatible endpoint, as a labeler. It gives hard answers with
// no probabilities, so gates other than 0.5 mean nothing for it. Useful as a second reader, as a
// reference to check a cheaper labeler against, or where no decision model is allowed.
import { postJson } from "../http.ts";
import type { Fetch } from "../http.ts";
import type { Labeler } from "../labeler.ts";
import type { Answer, WireQuestion } from "../schema.ts";

const SYSTEM = `You label one piece of text. Answer every question exactly as worded, about the state you are given.
"boolean" questions: true or false. "choice" questions: one of the option keys. "score" questions: the 0-based index of the level.
Reply with only JSON: {"<question key>": <answer>, ...} with every key.`;

const toAnswer = (key: string, question: WireQuestion, value: unknown): Answer => {
  if (question.type === "boolean") {
    if (value !== true && value !== false && value !== "true" && value !== "false") {
      throw new Error(`"${key}" wasn't answered true or false: ${JSON.stringify(value ?? null)}`);
    }
    return { type: "boolean", probability: value === true || value === "true" ? 1 : 0 };
  }
  if (question.type === "choice") {
    if (typeof value !== "string") {
      throw new Error(`"${key}" wasn't answered with one of its options: ${JSON.stringify(value ?? null)}`);
    }
    return { type: "choice", choice: value };
  }
  // A missing or null level must not read as level 0.
  const level = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(level)) {
    throw new Error(`"${key}" wasn't answered with a level: ${JSON.stringify(value ?? null)}`);
  }
  return { type: "score", score: level };
};

/**
 * A chat model as a labeler. `baseUrl` is the API root that has `/chat/completions` under it
 * (`https://ai-gateway.vercel.sh/v1`, `https://api.openai.com/v1`, a local server).
 */
export const chatLabeler = ({ model, apiKey, baseUrl, fetch: send = fetch, maxTokens = 2000 }: { model: string; apiKey: string; baseUrl: string; fetch?: Fetch; maxTokens?: number }): Labeler => ({
  id: model,
  probability: "none",
  label: async (state, questions) => {
    const reply = (await postJson(send, `${baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `State:\n${JSON.stringify(state, null, 2)}\n\nQuestions:\n${JSON.stringify(questions, null, 2)}` },
        ],
      },
    })) as { choices?: Array<{ message?: { content?: string } }>; usage?: { market_cost?: number; cost?: number } } | null;
    const text = reply?.choices?.[0]?.message?.content ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) {
      throw new Error(`${model} didn't reply with JSON: ${text.slice(0, 200)}`);
    }
    const given = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const cost = Number(reply?.usage?.market_cost ?? reply?.usage?.cost);
    return {
      answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, toAnswer(key, question, given[key])])),
      ...(Number.isFinite(cost) ? { cost } : {}),
    };
  },
});
