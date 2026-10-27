import type { Terminal, IBufferCell } from "@xterm/headless";

/** A run of consecutive cells on one line that share the same style. */
export interface Run {
  t: string;
  fg?: string; // "#rrggbb"; absent = terminal default foreground
  bg?: string; // "#rrggbb"; absent = terminal default background
  b?: 1; // bold
  d?: 1; // dim
  i?: 1; // italic
  u?: 1; // underline
  s?: 1; // strikethrough
  v?: 1; // inverse (renderer swaps fg/bg, resolving defaults against its theme)
  w?: 1; // run is a single double-width glyph
}

export interface Snapshot {
  name: string;
  /** Milliseconds since the app was spawned. */
  at: number;
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  altScreen: boolean;
  lines: Run[][];
  /** Plain text rendering, one string per row (trailing spaces trimmed). */
  text: string[];
  /** Input since the previous snapshot that never reached the app (e.g. mouse with reporting off). */
  inputWarnings?: string[];
}

const ANSI16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function paletteHex(idx: number): string {
  if (idx < 16) return ANSI16[idx]!;
  if (idx < 232) {
    const n = idx - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return rgbHex(steps[Math.floor(n / 36)]!, steps[Math.floor(n / 6) % 6]!, steps[n % 6]!);
  }
  const v = 8 + (idx - 232) * 10;
  return rgbHex(v, v, v);
}

function rgbHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function intHex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

function fgOf(cell: IBufferCell): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgRGB()) return intHex(cell.getFgColor());
  return paletteHex(cell.getFgColor());
}

function bgOf(cell: IBufferCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) return intHex(cell.getBgColor());
  return paletteHex(cell.getBgColor());
}

function styleKey(r: Omit<Run, "t">): string {
  return `${r.fg ?? ""}|${r.bg ?? ""}|${r.b ?? 0}${r.d ?? 0}${r.i ?? 0}${r.u ?? 0}${r.s ?? 0}${r.v ?? 0}`;
}

export function takeSnapshot(term: Terminal, name: string, at: number): Snapshot {
  const buf = term.buffer.active;
  const lines: Run[][] = [];
  const text: string[] = [];
  const cell = buf.getNullCell();

  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const runs: Run[] = [];
    let plain = "";
    let cur: Run | null = null;
    let curKey = "";
    for (let x = 0; x < term.cols; x++) {
      if (!line || !line.getCell(x, cell)) {
        plain += " ";
        continue;
      }
      const width = cell.getWidth();
      if (width === 0) continue; // trailing half of a wide glyph
      const ch = cell.getChars() || " ";
      plain += ch;
      const style: Omit<Run, "t"> = {};
      const fg = fgOf(cell);
      const bg = bgOf(cell);
      if (fg) style.fg = fg;
      if (bg) style.bg = bg;
      if (cell.isBold()) style.b = 1;
      if (cell.isDim()) style.d = 1;
      if (cell.isItalic()) style.i = 1;
      if (cell.isUnderline()) style.u = 1;
      if (cell.isStrikethrough()) style.s = 1;
      if (cell.isInverse()) style.v = 1;
      if (width === 2) {
        runs.push({ t: ch, ...style, w: 1 });
        cur = null;
        curKey = "";
        continue;
      }
      const key = styleKey(style);
      if (cur && key === curKey) {
        cur.t += ch;
      } else {
        cur = { t: ch, ...style };
        curKey = key;
        runs.push(cur);
      }
    }
    lines.push(runs);
    text.push(plain.replace(/\s+$/, ""));
  }

  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
  return {
    name,
    at,
    cols: term.cols,
    rows: term.rows,
    cursor: { x: buf.cursorX, y: buf.cursorY, visible: !(core?.coreService?.isCursorHidden ?? false) },
    altScreen: buf.type === "alternate",
    lines,
    text,
  };
}

/** Render a snapshot as plain text with a frame, for agent previews and CLI output. */
export function snapshotToText(s: Snapshot): string {
  const bar = "─".repeat(s.cols);
  const body = s.text.map((l) => "│" + l.padEnd(s.cols) + "│").join("\n");
  return `┌${bar}┐\n${body}\n└${bar}┘`;
}
