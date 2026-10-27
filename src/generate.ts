import fs from "node:fs";
import path from "node:path";
import { makeProvider } from "./agent/index.ts";
import { systemPrompt, taskPrompt } from "./agent/prompt.ts";
import { makeTools, newToolStats, type ToolContext } from "./agent/tools.ts";
import type { LogEvent } from "./agent/types.ts";
import { Entry, type EntryMeta } from "./entry.ts";
import type { ModelConfig } from "./models.ts";
import type { Stack } from "./stacks.ts";
import { installFixtures, type Task } from "./tasks.ts";
import { copyDir, listFiles } from "./util.ts";

export interface GenerateOptions {
  force?: boolean;
  log?: (line: string) => void;
}

const DEFAULT_MAX_TURNS = 60;
const DEFAULT_TIMEOUT_MIN = 45;

export function sourceStats(workspace: string): { files: number; lines: number } {
  const files = listFiles(workspace).filter((f) => !f.startsWith("data/") && !/(^|\/)(Cargo\.lock|bun\.lockb?|bun\.lock)$/.test(f));
  let lines = 0;
  for (const f of files) {
    try {
      lines += fs.readFileSync(path.join(workspace, f), "utf8").split("\n").length;
    } catch {}
  }
  return { files: files.length, lines };
}

/** Prepare a fresh workspace from the stack template plus task fixtures. */
export function prepareWorkspace(entry: Entry, stack: Stack, task: Task): void {
  fs.rmSync(entry.dir, { recursive: true, force: true });
  fs.mkdirSync(entry.dir, { recursive: true });
  copyDir(stack.templateDir, entry.workspace);
  for (const junk of ["node_modules", "target"]) fs.rmSync(path.join(entry.workspace, junk), { recursive: true, force: true });
  installFixtures(task, entry.workspace);
}

export async function generate(task: Task, stack: Stack, model: ModelConfig, opts: GenerateOptions = {}): Promise<EntryMeta | null> {
  const entry = new Entry(task.id, stack.id, model.id);
  const say = (s: string) => opts.log?.(`[${entry.id}] ${s}`);
  if (entry.exists() && !opts.force) {
    say("exists, skipping (use --force to regenerate)");
    return null;
  }

  prepareWorkspace(entry, stack, task);
  const started = Date.now();
  const meta: EntryMeta = {
    task: task.id,
    stack: stack.id,
    model: model.id,
    modelName: model.displayName,
    provider: model.provider,
    providerModel: "model" in model ? model.model : undefined,
    effort: "effort" in model ? model.effort : undefined,
    source: "generated",
    startedAt: new Date(started).toISOString(),
  };
  entry.writeMeta(meta);

  const transcript = fs.openSync(entry.transcriptFile, "w");
  const log = (e: LogEvent) => {
    fs.writeSync(transcript, JSON.stringify({ ...e, t: Date.now() - started }) + "\n");
    if (e.type === "tool_call") say(`→ ${e.name}${"path" in (e.input as object) ? " " + (e.input as { path: string }).path : ""}`);
    if (e.type === "turn") say(`turn ${e.turn} (${e.stopReason}, out ${e.usage.outputTokens} tok)`);
    if (e.type === "notice") say(e.text);
  };

  const ctx: ToolContext = { workspace: entry.workspace, stack, task, stats: newToolStats(), finished: null };
  const tools = makeTools(ctx);
  const interactive = model.provider !== "command";
  say(`generating with ${model.displayName}`);
  let result;
  try {
    result = await makeProvider(model).run({
      system: systemPrompt(stack, task, interactive),
      prompt: taskPrompt(task),
      tools,
      ctx,
      maxTurns: model.maxTurns ?? DEFAULT_MAX_TURNS,
      deadline: started + (model.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000,
      log,
    });
  } catch (e) {
    result = { stopReason: "error" as const, turns: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, error: e instanceof Error ? e.message : String(e) };
  }
  fs.closeSync(transcript);
  say(`agent stopped: ${result.stopReason}${result.error ? ` (${result.error})` : ""}`);

  installFixtures(task, entry.workspace);
  const build = await stack.check(entry.workspace);
  say(`final build: ${build.ok ? "ok" : "FAILED"}${build.typecheckOk === false ? " (typecheck failed)" : ""}`);
  fs.writeFileSync(path.join(entry.dir, "build.log"), build.output);

  Object.assign(meta, {
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    agent: {
      ...result,
      summary: ctx.finished?.summary,
      tools: ctx.stats.calls,
      builds: ctx.stats.builds,
      failedBuilds: ctx.stats.failedBuilds,
      runs: ctx.stats.runs,
    },
    build: { ok: build.ok, typecheckOk: build.typecheckOk, durationMs: build.durationMs },
    source_stats: sourceStats(entry.workspace),
  } satisfies Partial<EntryMeta>);
  entry.writeMeta(meta);
  return meta;
}

/** Register a workspace produced elsewhere (any agent, or a human) as a result entry. */
export async function importEntry(task: Task, stack: Stack, modelId: string, srcDir: string, name?: string): Promise<EntryMeta> {
  const entry = new Entry(task.id, stack.id, modelId);
  fs.rmSync(entry.dir, { recursive: true, force: true });
  fs.mkdirSync(entry.dir, { recursive: true });
  fs.cpSync(srcDir, entry.workspace, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|target|\.git)(\/|$)/.test(path.relative(srcDir, src)),
  });
  installFixtures(task, entry.workspace);
  const build = await stack.check(entry.workspace);
  fs.writeFileSync(path.join(entry.dir, "build.log"), build.output);
  const meta: EntryMeta = {
    task: task.id,
    stack: stack.id,
    model: modelId,
    modelName: name ?? modelId,
    provider: "imported",
    source: "imported",
    startedAt: new Date().toISOString(),
    build: { ok: build.ok, typecheckOk: build.typecheckOk, durationMs: build.durationMs },
    source_stats: sourceStats(entry.workspace),
  };
  entry.writeMeta(meta);
  return meta;
}
