import type { OptimizedBuffer } from "@opentui/core"
import { BOLD, Canvas, P, fit, gradient, hbar, mix, padL, padR, segLen, threshold, vcol, type Seg } from "./canvas.ts"
import type { Proc, Sample } from "./data.ts"
import { SORT_LABEL, type AppState, type SortKey } from "./state.ts"

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function fmtRate(k: number): string {
  if (k >= 1024 * 1024) return (k / 1024 / 1024).toFixed(2) + " GiB/s"
  if (k >= 1024) return (k / 1024).toFixed(2) + " MiB/s"
  return k.toFixed(0) + " KiB/s"
}

export function draw(buf: OptimizedBuffer, st: AppState) {
  const W = buf.width
  const H = buf.height
  const cv = new Canvas(buf, W, H)
  cv.dim = st.detailOpen
  cv.fill(0, 0, W, H, P.bg)

  if (W < 30 || H < 10) {
    cv.dim = false
    const msg = "Terminal too small"
    cv.text(Math.max(0, Math.floor((W - msg.length) / 2)), Math.floor(H / 2), fit(msg, W), P.yellow, P.bg, BOLD)
    return
  }

  const s = st.m.samples[st.index]!

  drawHeader(cv, st, s, W)
  drawFooter(cv, st, W, H)

  // ---- vertical layout -------------------------------------------------
  const top = 1
  const avail = H - 2
  let A = 12
  let B = 8
  const rest = () => avail - A - B
  if (rest() < 10) A = 10
  if (rest() < 8) B = 7
  if (rest() < 8) B = 6
  if (rest() < 8) A = 6
  if (rest() < 6) B = 5
  if (rest() < 5) A = 5
  const Pn = Math.max(0, rest())

  // ---- row A: CPU + history ------------------------------------------
  const cpuW = clamp(Math.round(W * (W >= 100 ? 0.38 : 0.45)), 24, W - 20)
  drawCpu(cv, st, s, 0, top, cpuW, A)
  drawHistory(cv, st, cpuW, top, W - cpuW, A)

  // ---- row B: memory, network, load ----------------------------------
  const yB = top + A
  const memW = Math.round(W * (W >= 100 ? 0.33 : 0.32))
  const loadW = Math.round(W * (W >= 100 ? 0.24 : 0.3))
  const netW = W - memW - loadW
  drawMemory(cv, s, 0, yB, memW, B)
  drawNetwork(cv, st, memW, yB, netW, B)
  drawLoad(cv, st, s, memW + netW, yB, loadW, B)

  // ---- row C: processes ------------------------------------------------
  if (Pn >= 3) drawProcesses(cv, st, 0, yB + B, W, Pn)

  if (st.detailOpen) {
    cv.dim = false
    drawDetail(cv, st, W, H)
  }
}

// ======================================================================
function drawHeader(cv: Canvas, st: AppState, s: Sample, W: number) {
  const m = st.m
  cv.fill(0, 0, W, 1, P.headerBg)
  const bg = P.headerBg
  const total = m.samples.length

  const badgeFor = (short: boolean): Seg => {
    if (st.finished && st.paused)
      return { t: short ? " ‖ PAUSED " : " ‖ PAUSED · REPLAY FINISHED ", fg: P.dark, bg: P.yellow, bold: true }
    if (st.finished) return { t: short ? " ■ FINISHED " : " ■ REPLAY FINISHED ", fg: P.dark, bg: P.purple, bold: true }
    if (st.paused) return { t: " ‖ PAUSED ", fg: P.dark, bg: P.yellow, bold: true }
    return { t: " ▶ PLAYING ", fg: P.dark, bg: P.green, bold: true }
  }
  // right-hand variants, most detailed first
  const rights = [
    { prog: 20, pos: `sample ${st.index + 1}/${total}`, short: false },
    { prog: 12, pos: `sample ${st.index + 1}/${total}`, short: false },
    { prog: 0, pos: `sample ${st.index + 1}/${total}`, short: false },
    { prog: 0, pos: `sample ${st.index + 1}/${total}`, short: true },
    { prog: 0, pos: `${st.index + 1}/${total}`, short: true },
  ]
  const rightLenOf = (r: (typeof rights)[number]) =>
    segLen([badgeFor(r.short)]) + 1 + r.pos.length + 1 + (r.prog ? r.prog + 1 : 0)

  const hostSeg: Seg[] = [{ t: " ● " + m.host + " ", fg: P.dark, bg: P.blue, bold: true }]
  const fullLeft: Seg[][] = [
    hostSeg,
    [{ t: "  ", fg: P.muted }, { t: m.kernel, fg: P.text }],
    [{ t: "  │  ", fg: P.faint }, { t: "up ", fg: P.muted }, { t: m.uptime, fg: P.text }],
    [{ t: "  │  ", fg: P.faint }, { t: String(m.cores), fg: P.text }, { t: " cores", fg: P.muted }],
  ]
  const midLeft: Seg[][] = [
    hostSeg,
    [{ t: "  ", fg: P.muted }, { t: m.kernel, fg: P.text }],
    [{ t: " │ ", fg: P.faint }, { t: "up ", fg: P.muted }, { t: m.uptime, fg: P.text }],
    [{ t: " │ ", fg: P.faint }, { t: String(m.cores), fg: P.text }, { t: " cores", fg: P.muted }],
  ]
  const compactLeft: Seg[][] = [
    hostSeg,
    [{ t: " ", fg: P.muted }, { t: m.kernel, fg: P.text }],
    [{ t: " · ", fg: P.faint }, { t: "up ", fg: P.muted }, { t: m.uptime, fg: P.text }],
  ]
  const total3 = (parts: Seg[][]) => parts.reduce((n, p) => n + segLen(p), 0)

  let chosen = rights[rights.length - 1]!
  let left = compactLeft
  outer: for (const l of [fullLeft, midLeft, compactLeft]) {
    for (const r of rights) {
      if (total3(l) + 2 + rightLenOf(r) <= W) {
        chosen = r
        left = l
        break outer
      }
    }
  }
  const rightLen = rightLenOf(chosen)
  const badge = badgeFor(chosen.short)
  let rx = W - rightLen
  if (chosen.prog) {
    const progW = chosen.prog
    const frac = total > 1 ? st.index / (total - 1) : 1
    const filled = Math.round(frac * progW)
    const col = st.finished ? P.purple : st.paused ? P.yellow : P.blue
    cv.text(rx, 0, "━".repeat(filled), col, bg)
    cv.text(rx + filled, 0, "─".repeat(progW - filled), P.faint, bg)
    rx += progW + 1
  }
  rx = cv.text(rx, 0, chosen.pos, P.text, bg, BOLD)
  rx += 1
  cv.segs(rx, 0, [badge], bg)

  // left side (parts dropped from the end if they still do not fit)
  const leftMax = Math.max(0, W - rightLen - 1)
  cv.pushClip(0, 0, leftMax, 1)
  let used = 0
  let lx = 0
  for (let i = 0; i < left.length; i++) {
    const p = left[i]!
    const len = segLen(p)
    if (i > 0 && used + len > leftMax) break
    lx = cv.segs(lx, 0, p, bg)
    used += len
  }
  cv.popClip()
}

function drawFooter(cv: Canvas, st: AppState, W: number, H: number) {
  const y = H - 1
  cv.fill(0, y, W, 1, P.headerBg)
  const bg = P.headerBg
  const narrow = W < 90
  const keys: [string, string][] = st.detailOpen
    ? [
        ["esc", "close"],
        ["p", st.paused ? "resume" : "pause"],
        ["q", "quit"],
      ]
    : [
        [narrow ? "j/k" : "↑↓ j k", "select"],
        ["s", "sort"],
        ["enter", "details"],
        ["p", st.paused ? "resume" : "pause"],
        ["q", "quit"],
      ]
  const right = `sort ${SORT_LABEL[st.sortKey]} ${st.sortKey === "pid" || st.sortKey === "name" ? "▲" : "▼"} · ${st.m.intervalMs} ms/sample `
  const lenWith = (gap: number) => keys.reduce((n, [k, l]) => n + k.length + 2 + 1 + l.length + gap, 1)
  const gap = lenWith(2) <= W ? 2 : 1
  const keysLen = lenWith(gap)
  const rightW = keysLen + right.length + 1 <= W ? right.length : 0
  let x = 1
  const limit = W - rightW
  // drop middle hints first so that quit stays visible
  const shown = [...keys]
  while (shown.length > 1 && shown.reduce((n, [k, l]) => n + k.length + 3 + l.length + gap, 1) > limit) {
    shown.splice(Math.max(0, shown.length - 3), 1)
  }
  for (const [k, label] of shown) {
    x = cv.text(x, y, ` ${k} `, P.dark, P.blue, BOLD)
    x = cv.text(x, y, " " + label, P.muted, bg)
    x += gap
  }
  if (rightW) cv.text(W - rightW, y, right, P.muted, bg)
}

// ======================================================================
function drawCpu(cv: Canvas, st: AppState, s: Sample, x: number, y: number, w: number, h: number) {
  if (w < 6 || h < 3) return
  const a = avg(s.cpu)
  cv.panel(x, y, w, h, {
    color: P.border,
    title: [{ t: "CPU", fg: P.blue, bold: true }],
    right: [
      { t: "avg ", fg: P.muted },
      { t: a.toFixed(1) + "%", fg: threshold(a), bold: true },
    ],
  })
  const ix = x + 2
  const iw = w - 4
  const iy = y + 1
  const ih = h - 2
  cv.pushClip(x + 1, iy, w - 2, ih)
  const n = s.cpu.length
  const showAvg = ih >= n + 2
  const rows = Math.max(1, Math.min(ih, n))
  const cols = Math.ceil(n / rows)
  const gap = 3
  const cw = Math.floor((iw - gap * (cols - 1)) / cols)
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / rows)
    const r = i % rows
    if (r >= ih) continue
    coreRow(cv, ix + c * (cw + gap), iy + r, cw, cols === 1 ? `cpu${i}` : `C${i}`, s.cpu[i]!, false)
  }
  if (showAvg) {
    cv.text(ix, iy + n, "┈".repeat(iw), P.faint)
    coreRow(cv, ix, iy + n + 1, iw, "avg", a, true)
  }
  cv.popClip()
}

function coreRow(cv: Canvas, x: number, y: number, w: number, label: string, v: number, strong: boolean) {
  const lw = label.length <= 2 ? 3 : 5
  const wide = w >= 22
  const pct = wide ? padL(v.toFixed(1) + "%", 6) : padL(Math.round(v) + "%", 4)
  const barW = w - lw - pct.length - 1
  cv.text(x, y, padR(label, lw), strong ? P.bright : P.muted, P.bg, strong ? BOLD : 0)
  if (barW >= 3) hbar(cv, x + lw, y, barW, v)
  cv.text(x + w - pct.length, y, pct, threshold(v), P.bg, strong ? BOLD : 0)
}

// ======================================================================
function drawHistory(cv: Canvas, st: AppState, x: number, y: number, w: number, h: number) {
  if (w < 10 || h < 3) return
  const played = st.m.samples.slice(0, st.index + 1).map((s) => avg(s.cpu))
  const cur = played[played.length - 1] ?? 0
  const peak = Math.max(...played)
  const low = Math.min(...played)
  cv.panel(x, y, w, h, {
    color: P.border,
    title: [{ t: "CPU history", fg: P.purple, bold: true }],
    right:
      w >= 64
        ? [
            { t: "min ", fg: P.muted },
            { t: low.toFixed(1) + "%", fg: threshold(low) },
            { t: "  max ", fg: P.muted },
            { t: peak.toFixed(1) + "%", fg: threshold(peak) },
            { t: "  now ", fg: P.muted },
            { t: cur.toFixed(1) + "%", fg: threshold(cur), bold: true },
          ]
        : [
            { t: "now ", fg: P.muted },
            { t: cur.toFixed(1) + "%", fg: threshold(cur), bold: true },
          ],
    bottomLeft: [
      { t: `${played.length}`, fg: P.text },
      { t: ` of ${st.m.samples.length} samples · ${st.m.intervalMs} ms`, fg: P.muted },
    ],
    bottomRight: st.finished ? [{ t: "■ replay complete", fg: P.purple }] : undefined,
  })
  const ih = h - 2
  const iw = w - 3
  const ix = x + 1
  const iy = y + 1
  cv.pushClip(ix, iy, w - 2, ih)
  const axisW = iw >= 30 ? 5 : 0
  const bottom = iy + ih - 1
  const grid = new Set<number>()
  if (axisW) {
    const label = (r: number, t: string) => {
      cv.text(ix, bottom - r, padL(t, 4), P.muted)
      cv.text(ix + 4, bottom - r, "┤", P.faint)
      grid.add(r)
    }
    for (let r = 0; r < ih; r++) cv.text(ix + 4, bottom - r, "│", P.faint)
    if (ih >= 2) {
      label(ih - 1, "100")
      label(0, "0")
    }
    if (ih >= 5) label(Math.round((ih - 1) / 2), "50")
    if (ih >= 9) {
      label(Math.round((ih - 1) * 0.25), "25")
      label(Math.round((ih - 1) * 0.75), "75")
    }
    grid.delete(0)
    grid.delete(ih - 1)
  }
  const cx = ix + axisW
  const cw = iw - axisW
  const visible = played.slice(Math.max(0, played.length - cw))
  // grid across the whole chart width first
  for (let c = 0; c < cw; c++) vcol(cv, cx + c, bottom, ih, 0, gradient, grid)
  visible.forEach((v, i) => {
    const isLast = i === visible.length - 1
    vcol(cv, cx + i, bottom, ih, v / 100, (rf) => (isLast ? mix(gradient(rf), "#ffffff", 0.25) : gradient(rf)), grid)
  })
  cv.popClip()
}

// ======================================================================
function drawMemory(cv: Canvas, s: Sample, x: number, y: number, w: number, h: number) {
  if (w < 8 || h < 3) return
  const memPct = s.mem.totalGiB > 0 ? (s.mem.usedGiB / s.mem.totalGiB) * 100 : 0
  const swpPct = s.swap.totalGiB > 0 ? (s.swap.usedGiB / s.swap.totalGiB) * 100 : 0
  cv.panel(x, y, w, h, {
    color: P.border,
    title: [{ t: "Memory", fg: P.green, bold: true }],
    right: [{ t: `${s.mem.totalGiB.toFixed(0)} GiB`, fg: P.muted }],
  })
  const ix = x + 2
  const iw = w - 4
  const iy = y + 1
  const ih = h - 2
  cv.pushClip(x + 1, iy, w - 2, ih)
  const gauge = (yy: number, label: string, pct: number) => {
    const p = padL(pct.toFixed(1) + "%", 6)
    cv.text(ix, yy, label, P.bright, P.bg, BOLD)
    hbar(cv, ix + 5, yy, iw - 5 - p.length - 1, pct)
    cv.text(ix + iw - p.length, yy, p, threshold(pct), P.bg, BOLD)
  }
  const values = (yy: number, used: number, total: number) => {
    let px = cv.text(ix + 5, yy, used.toFixed(2), P.text)
    px = cv.text(px, yy, " / ", P.faint)
    px = cv.text(px, yy, total.toFixed(2) + " GiB", P.muted)
    const free = `free ${Math.max(0, total - used).toFixed(2)}`
    if (px + free.length + 2 <= ix + iw) cv.text(ix + iw - free.length, yy, free, P.muted)
  }
  const gapRow = ih >= 5 ? 1 : 0
  gauge(iy, "Mem", memPct)
  if (ih >= 4) values(iy + 1, s.mem.usedGiB, s.mem.totalGiB)
  const sy = iy + (ih >= 4 ? 2 : 1) + gapRow
  if (s.swap.totalGiB > 0) {
    gauge(sy, "Swap", swpPct)
    if (ih >= 4) values(sy + 1, s.swap.usedGiB, s.swap.totalGiB)
  } else cv.text(ix, sy, "Swap  disabled", P.muted)
  cv.popClip()
}

// ======================================================================
function drawNetwork(cv: Canvas, st: AppState, x: number, y: number, w: number, h: number) {
  if (w < 10 || h < 3) return
  const played = st.m.samples.slice(0, st.index + 1)
  const s = played[played.length - 1]!
  const rx = played.map((p) => p.net.rxKiBps)
  const tx = played.map((p) => p.net.txKiBps)
  cv.panel(x, y, w, h, {
    color: P.border,
    title: [{ t: "Network", fg: P.cyan, bold: true }],
    right: [{ t: "eth0", fg: P.muted }],
  })
  const ix = x + 2
  const iw = w - 4
  const iy = y + 1
  const ih = h - 2
  cv.pushClip(x + 1, iy, w - 2, ih)
  const chartH = Math.max(0, Math.floor((ih - 2) / 2))
  const series = (yy: number, arrow: string, name: string, color: string, data: number[], cur: number) => {
    const peak = Math.max(1, ...data)
    let px = cv.text(ix, yy, arrow + " ", color, P.bg, BOLD)
    px = cv.text(px, yy, name + " ", P.muted)
    cv.text(px, yy, fmtRate(cur), P.bright, P.bg, BOLD)
    const pk = `peak ${fmtRate(peak)}`
    if (iw >= 34) cv.text(ix + iw - pk.length, yy, pk, P.muted)
    if (chartH > 0) {
      const vis = data.slice(Math.max(0, data.length - iw))
      const bottom = yy + chartH
      vis.forEach((v, i) => {
        vcol(cv, ix + i, bottom, chartH, v / peak, (rf) => mix(mix(color, P.bg, 0.55), color, Math.min(1, rf + 0.35)))
      })
    }
  }
  series(iy, "▼", "RX", P.cyan, rx, s.net.rxKiBps)
  series(iy + 1 + chartH, "▲", "TX", P.purple, tx, s.net.txKiBps)
  cv.popClip()
}

// ======================================================================
function drawLoad(cv: Canvas, st: AppState, s: Sample, x: number, y: number, w: number, h: number) {
  if (w < 8 || h < 3) return
  const cores = st.m.cores || 1
  const prev = st.index > 0 ? st.m.samples[st.index - 1]! : null
  cv.panel(x, y, w, h, {
    color: P.border,
    title: [{ t: "Load average", fg: P.yellow, bold: true }],
  })
  const ix = x + 2
  const iw = w - 4
  const iy = y + 1
  const ih = h - 2
  cv.pushClip(x + 1, iy, w - 2, ih)
  const labels = ["1 min", "5 min", "15 min"]
  const loadColor = (l: number) => (l / cores >= 1 ? P.red : l / cores >= 0.7 ? P.yellow : P.green)
  for (let i = 0; i < 3 && i < ih; i++) {
    const v = s.load[i] ?? 0
    const pv = prev?.load[i] ?? v
    const lw = iw >= 20 ? 7 : 4
    const lab = iw >= 20 ? labels[i]! : labels[i]!.replace(" min", "m")
    cv.text(ix, iy + i, padR(lab, lw), P.muted)
    const val = v.toFixed(2)
    cv.text(ix + lw, iy + i, padL(val, 5), loadColor(v), P.bg, BOLD)
    const arrow = v > pv + 0.001 ? "▲" : v < pv - 0.001 ? "▼" : "•"
    const ac = v > pv + 0.001 ? P.orange : v < pv - 0.001 ? P.teal : P.faint
    const barX = ix + lw + 6
    const barW = iw - lw - 6 - 2
    if (barW >= 4) hbar(cv, barX, iy + i, barW, (v / cores) * 100)
    cv.text(ix + iw - 1, iy + i, arrow, ac)
  }
  if (ih >= 6) {
    const hist = st.m.samples.slice(0, st.index + 1).map((x) => x.load[0] ?? 0)
    const chartH = ih - 4
    const bottom = iy + 3 + chartH - 1
    const scale = Math.max(cores * 0.75, ...hist)
    const vis = hist.slice(Math.max(0, hist.length - iw))
    vis.forEach((v, i) =>
      vcol(cv, ix + i, bottom, chartH, v / scale, () => mix(loadColor(v), P.bg, 0.25)),
    )
  }
  if (ih >= 5) {
    const per = (s.load[0] ?? 0) / cores
    const y2 = iy + ih - 1
    let px = cv.text(ix, y2, `${cores} cores`, P.muted)
    const sep = iw >= 24 ? "  ·  " : " · "
    if (`${cores} cores`.length + sep.length + 9 <= iw) {
      px = cv.text(px, y2, sep, P.faint)
      px = cv.text(px, y2, per.toFixed(2), loadColor(s.load[0] ?? 0))
      cv.text(px, y2, "/core", P.muted)
    }
  }
  cv.popClip()
}

// ======================================================================
interface Col {
  key: string
  label: string
  w: number
  right?: boolean
  sort?: SortKey
}

function stateSeg(state: string): { dot: string; color: string } {
  switch (state) {
    case "running":
      return { dot: "●", color: P.green }
    case "sleeping":
      return { dot: "●", color: P.blue }
    case "idle":
      return { dot: "○", color: P.muted }
    case "zombie":
      return { dot: "✕", color: P.red }
    case "stopped":
      return { dot: "■", color: P.yellow }
    default:
      return { dot: "●", color: P.muted }
  }
}

function procCpuColor(v: number): string {
  if (v >= 30) return P.red
  if (v >= 15) return P.orange
  if (v >= 5) return P.yellow
  return P.text
}
function procMemColor(v: number): string {
  if (v >= 10) return P.red
  if (v >= 5) return P.yellow
  return P.text
}

function drawProcesses(cv: Canvas, st: AppState, x: number, y: number, w: number, h: number) {
  const list = st.sorted
  const n = list.length
  const ih = h - 2
  const visible = Math.max(0, ih - 1)
  // keep the selection in view
  if (st.selected < st.scroll) st.scroll = st.selected
  if (st.selected >= st.scroll + visible) st.scroll = st.selected - visible + 1
  st.scroll = clamp(st.scroll, 0, Math.max(0, n - visible))

  const sortArrow = st.sortKey === "pid" || st.sortKey === "name" ? "▲" : "▼"
  const running = list.filter((p) => p.state === "running").length
  cv.panel(x, y, w, h, {
    color: P.border,
    title: [
      { t: "Processes", fg: P.red, bold: true },
      { t: `  ${n} total · ${running} running`, fg: P.muted },
    ],
    right: [
      { t: "sorted by ", fg: P.muted },
      { t: `${SORT_LABEL[st.sortKey]} ${sortArrow}`, fg: P.yellow, bold: true },
    ],
    bottomRight: n ? [{ t: `${st.selected + 1}/${n}`, fg: P.muted }] : undefined,
  })
  const ix = x + 1
  const iw = w - 2
  const iy = y + 1
  if (ih < 1) return
  cv.pushClip(ix, iy, iw, ih)

  // ---- columns ----
  const avail = iw - 4 // marker column + gap + right pad + scrollbar
  const cols: Col[] = [
    { key: "pid", label: "PID", w: 6, right: true, sort: "pid" },
    { key: "name", label: "NAME", w: 0, sort: "name" },
    { key: "user", label: "USER", w: 10 },
    { key: "cpu", label: "CPU%", w: 6, right: true, sort: "cpu" },
    { key: "mem", label: "MEM%", w: 6, right: true, sort: "mem" },
    { key: "state", label: "STATE", w: 10 },
  ]
  let nameW = avail - cols.reduce((s, c) => s + c.w, 0) - (cols.length - 1)
  if (nameW < 10) {
    cols[2]!.w = 8
    nameW += 2
  }
  if (nameW < 10) {
    cols[5]!.w = 8
    nameW += 2
  }
  if (nameW > 30) {
    cols.splice(5, 0, { key: "thr", label: "THR", w: 4, right: true })
    nameW -= 5
  }
  if (nameW >= 24 + 18) {
    const cmdW = nameW - 24 - 1
    nameW = 24
    cols.push({ key: "cmd", label: "COMMAND", w: cmdW })
  }
  cols[1]!.w = Math.max(4, nameW)

  // ---- header ----
  cv.fill(ix, iy, iw, 1, P.tableHead)
  let cx = ix + 2
  for (const c of cols) {
    const active = c.sort === st.sortKey
    const lab = active ? c.label + sortArrow : c.label
    const txt = c.right ? padL(lab, c.w) : padR(lab, c.w)
    cv.text(cx, iy, txt, active ? P.yellow : P.muted, P.tableHead, BOLD)
    cx += c.w + 1
  }

  // ---- rows ----
  for (let r = 0; r < visible; r++) {
    const i = st.scroll + r
    const p = list[i]
    if (!p) break
    const yy = iy + 1 + r
    const sel = i === st.selected
    const bg = sel ? P.selBg : r % 2 === 1 ? P.rowAlt : P.bg
    cv.fill(ix, yy, iw - 1, 1, bg)
    if (sel) cv.text(ix, yy, "▶", P.blue, bg, BOLD)
    let px = ix + 2
    for (const c of cols) {
      const cell = cellFor(p, c)
      const txt = c.right ? padL(cell.t, c.w) : padR(cell.t, c.w)
      if (c.key === "state") {
        const ss = stateSeg(p.state)
        cv.text(px, yy, ss.dot, ss.color, bg)
        cv.text(px + 2, yy, padR(p.state, c.w - 2), sel ? P.bright : ss.color, bg)
      } else {
        cv.text(px, yy, txt, sel && cell.fg === P.text ? P.bright : cell.fg, bg, sel || cell.bold ? BOLD : 0)
      }
      px += c.w + 1
    }
  }
  if (n === 0) cv.text(ix + 2, iy + 1, "no processes", P.muted)

  // ---- scrollbar ----
  if (n > visible && visible > 0) {
    const sx = ix + iw - 1
    const thumbH = Math.max(1, Math.round((visible / n) * visible))
    const maxScroll = n - visible
    const thumbY = Math.round((st.scroll / maxScroll) * (visible - thumbH))
    for (let r = 0; r < visible; r++) {
      const on = r >= thumbY && r < thumbY + thumbH
      cv.text(sx, iy + 1 + r, on ? "┃" : "│", on ? P.muted : P.faint)
    }
  }
  cv.popClip()
}

function cellFor(p: Proc, c: Col): { t: string; fg: string; bold?: boolean } {
  switch (c.key) {
    case "pid":
      return { t: String(p.pid), fg: P.muted }
    case "name":
      return { t: p.name, fg: P.text, bold: false }
    case "user":
      return { t: p.user, fg: p.user === "root" ? P.orange : P.teal }
    case "cpu":
      return { t: p.cpu.toFixed(1), fg: procCpuColor(p.cpu) }
    case "mem":
      return { t: p.mem.toFixed(1), fg: procMemColor(p.mem) }
    case "thr":
      return { t: String(p.threads), fg: P.muted }
    case "cmd":
      return { t: p.command, fg: P.muted }
    default:
      return { t: "", fg: P.text }
  }
}

// ======================================================================
function fmtStarted(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(s)
  return m ? `${m[1]} ${m[2]} UTC` : s
}

function drawDetail(cv: Canvas, st: AppState, W: number, H: number) {
  const p = st.selectedProc
  if (!p) return
  const w = Math.min(66, W - 4)
  const lines = 9
  const wantH = lines + 6
  const h = Math.min(wantH, H - 3)
  const x = Math.floor((W - w) / 2)
  const y = 1 + Math.max(0, Math.floor((H - 2 - h) / 2))
  const bg = "#161a28"
  // shadow (kept off the footer row)
  cv.pushClip(0, 1, W, H - 2)
  cv.fill(x + 2, y + 1, w, h, "#07080d")
  cv.popClip()
  cv.panel(x, y, w, h, {
    color: P.blue,
    bg,
    title: [
      { t: "Process ", fg: P.muted },
      { t: String(p.pid), fg: P.bright, bold: true },
    ],
    right: [{ t: "esc close", fg: P.muted }],
  })
  const ix = x + 3
  const iw = w - 6
  cv.pushClip(x + 1, y + 1, w - 2, h - 2)
  const roomy = h >= wantH
  let yy = y + 1 + (roomy ? 1 : 0)
  // heading: name + state badge
  const ss = stateSeg(p.state)
  const badge = ` ${ss.dot} ${p.state} `
  cv.text(ix, yy, fit(p.name, iw - badge.length - 1), P.bright, bg, BOLD)
  cv.text(ix + iw - badge.length, yy, badge, P.dark, ss.color, BOLD)
  yy++
  if (roomy) {
    cv.text(ix, yy, "─".repeat(iw), P.border, bg)
    yy++
  }
  const lw = 10
  const vw = iw - lw
  const row = (label: string, draw: (vx: number, yy: number) => void) => {
    if (yy >= y + h - 1) return
    cv.text(ix, yy, label, P.muted, bg)
    draw(ix + lw, yy)
    yy++
  }
  const plain = (v: string, fg: string = P.text, bold = false) => (vx: number, y2: number) => {
    cv.text(vx, y2, fit(v, vw), fg, bg, bold ? BOLD : 0)
  }
  const memGiB = (p.mem / 100) * (st.m.samples[st.index]?.mem.totalGiB ?? 0)
  row("PID", plain(String(p.pid), P.bright, true))
  row("Name", plain(p.name))
  row("User", plain(p.user, p.user === "root" ? P.orange : P.teal))
  row("CPU%", (vx, y2) => {
    const t = padR(p.cpu.toFixed(1) + "%", 7)
    cv.text(vx, y2, t, procCpuColor(p.cpu), bg, BOLD)
    if (vw - 8 >= 6) hbar(cv, vx + 8, y2, Math.min(24, vw - 8), p.cpu, gradient, bg)
  })
  row("MEM%", (vx, y2) => {
    const t = padR(p.mem.toFixed(1) + "%", 7)
    cv.text(vx, y2, t, procMemColor(p.mem), bg, BOLD)
    const bw = Math.min(24, vw - 8)
    if (bw >= 6) hbar(cv, vx + 8, y2, bw, p.mem, gradient, bg)
    const extra = `≈ ${memGiB.toFixed(2)} GiB`
    if (vw - 8 - bw - 2 >= extra.length) cv.text(vx + 8 + bw + 2, y2, extra, P.muted, bg)
  })
  row("Threads", plain(String(p.threads)))
  row("State", (vx, y2) => {
    cv.text(vx, y2, ss.dot, ss.color, bg)
    cv.text(vx + 2, y2, fit(p.state, vw - 2), ss.color, bg)
  })
  row("Started", plain(fmtStarted(p.started)))
  row("Command", plain(p.command, P.cyan))
  cv.popClip()
}
