import type { Stack } from "./stacks.ts";
import { installFixtures, type Task } from "./tasks.ts";
import { runScenario, type Step } from "./terminal/scenario.ts";
import { snapshotToText } from "./terminal/snapshot.ts";
import { truncateMiddle } from "./util.ts";

/**
 * Run an already-built app with the given steps and describe what happened as plain text: one framed
 * screenshot per snapshot step (plus one at the end), and any crash or exit details. This is what agents
 * see when they test their own app, through the `run_app` tool or the `tuibench preview` command.
 */
export async function previewApp(
  stack: Stack,
  task: Task,
  workspace: string,
  steps: Step[],
  size?: { cols?: number; rows?: number },
): Promise<string> {
  installFixtures(task, workspace);
  const all: Step[] = [...steps];
  if (!all.length || !("snapshot" in all[all.length - 1]!)) all.push({ snapshot: "end" });
  const r = await runScenario(
    { ...stack.runCommand(workspace), cwd: workspace, cols: size?.cols ?? task.size.cols, rows: size?.rows ?? task.size.rows },
    all,
    { startupTimeoutMs: 15000 },
  );
  const parts = r.snapshots.map((s) => `[${s.name}] ${s.cols}x${s.rows}\n${snapshotToText(s)}`);
  if (r.crashed || r.error) parts.push(`App problem: ${r.error ?? "crashed"}`);
  if (r.crashed && r.exit) {
    parts.push(`App exited on its own with code ${r.exit.code} after ${r.exit.at}ms.`);
    parts.push(appOutputTail(r.cast));
  }
  return truncateMiddle(parts.join("\n\n"), 30000);
}

/** The last bytes an app printed, with escape sequences stripped: usually a panic message or stack trace. */
function appOutputTail(cast: string): string {
  const out = cast
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as [number, string, string])
    .filter((e) => e[1] === "o")
    .map((e) => e[2])
    .join("");
  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[\]P_^][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g, "");
  return "Last output:\n" + plain.slice(-2000).trim();
}
