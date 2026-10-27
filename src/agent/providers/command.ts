import fs from "node:fs";
import path from "node:path";
import { exec } from "../../util.ts";
import { emptyUsage, type AgentProvider, type AgentRunInput, type AgentRunResult } from "../types.ts";
import type { ModelConfig } from "../../models.ts";

type CommandConfig = Extract<ModelConfig, { provider: "command" }>;

/**
 * Delegates the whole job to an external coding agent CLI run inside the workspace.
 * The harness only sees the final files; token usage is not tracked.
 */
export class CommandProvider implements AgentProvider {
  constructor(private cfg: CommandConfig) {}

  async run({ system, prompt, ctx, deadline, log }: AgentRunInput): Promise<AgentRunResult> {
    const full = `${system}\n\n${prompt}`;
    const promptFile = path.join(ctx.workspace, ".tuibench", "PROMPT.md");
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, full);
    log({ type: "notice", text: `$ ${this.cfg.command}` });
    const r = await exec("bash", ["-lc", this.cfg.command], {
      cwd: ctx.workspace,
      env: { ...this.cfg.env, TUIBENCH_PROMPT_FILE: promptFile, TUIBENCH_PROMPT: full },
      timeoutMs: Math.max(1000, deadline - Date.now()),
    });
    log({ type: "text", text: r.output.slice(-20000) });
    const usage = emptyUsage();
    if (r.timedOut) return { stopReason: "timeout", turns: 1, usage };
    if (r.code !== 0) return { stopReason: "error", turns: 1, usage, error: `command exited with ${r.code}` };
    return { stopReason: "end_turn", turns: 1, usage };
  }
}
