import http from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptedCall = { name: string; input: Record<string, unknown> };

/**
 * A fake LLM API. Each request gets the next scripted turn: a list of tool calls (or none, meaning
 * a plain text reply that ends the run). Speaks both the Anthropic Messages streaming protocol and
 * OpenAI Chat Completions. Records every request body for assertions.
 */
export async function startMockLLM(turns: ScriptedCall[][]) {
  const requests: any[] = [];
  let i = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = JSON.parse(body || "{}");
    requests.push({ url: req.url, body: json });
    const calls = turns[i++] ?? [];

    if (req.url?.endsWith("/messages")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", {
        message: { id: `msg_${i}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } },
      });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: `turn ${i}` } });
      send("content_block_stop", { index: 0 });
      calls.forEach((c, n) => {
        const idx = n + 1;
        send("content_block_start", { index: idx, content_block: { type: "tool_use", id: `toolu_${i}_${n}`, name: c.name, input: {} } });
        send("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
        send("content_block_stop", { index: idx });
      });
      send("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } });
      send("message_stop", {});
      return res.end();
    }

    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          id: `cmpl_${i}`,
          object: "chat.completion",
          created: 0,
          model: json.model,
          choices: [
            {
              index: 0,
              finish_reason: calls.length ? "tool_calls" : "stop",
              message: {
                role: "assistant",
                content: `turn ${i}`,
                tool_calls: calls.length
                  ? calls.map((c, n) => ({ id: `call_${i}_${n}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }))
                  : undefined,
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 42, total_tokens: 142, prompt_tokens_details: { cached_tokens: 50 } },
        }),
      );
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}
