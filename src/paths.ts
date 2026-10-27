import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TASKS_DIR = path.join(ROOT, "tasks");
export const STACKS_DIR = path.join(ROOT, "stacks");
export const CACHE_DIR = path.join(ROOT, ".cache");

export function resultsDir(): string {
  return path.resolve(process.env.TUIBENCH_RESULTS ?? path.join(ROOT, "results"));
}

/** results/<task>/<stack>/<model> */
export function entryDir(task: string, stack: string, model: string): string {
  return path.join(resultsDir(), task, stack, model);
}
