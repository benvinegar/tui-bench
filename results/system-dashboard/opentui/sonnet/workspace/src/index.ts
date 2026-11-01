import {
  Renderable,
  RGBA,
  TextAttributes,
  createCliRenderer,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import { readFileSync } from "node:fs"

// ───────────────────────────── data ─────────────────────────────

interface Sample {
  t: number
  cpu: number[]
  mem: { usedGiB: number; totalGiB: number }
  swap: { usedGiB: number; totalGiB: number }
  net: { rxKiBps: number; txKiBps: number }
  load: number[]
}
interface Proc {
  pid: number
  name: string
  user: string
  cpu: number
  mem: number
  threads: number
  state: string
  started: string
  command: string
}
interface Metrics {
  host: string
  kernel: string
  uptime: string
  cores: number
  intervalMs: number
  samples: Sample[]
  processes: Proc[]
}

const data: Metrics = JSON.parse(readFileSync("data/metrics.json", "utf8"))
const N = data.samples.length
const LAST = N - 1
const avgCpu = data.samples.map((s) => s.cpu.reduce((a, b) => a + b, 0) / Math.max(1, s.cpu.length))

type SortKey = "cpu" | "mem" | "pid" | "name"
const SORT_ORDER: SortKey[] = ["cpu", "mem", "pid", "name"]
const SORT_LABEL: Record<SortKey, string> = { cpu: "CPU%", mem: "MEM%", pid: "PID", name: "NAME" }

const state = {
  idx: 0,
  paused: false,
  sort: "cpu" as SortKey,
  sel: 0,
  scroll: 0,
  popup: false,
}

function sortedProcs(): Proc[] {
  const list = data.processes.slice()
  switch (state.sort) {
    case "cpu":
      list.sort((a, b) => b.cpu - a.cpu || a.pid - b.pid)
      break
    case "mem":
      list.sort((a, b) => b.mem - a.mem || a.pid - b.pid)
      break
    case "pid":
      list.sort((a, b) => a.pid - b.pid)
      break
    case "name":
      list.sort((a, b) => {
        const x = a.name.toLowerCase()
        const y = b.name.toLowerCase()
        return x < y ? -1 : x > y ? 1 : a.pid - b.pid
      })
      break
  }
  return list
}

// ───────────────────────────── colors ─────────────────────────────

type Rgb = [number, number, number]
const hex = (s: string): Rgb => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

const BG = hex("#0a0e14")
const PANEL = hex("#0f141b")
const PANEL_ALT = hex("#121821")
const BAR_BG = hex("#161c26")
const TRACK = hex("#1d2530")
const BORDER = hex("#2d3542")
const BORDER_HI = hex("#3d6fb6")
const TEXT = hex("#d5dde7")
const BRIGHT = hex("#ffffff")
const DIM = hex("#6b7686")
const FAINT = hex("#3a4352")
const ACCENT = hex("#58a6ff")
const GREEN = hex("#3fb950")
const YELLOW = hex("#e3b341")
const RED = hex("#f85149")
const CYAN = hex("#39c5cf")
const ORANGE = hex("#f0883e")
const PURPLE = hex("#bc8cff")
const SEL_BG = hex("#1d3a63")
const SHADOW = hex("#04060a")

let dimMode = false
const rgbaCache = new Map<number, RGBA>()
function K(c: Rgb): RGBA {
  const key = (c[0] << 16) | (c[1] << 8) | c[2] | (dimMode ? 1 << 24 : 0)
  let v = rgbaCache.get(key)
  if (!v) {
    let [r, g, b] = c
    if (dimMode) {
      r = Math.round(r * 0.4 + BG[0] * 0.6)
      g = Math.round(g * 0.4 + BG[1] * 0.6)
      b = Math.round(b * 0.4 + BG[2] * 0.6)
    }
    v = RGBA.fromInts(r, g, b, 255)
    rgbaCache.set(key, v)
  }
  return v
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/** green → yellow → red gradient over 0..1 */
function grad(f: number): Rgb {
  f = Math.max(0, Math.min(1, f))
  if (f < 0.55) return mix(GREEN, YELLOW, f / 0.55)
  return mix(YELLOW, RED, (f - 0.55) / 0.45)
}
/** threshold color for a percentage */
function level(pct: number): Rgb {
  return pct >= 85 ? RED : pct >= 60 ? YELLOW : GREEN
}

// ───────────────────────────── drawing helpers ─────────────────────────────

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

let buf: OptimizedBuffer
let clip: Rect = { x: 0, y: 0, w: 0, h: 0 }
const BOLD = TextAttributes.BOLD
const ITALIC = TextAttributes.ITALIC

function put(x: number, y: number, ch: string, fg: Rgb, bg: Rgb, attr = 0) {
  if (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h) return
  buf.setCell(x, y, ch, K(fg), K(bg), attr)
}

function txt(x: number, y: number, s: string, fg: Rgb, bg: Rgb, attr = 0): number {
  if (y < clip.y || y >= clip.y + clip.h) return x + s.length
  const x0 = Math.max(x, clip.x)
  const x1 = Math.min(x + s.length, clip.x + clip.w)
  if (x1 > x0) buf.drawText(s.slice(x0 - x, x1 - x), x0, y, K(fg), K(bg), attr)
  return x + s.length
}

function fill(r: Rect, bg: Rgb) {
  const x0 = Math.max(r.x, clip.x)
  const y0 = Math.max(r.y, clip.y)
  const x1 = Math.min(r.x + r.w, clip.x + clip.w)
  const y1 = Math.min(r.y + r.h, clip.y + clip.h)
  if (x1 > x0 && y1 > y0) buf.fillRect(x0, y0, x1 - x0, y1 - y0, K(bg))
}

const padL = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s)
const padR = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length))
function trunc(s: string, w: number): string {
  if (w <= 0) return ""
  if (s.length <= w) return s
  return w === 1 ? "…" : s.slice(0, w - 1) + "…"
}

interface Seg {
  t: string
  fg: Rgb
  attr?: number
}
const segLen = (segs: Seg[]) => segs.reduce((a, s) => a + s.t.length, 0)

function drawSegs(x: number, y: number, segs: Seg[], bg: Rgb): number {
  for (const s of segs) x = txt(x, y, s.t, s.fg, bg, s.attr ?? 0)
  return x
}

/** Rounded panel with title (left) and optional right-aligned info. Returns inner rect. */
function panel(r: Rect, title: Seg[], right: Seg[] = [], border: Rgb = BORDER, bottomRight: Seg[] = []): Rect {
  const saved = clip
  clip = { x: 0, y: 0, w: buf.width, h: buf.height }
  fill(r, PANEL)
  const { x, y, w, h } = r
  for (let i = 1; i < w - 1; i++) {
    put(x + i, y, "─", border, PANEL)
    put(x + i, y + h - 1, "─", border, PANEL)
  }
  for (let j = 1; j < h - 1; j++) {
    put(x, y + j, "│", border, PANEL)
    put(x + w - 1, y + j, "│", border, PANEL)
  }
  put(x, y, "╭", border, PANEL)
  put(x + w - 1, y, "╮", border, PANEL)
  put(x, y + h - 1, "╰", border, PANEL)
  put(x + w - 1, y + h - 1, "╯", border, PANEL)

  // title
  const maxTitle = w - 6
  if (maxTitle > 4) {
    const tl = [{ t: " ", fg: TEXT }, ...title, { t: " ", fg: TEXT }]
    const tlen = segLen(tl)
    if (tlen <= maxTitle) {
      drawSegs(x + 2, y, tl, PANEL)
      const rl = right.length ? [{ t: " ", fg: TEXT }, ...right, { t: " ", fg: TEXT }] : []
      const rlen = segLen(rl)
      if (rlen && tlen + rlen + 2 <= maxTitle) drawSegs(x + w - 2 - rlen, y, rl, PANEL)
    }
  }
  if (bottomRight.length && h >= 3) {
    const bl = [{ t: " ", fg: TEXT }, ...bottomRight, { t: " ", fg: TEXT }]
    const blen = segLen(bl)
    if (blen + 4 <= w) drawSegs(x + w - 2 - blen, y + h - 1, bl, PANEL)
  }
  clip = saved
  return { x: x + 2, y: y + 1, w: Math.max(0, w - 4), h: Math.max(0, h - 2) }
}

const PARTIAL = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/** Horizontal gauge with 1/8-cell precision and position-based color gradient. */
function gauge(x: number, y: number, w: number, frac: number, bg: Rgb = PANEL, solid?: Rgb) {
  if (w <= 0) return
  frac = Math.max(0, Math.min(1, frac))
  const eighths = Math.round(frac * w * 8)
  const full = Math.floor(eighths / 8)
  const rem = eighths % 8
  for (let i = 0; i < w; i++) {
    const c = solid ?? grad(w > 1 ? i / (w - 1) : 0)
    if (i < full) put(x + i, y, "█", c, bg)
    else if (i === full && rem > 0) put(x + i, y, PARTIAL[rem - 1], c, TRACK)
    else put(x + i, y, "█", TRACK, bg)
  }
}

const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

function fmtRate(kib: number): string {
  return kib >= 1024 ? (kib / 1024).toFixed(2) + " MiB/s" : kib.toFixed(0) + " KiB/s"
}
function fmtAxis(kib: number): string {
  if (kib >= 1024) {
    const m = kib / 1024
    return (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + "M"
  }
  return kib.toFixed(0) + "K"
}

// ───────────────────────────── panels ─────────────────────────────

function drawHeader(w: number, cur: Sample) {
  const finished = state.idx >= LAST
  clip = { x: 0, y: 0, w, h: 2 }
  fill({ x: 0, y: 0, w, h: 1 }, BAR_BG)
  fill({ x: 0, y: 1, w, h: 1 }, BG)

  // row 0
  const left: Seg[] = [
    { t: " ◆ ", fg: ACCENT, attr: BOLD },
    { t: data.host, fg: BRIGHT, attr: BOLD },
    { t: "  │  ", fg: FAINT },
    { t: data.kernel, fg: TEXT },
    { t: "  │  ", fg: FAINT },
    { t: "up ", fg: DIM },
    { t: data.uptime, fg: TEXT },
  ]
  const pos = `sample ${state.idx + 1}/${N}`
  const rightSegs: Seg[] = [
    { t: "◷ ", fg: DIM },
    { t: pos, fg: BRIGHT, attr: BOLD },
    { t: " ", fg: TEXT },
  ]
  const rl = segLen(rightSegs)
  const ll = segLen(left)
  if (ll + rl + 2 <= w) {
    drawSegs(0, 0, left, BAR_BG)
    drawSegs(w - rl, 0, rightSegs, BAR_BG)
  } else {
    // compact: drop kernel / uptime
    drawSegs(0, 0, left.slice(0, 2), BAR_BG)
    const mid = trunc(`${data.kernel}`, Math.max(0, w - rl - segLen(left.slice(0, 2)) - 3))
    txt(segLen(left.slice(0, 2)) + 2, 0, mid, DIM, BAR_BG)
    drawSegs(w - rl, 0, rightSegs, BAR_BG)
  }

  // row 1: status badge + progress
  let badge: string
  let badgeBg: Rgb
  if (finished) {
    badge = " ■ REPLAY FINISHED "
    badgeBg = PURPLE
  } else if (state.paused) {
    badge = " ▮▮ PAUSED "
    badgeBg = YELLOW
  } else {
    badge = " ▶ PLAYING "
    badgeBg = GREEN
  }
  let x = 1
  x = txt(x, 1, badge, BG, badgeBg, BOLD)
  x += 1
  const elapsed = ((state.idx * data.intervalMs) / 1000).toFixed(1)
  const total = ((LAST * data.intervalMs) / 1000).toFixed(1)
  const timeS = finished ? `recording complete  ${total}s` : `${elapsed}s / ${total}s`
  const tlen = timeS.length
  const barW = w - x - tlen - 3
  if (barW >= 6) {
    const frac = LAST > 0 ? state.idx / LAST : 1
    const filled = Math.round(frac * barW)
    const col = finished ? PURPLE : state.paused ? YELLOW : ACCENT
    for (let i = 0; i < barW; i++) {
      if (i < filled) put(x + i, 1, "━", col, BG)
      else put(x + i, 1, "─", FAINT, BG)
    }
    txt(x + barW + 2, 1, timeS, finished ? PURPLE : DIM, BG, finished ? BOLD : 0)
  } else if (w - x > 4) {
    txt(x, 1, trunc(timeS, w - x - 1), DIM, BG)
  }
  void cur
}

function drawFooter(w: number, y: number) {
  clip = { x: 0, y, w, h: 1 }
  fill({ x: 0, y, w, h: 1 }, BAR_BG)
  const items: [string, string][] = state.popup
    ? [
        ["esc", "Close"],
        ["p", state.paused ? "Resume" : "Pause"],
        ["q", "Quit"],
      ]
    : [
        ["j/k ↑/↓", "Move"],
        ["s", "Sort"],
        ["enter", "Details"],
        ["p", state.paused ? "Resume" : "Pause"],
        ["q", "Quit"],
      ]
  let x = 1
  for (const [k, l] of items) {
    if (x + k.length + l.length + 5 > w) break
    x = txt(x, y, ` ${k} `, ACCENT, FAINT, BOLD)
    x = txt(x, y, ` ${l}`, TEXT, BAR_BG)
    x += 2
  }
  const info = `sort: ${SORT_LABEL[state.sort]} ${state.sort === "pid" || state.sort === "name" ? "▲" : "▼"}  │  ${data.processes.length} procs `
  if (x + info.length < w) txt(w - info.length, y, info, DIM, BAR_BG)
}

function drawCpu(r: Rect, cur: Sample) {
  const avg = avgCpu[state.idx]
  const inner = panel(
    r,
    [
      { t: "▣ ", fg: ACCENT },
      { t: "CPU", fg: BRIGHT, attr: BOLD },
    ],
    [
      { t: `${data.cores} cores`, fg: DIM },
      { t: "  avg ", fg: DIM },
      { t: avg.toFixed(1) + "%", fg: level(avg), attr: BOLD },
    ],
  )
  clip = inner
  if (inner.w < 8 || inner.h < 1) return
  // overall average row
  const label = "AVG "
  txt(inner.x, inner.y, label, BRIGHT, PANEL, BOLD)
  const pct = padL(avg.toFixed(1) + "%", 6)
  const gw = inner.w - label.length - pct.length - 1
  gauge(inner.x + label.length, inner.y, gw, avg / 100)
  txt(inner.x + inner.w - pct.length, inner.y, pct, level(avg), PANEL, BOLD)

  // cores
  const n = cur.cpu.length
  const avail = inner.h - 1
  const maxCols = Math.max(1, Math.min(4, Math.floor((inner.w + 2) / 14)))
  let cols = maxCols
  let gap = 0
  let found = false
  for (const g of [1, 0]) {
    for (let c = 1; c <= maxCols && !found; c++) {
      if (Math.ceil(n / c) + g <= avail) {
        cols = c
        gap = g
        found = true
      }
    }
  }
  const rows = Math.ceil(n / cols)
  const colGap = 2
  const cw = Math.floor((inner.w - colGap * (cols - 1)) / cols)
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / rows)
    const rr = i % rows
    const cx = inner.x + c * (cw + colGap)
    const cy = inner.y + 1 + gap + rr
    const v = cur.cpu[i]
    const lab = padR(`C${i}`, 3)
    const p = padL(v.toFixed(0) + "%", 4)
    const bw = cw - lab.length - p.length - 1
    txt(cx, cy, lab, DIM, PANEL)
    gauge(cx + lab.length, cy, bw, v / 100)
    txt(cx + cw - p.length, cy, p, level(v), PANEL)
  }
}

function drawMemRows(inner: Rect, cur: Sample, gap: boolean) {
  const rowsDef: [string, { usedGiB: number; totalGiB: number }][] = [
    ["Memory", cur.mem],
    ["Swap", cur.swap],
  ]
  let y = inner.y
  for (const [name, m] of rowsDef) {
    const frac = m.totalGiB > 0 ? m.usedGiB / m.totalGiB : 0
    const pct = frac * 100
    const vals = `${m.usedGiB.toFixed(2)} / ${m.totalGiB.toFixed(2)} GiB`
    txt(inner.x, y, name, TEXT, PANEL, BOLD)
    txt(inner.x + inner.w - vals.length, y, vals, DIM, PANEL)
    const ps = padL(pct.toFixed(0) + "%", 4)
    gauge(inner.x, y + 1, inner.w - ps.length - 1, frac)
    txt(inner.x + inner.w - ps.length, y + 1, ps, level(pct), PANEL, BOLD)
    y += gap ? 3 : 2
  }
  return y
}

function drawMem(r: Rect, cur: Sample) {
  const inner = panel(r, [
    { t: "▤ ", fg: PURPLE },
    { t: "Memory", fg: BRIGHT, attr: BOLD },
  ])
  clip = inner
  drawMemRows(inner, cur, inner.h >= 6)
}

function loadColor(v: number): Rgb {
  const f = v / data.cores
  return f >= 1 ? RED : f >= 0.7 ? YELLOW : GREEN
}

function drawLoad(r: Rect, cur: Sample) {
  const inner = panel(r, [
    { t: "≋ ", fg: ORANGE },
    { t: "Load average", fg: BRIGHT, attr: BOLD },
  ])
  clip = inner
  const names = ["1 min", "5 min", "15 min"]
  const barW = Math.max(0, inner.w - 7 - 6 - 1)
  const off = inner.h >= 6 ? 1 : 0
  for (let i = 0; i < 3; i++) {
    const v = cur.load[i]
    const y = inner.y + off + i
    txt(inner.x, y, padR(names[i], 7), DIM, PANEL)
    txt(inner.x + 7, y, padL(v.toFixed(2), 5), loadColor(v), PANEL, BOLD)
    if (barW >= 4) gauge(inner.x + 13, y, barW, v / data.cores, PANEL, loadColor(v))
  }
  if (inner.h >= 5) {
    const d = cur.load[0] - cur.load[2]
    const trend = d > 0.15 ? "▲ rising" : d < -0.15 ? "▼ falling" : "▬ steady"
    const tc = d > 0.15 ? ORANGE : d < -0.15 ? CYAN : DIM
    txt(inner.x, inner.y + off + 3 + (inner.h >= 6 ? 1 : 0), trend, tc, PANEL, BOLD)
    txt(inner.x + inner.w - `per ${data.cores} cores`.length, inner.y + off + 3 + (inner.h >= 6 ? 1 : 0), `per ${data.cores} cores`, FAINT, PANEL)
  }
}

function drawMemLoad(r: Rect, cur: Sample) {
  const inner = panel(r, [
    { t: "▤ ", fg: PURPLE },
    { t: "Memory", fg: BRIGHT, attr: BOLD },
    { t: " · ", fg: FAINT },
    { t: "Load", fg: BRIGHT, attr: BOLD },
  ])
  clip = inner
  const y = drawMemRows(inner, cur, false)
  const roomForRule = y + 1 < inner.y + inner.h
  if (roomForRule) {
    for (let i = 0; i < inner.w; i++) put(inner.x + i, y, "─", FAINT, PANEL)
  }
  const ly = roomForRule ? y + 1 : y
  let x = inner.x
  x = txt(x, ly, "Load ", TEXT, PANEL, BOLD)
  for (let i = 0; i < 3; i++) {
    x = txt(x, ly, " " + cur.load[i].toFixed(2), loadColor(cur.load[i]), PANEL, BOLD)
  }
}

function drawCpuHistory(r: Rect) {
  const avg = avgCpu[state.idx]
  let peak = 0
  for (let i = 0; i <= state.idx; i++) peak = Math.max(peak, avgCpu[i])
  const inner = panel(
    r,
    [
      { t: "◢ ", fg: GREEN },
      { t: "CPU history", fg: BRIGHT, attr: BOLD },
    ],
    [
      { t: "now ", fg: DIM },
      { t: avg.toFixed(1) + "%", fg: level(avg), attr: BOLD },
      { t: "  peak ", fg: DIM },
      { t: peak.toFixed(1) + "%", fg: level(peak) },
    ],
  )
  clip = inner
  const axisW = 5
  const pw = inner.w - axisW
  const ph = inner.h
  if (pw < 4 || ph < 1) return
  const px = inner.x + axisW
  // axis labels
  txt(inner.x, inner.y, padL("100%", 4), DIM, PANEL)
  if (ph >= 3) txt(inner.x, inner.y + Math.floor((ph - 1) / 2), padL("50%", 4), FAINT, PANEL)
  txt(inner.x, inner.y + ph - 1, padL("0%", 4), DIM, PANEL)
  const midRow = Math.floor((ph - 1) / 2)
  // guide line
  if (ph >= 3) for (let c = 0; c < pw; c++) put(px + c, inner.y + midRow, "╌", FAINT, PANEL)

  for (let c = 0; c < pw; c++) {
    const s = pw > 1 ? (c * (N - 1)) / (pw - 1) : 0
    if (s > state.idx + 1e-9) break
    const i0 = Math.floor(s)
    const i1 = Math.min(LAST, i0 + 1)
    const v = avgCpu[i0] + (avgCpu[i1] - avgCpu[i0]) * (s - i0)
    const lev = Math.round((Math.max(0, Math.min(100, v)) / 100) * ph * 8)
    for (let rr = 0; rr < ph; rr++) {
      const fillN = Math.max(0, Math.min(8, lev - rr * 8))
      if (fillN <= 0) continue
      const y = inner.y + ph - 1 - rr
      const frac = ph > 1 ? rr / (ph - 1) : 0
      put(px + c, y, LOWER[fillN], grad(frac), PANEL)
    }
  }
  // latest-sample marker
  if (state.idx < LAST) {
    const cc = Math.min(pw - 1, Math.round((state.idx * (pw - 1)) / (N - 1)))
    void cc
  }
}

function drawNetwork(r: Rect, cur: Sample) {
  const { rxKiBps: rx, txKiBps: tx } = cur.net
  const inner = panel(
    r,
    [
      { t: "⇅ ", fg: CYAN },
      { t: "Network", fg: BRIGHT, attr: BOLD },
    ],
    [
      { t: "▼ ", fg: CYAN },
      { t: fmtRate(rx), fg: CYAN, attr: BOLD },
      { t: "   ▲ ", fg: ORANGE },
      { t: fmtRate(tx), fg: ORANGE, attr: BOLD },
    ],
  )
  clip = inner
  const axisW = 6
  const pw = inner.w - axisW
  const ph = inner.h
  if (pw < 4 || ph < 1) return
  const px = inner.x + axisW

  let mxR = 1
  let mxT = 1
  for (const s of data.samples) {
    mxR = Math.max(mxR, s.net.rxKiBps)
    mxT = Math.max(mxT, s.net.txKiBps)
  }
  const nice = (m: number) => {
    const step = m > 2048 ? 512 : m > 512 ? 250 : 50
    return Math.ceil(m / step) * step
  }
  const scaleR = nice(mxR)
  const scaleT = nice(mxT)

  const nU = ph === 1 ? 1 : Math.ceil(ph / 2)
  const nL = ph - nU
  txt(inner.x, inner.y, padL(fmtAxis(scaleR), 5), CYAN, PANEL)
  if (nL > 0) txt(inner.x, inner.y + ph - 1, padL(fmtAxis(scaleT), 5), ORANGE, PANEL)
  if (nU >= 1 && nL > 0) txt(inner.x, inner.y + nU - 1, padL("▼rx", 5), FAINT, PANEL)
  if (nL > 0) txt(inner.x, inner.y + nU, padL("▲tx", 5), FAINT, PANEL)

  for (let c = 0; c < pw; c++) {
    const s = pw > 1 ? (c * (N - 1)) / (pw - 1) : 0
    if (s > state.idx + 1e-9) break
    const i0 = Math.floor(s)
    const i1 = Math.min(LAST, i0 + 1)
    const f = s - i0
    const a = data.samples[i0].net
    const b = data.samples[i1].net
    const vr = a.rxKiBps + (b.rxKiBps - a.rxKiBps) * f
    const vt = a.txKiBps + (b.txKiBps - a.txKiBps) * f
    const levR = Math.round(Math.min(1, vr / scaleR) * nU * 8)
    for (let rr = 0; rr < nU; rr++) {
      const fillN = Math.max(0, Math.min(8, levR - rr * 8))
      if (fillN <= 0) continue
      put(px + c, inner.y + nU - 1 - rr, LOWER[fillN], mix(CYAN, BRIGHT, rr === nU - 1 ? 0 : 0), PANEL)
    }
    if (nL > 0) {
      const levT = Math.round(Math.min(1, vt / scaleT) * nL * 8)
      for (let rr = 0; rr < nL; rr++) {
        const fillN = Math.max(0, Math.min(8, levT - rr * 8))
        if (fillN <= 0) continue
        const y = inner.y + nU + rr
        if (fillN === 8) put(px + c, y, "█", ORANGE, PANEL)
        else put(px + c, y, LOWER[8 - fillN], PANEL, ORANGE)
      }
    }
  }
}

interface Col {
  key: SortKey | "user" | "state"
  label: string
  x: number
  w: number
  right: boolean
  bar: number
}

function drawProcs(r: Rect) {
  const procs = sortedProcs()
  const total = procs.length
  const arrow = state.sort === "pid" || state.sort === "name" ? "▲" : "▼"
  const inner0 = panel(
    r,
    [
      { t: "≡ ", fg: ACCENT },
      { t: "Processes", fg: BRIGHT, attr: BOLD },
    ],
    [
      { t: "sorted by ", fg: DIM },
      { t: `${SORT_LABEL[state.sort]} ${arrow}`, fg: ACCENT, attr: BOLD },
    ],
    BORDER_HI,
    [{ t: `${Math.min(total, state.sel + 1)}/${total}`, fg: DIM }],
  )
  // table spans full interior (1 col padding inside the border)
  const inner: Rect = { x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }
  void inner0
  clip = inner
  if (inner.w < 20 || inner.h < 2) return
  const iw = inner.w - 1 // keep last col for scrollbar spacing

  // column layout: pick the richest column set that still leaves room for NAME
  const W: Record<Col["key"], number> = { pid: 6, name: 0, user: 10, cpu: 5, mem: 5, state: 10 }
  const LABEL: Record<Col["key"], string> = { pid: "PID", name: "NAME", user: "USER", cpu: "CPU%", mem: "MEM%", state: "STATE" }
  const sets: { keys: Col["key"][]; user?: number }[] = [
    { keys: ["pid", "name", "user", "cpu", "mem", "state"] },
    { keys: ["pid", "name", "user", "cpu", "mem", "state"], user: 8 },
    { keys: ["pid", "name", "cpu", "mem", "state"] },
    { keys: ["pid", "name", "cpu", "mem"] },
    { keys: ["pid", "name", "cpu"] },
    { keys: ["name", "cpu"] },
  ]
  let chosen = sets[sets.length - 1]
  let nameW = 6
  const fixedOf = (keys: Col["key"][], uw: number) =>
    2 + keys.reduce((a, k) => a + (k === "name" ? 0 : k === "user" ? uw : W[k]), 0) + 2 * (keys.length - 1)
  for (const s of sets) {
    const nw = iw - fixedOf(s.keys, s.user ?? 10)
    if (nw >= 10) {
      chosen = s
      nameW = nw
      break
    }
  }
  if (chosen === sets[sets.length - 1]) nameW = Math.max(4, iw - fixedOf(chosen.keys, 10))
  const wUser = chosen.user ?? 10
  let bar = 0
  if (chosen.keys.includes("cpu") && chosen.keys.includes("mem")) {
    bar = Math.floor((nameW - 24) / 2) - 1
    bar = Math.max(0, Math.min(24, bar))
    if (bar < 4) bar = 0
    if (bar > 0) nameW -= 2 * (bar + 1)
  }
  const cols: Col[] = []
  let cx = inner.x + 1
  for (const k of chosen.keys) {
    const w = k === "name" ? nameW : k === "user" ? wUser : W[k]
    const isNum = k === "pid" || k === "cpu" || k === "mem"
    const b = k === "cpu" || k === "mem" ? bar : 0
    cols.push({ key: k, label: LABEL[k], x: cx, w, right: isNum, bar: b })
    cx += w + 2 + (b > 0 ? b + 1 : 0)
  }

  // header row
  fill({ x: inner.x, y: inner.y, w: inner.w, h: 1 }, BAR_BG)
  for (const c of cols) {
    const active = c.key === state.sort
    const fg = active ? ACCENT : DIM
    const attr = BOLD | (active ? TextAttributes.UNDERLINE : 0)
    const lab = c.right ? padL(c.label, c.w) : padR(c.label, c.w)
    txt(c.x, inner.y, lab, fg, BAR_BG, attr)
    if (active) {
      const ax = c.right ? c.x + c.w + 1 : c.x + c.label.length + 1
      txt(ax, inner.y, arrow, ACCENT, BAR_BG, BOLD)
    }
  }

  // rows
  const vis = inner.h - 1
  if (state.sel < state.scroll) state.scroll = state.sel
  if (state.sel >= state.scroll + vis) state.scroll = state.sel - vis + 1
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, total - vis)))

  for (let i = 0; i < vis; i++) {
    const pi = state.scroll + i
    const y = inner.y + 1 + i
    if (pi >= total) break
    const p = procs[pi]
    const sel = pi === state.sel
    const bg = sel ? SEL_BG : pi % 2 === 1 ? PANEL_ALT : PANEL
    fill({ x: inner.x, y, w: inner.w, h: 1 }, bg)
    if (sel) put(inner.x, y, "▌", ACCENT, bg)
    const fgMain = sel ? BRIGHT : TEXT
    for (const c of cols) {
      switch (c.key) {
        case "pid":
          txt(c.x, y, padL(String(p.pid), c.w), sel ? BRIGHT : DIM, bg)
          break
        case "name":
          txt(c.x, y, padR(trunc(p.name, c.w), c.w), fgMain, bg, sel ? BOLD : 0)
          break
        case "user":
          txt(c.x, y, padR(trunc(p.user, c.w), c.w), p.user === "root" ? ORANGE : sel ? TEXT : DIM, bg)
          break
        case "cpu":
        case "mem": {
          const v = c.key === "cpu" ? p.cpu : p.mem
          const col = level(c.key === "cpu" ? v : v * 4)
          txt(c.x, y, padL(v.toFixed(1), c.w), col, bg, sel ? BOLD : 0)
          if (c.bar > 0) gauge(c.x + c.w + 1, y, c.bar, v / (c.key === "cpu" ? 100 : 25), bg, col)
          break
        }
        case "state": {
          const sc = p.state === "running" ? GREEN : p.state === "sleeping" ? DIM : p.state === "idle" ? CYAN : YELLOW
          const dot = p.state === "running" ? "●" : p.state === "sleeping" ? "○" : "◌"
          put(c.x, y, dot, sc, bg)
          txt(c.x + 2, y, padR(trunc(p.state, c.w - 2), c.w - 2), sel ? sc : sc, bg)
          break
        }
      }
    }
  }

  // scrollbar on the right border
  if (total > vis && vis > 0) {
    clip = { x: 0, y: 0, w: buf.width, h: buf.height }
    const trackY = inner.y + 1
    const thumb = Math.max(1, Math.round((vis / total) * vis))
    const maxScroll = total - vis
    const thumbPos = maxScroll > 0 ? Math.round((state.scroll / maxScroll) * (vis - thumb)) : 0
    for (let i = 0; i < vis; i++) {
      const on = i >= thumbPos && i < thumbPos + thumb
      put(r.x + r.w - 1, trackY + i, on ? "┃" : "│", on ? ACCENT : BORDER_HI, PANEL)
    }
  }
}

function drawPopup(w: number, h: number) {
  const procs = sortedProcs()
  const p = procs[Math.min(state.sel, procs.length - 1)]
  if (!p) return
  const pw = Math.min(w - 2, 66)
  const ph = Math.min(h - 2, 14)
  if (pw < 24 || ph < 5) return
  const x = Math.floor((w - pw) / 2)
  const y = Math.floor((h - ph) / 2)
  clip = { x: 0, y: 0, w, h }
  fill({ x: x + 2, y: y + 1, w: pw, h: ph }, SHADOW)
  const r: Rect = { x, y, w: pw, h: ph }
  // panel() uses PANEL fill; popup gets a brighter border
  const inner = panel(
    r,
    [
      { t: "◆ ", fg: ACCENT },
      { t: "Process detail", fg: BRIGHT, attr: BOLD },
    ],
    [{ t: `PID ${p.pid}`, fg: DIM }],
    ACCENT,
  )
  clip = inner
  const sc = p.state === "running" ? GREEN : p.state === "sleeping" ? DIM : p.state === "idle" ? CYAN : YELLOW
  const rows: [string, string, Rgb, number][] = [
    ["PID", String(p.pid), BRIGHT, 0],
    ["Name", p.name, BRIGHT, BOLD],
    ["User", p.user, p.user === "root" ? ORANGE : TEXT, 0],
    ["State", p.state, sc, BOLD],
    ["CPU%", p.cpu.toFixed(1) + "%", level(p.cpu), BOLD],
    ["MEM%", p.mem.toFixed(1) + "%", level(p.mem * 4), BOLD],
    ["Threads", String(p.threads), TEXT, 0],
    ["Started", p.started, TEXT, 0],
    ["Command", p.command, TEXT, 0],
  ]
  let yy = inner.y + 1
  const lw = 9
  for (const [k, v, c, a] of rows) {
    txt(inner.x, yy, padR(k, lw), DIM, PANEL)
    const vx = inner.x + lw + 1
    if (k === "CPU%" || k === "MEM%") {
      const val = k === "CPU%" ? p.cpu : p.mem
      const full = k === "CPU%" ? 100 : 25
      txt(vx, yy, padR(v, 7), c, PANEL, a)
      const bw = Math.min(24, inner.w - lw - 1 - 8)
      if (bw >= 4) gauge(vx + 8, yy, bw, val / full, PANEL, c)
    } else {
      txt(vx, yy, trunc(v, inner.w - lw - 1), c, PANEL, a)
    }
    yy++
  }
  txt(inner.x, inner.y + inner.h - 1, "press esc to close", DIM, PANEL, ITALIC)
}

// ───────────────────────────── layout ─────────────────────────────

let started = false

class Dashboard extends Renderable {
  constructor(ctx: RenderContext) {
    super(ctx, { id: "dashboard", width: "100%", height: "100%" })
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!started) {
      started = true
      startPlayback()
    }
    buf = buffer
    const w = this.width
    const h = this.height
    clip = { x: 0, y: 0, w, h }
    dimMode = false
    fill({ x: 0, y: 0, w, h }, BG)
    if (w < 24 || h < 6) {
      const msg = "Terminal too small"
      txt(Math.max(0, Math.floor((w - msg.length) / 2)), Math.floor(h / 2), msg.slice(0, w), TEXT, BG)
      return
    }
    dimMode = state.popup
    const cur = data.samples[state.idx]

    drawHeader(w, cur)
    drawFooter(w, h - 1)

    const bodyY = 2
    const bodyH = h - 3
    let top = 8
    let mid = 8
    if (bodyH > 33) mid += Math.min(6, Math.floor((bodyH - 33) / 2))
    if (bodyH < 27) top = 7
    if (bodyH - top - mid < 9) mid = 6
    if (bodyH - top - mid < 7) mid = 0
    if (bodyH - top - mid < 7) top = 0
    if (bodyH < 8) top = 0
    const procH = bodyH - top - mid

    if (top > 0) {
      const t: Rect = { x: 0, y: bodyY, w, h: top }
      if (w >= 100) {
        const cw = Math.floor(w * 0.42)
        const mw = Math.floor(w * 0.34)
        drawCpu({ x: 0, y: t.y, w: cw, h: top }, cur)
        drawMem({ x: cw, y: t.y, w: mw, h: top }, cur)
        drawLoad({ x: cw + mw, y: t.y, w: w - cw - mw, h: top }, cur)
      } else if (w >= 56) {
        const cw = Math.floor(w * 0.5)
        drawCpu({ x: 0, y: t.y, w: cw, h: top }, cur)
        drawMemLoad({ x: cw, y: t.y, w: w - cw, h: top }, cur)
      } else {
        drawCpu(t, cur)
      }
    }
    if (mid > 0) {
      const my = bodyY + top
      const hw = Math.floor(w / 2)
      if (w >= 60) {
        drawCpuHistory({ x: 0, y: my, w: hw, h: mid })
        drawNetwork({ x: hw, y: my, w: w - hw, h: mid }, cur)
      } else {
        drawCpuHistory({ x: 0, y: my, w, h: mid })
      }
    }
    if (procH > 0) drawProcs({ x: 0, y: bodyY + top + mid, w, h: procH })

    if (state.popup) {
      dimMode = false
      drawPopup(w, h)
    }
    dimMode = false
  }
}

// ───────────────────────────── main ─────────────────────────────

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
const dash = new Dashboard(renderer)
renderer.root.add(dash)

let timer: ReturnType<typeof setInterval> | undefined
function startPlayback() {
  timer = setInterval(() => {
    if (!state.paused && state.idx < LAST) {
      state.idx++
      renderer.requestRender()
    }
  }, data.intervalMs)
}

let quitting = false
async function quit() {
  if (quitting) return
  quitting = true
  if (timer) clearInterval(timer)
  renderer.destroy()
  try {
    await renderer.closed
  } catch {}
  process.exit(0)
}

renderer.keyInput.on("keypress", (key) => {
  const n = data.processes.length
  if (key.ctrl || key.meta) return
  switch (key.name) {
    case "q":
      void quit()
      return
    case "p":
      state.paused = !state.paused
      break
    case "escape":
      state.popup = false
      break
    case "return":
    case "enter":
    case "linefeed":
      if (!state.popup) state.popup = true
      break
    case "j":
    case "down":
      if (!state.popup) state.sel = Math.min(n - 1, state.sel + 1)
      break
    case "k":
    case "up":
      if (!state.popup) state.sel = Math.max(0, state.sel - 1)
      break
    case "home":
      if (!state.popup) state.sel = 0
      break
    case "end":
      if (!state.popup) state.sel = n - 1
      break
    case "pagedown":
      if (!state.popup) state.sel = Math.min(n - 1, state.sel + 10)
      break
    case "pageup":
      if (!state.popup) state.sel = Math.max(0, state.sel - 10)
      break
    case "s":
      if (!state.popup) {
        state.sort = SORT_ORDER[(SORT_ORDER.indexOf(state.sort) + 1) % SORT_ORDER.length]
      }
      break
    default:
      return
  }
  renderer.requestRender()
})

process.on("SIGTERM", () => void quit())
