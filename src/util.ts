import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run a command, capturing combined stdout+stderr. Never throws for non-zero exit. */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number; input?: string },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      output += d.toString("utf8");
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, opts.timeoutMs)
      : null;
    child.on("error", (e) => {
      output += `\n[spawn error] ${e.message}`;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output, timedOut, durationMs: Date.now() - started });
    });
  });
}

/** Keep the head and tail of long tool output so error messages at either end survive. */
export function truncateMiddle(s: string, max = 12000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n… [${s.length - max} characters truncated] …\n\n${s.slice(-half)}`;
}

export function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Resolve a model-supplied relative path, refusing anything that escapes `root`. */
export function confine(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new Error(`path escapes the workspace: ${rel}`);
  return abs;
}

/** A tiny promise mutex, used to serialize builds that share a cargo target dir. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  });
  await Promise.all(workers);
}

const IGNORED_DIRS = new Set(["node_modules", "target", ".git", ".tuibench"]);

/** List source files in a workspace (skipping build output and dependencies). */
export function listFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (IGNORED_DIRS.has(ent.name)) continue;
    const rel = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}
