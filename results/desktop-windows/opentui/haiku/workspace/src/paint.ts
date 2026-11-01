// Draws the whole screen into the render buffer each frame: menu bar, desktop, windows, taskbar,
// open menu and the About dialog. Layout and state come from desk.ts and apps.ts.

import { RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core"
import {
  CLOCK,
  MENUS,
  aboutOkRect,
  aboutRect,
  contentRect,
  deskH,
  dropdownRect,
  focused,
  menuBarItems,
  setScreen,
  shell,
  taskbarItems,
  type Rect,
  type Win,
} from "./desk"
import { calc, calcLayout, calcPending, files, filesEnsure, fmtSize, noteEnsureVisible, notes } from "./apps"

const C = {
  menuBg: "#d4d4d4",
  menuFg: "#111111",
  taskBg: "#b8b8b8",
  accent: "#1f4f9e",
  accentFg: "#ffffff",
  deskBg: "#1d3a63",
  deskPat: "#2d507f",
  shadow: "#0a1322",
  winBg: "#e4e4e4",
  ink: "#141414",
  frameDim: "#8e8e8e",
  titleDimBg: "#a9a9a9",
  titleDimFg: "#2e2e2e",
  btn: "#ffd166",
  lcdBg: "#14261a",
  lcdFg: "#8dff9c",
  lcdDim: "#5a9a68",
  num: "#fbfbfb",
  op: "#f2a33a",
  eq: "#2e9e5b",
  clr: "#d9534f",
  listSel: "#c4c4c4",
}

const BOLD = TextAttributes.BOLD
const DIM = TextAttributes.DIM

const cache = new Map<string, RGBA>()
function rgba(hex: string): RGBA {
  let c = cache.get(hex)
  if (!c) {
    c = RGBA.fromHex(hex)
    cache.set(hex, c)
  }
  return c
}

function mix(a: string, b: string, t: number): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const A = parse(a)
  const B = parse(b)
  return (
    "#" +
    A.map((v, i) => Math.round(v + (B[i] - v) * t))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  )
}

// Colors of a window's content: unfocused windows are toned down toward the body color.
function tone(hex: string, focused: boolean): string {
  return focused ? hex : mix(hex, C.winBg, 0.45)
}

interface Clip {
  x0: number
  y0: number
  x1: number
  y1: number
}

class Painter {
  clip: Clip
  constructor(
    private readonly buf: OptimizedBuffer,
    clip: Clip,
  ) {
    this.clip = clip
  }

  cell(x: number, y: number, ch: string, fg: string, bg: string, attr = 0): void {
    const c = this.clip
    if (x < c.x0 || x >= c.x1 || y < c.y0 || y >= c.y1) return
    this.buf.setCell(x, y, ch, rgba(fg), rgba(bg), attr)
  }

  text(x: number, y: number, s: string, fg: string, bg: string, attr = 0): void {
    let i = x
    for (const ch of s) {
      this.cell(i, y, ch, fg, bg, attr)
      i++
    }
  }

  fill(x: number, y: number, w: number, h: number, ch: string, fg: string, bg: string, attr = 0): void {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) this.cell(c, r, ch, fg, bg, attr)
  }
}

export function paint(buf: OptimizedBuffer): void {
  const cols = buf.width
  const rows = buf.height
  setScreen(cols, rows)

  const full: Clip = { x0: 0, y0: 0, x1: cols, y1: rows }
  const desk: Clip = { x0: 0, y0: 1, x1: cols, y1: rows - 1 }
  const p = new Painter(buf, full)

  // Menu bar and taskbar backgrounds.
  p.fill(0, 0, cols, 1, " ", C.menuFg, C.menuBg)
  p.fill(0, rows - 1, cols, 1, " ", C.menuFg, C.menuBg)

  // Desktop pattern.
  p.clip = desk
  p.fill(0, 1, cols, deskH(), "░", C.deskPat, C.deskBg)

  // Windows, bottom to top.
  const top = focused()
  for (const win of shell.wins) drawWindow(p, win, win === top)

  p.clip = full
  drawMenuBar(p, cols)
  drawTaskbar(p, rows - 1, top)
  if (shell.menu !== null) drawDropdown(p, shell.menu)
  if (shell.about) drawAbout(p)
}

function drawMenuBar(p: Painter, cols: number): void {
  const open = shell.menu
  for (const it of menuBarItems()) {
    const sel = open === it.index
    const label = ` ${MENUS[it.index].label} `
    p.text(it.x - 1, 0, label, sel ? C.accentFg : C.menuFg, sel ? C.accent : C.menuBg, sel ? BOLD : 0)
  }
  const items = menuBarItems()
  const last = items[items.length - 1]
  if (cols - 7 > last.x + last.w + 1) p.text(cols - 7, 0, CLOCK, C.menuFg, C.menuBg)
}

function drawTaskbar(p: Painter, y: number, top: Win | undefined): void {
  for (const slot of taskbarItems()) {
    const on = slot.win === top
    p.text(slot.x, y, slot.label, on ? C.accentFg : C.menuFg, on ? C.accent : C.taskBg, on ? BOLD : 0)
  }
}

function drawDropdown(p: Painter, index: number): void {
  const r = dropdownRect(index)
  const menu = MENUS[index]
  p.fill(r.x, r.y, r.w, r.h, " ", C.menuFg, C.menuBg)
  p.fill(r.x + 1, r.y, r.w - 2, 1, "─", C.menuFg, C.menuBg)
  p.fill(r.x + 1, r.y + r.h - 1, r.w - 2, 1, "─", C.menuFg, C.menuBg)
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    p.cell(r.x, y, "│", C.menuFg, C.menuBg)
    p.cell(r.x + r.w - 1, y, "│", C.menuFg, C.menuBg)
  }
  p.cell(r.x, r.y, "┌", C.menuFg, C.menuBg)
  p.cell(r.x + r.w - 1, r.y, "┐", C.menuFg, C.menuBg)
  p.cell(r.x, r.y + r.h - 1, "└", C.menuFg, C.menuBg)
  p.cell(r.x + r.w - 1, r.y + r.h - 1, "┘", C.menuFg, C.menuBg)

  menu.items.forEach((item, j) => {
    const y = r.y + 1 + j
    const hl = j === shell.menuItem
    const fg = hl ? C.accentFg : C.menuFg
    const bg = hl ? C.accent : C.menuBg
    p.fill(r.x + 1, y, r.w - 2, 1, " ", fg, bg)
    p.text(r.x + 2, y, item.text, fg, bg)
    if (item.key) p.text(r.x + r.w - 2 - item.key.length, y, item.key, fg, bg, hl ? 0 : DIM)
  })
}

function drawAbout(p: Painter): void {
  const r = aboutRect()
  p.fill(r.x + r.w, r.y + 1, 2, r.h, " ", C.shadow, C.shadow)
  p.fill(r.x + 2, r.y + r.h, r.w, 1, " ", C.shadow, C.shadow)
  p.fill(r.x, r.y, r.w, r.h, " ", C.ink, C.winBg)
  p.fill(r.x + 1, r.y, r.w - 2, 1, "═", C.accentFg, C.accent)
  p.cell(r.x, r.y, "╔", C.accentFg, C.accent)
  p.cell(r.x + r.w - 1, r.y, "╗", C.accentFg, C.accent)
  p.text(r.x + Math.floor((r.w - 7) / 2), r.y, " About ", C.accentFg, C.accent, BOLD)
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    p.cell(r.x, y, "║", C.accent, C.winBg)
    p.cell(r.x + r.w - 1, y, "║", C.accent, C.winBg)
  }
  p.fill(r.x + 1, r.y + r.h - 1, r.w - 2, 1, "═", C.accent, C.winBg)
  p.cell(r.x, r.y + r.h - 1, "╚", C.accent, C.winBg)
  p.cell(r.x + r.w - 1, r.y + r.h - 1, "╝", C.accent, C.winBg)

  const lines = ["Desktop with windows", "A Turbo Vision style text desktop", "built with OpenTUI"]
  lines.forEach((s, i) => {
    p.text(r.x + Math.floor((r.w - s.length) / 2), r.y + 2 + i, s, C.ink, C.winBg, i === 0 ? BOLD : 0)
  })

  const ok = aboutOkRect()
  const label = "[ OK ]"
  p.fill(ok.x, ok.y, ok.w, ok.h, " ", C.accentFg, C.accent)
  p.text(ok.x + Math.floor((ok.w - label.length) / 2), ok.y, label, C.accentFg, C.accent, BOLD)
}

function drawWindow(p: Painter, win: Win, isFocused: boolean): void {
  const { x, y, w, h } = win.rect
  const dbl = isFocused

  // Drop shadow to the right and below.
  p.fill(x + w, y + 1, 2, h, " ", C.shadow, C.shadow)
  p.fill(x + 2, y + h, w, 1, " ", C.shadow, C.shadow)

  // Body.
  p.fill(x, y + 1, w, h - 1, " ", C.ink, C.winBg)

  const frame = isFocused ? C.accent : C.frameDim
  const titleBg = isFocused ? C.accent : C.titleDimBg
  const titleFg = isFocused ? C.accentFg : C.titleDimFg
  const btnFg = isFocused ? C.btn : C.titleDimFg
  const H = dbl ? "═" : "─"
  const V = dbl ? "║" : "│"

  // Title bar (top border row).
  p.fill(x, y, w, 1, H, titleFg, titleBg)
  p.cell(x, y, dbl ? "╔" : "┌", titleFg, titleBg)
  p.cell(x + w - 1, y, dbl ? "╗" : "┐", titleFg, titleBg)
  p.text(x + 1, y, "[×]", btnFg, titleBg, BOLD)
  p.text(x + w - 4, y, "[↑]", btnFg, titleBg, BOLD)
  const avail = w - 10
  if (avail > 2) {
    let label = ` ${win.title} `
    if (label.length > avail) label = win.title.length <= avail ? win.title : win.title.slice(0, avail)
    const start = x + 4 + Math.floor((avail - label.length) / 2)
    p.text(start, y, label, titleFg, titleBg, BOLD)
  }

  // Side borders.
  for (let r = y + 1; r < y + h - 1; r++) {
    p.cell(x, r, V, frame, C.winBg)
    p.cell(x + w - 1, r, V, frame, C.winBg)
  }

  // Bottom border with the resize grip in the corner.
  p.fill(x + 1, y + h - 1, w - 2, 1, H, frame, C.winBg)
  p.cell(x, y + h - 1, dbl ? "╚" : "└", frame, C.winBg)
  p.cell(x + w - 1, y + h - 1, "◢", frame, C.winBg)

  // Content, clipped to the desktop.
  const saved = p.clip
  const cr = contentRect(win.rect)
  p.clip = {
    x0: Math.max(saved.x0, cr.x),
    y0: Math.max(saved.y0, cr.y),
    x1: Math.min(saved.x1, cr.x + cr.w),
    y1: Math.min(saved.y1, cr.y + cr.h),
  }
  switch (win.id) {
    case "notes":
      drawNotes(p, cr, isFocused)
      break
    case "calc":
      drawCalc(p, cr, isFocused)
      break
    case "files":
      drawFiles(p, cr, isFocused)
      break
  }
  p.clip = saved
}

function drawNotes(p: Painter, c: Rect, isFocused: boolean): void {
  // One column of padding on the left and right of the text.
  const v = { x: c.x + 1, y: c.y, w: Math.max(1, c.w - 2), h: c.h }
  noteEnsureVisible(v.w, v.h)
  const ink = tone(C.ink, isFocused)
  p.fill(c.x, c.y, c.w, c.h, " ", ink, C.winBg)
  for (let i = 0; i < v.h; i++) {
    const li = notes.top + i
    if (li >= notes.lines.length) break
    p.text(v.x, v.y + i, notes.lines[li].slice(notes.left, notes.left + v.w), ink, C.winBg)
  }
  if (isFocused) {
    const cy = notes.row - notes.top
    const cx = notes.col - notes.left
    if (cy >= 0 && cy < v.h && cx >= 0 && cx < v.w) {
      const under = notes.lines[notes.row]?.[notes.col] ?? " "
      p.cell(v.x + cx, v.y + cy, under, C.winBg, C.ink)
    }
  }
}

function drawCalc(p: Painter, c: Rect, isFocused: boolean): void {
  const L = calcLayout(c)
  const d = L.display
  p.fill(d.x, d.y, d.w, d.h, " ", C.lcdFg, C.lcdBg)
  if (d.h >= 3) {
    const pend = calcPending()
    if (pend) p.text(Math.max(d.x, d.x + d.w - 1 - pend.length), d.y, pend, C.lcdDim, C.lcdBg)
  }
  const valueRow = d.y + (d.h >= 3 ? 1 : 0)
  const value = calc.error ? "Error" : calc.display
  p.text(Math.max(d.x, d.x + d.w - 1 - value.length), valueRow, value, C.lcdFg, C.lcdBg, BOLD)

  for (const k of L.keys) {
    let bg = C.num
    let fg = C.ink
    if (k.label === "C") {
      bg = C.clr
      fg = "#ffffff"
    } else if (k.label === "=") {
      bg = C.eq
      fg = "#ffffff"
    } else if (["÷", "×", "−", "+"].includes(k.label)) {
      bg = C.op
    }
    bg = tone(bg, isFocused)
    p.fill(k.x, k.y, k.w, k.h, " ", fg, bg)
    p.text(k.x + Math.floor((k.w - k.label.length) / 2), k.y, k.label, fg, bg, BOLD)
  }
}

function drawFiles(p: Painter, c: Rect, isFocused: boolean): void {
  const ink = tone(C.ink, isFocused)
  p.fill(c.x, c.y, c.w, c.h, " ", ink, C.winBg)

  const right = c.x + c.w - 2 // one column of padding before the frame
  const modW = 16
  const sizeW = 10
  const modX = right - modW + 1
  const sizeEnd = modX - 3
  const sizeX = sizeEnd - sizeW + 1
  const nameX = c.x + 1
  const nameW = Math.max(1, sizeX - 2 - nameX)

  p.text(nameX, c.y, "Name", ink, C.winBg, BOLD)
  p.text(sizeEnd - 3, c.y, "Size", ink, C.winBg, BOLD)
  p.text(modX, c.y, "Modified", ink, C.winBg, BOLD)
  p.fill(c.x + 1, c.y + 1, Math.max(0, c.w - 2), 1, "─", tone(C.frameDim, isFocused), C.winBg)

  const listY = c.y + 2
  const viewH = Math.max(0, c.h - 2)
  if (viewH <= 0) return
  filesEnsure(viewH)
  for (let i = 0; i < viewH; i++) {
    const idx = files.top + i
    if (idx >= files.entries.length) break
    const e = files.entries[idx]
    const y = listY + i
    const sel = idx === files.sel
    const rowBg = sel ? (isFocused ? C.accent : C.listSel) : C.winBg
    const rowFg = sel && isFocused ? C.accentFg : ink
    p.fill(c.x + 1, y, Math.max(0, c.w - 2), 1, " ", rowFg, rowBg)

    const isDir = e.type === "dir"
    const marker = isDir ? "▸ " : "  "
    let name = marker + e.name
    if (name.length > nameW) name = name.slice(0, nameW - 1) + "…"
    const nameFg = isDir && !(sel && isFocused) ? tone(C.accent, isFocused) : rowFg
    p.text(nameX, y, name, nameFg, rowBg, isDir ? BOLD : 0)

    const size = isDir ? "<DIR>" : fmtSize(e.size)
    p.text(sizeEnd - size.length + 1, y, size, rowFg, rowBg)
    p.text(modX, y, e.modified, rowFg, rowBg)
  }
}
