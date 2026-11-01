import { readFileSync } from "node:fs"
import { Renderable, createCliRenderer, type KeyEvent, type MouseEvent, type OptimizedBuffer } from "@opentui/core"
import { CalcApp, FilesApp, NotesApp, type App, type FileEntry, type Key } from "./apps.ts"
import { BOLD, Grid, padRight, strLen, truncate, type Rect } from "./grid.ts"
import { T } from "./theme.ts"

// ───────────────────────────────────────────────────────────── data

function readText(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return fallback
  }
}

function readFiles(path: string): FileEntry[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"))
    if (!Array.isArray(data)) return []
    return data.map((e: any) => ({
      name: String(e?.name ?? "?"),
      type: e?.type === "dir" ? "dir" : "file",
      size: Number(e?.size ?? 0) || 0,
      modified: String(e?.modified ?? ""),
    }))
  } catch {
    return []
  }
}

// ───────────────────────────────────────────────────────────── window model

interface Win {
  id: number
  title: string
  app: App
  x: number
  y: number
  w: number
  h: number
  maximized: boolean
  restore: Rect | null
  /** geometry the user asked for; screen resizes fit this rect onto the screen */
  pref: Rect
  initial: Rect
}

const MIN_W = 20
const MIN_H = 7

let W = 120
let H = 36

const calc = new CalcApp()
const allWins: Win[] = []
function makeWin(id: number, title: string, app: App, r: Rect): Win {
  const w: Win = { id, title, app, ...r, maximized: false, restore: null, pref: { ...r }, initial: { ...r } }
  allWins.push(w)
  return w
}
const notesWin = makeWin(1, "Notes", new NotesApp(readText("data/notes.txt", "")), { x: 4, y: 3, w: 44, h: 16 })
const calcWin = makeWin(2, "Calculator", calc, { x: 72, y: 4, w: 28, h: 17 })
const filesWin = makeWin(3, "Files", new FilesApp(readFiles("data/files.json")), { x: 8, y: 14, w: 56, h: 14 })

/** bottom → top; the last element is focused */
let stack: Win[] = [notesWin, calcWin, filesWin]

const focused = (): Win | undefined => stack[stack.length - 1]
const rectOf = (w: Win): Rect => ({ x: w.x, y: w.y, w: w.w, h: w.h })
const desktopRect = (): Rect => ({ x: 0, y: 1, w: W, h: Math.max(1, H - 2) })
const inner = (w: Win): Rect => ({ x: w.x + 1, y: w.y + 1, w: Math.max(0, w.w - 2), h: Math.max(0, w.h - 2) })

function setGeom(w: Win, r: Rect) {
  w.x = r.x
  w.y = r.y
  w.w = r.w
  w.h = r.h
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** Fit a rectangle on the desktop: move it to stay fully visible, shrink only when it doesn't fit. */
function fit(r: Rect): Rect {
  const d = desktopRect()
  const w = Math.max(1, Math.min(r.w, d.w))
  const h = Math.max(1, Math.min(r.h, d.h))
  const x = clamp(r.x, 0, Math.max(0, d.w - w))
  const y = clamp(r.y, d.y, Math.max(d.y, d.y + d.h - h))
  return { x, y, w, h }
}

function applyLayout() {
  for (const w of allWins) {
    if (w.maximized) setGeom(w, desktopRect())
    else setGeom(w, fit(w.pref))
  }
}

function raise(w: Win) {
  const i = stack.indexOf(w)
  if (i >= 0) stack.splice(i, 1)
  stack.push(w)
}

function closeWin(w: Win) {
  const i = stack.indexOf(w)
  if (i >= 0) stack.splice(i, 1)
  if (drag && drag.win === w) drag = null
}

function openWin(w: Win) {
  if (stack.includes(w)) {
    raise(w)
    return
  }
  w.maximized = false
  w.restore = null
  w.pref = { ...w.initial }
  setGeom(w, fit(w.pref))
  stack.push(w)
}

function toggleMax(w: Win) {
  if (w.maximized) {
    w.maximized = false
    const r = fit(w.restore ?? w.pref)
    w.restore = null
    setGeom(w, r)
    w.pref = { ...r }
  } else {
    w.restore = rectOf(w)
    w.maximized = true
    setGeom(w, desktopRect())
  }
}

function nextWin() {
  if (stack.length < 2) return
  const bottom = stack.shift()!
  stack.push(bottom)
}

function prevWin() {
  if (stack.length < 2) return
  const top = stack.pop()!
  stack.unshift(top)
}

function tile() {
  const wins = [...stack]
  const n = wins.length
  if (n === 0) return
  const d = desktopRect()
  const cols = Math.ceil(Math.sqrt(n))
  const base = Math.floor(n / cols)
  const extra = n % cols
  let k = 0
  for (let c = 0; c < cols; c++) {
    const rows = base + (c >= cols - extra ? 1 : 0)
    const x0 = d.x + Math.floor((c * d.w) / cols)
    const x1 = d.x + Math.floor(((c + 1) * d.w) / cols)
    for (let r = 0; r < rows; r++) {
      const y0 = d.y + Math.floor((r * d.h) / rows)
      const y1 = d.y + Math.floor(((r + 1) * d.h) / rows)
      const w = wins[k++]!
      w.maximized = false
      w.restore = null
      const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      setGeom(w, rect)
      w.pref = { ...rect }
    }
  }
}

function cascade() {
  const n = stack.length
  if (n === 0) return
  const d = desktopRect()
  let w = Math.min(d.w, Math.max(MIN_W, Math.floor(d.w * 0.6)))
  let h = Math.min(d.h, Math.max(MIN_H, Math.floor(d.h * 0.65)))
  let sx = 4
  let sy = 2
  // shrink the step until the whole cascade fits on the desktop
  while (sy > 0 && (n - 1) * sy + h > d.h) sy--
  while (sx > 0 && (n - 1) * sx + w > d.w) sx--
  const ox = Math.max(0, Math.min(2, d.w - ((n - 1) * sx + w)))
  const oy = Math.max(0, Math.min(1, d.h - ((n - 1) * sy + h)))
  stack.forEach((win, i) => {
    win.maximized = false
    win.restore = null
    const rect = fit({ x: d.x + ox + i * sx, y: d.y + oy + i * sy, w, h })
    setGeom(win, rect)
    win.pref = { ...rect }
  })
}

function topWinAt(x: number, y: number): Win | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const w = stack[i]!
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return w
  }
  return undefined
}

// ───────────────────────────────────────────────────────────── menus

type Action =
  | "about" | "quit" | "open-notes" | "open-calc" | "open-files"
  | "tile" | "cascade" | "next" | "zoom" | "close"

interface MenuItem {
  label: string
  key?: string
  action?: Action
  sep?: boolean
}

interface Menu {
  title: string
  hot: string
  items: MenuItem[]
}

const MENUS: Menu[] = [
  {
    title: "≡",
    hot: " ",
    items: [
      { label: "About…", action: "about" },
      { label: "", sep: true },
      { label: "Quit", key: "Ctrl+Q", action: "quit" },
    ],
  },
  {
    title: "File",
    hot: "f",
    items: [
      { label: "Notes", action: "open-notes" },
      { label: "Calculator", action: "open-calc" },
      { label: "Files", action: "open-files" },
      { label: "", sep: true },
      { label: "Exit", key: "Ctrl+Q", action: "quit" },
    ],
  },
  {
    title: "Window",
    hot: "w",
    items: [
      { label: "Tile", action: "tile" },
      { label: "Cascade", action: "cascade" },
      { label: "", sep: true },
      { label: "Next", key: "F6", action: "next" },
      { label: "Zoom", key: "F5", action: "zoom" },
      { label: "Close", key: "Ctrl+W", action: "close" },
    ],
  },
  {
    title: "Help",
    hot: "h",
    items: [{ label: "About…", action: "about" }],
  },
]

/** "closed": nothing; "bar": a title is highlighted; "open": a drop-down is shown */
let menuMode: "closed" | "bar" | "open" = "closed"
let menuIdx = 0
let itemIdx = 0
let aboutOpen = false

function menuTitleX(): number[] {
  const xs: number[] = []
  let x = 1
  for (const m of MENUS) {
    xs.push(x)
    x += strLen(m.title) + 2
  }
  return xs
}

function isEnabled(it: MenuItem): boolean {
  if (it.sep) return false
  if (it.action === "next") return stack.length > 1
  if (it.action === "zoom" || it.action === "close" || it.action === "tile" || it.action === "cascade")
    return stack.length > 0
  return true
}

function firstItem(m: Menu): number {
  const i = m.items.findIndex((it) => !it.sep)
  return i < 0 ? 0 : i
}

function dropRect(idx: number): Rect {
  const m = MENUS[idx]!
  let lw = 0
  let kw = 0
  for (const it of m.items) {
    lw = Math.max(lw, strLen(it.label))
    kw = Math.max(kw, it.key ? strLen(it.key) : 0)
  }
  const innerW = 2 + lw + (kw ? 4 + kw : 2) + 1
  const w = innerW + 2
  const h = m.items.length + 2
  let x = menuTitleX()[idx]! - 1
  if (x + w > W) x = Math.max(0, W - w)
  return { x, y: 1, w, h }
}

function openMenu(idx: number) {
  menuMode = "open"
  menuIdx = (idx + MENUS.length) % MENUS.length
  itemIdx = firstItem(MENUS[menuIdx]!)
}

function closeMenu() {
  menuMode = "closed"
}

function moveItem(dir: number) {
  const m = MENUS[menuIdx]!
  const n = m.items.length
  let i = itemIdx
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n
    if (!m.items[i]!.sep) {
      itemIdx = i
      return
    }
  }
}

function run(action: Action) {
  const f = focused()
  switch (action) {
    case "about": aboutOpen = true; break
    case "quit": quit(); break
    case "open-notes": openWin(notesWin); break
    case "open-calc": openWin(calcWin); break
    case "open-files": openWin(filesWin); break
    case "tile": tile(); break
    case "cascade": cascade(); break
    case "next": nextWin(); break
    case "zoom": if (f) toggleMax(f); break
    case "close": if (f) closeWin(f); break
  }
}

function activateItem() {
  const it = MENUS[menuIdx]!.items[itemIdx]
  closeMenu()
  if (it && it.action && isEnabled(it)) run(it.action)
}

// ───────────────────────────────────────────────────────────── about dialog

function aboutRect(): Rect {
  const w = Math.min(48, W)
  const h = Math.min(12, Math.max(3, H - 2))
  return { x: Math.floor((W - w) / 2), y: Math.max(1, Math.floor((H - h) / 2)), w, h }
}

function aboutOk(): Rect {
  const r = aboutRect()
  const bw = 8
  return { x: r.x + Math.floor((r.w - bw) / 2), y: r.y + r.h - 3, w: bw, h: 1 }
}

// ───────────────────────────────────────────────────────────── drawing

const g = new Grid()

function drawDesktop() {
  for (let y = 1; y < H - 1; y++) for (let x = 0; x < W; x++) g.set(x, y, T.deskChar, T.deskFg, T.deskBg)
}

function drawShadow(r: Rect, f = T.shadow) {
  for (let x = r.x + 2; x < r.x + r.w + 2; x++) g.darken(x, r.y + r.h, f)
  for (let y = r.y + 1; y < r.y + r.h; y++) {
    g.darken(r.x + r.w, y, f)
    g.darken(r.x + r.w + 1, y, f)
  }
}

function drawWindow(win: Win, isFocused: boolean) {
  const { x, y, w, h } = win
  const active = isFocused && !aboutOpen
  g.resetClip()
  drawShadow(rectOf(win))
  g.fill(x, y, w, h, T.winBg)
  const fc = isFocused ? T.frameActive : T.frameInactive
  const bg = T.winBg
  const [tl, tr, bl, br, hz, vt] = isFocused ? ["╔", "╗", "╚", "╝", "═", "║"] : ["┌", "┐", "└", "┘", "─", "│"]
  for (let i = 1; i < w - 1; i++) {
    g.set(x + i, y, hz, fc, bg)
    g.set(x + i, y + h - 1, hz, fc, bg)
  }
  for (let j = 1; j < h - 1; j++) {
    g.set(x, y + j, vt, fc, bg)
    g.set(x + w - 1, y + j, vt, fc, bg)
  }
  g.set(x, y, tl, fc, bg)
  g.set(x + w - 1, y, tr, fc, bg)
  g.set(x, y + h - 1, bl, fc, bg)
  g.set(x + w - 1, y + h - 1, br, fc, bg)

  // title
  const maxTitle = w - 12
  if (maxTitle > 0) {
    const t = " " + truncate(win.title, Math.max(1, maxTitle - 2)) + " "
    const tlen = strLen(t)
    const tx = x + Math.floor((w - tlen) / 2)
    if (isFocused) g.text(tx, y, t, T.titleActiveFg, T.titleActiveBg, BOLD)
    else g.text(tx, y, t, T.titleInactive, bg)
  }
  // buttons
  const bc = isFocused ? T.btnActive : T.btnInactive
  if (w >= 5) {
    g.set(x + 1, y, "[", fc, bg)
    g.set(x + 2, y, "×", bc, bg, isFocused ? BOLD : 0)
    g.set(x + 3, y, "]", fc, bg)
  }
  if (w >= 9) {
    g.set(x + w - 4, y, "[", fc, bg)
    g.set(x + w - 3, y, win.maximized ? "↕" : "↑", bc, bg, isFocused ? BOLD : 0)
    g.set(x + w - 2, y, "]", fc, bg)
  }
  // resize grip
  if (isFocused && !win.maximized) {
    g.set(x + w - 1, y + h - 1, "┘", T.grip, bg, BOLD)
    if (w > 2) g.set(x + w - 2, y + h - 1, "─", T.grip, bg)
  }

  const ir = inner(win)
  // footer on the bottom border
  const foot = win.app.footer()
  if (foot && w > strLen(foot) + 8) {
    g.text(x + 2, y + h - 1, ` ${foot} `, isFocused ? T.frameActive : T.frameInactive, bg)
  }
  // scrollbar on the right border
  const si = isFocused ? win.app.scrollInfo(ir) : null
  if (si && ir.h >= 3) {
    const sx = x + w - 1
    const top = ir.y
    const len = ir.h
    g.set(sx, top, "▲", T.scrollThumb, T.scrollTrack)
    g.set(sx, top + len - 1, "▼", T.scrollThumb, T.scrollTrack)
    const track = len - 2
    for (let j = 0; j < track; j++) g.set(sx, top + 1 + j, "▒", T.scrollTrack, bg)
    if (track > 0) {
      const maxOff = Math.max(1, si.total - si.visible)
      const pos = Math.round((si.offset / maxOff) * (track - 1))
      g.set(sx, top + 1 + clamp(pos, 0, track - 1), "■", T.scrollThumb, bg)
    }
  }

  // content
  g.setClip(ir)
  win.app.render(g, ir, active)
  g.resetClip()
}

function drawMenuBar() {
  g.fill(0, 0, W, 1, T.barBg)
  const xs = menuTitleX()
  MENUS.forEach((m, i) => {
    const sel = menuMode !== "closed" && menuIdx === i
    const bg = sel ? T.accent : T.barBg
    const fg = sel ? T.accentFg : T.barFg
    let x = g.text(xs[i]!, 0, " ", fg, bg)
    Array.from(m.title).forEach((c, ci) => {
      const hot = ci === 0 && m.hot !== " "
      g.set(x++, 0, c, hot ? (sel ? 0xffe28a : T.barHot) : fg, bg, m.title === "≡" ? BOLD : 0)
    })
    g.text(x, 0, " ", fg, bg)
  })
  const clock = " 10:42 "
  g.text(W - strLen(clock), 0, clock, T.barFg, T.barBg)
}

interface TaskHit {
  x0: number
  x1: number
  win: Win
}
let taskHits: TaskHit[] = []

function drawTaskbar() {
  const y = H - 1
  g.fill(0, y, W, 1, T.barBg)
  taskHits = []
  const top = focused()
  let x = 1
  const open = allWins.filter((w) => stack.includes(w))
  if (open.length === 0) {
    g.text(x, y, "No open windows — F10 › File to reopen one", T.barDim, T.barBg)
    x += 44
  }
  for (const w of open) {
    const sel = w === top
    const bg = sel ? T.accent : T.barBg
    const label = ` ${w.id} ${w.title} `
    const x0 = x
    g.set(x, y, " ", T.barFg, bg)
    g.set(x + 1, y, String(w.id), sel ? 0xffe28a : T.barHot, bg, BOLD)
    g.text(x + 2, y, ` ${w.title} `, sel ? T.accentFg : T.barFg, bg, sel ? BOLD : 0)
    x += strLen(label)
    taskHits.push({ x0, x1: x - 1, win: w })
    x += 1
  }
  // key hints on the right
  const hints: [string, string][] = [["F10", "Menu"], ["F6", "Next"], ["F5", "Zoom"], ["^W", "Close"], ["^Q", "Quit"]]
  let parts = hints
  const width = (p: [string, string][]) => p.reduce((s, [k, l]) => s + strLen(k) + 1 + strLen(l) + 2, 0)
  while (parts.length > 0 && x + 2 + width(parts) > W) parts = parts.slice(0, -1)
  let hx = W - width(parts)
  for (const [k, l] of parts) {
    hx = g.text(hx, y, k, T.barHot, T.barBg)
    hx = g.text(hx, y, " " + l + "  ", T.barFg, T.barBg)
  }
}

function drawDropdown() {
  if (menuMode !== "open") return
  const m = MENUS[menuIdx]!
  const r = dropRect(menuIdx)
  drawShadow(r)
  g.fill(r.x, r.y, r.w, r.h, T.barBg)
  const fc = T.barFg
  for (let i = 1; i < r.w - 1; i++) {
    g.set(r.x + i, r.y, "─", fc, T.barBg)
    g.set(r.x + i, r.y + r.h - 1, "─", fc, T.barBg)
  }
  for (let j = 1; j < r.h - 1; j++) {
    g.set(r.x, r.y + j, "│", fc, T.barBg)
    g.set(r.x + r.w - 1, r.y + j, "│", fc, T.barBg)
  }
  g.set(r.x, r.y, "┌", fc, T.barBg)
  g.set(r.x + r.w - 1, r.y, "┐", fc, T.barBg)
  g.set(r.x, r.y + r.h - 1, "└", fc, T.barBg)
  g.set(r.x + r.w - 1, r.y + r.h - 1, "┘", fc, T.barBg)
  m.items.forEach((it, i) => {
    const y = r.y + 1 + i
    if (it.sep) {
      g.set(r.x, y, "├", fc, T.barBg)
      for (let k = 1; k < r.w - 1; k++) g.set(r.x + k, y, "─", fc, T.barBg)
      g.set(r.x + r.w - 1, y, "┤", fc, T.barBg)
      return
    }
    const sel = i === itemIdx
    const enabled = isEnabled(it)
    const bg = sel ? T.accent : T.barBg
    const fg = !enabled ? T.barDim : sel ? T.accentFg : T.barFg
    g.fill(r.x + 1, y, r.w - 2, 1, bg)
    g.text(r.x + 2, y, it.label, fg, bg, sel ? BOLD : 0)
    if (it.key) {
      const kx = r.x + r.w - 2 - strLen(it.key)
      g.text(kx, y, it.key, !enabled ? T.barDim : sel ? 0xffe28a : T.barDim, bg)
    }
  })
}

function drawAbout() {
  if (!aboutOpen) return
  g.resetClip()
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.darken(x, y, 0.55)
  const r = aboutRect()
  drawShadow(r, 0.3)
  g.fill(r.x, r.y, r.w, r.h, T.dlgBg)
  const fc = T.dlgFrame
  for (let i = 1; i < r.w - 1; i++) {
    g.set(r.x + i, r.y, "═", fc, T.dlgBg)
    g.set(r.x + i, r.y + r.h - 1, "═", fc, T.dlgBg)
  }
  for (let j = 1; j < r.h - 1; j++) {
    g.set(r.x, r.y + j, "║", fc, T.dlgBg)
    g.set(r.x + r.w - 1, r.y + j, "║", fc, T.dlgBg)
  }
  g.set(r.x, r.y, "╔", fc, T.dlgBg)
  g.set(r.x + r.w - 1, r.y, "╗", fc, T.dlgBg)
  g.set(r.x, r.y + r.h - 1, "╚", fc, T.dlgBg)
  g.set(r.x + r.w - 1, r.y + r.h - 1, "╝", fc, T.dlgBg)
  const title = " About "
  g.text(r.x + Math.floor((r.w - strLen(title)) / 2), r.y, title, T.dlgTitle, T.dlgBg, BOLD)
  g.set(r.x + 1, r.y, "[", fc, T.dlgBg)
  g.set(r.x + 2, r.y, "■", T.keyEqBg, T.dlgBg)
  g.set(r.x + 3, r.y, "]", fc, T.dlgBg)
  const lines: [string, number, number][] = [
    ["≡  T E X T   D E S K T O P", T.accent, BOLD],
    ["", 0, 0],
    ["Overlapping windows in the spirit of", T.dlgFg, 0],
    ["Turbo Vision · built with OpenTUI", T.dlgFg, 0],
    ["", 0, 0],
    ["Version 1.0  ·  10:42", T.barDim, 0],
  ]
  g.setClip({ x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 })
  lines.forEach(([s, fg, at], i) => {
    if (!s) return
    g.text(r.x + Math.floor((r.w - strLen(s)) / 2), r.y + 2 + i, s, fg, T.dlgBg, at)
  })
  const ok = aboutOk()
  g.text(ok.x, ok.y, padRight("   OK", ok.w), T.okFg, T.okBg, BOLD)
  g.put(ok.x + ok.w, ok.y, "▄", T.keyShadow)
  for (let i = 1; i <= ok.w; i++) g.put(ok.x + i, ok.y + 1, "▀", T.keyShadow)
  g.resetClip()
}

function drawAll(buf: OptimizedBuffer) {
  if (buf.width !== W || buf.height !== H) onScreenResize(buf.width, buf.height)
  g.resize(W, H)
  g.resetClip()
  drawDesktop()
  const top = focused()
  for (const w of stack) drawWindow(w, w === top)
  g.resetClip()
  drawMenuBar()
  drawTaskbar()
  drawDropdown()
  drawAbout()
  g.blit(buf)
}

// ───────────────────────────────────────────────────────────── input

interface Drag {
  kind: "move" | "resize"
  win: Win
  ox: number
  oy: number
  moved: boolean
}
let drag: Drag | null = null
let lastClick: { x: number; y: number; t: number; win: Win } | null = null

function onDown(mx: number, my: number) {
  if (aboutOpen) {
    const ok = aboutOk()
    const ar = aboutRect()
    if (my === ok.y && mx >= ok.x && mx < ok.x + ok.w) aboutOpen = false
    if (my === ar.y && mx >= ar.x + 1 && mx <= ar.x + 3) aboutOpen = false
    return
  }
  const xs = menuTitleX()
  if (my === 0) {
    for (let i = 0; i < MENUS.length; i++) {
      const x0 = xs[i]!
      const x1 = x0 + strLen(MENUS[i]!.title) + 2
      if (mx >= x0 && mx < x1) {
        if (menuMode === "open" && menuIdx === i) closeMenu()
        else openMenu(i)
        return
      }
    }
    closeMenu()
    return
  }
  if (menuMode !== "closed") {
    if (menuMode === "open") {
      const r = dropRect(menuIdx)
      if (mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h) {
        const i = my - r.y - 1
        const it = MENUS[menuIdx]!.items[i]
        if (it && !it.sep && mx > r.x && mx < r.x + r.w - 1) {
          itemIdx = i
          activateItem()
        }
        return
      }
    }
    closeMenu()
    return
  }
  if (my === H - 1) {
    for (const h of taskHits) {
      if (mx >= h.x0 && mx <= h.x1) {
        raise(h.win)
        return
      }
    }
    return
  }
  const win = topWinAt(mx, my)
  if (!win) return
  raise(win)
  const now = performance.now()
  const dbl = lastClick && lastClick.win === win && lastClick.x === mx && lastClick.y === my && now - lastClick.t < 450
  lastClick = { x: mx, y: my, t: now, win }
  const isCorner = mx === win.x + win.w - 1 && my === win.y + win.h - 1
  if (my === win.y && !isCorner) {
    if (mx >= win.x + 1 && mx <= win.x + 3) {
      closeWin(win)
      lastClick = null
      return
    }
    if (mx >= win.x + win.w - 4 && mx <= win.x + win.w - 2) {
      toggleMax(win)
      lastClick = null
      return
    }
    if (dbl) {
      toggleMax(win)
      lastClick = null
      return
    }
    drag = { kind: "move", win, ox: mx - win.x, oy: my - win.y, moved: false }
    return
  }
  if (isCorner) {
    drag = { kind: "resize", win, ox: 0, oy: 0, moved: false }
    return
  }
  const ir = inner(win)
  if (mx >= ir.x && mx < ir.x + ir.w && my >= ir.y && my < ir.y + ir.h) win.app.mouseDown(mx, my, ir)
}

function onDrag(mx: number, my: number) {
  if (!drag) return
  const w = drag.win
  if (!stack.includes(w)) {
    drag = null
    return
  }
  if (drag.kind === "move") {
    const keep = Math.min(w.w, 6)
    const nx = clamp(mx - drag.ox, -(w.w - keep), W - keep)
    const ny = clamp(my - drag.oy, 1, Math.max(1, H - 2))
    if (nx === w.x && ny === w.y) return
    if (w.maximized) {
      w.maximized = false
      w.restore = null
    }
    w.x = nx
    w.y = ny
  } else {
    const maxW = Math.max(MIN_W, W - w.x)
    const maxH = Math.max(MIN_H, H - 1 - w.y)
    const nw = clamp(mx - w.x + 1, MIN_W, maxW)
    const nh = clamp(my - w.y + 1, MIN_H, maxH)
    if (nw === w.w && nh === w.h) return
    if (w.maximized) {
      w.maximized = false
      w.restore = null
    }
    w.w = nw
    w.h = nh
  }
  drag.moved = true
  w.pref = rectOf(w)
}

function onScroll(mx: number, my: number, dir: number) {
  if (aboutOpen || menuMode !== "closed") return
  if (my <= 0 || my >= H - 1) return
  const win = topWinAt(mx, my)
  if (!win) return
  win.app.scroll(dir, inner(win))
}

function toKey(k: KeyEvent): Key {
  return { name: k.name ?? "", seq: k.sequence ?? "", ctrl: !!k.ctrl, meta: !!(k.meta || k.option), shift: !!k.shift }
}

function onKey(k: Key) {
  const name = k.name
  if (k.ctrl && (name === "q" || name === "c")) return quit()

  if (aboutOpen) {
    if (name === "escape" || name === "return" || name === "enter" || name === "space") aboutOpen = false
    return
  }

  if (menuMode !== "closed") {
    switch (name) {
      case "escape":
      case "f10":
        closeMenu()
        return
      case "left":
        if (menuMode === "open") openMenu(menuIdx - 1)
        else menuIdx = (menuIdx - 1 + MENUS.length) % MENUS.length
        return
      case "right":
        if (menuMode === "open") openMenu(menuIdx + 1)
        else menuIdx = (menuIdx + 1) % MENUS.length
        return
      case "down":
        if (menuMode === "bar") openMenu(menuIdx)
        else moveItem(1)
        return
      case "up":
        if (menuMode === "bar") {
          openMenu(menuIdx)
          itemIdx = MENUS[menuIdx]!.items.length - 1
          if (MENUS[menuIdx]!.items[itemIdx]!.sep) moveItem(-1)
        } else moveItem(-1)
        return
      case "return":
      case "enter":
      case "space":
        if (menuMode === "bar") openMenu(menuIdx)
        else activateItem()
        return
    }
    const hot = MENUS.findIndex((m) => m.hot === name)
    if (hot >= 0 && (k.meta || menuMode === "bar")) openMenu(hot)
    return
  }

  if (name === "f1") {
    aboutOpen = true
    return
  }
  if (name === "f10") {
    menuMode = "bar"
    menuIdx = 0
    return
  }
  if (k.meta) {
    const hot = MENUS.findIndex((m) => m.hot === name)
    if (hot >= 0) {
      openMenu(hot)
      return
    }
  }
  const f = focused()
  if (name === "f5") {
    if (f) toggleMax(f)
    return
  }
  if (name === "f6") {
    if (k.shift) prevWin()
    else nextWin()
    return
  }
  if (k.ctrl && name === "w") {
    if (f) closeWin(f)
    return
  }
  if (f) f.app.key(k)
}

function onScreenResize(w: number, h: number) {
  W = Math.max(1, w)
  H = Math.max(1, h)
  applyLayout()
}

// ───────────────────────────────────────────────────────────── renderer

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  enableMouseMovement: false,
  backgroundColor: "#15233c",
})

W = renderer.width || 120
H = renderer.height || 36
applyLayout()

class DesktopView extends Renderable {
  protected renderSelf(buf: OptimizedBuffer): void {
    try {
      drawAll(buf)
    } catch {
      // never crash while painting
    }
  }

  protected onMouseEvent(e: MouseEvent): void {
    try {
      switch (e.type) {
        case "down":
          if (e.button === 0) onDown(e.x, e.y)
          break
        case "drag":
          onDrag(e.x, e.y)
          break
        case "up":
        case "drag-end":
          drag = null
          break
        case "scroll": {
          const d = e.scroll?.direction
          if (d === "up") onScroll(e.x, e.y, -1)
          else if (d === "down") onScroll(e.x, e.y, 1)
          break
        }
      }
    } catch {
      // ignore
    }
    this.requestRender()
  }
}

const view = new DesktopView(renderer, { width: "100%", height: "100%" })
renderer.root.add(view)
calc.onChange = () => view.requestRender()

let quitting = false
function quit() {
  if (quitting) return
  quitting = true
  try {
    renderer.destroy()
  } catch {
    // ignore
  }
  process.exit(0)
}

renderer.keyInput.on("keypress", (k: KeyEvent) => {
  try {
    onKey(toKey(k))
  } catch {
    // ignore
  }
  view.requestRender()
})

renderer.on("resize", (w: number, h: number) => {
  onScreenResize(w, h)
  view.requestRender()
})

process.on("SIGTERM", quit)
process.on("SIGINT", quit)
view.requestRender()
