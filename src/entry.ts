import fs from "node:fs";
import path from "node:path";
import { entryDir } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";
import type { StopReason, Usage } from "./agent/types.ts";
import type { ToolStats } from "./agent/tools.ts";
import type { ScenarioResult } from "./terminal/scenario.ts";

/** One (task, stack, model) result: results/<task>/<stack>/<model>/ */
export interface EntryMeta {
  task: string;
  stack: string;
  model: string;
  modelName: string;
  provider: string;
  providerModel?: string;
  effort?: string;
  source: "generated" | "imported";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  agent?: {
    stopReason: StopReason;
    turns: number;
    usage: Usage;
    error?: string;
    summary?: string;
    tools?: ToolStats["calls"];
    builds?: number;
    failedBuilds?: number;
    runs?: number;
  };
  build?: { ok: boolean; typecheckOk?: boolean; durationMs: number };
  source_stats?: { files: number; lines: number };
}

export type CaptureMeta = Omit<ScenarioResult, "cast" | "snapshots"> & {
  capturedAt: string;
  size: { cols: number; rows: number };
  snapshotCount: number;
};

export class Entry {
  readonly dir: string;
  constructor(
    readonly task: string,
    readonly stack: string,
    readonly model: string,
  ) {
    this.dir = entryDir(task, stack, model);
  }
  get id(): string {
    return `${this.task}/${this.stack}/${this.model}`;
  }
  get workspace(): string {
    return path.join(this.dir, "workspace");
  }
  get metaFile(): string {
    return path.join(this.dir, "meta.json");
  }
  get transcriptFile(): string {
    return path.join(this.dir, "transcript.jsonl");
  }
  get captureDir(): string {
    return path.join(this.dir, "capture");
  }
  exists(): boolean {
    return fs.existsSync(this.metaFile);
  }
  meta(): EntryMeta | null {
    return readJson<EntryMeta>(this.metaFile);
  }
  writeMeta(m: EntryMeta): void {
    writeJson(this.metaFile, m);
  }
  capture(): CaptureMeta | null {
    return readJson<CaptureMeta>(path.join(this.captureDir, "capture.json"));
  }
}
