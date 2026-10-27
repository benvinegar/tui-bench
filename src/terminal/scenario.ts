import { z } from "zod";
import { TerminalSession, type SessionOptions } from "./session.ts";
import { splitKeys } from "./keys.ts";
import type { Snapshot } from "./snapshot.ts";

const Keys = z.union([z.string(), z.array(z.string())]);

export const Step = z.union([
  z.object({ wait: z.number().int().nonnegative() }).strict(),
  z.object({ press: Keys, delay: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.string(), delay: z.number().int().nonnegative().optional() }).strict(),
  z.object({ paste: z.string() }).strict(),
  z.object({ click: z.object({ x: z.number().int(), y: z.number().int(), button: z.number().int().optional() }) }).strict(),
  z.object({ resize: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }) }).strict(),
  z
    .object({
      snapshot: z.string(),
      note: z.string().optional(),
      quiet: z.number().int().optional(),
      maxWait: z.number().int().optional(),
    })
    .strict(),
  z.object({ expectExit: z.number().int().positive() }).strict(),
]);
export type Step = z.infer<typeof Step>;

export interface ScenarioResult {
  started: boolean;
  snapshots: Snapshot[];
  /** Notes from the scenario, keyed by snapshot name, describing what a judge should look for. */
  notes: Record<string, string>;
  crashed: boolean;
  exit: { code: number; signal?: number; at: number } | null;
  /** Set by an `expectExit` step: did the app quit when asked, and leave the alternate screen? */
  cleanExit: boolean | null;
  cast: string;
  durationMs: number;
  error?: string;
}

export async function runScenario(
  session: SessionOptions,
  steps: Step[],
  opts: { title?: string; startupTimeoutMs?: number } = {},
): Promise<ScenarioResult> {
  const s = new TerminalSession(session);
  const snapshots: Snapshot[] = [];
  const notes: Record<string, string> = {};
  let cleanExit: boolean | null = null;
  let error: string | undefined;

  try {
    const started = await s.waitForStartup(opts.startupTimeoutMs ?? 20000);
    if (!started) error = "app produced no output before the startup timeout";
    for (const step of steps) {
      // The app is gone: only an expectExit step still makes sense, anything else means it crashed.
      if (s.exit && !("expectExit" in step)) break;
      if ("wait" in step) await new Promise((r) => setTimeout(r, step.wait));
      else if ("press" in step) await s.press(splitKeys(step.press), step.delay);
      else if ("type" in step) await s.type(step.type, step.delay);
      else if ("paste" in step) s.paste(step.paste);
      else if ("click" in step) await s.click(step.click.x, step.click.y, step.click.button);
      else if ("resize" in step) s.resize(step.resize.cols, step.resize.rows);
      else if ("snapshot" in step) {
        await s.waitIdle(step.quiet ?? 250, step.maxWait ?? 3000);
        snapshots.push(s.snapshot(step.snapshot));
        if (step.note) notes[step.snapshot] = step.note;
      } else if ("expectExit" in step) {
        const exited = await s.waitForExit(step.expectExit);
        await s.waitIdle(50, 500);
        cleanExit = exited && s.exit?.exitCode === 0 && s.term.buffer.active.type !== "alternate";
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // Exiting on its own without being asked to (no expectExit step) is a crash; being killed after the last step is not.
  const crashed = s.exit !== null && cleanExit === null;
  await s.kill();

  const result: ScenarioResult = {
    started: snapshots.length > 0 || s.events.some((e) => e[1] === "o"),
    snapshots,
    notes,
    crashed,
    exit: s.exit ? { code: s.exit.exitCode, signal: s.exit.signal, at: s.exit.at } : null,
    cleanExit,
    cast: s.toCast(opts.title ?? session.command),
    durationMs: Date.now() - s.startedAt,
    error: error ?? (crashed ? `app exited unexpectedly with code ${s.exit?.exitCode}` : undefined),
  };
  s.dispose();
  return result;
}
