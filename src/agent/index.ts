import type { ModelConfig } from "../models.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { CommandProvider } from "./providers/command.ts";
import { OpenAICompatProvider } from "./providers/openai.ts";
import type { AgentProvider } from "./types.ts";

export function makeProvider(cfg: ModelConfig): AgentProvider {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "openai":
      return new OpenAICompatProvider(cfg);
    case "command":
      return new CommandProvider(cfg);
  }
}
