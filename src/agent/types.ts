import type { ToolContext, ToolSpec } from "./tools.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Normalized transcript events, written to transcript.jsonl for every provider. */
export type LogEvent =
  | { type: "turn"; turn: number; at: number; usage: Usage; stopReason: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean; ms: number }
  | { type: "notice"; text: string };

export interface AgentRunInput {
  system: string;
  prompt: string;
  tools: ToolSpec[];
  ctx: ToolContext;
  maxTurns: number;
  /** Epoch ms after which no new turn is started. */
  deadline: number;
  log: (e: LogEvent) => void;
}

export type StopReason = "finished" | "end_turn" | "max_turns" | "timeout" | "refusal" | "error";

export interface AgentRunResult {
  stopReason: StopReason;
  turns: number;
  usage: Usage;
  error?: string;
}

export interface AgentProvider {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
