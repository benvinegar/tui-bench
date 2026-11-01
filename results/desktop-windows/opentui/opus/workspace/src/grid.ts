import { RGBA, type OptimizedBuffer } from "@opentui/core"

export const BOLD = 1
export const DIM = 2
export const ITALIC = 4
export const UNDERLINE = 8

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}

export function shade(c: number, f: number): number {
  return mix(0x000000, c, f)
}

/** A simple cell grid we compose the whole screen into, then blit to the OpenTUI buffer. */
export class Grid {
  w = 0
  h = 0
  ch: string[] = []
  fg = new Int32Array(0)
  bg = new Int32Array(0)
  at = new Uint8Array(0)
  clip: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private rgbaCache = new Map<number, RGBA>()

  resize(w: number, h: number) {
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    const n = w * h
    this.ch = new Array(n).fill(" ")
    this.fg = new Int32Array(n)
    this.bg = new Int32Array(n)
    this.at = new Uint8Array(n)
    this.resetClip()
  }

  resetClip() {
    this.clip = { x: 0, y: 0, w: this.w, h: this.h }
  }

  setClip(r: Rect) {
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y)
    const x1 = Math.min(this.w, r.x + r.w), y1 = Math.min(this.h, r.y + r.h)
    this.clip = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
  }

  inClip(x: number, y: number): boolean {
    const c = this.clip
    return x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h
  }

  set(x: number, y: number, ch: string, fg: number, bg: number, at = 0) {
    if (!this.inClip(x, y)) return
    const i = y * this.w + x
    this.ch[i] = ch
    this.fg[i] = fg
    this.bg[i] = bg
    this.at[i] = at
  }

  /** Set only foreground character, keep the background. */
  put(x: number, y: number, ch: string, fg: number, at = 0) {
    if (!this.inClip(x, y)) return
    const i = y * this.w + x
    this.ch[i] = ch
    this.fg[i] = fg
    this.at[i] = at
  }

  fill(x: number, y: number, w: number, h: number, bg: number, ch = " ", fg = 0xffffff) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, fg, bg)
  }

  /** Draw text; returns the x after the last cell drawn. */
  text(x: number, y: number, s: string, fg: number, bg: number, at = 0): number {
    for (const c of s) {
      this.set(x, y, c, fg, bg, at)
      x++
    }
    return x
  }

  darken(x: number, y: number, f: number) {
    if (!this.inClip(x, y)) return
    const i = y * this.w + x
    this.fg[i] = shade(this.fg[i]!, f)
    this.bg[i] = shade(this.bg[i]!, f)
  }

  private rgba(c: number): RGBA {
    let v = this.rgbaCache.get(c)
    if (!v) {
      v = RGBA.fromInts((c >> 16) & 255, (c >> 8) & 255, c & 255, 255)
      this.rgbaCache.set(c, v)
    }
    return v
  }

  blit(buf: OptimizedBuffer) {
    const w = Math.min(this.w, buf.width)
    const h = Math.min(this.h, buf.height)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * this.w + x
        buf.setCell(x, y, this.ch[i]!, this.rgba(this.fg[i]!), this.rgba(this.bg[i]!), this.at[i]!)
      }
    }
  }
}

export function chars(s: string): string[] {
  return Array.from(s)
}

export function strLen(s: string): number {
  return Array.from(s).length
}

export function truncate(s: string, n: number): string {
  const a = Array.from(s)
  if (n <= 0) return ""
  if (a.length <= n) return s
  if (n === 1) return "…"
  return a.slice(0, n - 1).join("") + "…"
}

export function padRight(s: string, n: number): string {
  const t = truncate(s, n)
  return t + " ".repeat(Math.max(0, n - strLen(t)))
}

export function padLeft(s: string, n: number): string {
  const t = truncate(s, n)
  return " ".repeat(Math.max(0, n - strLen(t))) + t
}
