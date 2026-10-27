import OpenAI from "openai";
import { jsonSchemaOf, runTool } from "../tools.ts";
import { emptyUsage, type AgentProvider, type AgentRunInput, type AgentRunResult } from "../types.ts";
import type { ModelConfig } from "../../models.ts";

type OpenAIConfig = Extract<ModelConfig, { provider: "openai" }>;

/** Agent loop over any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, vLLM, Ollama, ...). */
export class OpenAICompatProvider implements AgentProvider {
  private client: OpenAI;

  constructor(private cfg: OpenAIConfig) {
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey && !cfg.baseURL) throw new Error(`${cfg.apiKeyEnv} is not set`);
    this.client = new OpenAI({ apiKey: apiKey ?? "unused", ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });
  }

  async run({ system, prompt, tools, ctx, maxTurns, deadline, log }: AgentRunInput): Promise<AgentRunResult> {
    const apiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: jsonSchemaOf(t.schema) },
    }));
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ];
    const usage = emptyUsage();
    let turns = 0;

    while (true) {
      if (turns >= maxTurns) return { stopReason: "max_turns", turns, usage };
      if (Date.now() > deadline) return { stopReason: "timeout", turns, usage };

      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await this.client.chat.completions.create({
          model: this.cfg.model,
          messages,
          tools: apiTools,
          ...(this.cfg.maxTokens ? { max_completion_tokens: this.cfg.maxTokens } : {}),
          ...(this.cfg.extra ?? {}),
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      } catch (err) {
        return { stopReason: "error", turns, usage, error: err instanceof Error ? err.message : String(err) };
      }

      turns++;
      const choice = completion.choices[0];
      const u = completion.usage;
      const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
      const turnUsage = {
        inputTokens: (u?.prompt_tokens ?? 0) - cached,
        outputTokens: u?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
      usage.inputTokens += turnUsage.inputTokens;
      usage.outputTokens += turnUsage.outputTokens;
      usage.cacheReadTokens += turnUsage.cacheReadTokens;
      log({ type: "turn", turn: turns, at: Date.now(), stopReason: choice?.finish_reason ?? "unknown", usage: turnUsage });
      if (!choice) return { stopReason: "error", turns, usage, error: "response had no choices" };

      const msg = choice.message;
      if (msg.content?.trim()) log({ type: "text", text: msg.content });
      messages.push(msg);

      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (calls.length === 0) return { stopReason: "end_turn", turns, usage };

      for (const call of calls) {
        let input: unknown;
        let r: { output: string; isError: boolean };
        const started = Date.now();
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = call.function.arguments;
        }
        log({ type: "tool_call", id: call.id, name: call.function.name, input });
        if (choice.finish_reason === "length") {
          r = { output: "Your response hit the output token limit, so this tool call was truncated and not executed.", isError: true };
        } else if (typeof input === "string") {
          r = { output: `Tool arguments were not valid JSON: ${input.slice(0, 500)}`, isError: true };
        } else {
          r = await runTool(tools, ctx, call.function.name, input);
        }
        log({ type: "tool_result", id: call.id, name: call.function.name, output: r.output, isError: r.isError, ms: Date.now() - started });
        messages.push({ role: "tool", tool_call_id: call.id, content: r.isError ? `ERROR: ${r.output}` : r.output });
      }
      if (ctx.finished) return { stopReason: "finished", turns, usage };
    }
  }
}
