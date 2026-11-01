import { RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core"

export const BOLD = TextAttributes.BOLD

/** Palette (Tokyo-night inspired). */
export const P = {
  bg: "#0f111a",
  headerBg: "#1a1e2e",
  rowAlt: "#131622",
  tableHead: "#181c2b",
  selBg: "#2a3a63",
  border: "#2b3149",
  borderHi: "#3d4566",
  text: "#c0caf5",
  bright: "#e6eaff",
  muted: "#7a83ad",
  faint: "#3b4261",
  track: "#262b40",
  grid: "#1f2436",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  teal: "#73daca",
  green: "#9ece6a",
  yellow: "#e0af68",
  orange: "#ff9e64",
  red: "#f7768e",
  purple: "#bb9af7",
  dark: "#11131c",
}

export interface Seg {
  t: string
  fg: string
  bg?: string
  bold?: boolean
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0")
  return `#${c(r)}${c(g)}${c(b)}`
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}

const STOPS: [number, string][] = [
  [0, P.green],
  [0.5, P.yellow],
  [0.8, P.orange],
  [1, P.red],
]
/** Smooth green → yellow → red gradient for a fraction 0..1. */
export function gradient(f: number): string {
  const x = Math.max(0, Math.min(1, f))
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i]!
    const [p0, c0] = STOPS[i - 1]!
    if (x <= p1) return mix(c0, c1, (x - p0) / (p1 - p0))
  }
  return P.red
}
/** Discrete threshold color for a percentage. */
export function threshold(pct: number): string {
  if (pct >= 80) return P.red
  if (pct >= 50) return P.yellow
  return P.green
}

const rgbaCache = new Map<string, RGBA>()

export class Canvas {
  dim = false
  private clips: [number, number, number, number][] = []
  constructor(
    public buf: OptimizedBuffer,
    public W: number,
    public H: number,
  ) {}

  c(hex: string): RGBA {
    const key = this.dim ? "d" + hex : hex
    let v = rgbaCache.get(key)
    if (!v) {
      const h = this.dim ? mix(hex, P.bg, 0.6) : hex
      v = RGBA.fromHex(h)
      rgbaCache.set(key, v)
    }
    return v
  }

  private clip(): [number, number, number, number] {
    const top = this.clips[this.clips.length - 1]
    return top ?? [0, 0, this.W, this.H]
  }
  pushClip(x: number, y: number, w: number, h: number) {
    const [cx, cy, cw, ch] = this.clip()
    const x0 = Math.max(cx, x)
    const y0 = Math.max(cy, y)
    const x1 = Math.min(cx + cw, x + w)
    const y1 = Math.min(cy + ch, y + h)
    this.clips.push([x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)])
  }
  popClip() {
    this.clips.pop()
  }

  fill(x: number, y: number, w: number, h: number, bg: string) {
    const [cx, cy, cw, ch] = this.clip()
    const x0 = Math.max(cx, x)
    const y0 = Math.max(cy, y)
    const x1 = Math.min(cx + cw, x + w)
    const y1 = Math.min(cy + ch, y + h)
    if (x1 <= x0 || y1 <= y0) return
    this.buf.fillRect(x0, y0, x1 - x0, y1 - y0, this.c(bg))
  }

  /** Draw text, clipped to the active clip rect. Returns the x after the text. */
  text(x: number, y: number, s: string, fg: string, bg: string = P.bg, attr = 0): number {
    const chars = Array.from(s)
    const end = x + chars.length
    const [cx, cy, cw, ch] = this.clip()
    if (y < cy || y >= cy + ch || chars.length === 0) return end
    let start = 0
    let px = x
    if (px < cx) {
      start = cx - px
      px = cx
    }
    const maxLen = cx + cw - px
    if (maxLen <= 0 || start >= chars.length) return end
    const str = chars.slice(start, start + maxLen).join("")
    if (str.length === 0) return end
    this.buf.drawText(str, px, y, this.c(fg), this.c(bg), attr)
    return end
  }

  segs(x: number, y: number, segs: Seg[], bg: string = P.bg): number {
    let px = x
    for (const s of segs) px = this.text(px, y, s.t, s.fg, s.bg ?? bg, s.bold ? BOLD : 0)
    return px
  }

  /** Rounded panel with a title on the top border and optional right/bottom titles. */
  panel(
    x: number,
    y: number,
    w: number,
    h: number,
    opts: { color: string; title: Seg[]; right?: Seg[]; bottomLeft?: Seg[]; bottomRight?: Seg[]; bg?: string },
  ) {
    if (w < 2 || h < 2) return
    const bg = opts.bg ?? P.bg
    const bc = opts.color
    this.fill(x, y, w, h, bg)
    this.text(x, y, "╭" + "─".repeat(w - 2) + "╮", bc, bg)
    this.text(x, y + h - 1, "╰" + "─".repeat(w - 2) + "╯", bc, bg)
    for (let i = 1; i < h - 1; i++) {
      this.text(x, y + i, "│", bc, bg)
      this.text(x + w - 1, y + i, "│", bc, bg)
    }
    const maxInner = w - 4
    const titleLen = segLen(opts.title) + 2
    if (maxInner > 2) {
      this.pushClip(x + 2, y, maxInner, 1)
      let px = this.text(x + 2, y, " ", bc, bg)
      px = this.segs(px, y, opts.title, bg)
      this.text(px, y, " ", bc, bg)
      if (opts.right) {
        const rl = segLen(opts.right) + 2
        if (titleLen + rl + 2 <= maxInner) {
          let rx = x + w - 2 - rl
          rx = this.text(rx, y, " ", bc, bg)
          rx = this.segs(rx, y, opts.right, bg)
          this.text(rx, y, " ", bc, bg)
        }
      }
      this.popClip()
      this.pushClip(x + 2, y + h - 1, maxInner, 1)
      let bl = 0
      if (opts.bottomLeft) {
        bl = segLen(opts.bottomLeft) + 2
        let px2 = this.text(x + 2, y + h - 1, " ", bc, bg)
        px2 = this.segs(px2, y + h - 1, opts.bottomLeft, bg)
        this.text(px2, y + h - 1, " ", bc, bg)
      }
      if (opts.bottomRight) {
        const rl = segLen(opts.bottomRight) + 2
        if (bl + rl + 2 <= maxInner) {
          let rx = x + w - 2 - rl
          rx = this.text(rx, y + h - 1, " ", bc, bg)
          rx = this.segs(rx, y + h - 1, opts.bottomRight, bg)
          this.text(rx, y + h - 1, " ", bc, bg)
        }
      }
      this.popClip()
    }
  }
}

export function segLen(segs: Seg[]): number {
  let n = 0
  for (const s of segs) n += Array.from(s.t).length
  return n
}

export function fit(s: string, w: number): string {
  if (w <= 0) return ""
  const chars = Array.from(s)
  if (chars.length <= w) return s
  if (w === 1) return "…"
  return chars.slice(0, w - 1).join("") + "…"
}
export function padR(s: string, w: number): string {
  const f = fit(s, w)
  return f + " ".repeat(Math.max(0, w - Array.from(f).length))
}
export function padL(s: string, w: number): string {
  const f = fit(s, w)
  return " ".repeat(Math.max(0, w - Array.from(f).length)) + f
}

const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const VBLOCK = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/** Horizontal gauge with eighth-cell precision; colors follow the gradient by cell position. */
export function hbar(
  cv: Canvas,
  x: number,
  y: number,
  w: number,
  pct: number,
  color: (f: number) => string = gradient,
  bg: string = P.bg,
) {
  if (w <= 0) return
  const total = (Math.max(0, Math.min(100, pct)) / 100) * w
  const full = Math.floor(total)
  const eighth = Math.round((total - full) * 8)
  for (let i = 0; i < w; i++) {
    const f = (i + 0.5) / w
    if (i < full) cv.text(x + i, y, "█", color(f), bg)
    else if (i === full && eighth > 0) cv.text(x + i, y, eighth === 8 ? "█" : PARTIAL[eighth]!, color(f), P.track)
    else cv.text(x + i, y, "░", P.track, bg)
  }
}

/** One column of a vertical bar chart. `f` is 0..1; rows counted from the bottom. */
export function vcol(
  cv: Canvas,
  x: number,
  yBottom: number,
  h: number,
  f: number,
  color: (rowFrac: number) => string,
  gridRows: Set<number> | null = null,
  bg: string = P.bg,
) {
  let eighths = Math.round(Math.max(0, Math.min(1, f)) * h * 8)
  if (f > 0 && eighths === 0) eighths = 1
  for (let r = 0; r < h; r++) {
    const e = Math.max(0, Math.min(8, eighths - r * 8))
    const y = yBottom - r
    if (e > 0) cv.text(x, y, VBLOCK[e]!, color((r + 0.5) / h), bg)
    else if (gridRows && gridRows.has(r)) cv.text(x, y, "┈", P.grid, bg)
  }
}
