// Decision models on the Vercel AI Gateway: TypeSafe's Jev, and the others the gateway lists
// with type "decision". They answer typed questions with their own probabilities.
import { postJson } from "../http.ts";
import type { Fetch } from "../http.ts";
import type { Labeler, LabelResult } from "../labeler.ts";

/**
 * A decision model through the gateway. Give `model` an exact version (`typesafe-ai/jev-1.14.0`):
 * an unversioned id can change models, and on the gateway can change who processes the text.
 */
export const decisionLabeler = ({ model, apiKey, baseUrl = "https://ai-gateway.vercel.sh", fetch: send = fetch, retries = 3 }: { model: string; apiKey: string; baseUrl?: string; fetch?: Fetch; retries?: number }): Labeler => ({
  id: model,
  probability: "native",
  label: async (state, questions) => {
    const reply = (await postJson(send, `${baseUrl}/v4/ai/decision-model`, {
      headers: {
        "ai-decision-model-specification-version": "4",
        "ai-gateway-auth-method": "api-key",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-model-id": model,
        authorization: `Bearer ${apiKey}`,
      },
      body: { state, questions },
      retries,
    })) as { answers?: LabelResult["answers"]; providerMetadata?: { gateway?: { cost?: string } } } | null;
    if (!reply?.answers) {
      throw new Error(`${model} returned no answers`);
    }
    const cost = Number(reply.providerMetadata?.gateway?.cost);
    return { answers: reply.answers, ...(Number.isFinite(cost) ? { cost } : {}) };
  },
});
