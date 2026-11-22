// One JSON POST with retries, shared by everything that calls a model or a webhook.

export type Fetch = typeof fetch;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs JSON and returns the reply, parsed when it is JSON. Retries a busy or failing server (429
 * and 5xx) with backoff, and throws with the status and the start of the reply on anything else.
 */
export const postJson = async (send: Fetch, url: string, { headers = {}, body, retries = 3, backoffMs = 500 }: { headers?: Record<string, string>; body: unknown; retries?: number; backoffMs?: number }): Promise<unknown> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (response.ok) {
      const text = await response.text();
      // Webhooks often answer "ok": a reply that isn't JSON comes back as the text it is.
      try {
        return text === "" ? null : (JSON.parse(text) as unknown);
      } catch {
        return text;
      }
    }
    const reply = await response.text();
    if (attempt >= retries || (response.status !== 429 && response.status < 500)) {
      throw new Error(`${url} answered ${response.status}: ${reply.slice(0, 300)}`);
    }
    await sleep(backoffMs * 2 ** attempt);
  }
};
