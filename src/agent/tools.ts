import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Stack, BuildResult } from "../stacks.ts";
import { previewApp } from "../preview.ts";
import type { Task } from "../tasks.ts";
import { Step } from "../terminal/scenario.ts";
import { confine, listFiles } from "../util.ts";

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Returns the text sent back to the model. Throwing produces an error result. */
  run(input: any): Promise<string>;
}

export interface ToolContext {
  workspace: string;
  stack: Stack;
  task: Task;
  stats: ToolStats;
  /** Set when the agent calls `finish`. */
  finished: { summary: string } | null;
}

export interface ToolStats {
  calls: Record<string, number>;
  builds: number;
  failedBuilds: number;
  runs: number;
  lastBuild: BuildResult | null;
}

export function newToolStats(): ToolStats {
  return { calls: {}, builds: 0, failedBuilds: 0, runs: 0, lastBuild: null };
}

const MAX_READ_LINES = 2000;

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function makeTools(ctx: ToolContext): ToolSpec[] {
  const ws = ctx.workspace;

  const build = async (): Promise<BuildResult> => {
    ctx.stats.builds++;
    const r = await ctx.stack.check(ws);
    if (!r.ok) ctx.stats.failedBuilds++;
    ctx.stats.lastBuild = r;
    return r;
  };

  return [
    {
      name: "list_files",
      description: "List the files in the workspace (build output and dependencies are omitted).",
      schema: z.object({}).strict(),
      async run() {
        return listFiles(ws).join("\n") || "(empty)";
      },
    },
    {
      name: "read_file",
      description: `Read a text file from the workspace. Returns at most ${MAX_READ_LINES} lines starting at \`offset\` (1-based).`,
      schema: z
        .object({
          path: z.string().describe("Path relative to the workspace root"),
          offset: z.number().int().positive().optional().describe("First line to return (1-based)"),
          limit: z.number().int().positive().optional().describe("Maximum number of lines to return"),
        })
        .strict(),
      async run({ path: rel, offset, limit }) {
        const lines = fs.readFileSync(confine(ws, rel), "utf8").split("\n");
        const start = (offset ?? 1) - 1;
        const count = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
        const slice = lines.slice(start, start + count);
        const more = start + count < lines.length ? `\n… (${lines.length - start - count} more lines)` : "";
        return slice.join("\n") + more;
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file in the workspace with the given full contents.",
      schema: z.object({ path: z.string(), content: z.string() }).strict(),
      async run({ path: rel, content }) {
        const abs = confine(ws, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        return `wrote ${rel} (${content.split("\n").length} lines)`;
      },
    },
    {
      name: "edit_file",
      description:
        "Replace an exact substring of a file. `old_string` must occur exactly once unless `replace_all` is true.",
      schema: z
        .object({
          path: z.string(),
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        })
        .strict(),
      async run({ path: rel, old_string, new_string, replace_all }) {
        const abs = confine(ws, rel);
        const src = fs.readFileSync(abs, "utf8");
        const count = src.split(old_string).length - 1;
        if (count === 0) throw new Error("old_string not found in file");
        if (count > 1 && !replace_all) throw new Error(`old_string occurs ${count} times; make it unique or set replace_all`);
        fs.writeFileSync(abs, replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string));
        return `edited ${rel} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})`;
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from the workspace.",
      schema: z.object({ path: z.string() }).strict(),
      async run({ path: rel }) {
        fs.rmSync(confine(ws, rel));
        return `deleted ${rel}`;
      },
    },
    {
      name: "build",
      description: "Build (and for TypeScript, typecheck) the app and return the tool output.",
      schema: z.object({}).strict(),
      async run() {
        const r = await build();
        const status = r.ok ? (r.typecheckOk === false ? "BUILD OK, TYPECHECK FAILED" : "BUILD OK") : "BUILD FAILED";
        return `${status} (${(r.durationMs / 1000).toFixed(1)}s)\n\n${r.output}`;
      },
    },
    {
      name: "run_app",
      description:
        "Build the app, run it in a pseudo-terminal, perform the given steps and return plain-text screenshots. " +
        "Steps: {press: 'j j enter'} or {press: ['ctrl+c']}, {type: 'text'}, {wait: ms}, {resize: {cols, rows}}, " +
        "{snapshot: 'name'}, and mouse input with 0-based cells: {click: {x, y, button?, count?}}, " +
        "{drag: {from: {x, y}, to: {x, y}}}, {scroll: {x, y, direction: 'up'|'down'}}, {hover: {x, y}}, " +
        "and {expectExit: ms} after a quit key to check a clean exit. " +
        "Mouse input only reaches the app if it enabled mouse reporting. A screenshot is always taken at the end. The app is killed afterwards.",
      schema: z
        .object({
          steps: z.array(Step).describe("Interaction steps; each is an object with exactly one action key"),
          cols: z.number().int().positive().optional(),
          rows: z.number().int().positive().optional(),
        })
        .strict(),
      async run({ steps, cols, rows }) {
        const b = await build();
        if (!b.ok) return `BUILD FAILED, app not started\n\n${b.output}`;
        ctx.stats.runs++;
        return previewApp(ctx.stack, ctx.task, ws, steps, { cols, rows });
      },
    },
    {
      name: "finish",
      description: "Declare the app complete. Call this once, when you are done.",
      schema: z.object({ summary: z.string().describe("What you built, in a few sentences") }).strict(),
      async run({ summary }) {
        ctx.finished = { summary };
        return "Finished.";
      },
    },
  ];
}

/** Run a tool by name with validation, mapping failures to an error string. */
export async function runTool(
  tools: ToolSpec[],
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  ctx.stats.calls[name] = (ctx.stats.calls[name] ?? 0) + 1;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { output: `Unknown tool: ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { output: `Invalid input for ${name}:\n${z.prettifyError(parsed.error)}`, isError: true };
  }
  try {
    return { output: await tool.run(parsed.data), isError: false };
  } catch (e) {
    return { output: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}
