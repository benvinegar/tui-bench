import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ROOT } from "./paths.ts";

const Common = {
  /** Human-facing name in reports; defaults to the config key. */
  name: z.string().optional(),
  /** Max agent turns (model responses). */
  maxTurns: z.number().int().positive().optional(),
  /** Wall-clock budget for one generation, in minutes. */
  timeoutMinutes: z.number().positive().optional(),
};

const AnthropicModel = z
  .object({
    provider: z.literal("anthropic"),
    model: z.string(),
    /** output_config.effort: low | medium | high | xhigh | max */
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    maxTokens: z.number().int().positive().optional(),
    apiKeyEnv: z.string().optional(),
    baseURL: z.string().optional(),
    /** Extra request params merged into every messages.stream() call (e.g. thinking config for older models). */
    extra: z.record(z.string(), z.unknown()).optional(),
    ...Common,
  })
  .strict();

const OpenAICompatModel = z
  .object({
    /** Any OpenAI-compatible Chat Completions endpoint: OpenAI, OpenRouter, Together, vLLM, Ollama, ... */
    provider: z.literal("openai"),
    model: z.string(),
    baseURL: z.string().optional(),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    maxTokens: z.number().int().positive().optional(),
    /** Extra body params, e.g. { reasoning_effort: "high" } or OpenRouter provider routing. */
    extra: z.record(z.string(), z.unknown()).optional(),
    ...Common,
  })
  .strict();

const CommandModel = z
  .object({
    /**
     * Runs an external coding agent (Claude Code, Codex CLI, aider, ...) as a shell command inside the
     * workspace. The prompt is in $TUIBENCH_PROMPT_FILE; $TUIBENCH_PROMPT holds the same text.
     */
    provider: z.literal("command"),
    command: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    ...Common,
  })
  .strict();

export const ModelSpec = z.discriminatedUnion("provider", [AnthropicModel, OpenAICompatModel, CommandModel]);
export type ModelSpec = z.infer<typeof ModelSpec>;
export type ModelConfig = ModelSpec & { id: string; displayName: string };

const ModelsFile = z.object({ models: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), ModelSpec) }).strict();

export function modelsFile(): string {
  return path.resolve(process.env.TUIBENCH_MODELS ?? path.join(ROOT, "models.yaml"));
}

export function loadModels(file = modelsFile()): Record<string, ModelConfig> {
  if (!fs.existsSync(file)) {
    throw new Error(`No model config at ${file}. Copy models.example.yaml to models.yaml and edit it.`);
  }
  const parsed = ModelsFile.safeParse(YAML.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  return Object.fromEntries(
    Object.entries(parsed.data.models).map(([id, m]) => [id, { ...m, id, displayName: m.name ?? id }]),
  );
}
