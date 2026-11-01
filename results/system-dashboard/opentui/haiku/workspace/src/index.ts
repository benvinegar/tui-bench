import { BoxRenderable, RGBA, TextAttributes, createCliRenderer, type KeyEvent, type OptimizedBuffer } from "@opentui/core"
import { readFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

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

interface Sample {
  t: number
  cpu: number[]
  mem: { usedGiB: number; totalGiB: number }
  swap: { usedGiB: number; totalGiB: number }
  net: { rxKiBps: number; txKiBps: number }
  load: [number, number, number]
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

const metrics: Metrics = JSON.parse(readFileSync("data/metrics.json", "utf8"))
const samples = metrics.samples
const N = samples.length
const PROCS = metrics.processes

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const hex = (h: string) => RGBA.fromHex(h)
const P = {
  bg: hex("#1B1F27"),
  bar: hex("#2A303C"),
  border: hex("#4C566A"),
  trough: hex("#353D4C"),
  title: hex("#88C0D0"),
  text: hex("#ECEFF4"),
  bright: hex("#FFFFFF"),
  dim: hex("#7F8AA3"),
  green: hex("#A3BE8C"),
  yellow: hex("#EBCB8B"),
  red: hex("#BF616A"),
  blue: hex("#81A1C1"),
  magenta: hex("#B48EAD"),
  cyan: hex("#88C0D0"),
  sel: hex("#3B4C63"),
  popup: hex("#262C38"),
}
const BOLD = TextAttributes.BOLD

const EIGHTHS_H = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]
const EIGHTHS_V = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const padR = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))
const padL = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s)

const avgs = samples.map((s) => mean(s.cpu))
const rxAll = samples.map((s) => s.net.rxKiBps)
const txAll = samples.map((s) => s.net.txKiBps)
const rxMax = Math.max(1, ...rxAll)
const txMax = Math.max(1, ...txAll)

function usageColor(p: number): RGBA {
  if (p >= 85) return P.red
  if (p >= 60) return P.yellow
  return P.green
}

function fmtRate(kib: number): string {
  return kib >= 1024 ? `${(kib / 1024).toFixed(2)} MiB/s` : `${kib.toFixed(0)} KiB/s`
}

/** Last `w` values of `vals` ending at index `upto` (inclusive), newest on the right. */
function series(vals: number[], upto: number, w: number): (number | undefined)[] {
  const out: (number | undefined)[] = []
  for (let i = 0; i < w; i++) {
    const k = upto - (w - 1 - i)
    out.push(k >= 0 && k < vals.length ? vals[k] : undefined)
  }
  return out
}

function txt(
  b: OptimizedBuffer,
  x: number,
  y: number,
  s: string,
  fg: RGBA,
  bg?: RGBA,
  attr = 0,
  right: number = b.width,
): void {
  if (y < 0 || y >= b.height || x < 0 || x >= right || s.length === 0) return
  const avail = right - x
  const str = s.length > avail ? s.slice(0, avail) : s
  b.drawText(str, x, y, fg, bg, attr)
}

type Seg = [string, RGBA, number?]
/** Writes segments left to right; stops before a segment that would not fit completely. */
function segs(b: OptimizedBuffer, x: number, y: number, list: Seg[], bg: RGBA, right: number): void {
  let cx = x
  for (const [s, fg, attr = 0] of list) {
    if (cx + s.length > right) break
    txt(b, cx, y, s, fg, bg, attr, right)
    cx += s.length
  }
}

/** Horizontal gauge: filled part in `color`, remainder as a dim trough. */
function gauge(b: OptimizedBuffer, x: number, y: number, w: number, frac: number, color: RGBA, bg: RGBA): void {
  if (w <= 0) return
  const total = Math.round(clamp(frac, 0, 1) * w * 8)
  const full = Math.floor(total / 8)
  const rem = total % 8
  const filledLen = full + (rem ? 1 : 0)
  if (filledLen > 0) txt(b, x, y, "█".repeat(full) + (rem ? EIGHTHS_H[rem] : ""), color, bg)
  if (w - filledLen > 0) txt(b, x + filledLen, y, "░".repeat(w - filledLen), P.border, bg)
}

/** Label + gauge + percentage on one line. */
function barLine(
  b: OptimizedBuffer,
  r: Rect,
  label: string,
  labelW: number,
  pct: number,
  bold: boolean,
  bg: RGBA,
): void {
  const color = usageColor(pct)
  const attr = bold ? BOLD : 0
  txt(b, r.x, r.y, padR(label, labelW), P.text, bg, attr, r.x + r.w)
  const pctStr = `${padL(pct.toFixed(1), 5)}%`
  const barW = r.w - labelW - pctStr.length - 1
  if (barW >= 2) {
    gauge(b, r.x + labelW, r.y, barW, pct / 100, color, bg)
    txt(b, r.x + labelW + barW + 1, r.y, pctStr, color, bg, attr, r.x + r.w)
  } else {
    txt(b, r.x + labelW, r.y, pctStr, color, bg, attr, r.x + r.w)
  }
}

/** Vertical bar chart, bottom aligned, `values` already sized to r.w (newest on the right). */
function vbars(
  b: OptimizedBuffer,
  r: Rect,
  values: (number | undefined)[],
  max: number,
  colorOf: (v: number) => RGBA,
  bg: RGBA,
): void {
  if (r.w <= 0 || r.h <= 0) return
  for (let i = 0; i < r.w && i < values.length; i++) {
    const v = values[i]
    if (v === undefined) continue
    const total = Math.round(clamp(v / max, 0, 1) * r.h * 8)
    const color = colorOf(v)
    for (let row = 0; row < r.h; row++) {
      const e = clamp(total - row * 8, 0, 8)
      if (e === 0) break
      txt(b, r.x + i, r.y + r.h - 1 - row, EIGHTHS_V[e], color, bg)
    }
  }
}

/** Draws a rounded panel border with optional title/footer; returns the inner rect. */
function panel(b: OptimizedBuffer, r: Rect, title: string, footer?: string, bg: RGBA = P.bg): Rect {
  const { x, y, w, h } = r
  if (w < 4 || h < 3) return { x, y, w: 0, h: 0 }
  txt(b, x, y, "╭" + "─".repeat(w - 2) + "╮", P.border, bg)
  txt(b, x, y + h - 1, "╰" + "─".repeat(w - 2) + "╯", P.border, bg)
  for (let i = 1; i < h - 1; i++) {
    txt(b, x, y + i, "│", P.border, bg)
    txt(b, x + w - 1, y + i, "│", P.border, bg)
  }
  if (title) txt(b, x + 2, y, ` ${title} `, P.title, bg, BOLD, x + w - 1)
  if (footer && footer.length + 4 < w - 2) {
    txt(b, x + w - footer.length - 4, y + h - 1, ` ${footer} `, P.dim, bg, 0, x + w - 1)
  }
  return { x: x + 1, y: y + 1, w: w - 2, h: h - 2 }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SortKey = "cpu" | "mem" | "pid" | "name"
const SORT_ORDER: SortKey[] = ["cpu", "mem", "pid", "name"]
const SORT_LABEL: Record<SortKey, string> = { cpu: "CPU% ▼", mem: "MEM% ▼", pid: "PID ▲", name: "NAME ▲" }

let idx = 0
let paused = false
let sortMode = 0
let selPid = -1
let scroll = 0
let popupOpen = false
let popupPid = -1

const sortKey = (): SortKey => SORT_ORDER[sortMode]!

function sortedProcs(): Proc[] {
  const key = sortKey()
  const list = [...PROCS]
  list.sort((a, b) => {
    switch (key) {
      case "cpu":
        return b.cpu - a.cpu || a.pid - b.pid
      case "mem":
        return b.mem - a.mem || a.pid - b.pid
      case "pid":
        return a.pid - b.pid
      case "name":
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.pid - b.pid
    }
  })
  return list
}

let sorted = sortedProcs()
if (sorted.length > 0) selPid = sorted[0]!.pid

const finished = () => idx >= N - 1
const selIndex = () => Math.max(0, sorted.findIndex((p) => p.pid === selPid))

function resort(): void {
  sorted = sortedProcs()
  if (!sorted.some((p) => p.pid === selPid) && sorted.length > 0) selPid = sorted[0]!.pid
}

function moveSelection(delta: number): void {
  if (sorted.length === 0) return
  const next = clamp(selIndex() + delta, 0, sorted.length - 1)
  selPid = sorted[next]!.pid
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function drawCpu(b: OptimizedBuffer, r: Rect): void {
  const inner = panel(b, r, "CPU")
  if (inner.w <= 0 || inner.h <= 0) return
  const s = samples[idx]!
  const cores = s.cpu.length
  barLine(b, { x: inner.x, y: inner.y, w: inner.w, h: 1 }, "avg", 6, mean(s.cpu), true, P.bg)

  const rowsAvail = inner.h - 1
  if (rowsAvail <= 0) return
  if (rowsAvail >= cores) {
    const labelW = inner.w >= 30 ? 6 : 3
    for (let i = 0; i < cores; i++) {
      const label = inner.w >= 30 ? `cpu${i}` : `${i}`
      barLine(b, { x: inner.x, y: inner.y + 1 + i, w: inner.w, h: 1 }, label, labelW, s.cpu[i]!, false, P.bg)
    }
  } else {
    // Two columns when there is not enough height for one row per core.
    const colW = Math.floor(inner.w / 2)
    const rows = Math.ceil(cores / 2)
    const labelW = colW >= 26 ? 6 : 3
    for (let i = 0; i < cores; i++) {
      const row = Math.floor(i / 2)
      if (row >= rowsAvail || row >= rows) break
      const col = i % 2
      const label = colW >= 26 ? `cpu${i}` : `${i}`
      barLine(
        b,
        { x: inner.x + col * colW, y: inner.y + 1 + row, w: col === 0 ? colW - 1 : inner.w - colW, h: 1 },
        label,
        labelW,
        s.cpu[i]!,
        false,
        P.bg,
      )
    }
  }
}

function drawHistory(b: OptimizedBuffer, r: Rect): void {
  let peak = 0
  for (let i = 0; i <= idx; i++) peak = Math.max(peak, avgs[i]!)
  const inner = panel(b, r, "CPU history")
  if (inner.w <= 0 || inner.h <= 0) return
  const now = avgs[idx]!
  const line: Seg[] = [
    ["now ", P.dim],
    [`${now.toFixed(1)}%`, usageColor(now), BOLD],
    ["   peak ", P.dim],
    [`${peak.toFixed(1)}%`, P.text],
    ["   samples ", P.dim],
    [`${idx + 1}`, P.text],
  ]
  segs(b, inner.x, inner.y, line, P.bg, inner.x + inner.w)
  const chart: Rect = { x: inner.x, y: inner.y + 1, w: inner.w, h: inner.h - 1 }
  vbars(b, chart, series(avgs, idx, inner.w), 100, usageColor, P.bg)
}

function drawMem(b: OptimizedBuffer, r: Rect): void {
  const inner = panel(b, r, "Memory")
  if (inner.w <= 0 || inner.h <= 0) return
  const s = samples[idx]!
  const groups: [string, number, number][] = [
    ["RAM", s.mem.usedGiB, s.mem.totalGiB],
    ["SWAP", s.swap.usedGiB, s.swap.totalGiB],
  ]
  const detailed = inner.h >= 5
  let y = inner.y
  for (const [label, used, total] of groups) {
    if (y >= inner.y + inner.h) break
    const frac = total > 0 ? used / total : 0
    barLine(b, { x: inner.x, y, w: inner.w, h: 1 }, label, 6, frac * 100, true, P.bg)
    if (detailed && y + 1 < inner.y + inner.h) {
      const free = Math.max(0, total - used)
      segs(
        b,
        inner.x,
        y + 1,
        [
          [`${used.toFixed(2)} / ${total.toFixed(2)} GiB`, P.text],
          [`   free ${free.toFixed(2)} GiB`, P.dim],
        ],
        P.bg,
        inner.x + inner.w,
      )
      y += 3
    } else {
      y += 1
    }
  }
}

function drawNet(b: OptimizedBuffer, r: Rect): void {
  const inner = panel(b, r, "Network")
  if (inner.w <= 0 || inner.h <= 0) return
  const s = samples[idx]!
  segs(
    b,
    inner.x,
    inner.y,
    [
      ["rx ", P.dim],
      [fmtRate(s.net.rxKiBps), P.green, BOLD],
      ["   tx ", P.dim],
      [fmtRate(s.net.txKiBps), P.magenta, BOLD],
    ],
    P.bg,
    inner.x + inner.w,
  )
  const rem = inner.h - 1
  if (rem <= 0) return
  const rxRows = rem >= 2 ? Math.ceil(rem / 2) : rem
  const txRows = rem - rxRows
  vbars(b, { x: inner.x, y: inner.y + 1, w: inner.w, h: rxRows }, series(rxAll, idx, inner.w), rxMax, () => P.green, P.bg)
  if (txRows > 0) {
    vbars(
      b,
      { x: inner.x, y: inner.y + 1 + rxRows, w: inner.w, h: txRows },
      series(txAll, idx, inner.w),
      txMax,
      () => P.magenta,
      P.bg,
    )
  }
}

function drawLoad(b: OptimizedBuffer, r: Rect): void {
  const inner = panel(b, r, "Load average")
  if (inner.w <= 0 || inner.h <= 0) return
  const s = samples[idx]!
  const cores = metrics.cores
  const rows: [string, number][] = [
    ["1 min", s.load[0]],
    ["5 min", s.load[1]],
    ["15 min", s.load[2]],
  ]
  rows.forEach(([label, v], i) => {
    if (i >= inner.h) return
    const y = inner.y + i
    const frac = v / cores
    const color = frac >= 1 ? P.red : frac >= 0.7 ? P.yellow : P.green
    txt(b, inner.x, y, padR(label, 7), P.dim, P.bg, 0, inner.x + inner.w)
    txt(b, inner.x + 7, y, padL(v.toFixed(2), 6), color, P.bg, BOLD, inner.x + inner.w)
    const barW = inner.w - 15
    if (barW >= 4) gauge(b, inner.x + 15, y, barW, frac, color, P.bg)
  })
  if (inner.h > rows.length) {
    txt(b, inner.x, inner.y + rows.length, `${cores} cores`, P.dim, P.bg, 0, inner.x + inner.w)
  }
}

function columnSpec(innerW: number): { key: string; label: string; w: number; right: boolean }[] {
  let cols = [
    { key: "pid", label: "PID", w: 6, right: true },
    { key: "name", label: "NAME", w: 0, right: false },
    { key: "user", label: "USER", w: 10, right: false },
    { key: "cpu", label: "CPU%", w: 6, right: true },
    { key: "mem", label: "MEM%", w: 6, right: true },
    { key: "state", label: "STATE", w: 9, right: false },
  ]
  if (innerW < 62) cols = cols.filter((c) => c.key !== "user")
  if (innerW < 46) cols = cols.filter((c) => c.key !== "state")
  const fixed = cols.reduce((a, c) => a + c.w, 0) + (cols.length - 1) * 2
  const name = cols.find((c) => c.key === "name")!
  name.w = Math.max(6, innerW - fixed + name.w)
  return cols
}

function stateColor(state: string): RGBA {
  switch (state) {
    case "running":
      return P.green
    case "sleeping":
      return P.blue
    case "idle":
      return P.dim
    case "stopped":
      return P.yellow
    case "zombie":
      return P.red
    default:
      return P.text
  }
}

function drawProcs(b: OptimizedBuffer, r: Rect): void {
  const inner = panel(b, r, `Processes  sort: ${SORT_LABEL[sortKey()]}`, `${selIndex() + 1}/${sorted.length}`)
  if (inner.w <= 0 || inner.h <= 1) return
  const cols = columnSpec(inner.w)
  const active = sortKey()
  const sortColKey = active === "cpu" ? "cpu" : active === "mem" ? "mem" : active === "pid" ? "pid" : "name"

  // Header row
  let x = inner.x
  for (const c of cols) {
    const isSort = c.key === sortColKey
    const label = c.label + (isSort ? (active === "cpu" || active === "mem" ? "▼" : "▲") : "")
    const text = c.right ? padL(label, c.w) : padR(label, c.w)
    txt(b, x, inner.y, text, isSort ? P.cyan : P.dim, P.bg, BOLD, inner.x + inner.w)
    x += c.w + 2
  }

  // Keep the selection visible
  const visible = inner.h - 1
  const selI = selIndex()
  if (selI < scroll) scroll = selI
  if (selI >= scroll + visible) scroll = selI - visible + 1
  scroll = clamp(scroll, 0, Math.max(0, sorted.length - visible))

  for (let i = 0; i < visible; i++) {
    const pIdx = scroll + i
    if (pIdx >= sorted.length) break
    const p = sorted[pIdx]!
    const y = inner.y + 1 + i
    const selected = p.pid === selPid
    const rowBg = selected ? P.sel : P.bg
    if (selected) b.fillRect(inner.x, y, inner.w, 1, P.sel)

    let cx = inner.x
    for (const c of cols) {
      let value: string
      let fg: RGBA = P.text
      let attr = selected ? BOLD : 0
      switch (c.key) {
        case "pid":
          value = String(p.pid)
          break
        case "name":
          value = p.name
          break
        case "user":
          value = p.user
          break
        case "cpu":
          value = p.cpu.toFixed(1)
          fg = p.cpu >= 50 ? P.red : p.cpu >= 25 ? P.yellow : P.text
          break
        case "mem":
          value = p.mem.toFixed(1)
          fg = p.mem >= 10 ? P.red : p.mem >= 5 ? P.yellow : P.text
          break
        case "state":
          value = p.state
          fg = stateColor(p.state)
          attr = BOLD
          break
        default:
          value = ""
      }
      const text = c.right ? padL(value, c.w) : padR(value, c.w)
      txt(b, cx, y, text, fg, rowBg, attr, inner.x + inner.w)
      cx += c.w + 2
    }
  }
}

function drawPopup(b: OptimizedBuffer): void {
  if (!popupOpen) return
  const p = PROCS.find((pr) => pr.pid === popupPid)
  if (!p) return
  const W = b.width
  const H = b.height
  const pw = Math.min(72, W - 4)
  const ph = Math.min(13, H - 2)
  if (pw < 30 || ph < 9) return
  const x = Math.floor((W - pw) / 2)
  const y = Math.floor((H - ph) / 2)
  b.fillRect(x, y, pw, ph, P.popup)
  const inner = panel(b, { x, y, w: pw, h: ph }, `Process ${p.pid}`, "esc to close", P.popup)
  const fields: [string, string, RGBA][] = [
    ["PID", String(p.pid), P.text],
    ["Name", p.name, P.bright],
    ["User", p.user, P.text],
    ["CPU", `${p.cpu.toFixed(1)} %`, usageColor(p.cpu)],
    ["Memory", `${p.mem.toFixed(1)} %`, usageColor(p.mem * 5)],
    ["Threads", String(p.threads), P.text],
    ["State", p.state, stateColor(p.state)],
    ["Started", p.started, P.text],
    ["Command", p.command, P.text],
  ]
  fields.forEach(([label, value, color], i) => {
    if (i >= inner.h) return
    const yy = inner.y + i
    txt(b, inner.x + 1, yy, padR(label, 10), P.dim, P.popup, 0, inner.x + inner.w)
    txt(b, inner.x + 11, yy, value, color, P.popup, i === 1 ? BOLD : 0, inner.x + inner.w)
  })
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function drawHeader(b: OptimizedBuffer, W: number): void {
  b.fillRect(0, 0, W, 1, P.bar)
  const badge: [string, RGBA] = finished()
    ? ["■ REPLAY FINISHED ", P.cyan]
    : paused
      ? ["|| PAUSED ", P.yellow]
      : ["● PLAYING ", P.green]
  const badgeX = Math.max(0, W - badge[0].length)
  segs(
    b,
    0,
    0,
    [
      [` ${metrics.host}`, P.bright, BOLD],
      ["   sample ", P.dim],
      [`${idx + 1}/${N}`, P.text, BOLD],
      ["   uptime ", P.dim],
      [metrics.uptime, P.text],
      ["   " + metrics.kernel, P.dim],
    ],
    P.bar,
    badgeX,
  )
  txt(b, badgeX, 0, badge[0], badge[1], P.bar, BOLD, W)
}

function drawFooter(b: OptimizedBuffer, W: number, H: number): void {
  const y = H - 1
  b.fillRect(0, y, W, 1, P.bar)
  const pauseLabel = paused ? "resume" : "pause"
  const full: [string, string][] = [
    ["j/k", "move"],
    ["s", `sort ${SORT_LABEL[sortKey()]}`],
    ["enter", "details"],
    ["p", pauseLabel],
    ["q", "quit"],
  ]
  const compact: [string, string][] = [
    ["j/k", "move"],
    ["s", "sort"],
    ["enter", "info"],
    ["p", pauseLabel],
    ["q", "quit"],
  ]
  const toSegs = (items: [string, string][]): Seg[] => {
    const list: Seg[] = []
    for (const [k, label] of items) {
      list.push([` ${k} `, P.bright, BOLD])
      list.push([`${label}  `, P.dim])
    }
    return list
  }
  const fullList = toSegs(full)
  const fullLen = fullList.reduce((a, [s]) => a + s.length, 0)
  segs(b, 0, y, fullLen <= W ? fullList : toSegs(compact), P.bar, W)
}

function draw(b: OptimizedBuffer): void {
  const W = b.width
  const H = b.height
  b.clear(P.bg)
  if (W < 40 || H < 12) {
    txt(b, 0, 0, `Terminal too small (${W}x${H}). Need at least 40x12.`, P.yellow, P.bg, BOLD)
    return
  }
  drawHeader(b, W)
  drawFooter(b, W, H)

  // Vertical split of the body (between header and footer)
  const bodyY = 1
  const bodyH = H - 2
  let A = clamp(Math.round(bodyH * 0.35), 6, bodyH)
  let Bh = clamp(Math.round(bodyH * 0.24), 5, bodyH)
  if (bodyH - A - Bh < 6) Bh = 0
  const C = bodyH - A - Bh

  // Row A: CPU cores | CPU history
  const leftW = W >= 60 ? Math.round(W * 0.45) : W
  drawCpu(b, { x: 0, y: bodyY, w: leftW, h: A })
  if (W >= 60) drawHistory(b, { x: leftW, y: bodyY, w: W - leftW, h: A })

  // Row B: Memory | Load average | Network
  if (Bh > 0) {
    const y = bodyY + A
    let memW: number
    let loadW: number
    if (W >= 90) {
      memW = Math.round(W * 0.34)
      loadW = 24
    } else if (W >= 60) {
      memW = Math.round(W * 0.4)
      loadW = 18
    } else {
      memW = Math.floor(W / 2)
      loadW = 0
    }
    const netW = W - memW - loadW
    drawMem(b, { x: 0, y, w: memW, h: Bh })
    if (loadW > 0) drawLoad(b, { x: memW, y, w: loadW, h: Bh })
    drawNet(b, { x: memW + loadW, y, w: netW, h: Bh })
  }

  // Row C: processes
  drawProcs(b, { x: 0, y: bodyY + A + Bh, w: W, h: C })

  drawPopup(b)
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const renderer = await createCliRenderer({ exitOnCtrlC: true })

let timer: ReturnType<typeof setInterval> | null = null

function quit(): void {
  if (timer) clearInterval(timer)
  timer = null
  renderer.destroy()
  process.exit(0)
}

const root = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  border: false,
  renderBefore: (buffer: OptimizedBuffer) => {
    try {
      draw(buffer)
    } catch {
      // Never let a drawing problem take the app down.
    }
  },
})
renderer.root.add(root)

renderer.on("resize", () => renderer.requestRender())

timer = setInterval(() => {
  if (!paused && !finished()) {
    idx++
    if (finished() && timer) {
      clearInterval(timer)
      timer = null
    }
    renderer.requestRender()
  }
}, metrics.intervalMs)

function togglePause(): void {
  if (finished()) return
  paused = !paused
}

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  const name = key.name
  if (popupOpen) {
    if (name === "escape" || name === "esc") popupOpen = false
    else if (name === "p") togglePause()
    else if (name === "q") return quit()
    renderer.requestRender()
    return
  }
  switch (name) {
    case "j":
    case "down":
      moveSelection(1)
      break
    case "k":
    case "up":
      moveSelection(-1)
      break
    case "s":
      sortMode = (sortMode + 1) % SORT_ORDER.length
      resort()
      break
    case "return":
    case "enter":
      if (sorted.length > 0) {
        popupPid = selPid
        popupOpen = true
      }
      break
    case "p":
      togglePause()
      break
    case "q":
      return quit()
    default:
      return
  }
  renderer.requestRender()
})
