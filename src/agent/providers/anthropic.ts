import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOf, runTool } from "../tools.ts";
import { emptyUsage, type AgentProvider, type AgentRunInput, type AgentRunResult } from "../types.ts";
import type { ModelConfig } from "../../models.ts";

type AnthropicConfig = Extract<ModelConfig, { provider: "anthropic" }>;

export class AnthropicProvider implements AgentProvider {
  private client: Anthropic;

  constructor(private cfg: AnthropicConfig) {
    this.client = new Anthropic({
      ...(cfg.apiKeyEnv ? { apiKey: process.env[cfg.apiKeyEnv] } : {}),
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }

  async run({ system, prompt, tools, ctx, maxTurns, deadline, log }: AgentRunInput): Promise<AgentRunResult> {
    // Eager input streaming lets large write_file bodies stream as they are generated. The server then
    // skips input validation, so every input is validated client-side in runTool(). Proxies may reject
    // the field, so it's only on when talking to the real API.
    const eager = !this.cfg.baseURL;
    const apiTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: jsonSchemaOf(t.schema) as Anthropic.Tool.InputSchema,
      ...(eager ? { eager_input_streaming: true } : {}),
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const usage = emptyUsage();
    let turns = 0;
    let jsonRetries = 0;

    while (true) {
      if (turns >= maxTurns) return { stopReason: "max_turns", turns, usage };
      if (Date.now() > deadline) return { stopReason: "timeout", turns, usage };

      let message: Anthropic.Message;
      try {
        const stream = this.client.messages.stream({
          model: this.cfg.model,
          max_tokens: this.cfg.maxTokens ?? 64000,
          system,
          tools: apiTools,
          messages,
          // Automatic prompt caching: the conversation prefix is re-sent every turn.
          cache_control: { type: "ephemeral" },
          ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
          ...(this.cfg.extra ?? {}),
        } as Anthropic.MessageStreamParams);
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors (auth, rate limits after the
        // SDK's own retries, bad requests) end the run.
        if (err instanceof Anthropic.APIError) {
          return { stopReason: "error", turns, usage, error: `${err.status ?? ""} ${err.message}`.trim() };
        }
        if (jsonRetries++ >= 2) {
          return { stopReason: "error", turns, usage, error: err instanceof Error ? err.message : String(err) };
        }
        log({ type: "notice", text: "tool input was not parseable JSON; re-issuing the turn" });
        continue;
      }

      turns++;
      const u = message.usage;
      usage.inputTokens += u.input_tokens;
      usage.outputTokens += u.output_tokens;
      usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      log({
        type: "turn",
        turn: turns,
        at: Date.now(),
        stopReason: message.stop_reason ?? "unknown",
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      });
      for (const block of message.content) if (block.type === "text" && block.text.trim()) log({ type: "text", text: block.text });

      // Append the full content (including thinking blocks) so the history stays append-only.
      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") return { stopReason: "refusal", turns, usage };
      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) return { stopReason: "end_turn", turns, usage };

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        log({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        const started = Date.now();
        let r: { output: string; isError: boolean };
        if (message.stop_reason === "max_tokens") {
          // The last tool input was cut off; running it on a truncated object would corrupt files.
          r = {
            output: "Your response hit the output token limit, so this tool call was truncated and not executed. Use smaller steps (e.g. split large files, or use edit_file).",
            isError: true,
          };
        } else {
          r = await runTool(tools, ctx, call.name, call.input);
        }
        log({ type: "tool_result", id: call.id, name: call.name, output: r.output, isError: r.isError, ms: Date.now() - started });
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.output, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      if (ctx.finished) return { stopReason: "finished", turns, usage };
    }
  }
}
