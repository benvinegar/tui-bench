import fs from "node:fs";
import path from "node:path";
import { Entry, type CaptureMeta } from "./entry.ts";
import { getStack } from "./stacks.ts";
import { installFixtures, loadTask } from "./tasks.ts";
import { runScenario } from "./terminal/scenario.ts";
import { writeJson } from "./util.ts";

/** Build the entry's workspace and replay the task scenario, writing snapshots + an asciicast recording. */
export async function capture(entry: Entry, log?: (s: string) => void): Promise<CaptureMeta> {
  const task = loadTask(entry.task);
  const stack = getStack(entry.stack);
  const out = entry.captureDir;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  installFixtures(task, entry.workspace);
  const build = await stack.build(entry.workspace);
  const base = { capturedAt: new Date().toISOString(), size: task.size };
  if (!build.ok) {
    fs.writeFileSync(path.join(out, "build.log"), build.output);
    const meta: CaptureMeta = {
      ...base,
      started: false,
      notes: {},
      crashed: false,
      exit: null,
      cleanExit: null,
      warnings: [],
      durationMs: build.durationMs,
      error: "build failed",
      snapshotCount: 0,
    };
    writeJson(path.join(out, "capture.json"), meta);
    log?.(`[${entry.id}] build failed`);
    return meta;
  }

  const cmd = stack.runCommand(entry.workspace);
  const r = await runScenario({ ...cmd, cwd: entry.workspace, ...task.size }, task.scenario, { title: entry.id });
  fs.writeFileSync(path.join(out, "recording.cast"), r.cast);
  writeJson(path.join(out, "snapshots.json"), r.snapshots);
  const { cast: _cast, snapshots, ...rest } = r;
  const meta: CaptureMeta = { ...base, ...rest, snapshotCount: snapshots.length };
  writeJson(path.join(out, "capture.json"), meta);
  log?.(
    `[${entry.id}] ${snapshots.length} snapshots${r.crashed ? ", CRASHED" : ""}${r.cleanExit === false ? ", unclean exit" : ""}${r.error && !r.crashed ? `, ${r.error}` : ""}`,
  );
  return meta;
}

/** All entries on disk, optionally filtered. */
export function findEntries(resultsRoot: string, filter: { tasks?: string[]; stacks?: string[]; models?: string[] } = {}): Entry[] {
  const out: Entry[] = [];
  if (!fs.existsSync(resultsRoot)) return out;
  const dirs = (p: string) => fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const t of dirs(resultsRoot)) {
    if (filter.tasks?.length && !filter.tasks.includes(t)) continue;
    for (const s of dirs(path.join(resultsRoot, t))) {
      if (filter.stacks?.length && !filter.stacks.includes(s)) continue;
      for (const m of dirs(path.join(resultsRoot, t, s))) {
        if (filter.models?.length && !filter.models.includes(m)) continue;
        const e = new Entry(t, s, m);
        if (e.exists()) out.push(e);
      }
    }
  }
  return out;
}
