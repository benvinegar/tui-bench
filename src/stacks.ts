import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, STACKS_DIR } from "./paths.ts";
import { exec, Mutex, truncateMiddle } from "./util.ts";

export interface BuildResult {
  ok: boolean;
  /** For stacks with a separate typecheck (OpenTUI), whether it passed. Undefined if not applicable. */
  typecheckOk?: boolean;
  output: string;
  durationMs: number;
}

export interface Stack {
  id: string;
  title: string;
  language: string;
  framework: string;
  templateDir: string;
  /** Stack-specific instructions appended to the system prompt. */
  promptNotes: string;
  /** Produce something runnable. Must succeed for the app to be captured. */
  build(workspace: string): Promise<BuildResult>;
  /** Build plus extra static checks, used as feedback for the agent. */
  check(workspace: string): Promise<BuildResult>;
  runCommand(workspace: string): { command: string; args: string[] };
}

const BUILD_TIMEOUT = 10 * 60_000;
const CARGO_TARGET = path.join(CACHE_DIR, "cargo-target");
// All ratatui workspaces share one cargo target dir so dependencies compile once.
// The app binary has the same name everywhere, so build + copy-out must be serialized.
const cargoLock = new Mutex();

const ratatui: Stack = {
  id: "ratatui",
  title: "Rust + ratatui",
  language: "Rust",
  framework: "ratatui",
  templateDir: path.join(STACKS_DIR, "ratatui", "template"),
  promptNotes: `## Stack: Rust + ratatui

- This is a Rust (edition 2024) binary crate named \`app\` at the workspace root. The entry point is \`src/main.rs\`.
- \`Cargo.toml\` already depends on \`ratatui = "0.30"\`, \`crossterm = "0.29"\`, \`serde\` and \`serde_json\`. You may add other crates from crates.io by editing \`Cargo.toml\`.
- It is built with \`cargo build --release\` and the binary is run with the workspace root as its working directory.
- The \`build\` tool (when you have one) runs the same build and returns compiler output.`,
  async build(ws) {
    return cargoLock.run(async () => {
      const r = await exec("cargo", ["build", "--release", "--color", "never"], {
        cwd: ws,
        env: { CARGO_TARGET_DIR: CARGO_TARGET, CARGO_TERM_COLOR: "never" },
        timeoutMs: BUILD_TIMEOUT,
      });
      const ok = r.code === 0;
      if (ok) {
        const bin = path.join(ws, ".tuibench", "bin");
        fs.mkdirSync(bin, { recursive: true });
        fs.copyFileSync(path.join(CARGO_TARGET, "release", "app"), path.join(bin, "app"));
        fs.chmodSync(path.join(bin, "app"), 0o755);
      }
      const output = r.timedOut ? r.output + "\n[build timed out]" : r.output;
      return { ok, output: truncateMiddle(output), durationMs: r.durationMs };
    });
  },
  check(ws) {
    return this.build(ws);
  },
  runCommand(ws) {
    return { command: path.join(ws, ".tuibench", "bin", "app"), args: [] };
  },
};

const opentui: Stack = {
  id: "opentui",
  title: "TypeScript + OpenTUI",
  language: "TypeScript",
  framework: "OpenTUI",
  templateDir: path.join(STACKS_DIR, "opentui", "template"),
  promptNotes: `## Stack: TypeScript + OpenTUI (Bun)

- This is a Bun + TypeScript project at the workspace root. The entry point is \`src/index.ts\`.
- \`package.json\` already depends on \`@opentui/core\` 0.7.0. You may add other npm packages (for example \`@opentui/react\` or \`@opentui/solid\`) by editing \`package.json\`; they are installed with \`bun install\`.
- The type declarations of installed packages are in \`node_modules\`, e.g. \`node_modules/@opentui/core/index.d.ts\` and \`node_modules/@opentui/core/renderables/*.d.ts\`.
- It is run with \`bun run src/index.ts\` from the workspace root.
- Building means \`bun install\` followed by \`tsc --noEmit\` (the \`build\` tool, when you have one, runs both). Type errors don't stop the app from running, but you should fix them.`,
  async build(ws) {
    const r = await exec("bun", ["install"], { cwd: ws, env: { NO_COLOR: "1" }, timeoutMs: BUILD_TIMEOUT });
    const output = r.timedOut ? r.output + "\n[bun install timed out]" : r.output;
    const entry = fs.existsSync(path.join(ws, "src", "index.ts")) || fs.existsSync(path.join(ws, "src", "index.tsx"));
    return {
      ok: r.code === 0 && entry,
      output: truncateMiddle(entry ? output : output + "\nmissing entry point src/index.ts"),
      durationMs: r.durationMs,
    };
  },
  async check(ws) {
    const install = await this.build(ws);
    if (!install.ok) return { ...install, typecheckOk: false };
    const tsc = await exec("bun", ["x", "tsc", "--noEmit", "--pretty", "false"], { cwd: ws, timeoutMs: BUILD_TIMEOUT });
    const typecheckOk = tsc.code === 0;
    return {
      ok: true,
      typecheckOk,
      output: truncateMiddle(`$ bun install\n${install.output}\n$ tsc --noEmit\n${tsc.output || "(no type errors)"}`),
      durationMs: install.durationMs + tsc.durationMs,
    };
  },
  runCommand(ws) {
    const entry = fs.existsSync(path.join(ws, "src", "index.tsx")) && !fs.existsSync(path.join(ws, "src", "index.ts"))
      ? "src/index.tsx"
      : "src/index.ts";
    return { command: process.env.BUN_PATH ?? "bun", args: ["run", entry] };
  },
};

export const STACKS: Record<string, Stack> = { ratatui, opentui };

export function getStack(id: string): Stack {
  const s = STACKS[id];
  if (!s) throw new Error(`Unknown stack "${id}". Available: ${Object.keys(STACKS).join(", ")}`);
  return s;
}
