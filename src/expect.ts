import { z } from "zod";
import type { Snapshot } from "./terminal/snapshot.ts";

/**
 * Objective assertions about a checkpoint's screen, declared in a task's scenario under `expect:`.
 * They check what the spec makes mandatory (data shown, state changes, fixed hit targets), never style.
 *
 *   - contains: "API server"                     # anywhere on screen
 *   - contains: "26×9", in: { rows: [-1, -1] }    # only in the last row
 *   - notContains: "Files", in: { rows: [-1, -1] }
 *   - matches: "Ln 3, Col \\d+"                 # regular expression
 *   - inOrder: [rust-analyzer, chrome, containerd]  # first appear in this reading order (row, then column)
 *   - at: { x: 44, y: 9 }, oneOf: "▶"            # the cell's character is one of these
 *   - at: { x: 44, y: 9 }, notOneOf: "▶"
 *   - at: { x: 8, y: 6 }, text: "API server"     # text starting at that cell
 *
 * Coordinates are 0-based cells. Negative rows/columns in `in` count from the end (-1 is the last).
 * Text comparisons ignore case unless `caseSensitive: true`. Every expectation may carry a `label`.
 */
const Range = z.tuple([z.number().int(), z.number().int()]);
const Region = z.object({ rows: Range.optional(), cols: Range.optional() }).strict();
const Cell = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }).strict();
const common = { label: z.string().optional(), caseSensitive: z.boolean().optional() };

export const Expectation = z.union([
  z.object({ contains: z.string().min(1), in: Region.optional(), ...common }).strict(),
  z.object({ notContains: z.string().min(1), in: Region.optional(), ...common }).strict(),
  z.object({ matches: z.string().min(1), in: Region.optional(), ...common }).strict(),
  z.object({ inOrder: z.array(z.string().min(1)).min(2), in: Region.optional(), ...common }).strict(),
  z.object({ at: Cell, oneOf: z.string().min(1), ...common }).strict(),
  z.object({ at: Cell, notOneOf: z.string().min(1), ...common }).strict(),
  z.object({ at: Cell, text: z.string().min(1), ...common }).strict(),
]);
export type Expectation = z.infer<typeof Expectation>;

export interface CheckResult {
  checkpoint: string;
  label: string;
  pass: boolean;
  /** What was actually on screen, for failures. */
  detail?: string;
}

/** The screen as a grid of cells; the right half of a wide glyph is "". */
function grid(snap: Snapshot): string[][] {
  return snap.lines.map((runs) => {
    const row: string[] = [];
    for (const r of runs) {
      for (const ch of r.w ? [r.t] : Array.from(r.t)) {
        row.push(ch);
        if (r.w) row.push("");
      }
    }
    while (row.length < snap.cols) row.push(" ");
    return row;
  });
}

function span(range: [number, number] | undefined, size: number): [number, number] {
  if (!range) return [0, size - 1];
  const fix = (n: number) => (n < 0 ? size + n : n);
  return [Math.max(0, fix(range[0])), Math.min(size - 1, fix(range[1]))];
}

function regionText(cells: string[][], snap: Snapshot, region?: z.infer<typeof Region>): string[] {
  const [r0, r1] = span(region?.rows, snap.rows);
  const [c0, c1] = span(region?.cols, snap.cols);
  const out: string[] = [];
  for (let y = r0; y <= r1; y++) out.push((cells[y] ?? []).slice(c0, c1 + 1).join(""));
  return out;
}

const norm = (s: string, cs?: boolean) => (cs ? s : s.toLowerCase());
const where = (e: { in?: z.infer<typeof Region> }) =>
  e.in ? ` in ${e.in.rows ? `rows ${e.in.rows.join("…")}` : ""}${e.in.rows && e.in.cols ? ", " : ""}${e.in.cols ? `cols ${e.in.cols.join("…")}` : ""}` : "";

export function describe(e: Expectation): string {
  if (e.label) return e.label;
  if ("contains" in e) return `shows “${e.contains}”${where(e)}`;
  if ("notContains" in e) return `does not show “${e.notContains}”${where(e)}`;
  if ("matches" in e) return `matches /${e.matches}/${where(e)}`;
  if ("inOrder" in e) return `lists ${e.inOrder.map((t) => `“${t}”`).join(" → ")} in order${where(e)}`;
  if ("oneOf" in e) return `cell (${e.at.x},${e.at.y}) is ${[...e.oneOf].join(" or ")}`;
  if ("notOneOf" in e) return `cell (${e.at.x},${e.at.y}) is not ${[...e.notOneOf].join(" or ")}`;
  return `“${e.text}” at (${e.at.x},${e.at.y})`;
}

export function check(e: Expectation, snap: Snapshot): { pass: boolean; detail?: string } {
  const cells = grid(snap);
  const cs = e.caseSensitive;
  if ("contains" in e || "notContains" in e || "matches" in e || "inOrder" in e) {
    const rows = regionText(cells, snap, e.in);
    if ("inOrder" in e) {
      // Each string's first occurrence, in reading order (row, then column); positions must increase.
      const page = norm(rows.join("\n"), cs);
      const at = e.inOrder.map((t) => page.indexOf(norm(t, cs)));
      const missing = e.inOrder.filter((_, i) => at[i]! < 0);
      if (missing.length) return { pass: false, detail: `not shown: ${missing.join(", ")}` };
      const ok = at.every((p, i) => i === 0 || p > at[i - 1]!);
      const pos = (p: number) => `${page.slice(0, p).split("\n").length - 1}:${p - page.lastIndexOf("\n", p - 1) - 1}`;
      return { pass: ok, detail: ok ? undefined : `found at ${at.map(pos).join(", ")}` };
    }
    if ("matches" in e) {
      const re = new RegExp(e.matches, cs ? "" : "i");
      return { pass: rows.some((r) => re.test(r)) };
    }
    const needle = norm("contains" in e ? e.contains : e.notContains, cs);
    const found = rows.findIndex((r) => norm(r, cs).includes(needle));
    if ("contains" in e) return { pass: found >= 0 };
    return { pass: found < 0, detail: found >= 0 ? `found: “${rows[found]!.trim()}”` : undefined };
  }
  const row = cells[e.at.y] ?? [];
  if ("text" in e) {
    const got = row.slice(e.at.x, e.at.x + [...e.text].length).join("");
    return { pass: norm(got, cs) === norm(e.text, cs), detail: `found “${got}”` };
  }
  const ch = row[e.at.x] ?? " ";
  const set = [...("oneOf" in e ? e.oneOf : e.notOneOf)];
  const hit = set.includes(ch);
  return { pass: "oneOf" in e ? hit : !hit, detail: `found “${ch}”` };
}

/** Evaluate every expectation of a scenario against the captured snapshots. A missing snapshot fails its checks. */
export function evaluate(
  scenario: Array<{ snapshot?: string; expect?: Expectation[] } | object>,
  snapshots: Snapshot[],
): CheckResult[] {
  const out: CheckResult[] = [];
  for (const step of scenario) {
    if (!("snapshot" in step) || !("expect" in step) || !step.expect) continue;
    const name = step.snapshot as string;
    const snap = snapshots.find((s) => s.name === name);
    for (const e of step.expect) {
      if (!snap) {
        out.push({ checkpoint: name, label: describe(e), pass: false, detail: "no screen at this checkpoint" });
        continue;
      }
      const r = check(e, snap);
      out.push({ checkpoint: name, label: describe(e), pass: r.pass, ...(r.pass ? {} : { detail: r.detail }) });
    }
  }
  return out;
}
