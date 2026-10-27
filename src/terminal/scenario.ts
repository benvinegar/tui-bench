import { z } from "zod";
import { TerminalSession, type SessionOptions } from "./session.ts";
import { splitKeys } from "./keys.ts";
import type { Snapshot } from "./snapshot.ts";

const Keys = z.union([z.string(), z.array(z.string())]);
/** 0-based cell coordinates. */
const Coord = z.number().int().nonnegative();
const Point = z.object({ x: Coord, y: Coord }).strict();
const Button = z.enum(["left", "middle", "right"]);
const Mods = z.array(z.enum(["shift", "alt", "ctrl"]));

export const Step = z.union([
  z.object({ wait: z.number().int().nonnegative() }).strict(),
  z.object({ press: Keys, delay: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.string(), delay: z.number().int().nonnegative().optional() }).strict(),
  z.object({ paste: z.string() }).strict(),
  z.object({ click: z.object({ x: Coord, y: Coord, button: Button.optional(), count: z.number().int().min(1).max(3).optional(), mods: Mods.optional() }).strict() }).strict(),
  z.object({ drag: z.object({ from: Point, to: Point, button: Button.optional(), mods: Mods.optional() }).strict() }).strict(),
  z.object({ scroll: z.object({ x: Coord, y: Coord, direction: z.enum(["up", "down"]), amount: z.number().int().positive().optional() }).strict() }).strict(),
  z.object({ hover: Point }).strict(),
  z.object({ resize: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }) }).strict(),
  z
    .object({
      snapshot: z.string(),
      note: z.string().optional(),
      quiet: z.number().int().optional(),
      /** Give up waiting for the screen to settle after this many ms (default 1500; animations never settle). */
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
  /** Inputs that were not delivered, e.g. mouse events while the app had mouse reporting off. */
  warnings: string[];
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
  let warned = 0;
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
      else if ("click" in step) await s.click(step.click.x, step.click.y, step.click);
      else if ("drag" in step) await s.drag(step.drag.from, step.drag.to, step.drag);
      else if ("scroll" in step) await s.scroll(step.scroll.x, step.scroll.y, step.scroll.direction, step.scroll.amount);
      else if ("hover" in step) await s.hover(step.hover.x, step.hover.y);
      else if ("resize" in step) s.resize(step.resize.cols, step.resize.rows);
      else if ("snapshot" in step) {
        await s.waitIdle(step.quiet ?? 250, step.maxWait ?? 1500);
        const snap = s.snapshot(step.snapshot);
        const fresh = s.warnings.slice(warned);
        warned = s.warnings.length;
        if (fresh.length) snap.inputWarnings = [...new Set(fresh)];
        snapshots.push(snap);
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
    warnings: [...new Set(s.warnings)],
    cast: s.toCast(opts.title ?? session.command),
    durationMs: Date.now() - s.startedAt,
    error: error ?? (crashed ? `app exited unexpectedly with code ${s.exit?.exitCode}` : undefined),
  };
  s.dispose();
  return result;
}
