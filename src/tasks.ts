import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { Step } from "./terminal/scenario.ts";
import { TASKS_DIR } from "./paths.ts";

export const TaskSpec = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string(),
    summary: z.string(),
    /** Terminal size the app starts in. */
    size: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).default({ cols: 100, rows: 30 }),
    tags: z.array(z.string()).default([]),
    /** The specification given to the model. */
    prompt: z.string(),
    /** Scripted interaction replayed against every build, producing snapshots for judging. */
    scenario: z.array(Step).min(1),
  })
  .strict();
export type Task = z.infer<typeof TaskSpec> & { dir: string; fixturesDir: string | null };

export function loadTask(id: string): Task {
  const dir = path.join(TASKS_DIR, id);
  const file = path.join(dir, "task.yaml");
  if (!fs.existsSync(file)) throw new Error(`Unknown task "${id}" (no ${file})`);
  const parsed = TaskSpec.safeParse(YAML.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.id !== id) throw new Error(`${file}: id "${parsed.data.id}" does not match directory "${id}"`);
  const fixtures = path.join(dir, "data");
  return { ...parsed.data, dir, fixturesDir: fs.existsSync(fixtures) ? fixtures : null };
}

export function listTasks(): Task[] {
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(TASKS_DIR, d.name, "task.yaml")))
    .map((d) => loadTask(d.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Copy the task's fixture data into `<workspace>/data`, overwriting anything the agent changed. */
export function installFixtures(task: Task, workspace: string): void {
  if (!task.fixturesDir) return;
  const dest = path.join(workspace, "data");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(task.fixturesDir, dest, { recursive: true });
}
