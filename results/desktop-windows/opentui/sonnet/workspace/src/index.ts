import { readFileSync } from "node:fs"
import { createCliRenderer, Renderable, RGBA, TextAttributes } from "@opentui/core"
import type { CliRenderer, KeyEvent, MouseEvent, OptimizedBuffer, RenderableOptions } from "@opentui/core"

// ---------------------------------------------------------------- grid ----
const BOLD = TextAttributes.BOLD
const ITALIC = TextAttributes.ITALIC

class Grid {
  w = 0
  h = 0
  ch: string[] = []
  fg = new Int32Array(0)
  bg = new Int32Array(0)
  at = new Uint8Array(0)
  cx0 = 0
  cy0 = 0
  cx1 = 0
  cy1 = 0

  resize(w: number, h: number) {
    this.w = w
    this.h = h
    this.ch = new Array(w * h).fill(" ")
    this.fg = new Int32Array(w * h)
    this.bg = new Int32Array(w * h)
    this.at = new Uint8Array(w * h)
    this.unclip()
  }
  unclip() {
    this.cx0 = 0
    this.cy0 = 0
    this.cx1 = this.w
    this.cy1 = this.h
  }
  clip(x: number, y: number, w: number, h: number) {
    this.cx0 = Math.max(0, x)
    this.cy0 = Math.max(0, y)
    this.cx1 = Math.min(this.w, x + w)
    this.cy1 = Math.min(this.h, y + h)
  }
  set(x: number, y: number, ch: string, fg: number, bg: number, at = 0) {
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return
    const i = y * this.w + x
    this.ch[i] = ch
    this.fg[i] = fg
    this.bg[i] = bg
    this.at[i] = at
  }
  text(x: number, y: number, s: string, fg: number, bg: number, at = 0) {
    let cx = x
    for (const c of s) {
      this.set(cx, y, c, fg, bg, at)
      cx++
    }
  }
  fill(x: number, y: number, w: number, h: number, bg: number, ch = " ", fg = 0xffffff) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, fg, bg)
  }
  /** keep only the bg of the cell */
  bgAt(x: number, y: number): number {
    return this.bg[y * this.w + x]
  }
  darken(x: number, y: number, w: number, h: number, f: number) {
    for (let yy = Math.max(y, this.cy0); yy < Math.min(y + h, this.cy1); yy++)
      for (let xx = Math.max(x, this.cx0); xx < Math.min(x + w, this.cx1); xx++) {
        const i = yy * this.w + xx
        this.fg[i] = mix(this.fg[i], 0x000000, f)
        this.bg[i] = mix(this.bg[i], 0x000000, f)
      }
  }
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255
  const br = (b >> 16) & 255,
    bgc = (b >> 8) & 255,
    bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bgc - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}

// -------------------------------------------------------------- palette ----
const C = {
  deskBg: 0x14202e,
  deskFg: 0x203348,
  menuBg: 0xc9d1dd,
  menuFg: 0x111827,
  menuSelBg: 0x1f3a5f,
  menuSelFg: 0xffffff,
  menuDim: 0x4b5563,
  taskBg: 0x0c131d,
  taskFg: 0x8da0b8,
  taskEntry: 0x1d2b3d,
  taskFocus: 0x3b82c4,
  accent: 0x6cc4ff,
}

interface Pal {
  frame: number
  titleBg: number
  titleFg: number
  body: number
  fg: number
  dim: number
  accent: number
  selBg: number
  selFg: number
  hdrBg: number
  closeFg: number
}
const PAL_FOCUS: Pal = {
  frame: 0x9bd8ff,
  titleBg: 0x2563a8,
  titleFg: 0xffffff,
  body: 0x101a28,
  fg: 0xdbe4f0,
  dim: 0x7d8da3,
  accent: 0x6cc4ff,
  selBg: 0x2f6db5,
  selFg: 0xffffff,
  hdrBg: 0x1a2a40,
  closeFg: 0xff8a8a,
}
const PAL_BLUR: Pal = {
  frame: 0x56667c,
  titleBg: 0x2a3441,
  titleFg: 0x8794a7,
  body: 0x151c27,
  fg: 0x8c98aa,
  dim: 0x5d6a7c,
  accent: 0x6f8aa5,
  selBg: 0x2c3a4d,
  selFg: 0xaab5c5,
  hdrBg: 0x1b2430,
  closeFg: 0x9a6a6a,
}

// ----------------------------------------------------------------- data ----
interface FileEntry {
  name: string
  type: "dir" | "file"
  size: number
  modified: string
}
const filesData: FileEntry[] = (() => {
  try {
    const arr = JSON.parse(readFileSync("data/files.json", "utf8")) as FileEntry[]
    const dirs = arr.filter((f) => f.type === "dir")
    const files = arr.filter((f) => f.type !== "dir")
    return [...dirs, ...files]
  } catch {
    return []
  }
})()
const notesText = (() => {
  try {
    return readFileSync("data/notes.txt", "utf8")
  } catch {
    return ""
  }
})()

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n
  let u = -1
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(1)} ${units[u]}`
}

// -------------------------------------------------------------- windows ----
type Kind = "notes" | "calc" | "files"
interface Geo {
  x: number
  y: number
  w: number
  h: number
}
interface Win extends Geo {
  id: number
  kind: Kind
  title: string
  max: boolean
  restore: Geo | null
  state: any
}

interface NotesState {
  lines: string[]
  cy: number
  cx: number
  top: number
  left: number
}
interface FilesState {
  sel: number
  top: number
}

class Calc {
  disp = "0"
  acc: number | null = null
  op: string | null = null
  fresh = true
  expr = ""
  err = false

  static fmt(n: number): string {
    if (!isFinite(n)) return "Error"
    let s = parseFloat(n.toPrecision(12)).toString()
    if (s.length > 14) s = n.toExponential(6)
    return s
  }
  static compute(a: number, op: string, b: number): number {
    switch (op) {
      case "+":
        return a + b
      case "−":
        return a - b
      case "×":
        return a * b
      case "÷":
        return b === 0 ? NaN : a / b
    }
    return b
  }
  reset() {
    this.disp = "0"
    this.acc = null
    this.op = null
    this.fresh = true
    this.expr = ""
    this.err = false
  }
  setErr() {
    this.disp = "Error"
    this.err = true
    this.acc = null
    this.op = null
    this.fresh = true
    this.expr = ""
  }
  press(k: string) {
    if (k === "C") return this.reset()
    if (this.err) {
      if (/^[0-9.]$/.test(k)) this.reset()
      else return
    }
    if (/^[0-9]$/.test(k)) {
      if (this.fresh) {
        this.disp = k
        this.fresh = false
      } else if (this.disp === "0") this.disp = k
      else if (this.disp.replace(/[-.]/g, "").length < 12) this.disp += k
    } else if (k === ".") {
      if (this.fresh) {
        this.disp = "0."
        this.fresh = false
      } else if (!this.disp.includes(".")) this.disp += "."
    } else if (k === "⌫") {
      if (!this.fresh && this.disp.length > 1) this.disp = this.disp.slice(0, -1)
      else if (!this.fresh) this.disp = "0"
      if (this.disp === "-") this.disp = "0"
    } else if (k === "=") {
      if (this.op !== null && this.acc !== null) {
        const b = parseFloat(this.disp)
        const r = Calc.compute(this.acc, this.op, b)
        if (!isFinite(r)) return this.setErr()
        this.expr = `${Calc.fmt(this.acc)} ${this.op} ${Calc.fmt(b)} =`
        this.disp = Calc.fmt(r)
        this.op = null
        this.acc = null
        this.fresh = true
      }
    } else if ("+−×÷".includes(k)) {
      if (this.op !== null && this.acc !== null && !this.fresh) {
        const r = Calc.compute(this.acc, this.op, parseFloat(this.disp))
        if (!isFinite(r)) return this.setErr()
        this.acc = r
        this.disp = Calc.fmt(r)
      } else if (this.op === null) {
        this.acc = parseFloat(this.disp)
      }
      this.op = k
      this.fresh = true
      this.expr = `${Calc.fmt(this.acc as number)} ${k}`
    }
  }
}

interface CalcBtn {
  label: string
  x: number
  y: number
  w: number
  h: number
  kind: "num" | "op" | "eq" | "clr"
}
function calcLayout(iw: number, ih: number): { btns: CalcBtn[]; dx: number; dw: number } {
  const bw = Math.max(3, Math.floor((iw - 2 - 3) / 4))
  const total = bw * 4 + 3
  const dx = Math.max(0, Math.floor((iw - total) / 2))
  const avail = Math.max(5, ih - 4)
  const rowH = Math.max(1, Math.floor(avail / 5))
  const bh = rowH >= 3 ? rowH - 1 : 1
  const used = rowH * 5 - (rowH - bh)
  const off = 3 + Math.max(0, Math.floor((avail - used) / 2))
  const rows = [
    ["C"],
    ["7", "8", "9", "÷"],
    ["4", "5", "6", "×"],
    ["1", "2", "3", "−"],
    ["0", ".", "=", "+"],
  ]
  const btns: CalcBtn[] = []
  rows.forEach((r, ri) => {
    const y = off + ri * rowH
    if (r.length === 1) {
      btns.push({ label: "C", x: dx, y, w: total, h: bh, kind: "clr" })
    } else
      r.forEach((l, ci) => {
        const kind = l === "=" ? "eq" : "+−×÷".includes(l) ? "op" : "num"
        btns.push({ label: l, x: dx + ci * (bw + 1), y, w: bw, h: bh, kind })
      })
  })
  return { btns, dx, dw: total }
}

// ------------------------------------------------------------- menus -------
interface MenuItem {
  label: string
  hint?: string
  act?: string
  sep?: boolean
}
interface Menu {
  label: string
  x: number
  items: MenuItem[]
}
const MENUS: Menu[] = [
  { label: "≡", x: 0, items: [{ label: "About", act: "about" }, { label: "Quit", hint: "Ctrl+Q", act: "quit" }] },
  {
    label: "File",
    x: 0,
    items: [
      { label: "Notes", act: "open:notes" },
      { label: "Calculator", act: "open:calc" },
      { label: "Files", act: "open:files" },
      { label: "", sep: true },
      { label: "Quit", hint: "Ctrl+Q", act: "quit" },
    ],
  },
  {
    label: "Window",
    x: 0,
    items: [
      { label: "Tile", act: "tile" },
      { label: "Cascade", act: "cascade" },
      { label: "Next", hint: "F6", act: "next" },
      { label: "Zoom", hint: "F5", act: "zoom" },
      { label: "Close", hint: "Ctrl+W", act: "close" },
    ],
  },
  { label: "Help", x: 0, items: [{ label: "About", act: "about" }] },
]
// bar layout: each title is " label " ; ≡ gets extra padding
{
  let x = 0
  for (const m of MENUS) {
    m.x = x
    x += m.label.length + 2 + (m.label === "≡" ? 1 : 0)
  }
}
function menuW(m: Menu): number {
  return m.label === "≡" ? 5 : m.label.length + 2
}
function dropW(m: Menu): number {
  let w = 0
  for (const it of m.items) w = Math.max(w, it.label.length + (it.hint ? it.hint.length + 3 : 0))
  return w + 4
}

// ------------------------------------------------------------- the app -----
class Desktop extends Renderable {
  grid = new Grid()
  W = 0
  H = 0
  wins: Win[] = []
  nextId = 1
  menuOpen = -1 // index of the opened menu or -1
  menuItem = 0
  about = false
  drag: null | { mode: "move" | "resize"; win: Win; sx: number; sy: number; orig: Geo } = null
  lastClick = { t: 0, id: -1 }
  colors = new Map<number, RGBA>()
  rend: CliRenderer
  lastW = -1
  lastH = -1

  constructor(ctx: CliRenderer, options: RenderableOptions<Desktop>) {
    super(ctx, options)
    this.rend = ctx
    this.wins.push(this.makeWin("notes", 4, 3, 44, 16))
    this.wins.push(this.makeWin("calc", 72, 4, 28, 17))
    this.wins.push(this.makeWin("files", 8, 14, 56, 14))
  }

  makeWin(kind: Kind, x: number, y: number, w: number, h: number): Win {
    const title = kind === "notes" ? "Notes" : kind === "calc" ? "Calculator" : "Files"
    let state: any
    if (kind === "notes") {
      const lines = notesText.replace(/\r/g, "").split("\n")
      state = { lines, cy: 0, cx: 0, top: 0, left: 0 } as NotesState
    } else if (kind === "calc") state = new Calc()
    else state = { sel: 0, top: 0 } as FilesState
    return { id: this.nextId++, kind, title, x, y, w, h, max: false, restore: null, state }
  }

  get fw(): Win | undefined {
    return this.wins[this.wins.length - 1]
  }
  redraw() {
    this.rend.requestRender()
  }

  // ----- geometry -----
  fit(win: Win) {
    const { W, H } = this
    if (win.max) {
      win.x = 0
      win.y = 1
      win.w = W
      win.h = Math.max(1, H - 2)
      return
    }
    win.w = Math.max(1, Math.min(win.w, W))
    win.h = Math.max(1, Math.min(win.h, H - 2))
    win.x = Math.max(0, Math.min(win.x, W - win.w))
    win.y = Math.max(1, Math.min(win.y, H - 1 - win.h))
  }
  refit() {
    for (const w of this.wins) {
      this.fit(w)
      if (w.restore) {
        const r = w.restore
        r.w = Math.max(1, Math.min(r.w, this.W))
        r.h = Math.max(1, Math.min(r.h, this.H - 2))
        r.x = Math.max(0, Math.min(r.x, this.W - r.w))
        r.y = Math.max(1, Math.min(r.y, this.H - 1 - r.h))
      }
    }
  }
  raise(win: Win) {
    const i = this.wins.indexOf(win)
    if (i >= 0 && i !== this.wins.length - 1) {
      this.wins.splice(i, 1)
      this.wins.push(win)
    }
  }
  toggleMax(win: Win) {
    if (win.max) {
      win.max = false
      if (win.restore) Object.assign(win, win.restore)
      win.restore = null
      this.fit(win)
    } else {
      win.restore = { x: win.x, y: win.y, w: win.w, h: win.h }
      win.max = true
      this.fit(win)
    }
  }
  closeWin(win: Win) {
    const i = this.wins.indexOf(win)
    if (i >= 0) this.wins.splice(i, 1)
    if (this.drag && this.drag.win === win) this.drag = null
  }
  tile() {
    const n = this.wins.length
    if (!n) return
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    const dh = this.H - 2
    this.wins.forEach((w, i) => {
      const r = Math.floor(i / cols)
      const c = i % cols
      const count = r < rows - 1 ? cols : n - cols * (rows - 1)
      const cw = Math.floor(this.W / count)
      const rh = Math.floor(dh / rows)
      w.max = false
      w.restore = null
      w.x = c * cw
      w.w = c === count - 1 ? this.W - c * cw : cw
      w.y = 1 + r * rh
      w.h = r === rows - 1 ? dh - r * rh : rh
    })
  }
  cascade() {
    const dh = this.H - 2
    const n = this.wins.length
    this.wins.forEach((w, i) => {
      w.max = false
      w.restore = null
      w.w = Math.min(this.W, Math.max(30, Math.floor(this.W * 0.6)))
      w.h = Math.min(dh, Math.max(10, Math.floor(dh * 0.7)))
      w.x = Math.min(i * 3, Math.max(0, this.W - w.w))
      w.y = Math.min(1 + i, Math.max(1, this.H - 1 - w.h))
    })
    void n
  }
  openKind(kind: Kind) {
    let w = this.wins.find((x) => x.kind === kind)
    if (!w) {
      const base = { notes: [4, 3, 44, 16], calc: [72, 4, 28, 17], files: [8, 14, 56, 14] }[kind]
      w = this.makeWin(kind, base[0], base[1], base[2], base[3])
      this.fit(w)
      this.wins.push(w)
    } else this.raise(w)
  }

  // ----- actions -----
  doAction(act: string) {
    this.menuOpen = -1
    if (act === "about") this.about = true
    else if (act === "quit") quit()
    else if (act === "tile") this.tile()
    else if (act === "cascade") this.cascade()
    else if (act === "next") this.next()
    else if (act === "zoom") {
      const f = this.fw
      if (f) this.toggleMax(f)
    } else if (act === "close") {
      const f = this.fw
      if (f) this.closeWin(f)
    } else if (act.startsWith("open:")) this.openKind(act.slice(5) as Kind)
    this.redraw()
  }
  next() {
    if (this.wins.length > 1) {
      const w = this.wins.shift()!
      this.wins.push(w)
    }
  }

  // ----- keyboard -----
  onKey(key: KeyEvent) {
    const name = key.name
    if (key.ctrl && name === "q") return quit()
    if (key.ctrl && name === "c") return quit()
    if (this.about) {
      if (name === "return" || name === "enter" || name === "escape" || name === "space") {
        this.about = false
        this.redraw()
      }
      return
    }
    if (name === "f10") {
      this.menuOpen = this.menuOpen >= 0 ? -1 : 0
      this.menuItem = this.firstItem(0)
      return this.redraw()
    }
    if (this.menuOpen >= 0) return this.menuKey(name)
    if (name === "f5") {
      const f = this.fw
      if (f) this.toggleMax(f)
      return this.redraw()
    }
    if (name === "f6") {
      this.next()
      return this.redraw()
    }
    if (key.ctrl && name === "w") {
      const f = this.fw
      if (f) this.closeWin(f)
      return this.redraw()
    }
    const f = this.fw
    if (!f) return
    if (f.kind === "notes") this.notesKey(f, key)
    else if (f.kind === "calc") this.calcKey(f, key)
    else this.filesKey(f, key)
    this.redraw()
  }
  firstItem(mi: number): number {
    const items = MENUS[mi].items
    const i = items.findIndex((x) => !x.sep)
    return i < 0 ? 0 : i
  }
  menuKey(name: string) {
    const n = MENUS.length
    if (name === "escape") this.menuOpen = -1
    else if (name === "left") {
      this.menuOpen = (this.menuOpen + n - 1) % n
      this.menuItem = this.firstItem(this.menuOpen)
    } else if (name === "right") {
      this.menuOpen = (this.menuOpen + 1) % n
      this.menuItem = this.firstItem(this.menuOpen)
    } else if (name === "up" || name === "down") {
      const items = MENUS[this.menuOpen].items
      const d = name === "up" ? -1 : 1
      let i = this.menuItem
      for (let k = 0; k < items.length; k++) {
        i = (i + d + items.length) % items.length
        if (!items[i].sep) break
      }
      this.menuItem = i
    } else if (name === "return" || name === "enter") {
      const it = MENUS[this.menuOpen].items[this.menuItem]
      if (it && it.act) return this.doAction(it.act)
    }
    this.redraw()
  }

  notesKey(win: Win, key: KeyEvent) {
    const s = win.state as NotesState
    const L = s.lines
    const name = key.name
    const clampX = () => (s.cx = Math.min(s.cx, L[s.cy].length))
    if (name === "left") {
      if (s.cx > 0) s.cx--
      else if (s.cy > 0) {
        s.cy--
        s.cx = L[s.cy].length
      }
    } else if (name === "right") {
      if (s.cx < L[s.cy].length) s.cx++
      else if (s.cy < L.length - 1) {
        s.cy++
        s.cx = 0
      }
    } else if (name === "up") {
      if (s.cy > 0) s.cy--
      clampX()
    } else if (name === "down") {
      if (s.cy < L.length - 1) s.cy++
      clampX()
    } else if (name === "home") s.cx = 0
    else if (name === "end") s.cx = L[s.cy].length
    else if (name === "pageup") {
      s.cy = Math.max(0, s.cy - Math.max(1, win.h - 4))
      clampX()
    } else if (name === "pagedown") {
      s.cy = Math.min(L.length - 1, s.cy + Math.max(1, win.h - 4))
      clampX()
    } else if (name === "return" || name === "enter") {
      const rest = L[s.cy].slice(s.cx)
      L[s.cy] = L[s.cy].slice(0, s.cx)
      L.splice(s.cy + 1, 0, rest)
      s.cy++
      s.cx = 0
    } else if (name === "backspace") {
      if (s.cx > 0) {
        L[s.cy] = L[s.cy].slice(0, s.cx - 1) + L[s.cy].slice(s.cx)
        s.cx--
      } else if (s.cy > 0) {
        const prev = L[s.cy - 1].length
        L[s.cy - 1] += L[s.cy]
        L.splice(s.cy, 1)
        s.cy--
        s.cx = prev
      }
    } else if (name === "delete") {
      if (s.cx < L[s.cy].length) L[s.cy] = L[s.cy].slice(0, s.cx) + L[s.cy].slice(s.cx + 1)
      else if (s.cy < L.length - 1) {
        L[s.cy] += L[s.cy + 1]
        L.splice(s.cy + 1, 1)
      }
    } else if (name === "tab") {
      L[s.cy] = L[s.cy].slice(0, s.cx) + "  " + L[s.cy].slice(s.cx)
      s.cx += 2
    } else if (!key.ctrl && !key.meta && !key.option) {
      const seq = key.sequence
      if (seq && [...seq].length === 1 && seq >= " " && seq !== "\x7f") {
        L[s.cy] = L[s.cy].slice(0, s.cx) + seq + L[s.cy].slice(s.cx)
        s.cx += seq.length
      }
    }
  }
  calcKey(win: Win, key: KeyEvent) {
    const c = win.state as Calc
    const name = key.name
    const seq = key.sequence
    if (name === "return" || name === "enter") return c.press("=")
    if (name === "backspace") return c.press("⌫")
    if (key.ctrl || key.meta || key.option) return
    if (/^[0-9]$/.test(seq) || seq === ".") c.press(seq)
    else if (seq === "=") c.press("=")
    else if (seq === "+") c.press("+")
    else if (seq === "-") c.press("−")
    else if (seq === "*") c.press("×")
    else if (seq === "/") c.press("÷")
    else if (seq === "c" || seq === "C") c.press("C")
  }
  filesKey(win: Win, key: KeyEvent) {
    const s = win.state as FilesState
    const n = filesData.length
    const page = Math.max(1, win.h - 5)
    const name = key.name
    if (name === "up") s.sel = Math.max(0, s.sel - 1)
    else if (name === "down") s.sel = Math.min(n - 1, s.sel + 1)
    else if (name === "home") s.sel = 0
    else if (name === "end") s.sel = Math.max(0, n - 1)
    else if (name === "pageup") s.sel = Math.max(0, s.sel - page)
    else if (name === "pagedown") s.sel = Math.min(n - 1, s.sel + page)
  }

  // ----- mouse -----
  winAt(x: number, y: number): Win | undefined {
    for (let i = this.wins.length - 1; i >= 0; i--) {
      const w = this.wins[i]
      if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return w
    }
    return undefined
  }

  protected onMouseEvent(ev: MouseEvent): void {
    try {
      this.handleMouse(ev)
    } catch {}
    this.redraw()
  }

  aboutRect() {
    const w = 42
    const h = 9
    return { x: Math.floor((this.W - w) / 2), y: Math.floor((this.H - h) / 2), w, h }
  }

  handleMouse(ev: MouseEvent) {
    const { x, y } = ev
    const t = ev.type
    if (t === "drag") {
      this.dragTo(x, y)
      return
    }
    if (t === "up" || t === "drag-end") {
      if (this.drag) this.drag = null
      return
    }
    if (t === "scroll") {
      const w = this.winAt(x, y)
      if (!w || this.about || this.menuOpen >= 0) return
      const d = ev.scroll?.direction === "up" ? -1 : ev.scroll?.direction === "down" ? 1 : 0
      if (w.kind === "files") {
        const s = w.state as FilesState
        s.sel = Math.max(0, Math.min(filesData.length - 1, s.sel + d))
      } else if (w.kind === "notes") {
        const s = w.state as NotesState
        s.top = Math.max(0, Math.min(s.lines.length - 1, s.top + d * 2))
        s.cy = Math.max(0, Math.min(s.lines.length - 1, s.cy + d * 2))
        s.cx = Math.min(s.cx, s.lines[s.cy].length)
      }
      return
    }
    if (t !== "down" || ev.button !== 0) return

    // modal
    if (this.about) {
      const r = this.aboutRect()
      const bx = r.x + Math.floor(r.w / 2) - 4
      const by = r.y + r.h - 3
      if (y >= by && y <= by + 1 && x >= bx && x < bx + 8) this.about = false
      return
    }
    // menu
    if (this.menuOpen >= 0) {
      const m = MENUS[this.menuOpen]
      const dw = dropW(m)
      if (y === 0) {
        const mi = this.menuAt(x)
        if (mi >= 0 && mi !== this.menuOpen) {
          this.menuOpen = mi
          this.menuItem = this.firstItem(mi)
        } else this.menuOpen = -1
        return
      }
      if (x >= m.x && x < m.x + dw && y >= 2 && y < 2 + m.items.length) {
        const it = m.items[y - 2]
        if (it.act) this.doAction(it.act)
        return
      }
      this.menuOpen = -1
      return
    }
    if (y === 0) {
      const mi = this.menuAt(x)
      if (mi >= 0) {
        this.menuOpen = mi
        this.menuItem = this.firstItem(mi)
      }
      return
    }
    if (y === this.H - 1) {
      let tx = 1
      for (const w of this.wins.slice().sort((a, b) => a.id - b.id)) {
        const len = w.title.length + 4
        if (x >= tx && x < tx + len) {
          this.raise(w)
          return
        }
        tx += len + 1
      }
      return
    }
    const w = this.winAt(x, y)
    if (!w) return
    this.raise(w)
    const rx = x - w.x
    const ry = y - w.y
    if (ry === 0) {
      if (rx >= 1 && rx <= 3) return this.closeWin(w)
      if (rx >= w.w - 4 && rx <= w.w - 2) return this.toggleMax(w)
      const now = Date.now()
      if (this.lastClick.id === w.id && now - this.lastClick.t < 500) {
        this.lastClick = { t: 0, id: -1 }
        this.toggleMax(w)
        return
      }
      this.lastClick = { t: now, id: w.id }
      if (!w.max) this.drag = { mode: "move", win: w, sx: x, sy: y, orig: { x: w.x, y: w.y, w: w.w, h: w.h } }
      return
    }
    this.lastClick = { t: 0, id: -1 }
    if (rx === w.w - 1 && ry === w.h - 1) {
      if (!w.max) this.drag = { mode: "resize", win: w, sx: x, sy: y, orig: { x: w.x, y: w.y, w: w.w, h: w.h } }
      return
    }
    this.contentClick(w, x, y)
  }

  menuAt(x: number): number {
    for (let i = 0; i < MENUS.length; i++) if (x >= MENUS[i].x && x < MENUS[i].x + menuW(MENUS[i])) return i
    return -1
  }

  dragTo(x: number, y: number) {
    const d = this.drag
    if (!d) return
    const w = d.win
    if (d.mode === "move") {
      let nx = d.orig.x + (x - d.sx)
      let ny = d.orig.y + (y - d.sy)
      const vis = 4
      nx = Math.max(vis - w.w, Math.min(this.W - vis, nx))
      ny = Math.max(1, Math.min(this.H - 2, ny))
      w.x = nx
      w.y = ny
    } else {
      const nw = x - w.x + 1
      const nh = y - w.y + 1
      w.w = Math.max(20, Math.min(this.W - w.x, nw))
      w.h = Math.max(7, Math.min(this.H - 1 - w.y, nh))
    }
  }

  contentClick(w: Win, x: number, y: number) {
    const ix = w.x + 1
    const iy = w.y + 1
    const iw = w.w - 2
    const ih = w.h - 2
    if (w.kind === "calc") {
      const { btns } = calcLayout(iw, ih)
      for (const b of btns)
        if (x >= ix + b.x && x < ix + b.x + b.w && y >= iy + b.y && y < iy + b.y + b.h) {
          ;(w.state as Calc).press(b.label)
          return
        }
    } else if (w.kind === "files") {
      const s = w.state as FilesState
      const row = y - iy - 1
      const listH = Math.max(1, ih - 2)
      if (row >= 0 && row < listH) {
        const idx = s.top + row
        if (idx < filesData.length) s.sel = idx
      }
    } else if (w.kind === "notes") {
      const s = w.state as NotesState
      const textH = Math.max(1, ih - 1)
      const row = y - iy
      if (row >= 0 && row < textH) {
        s.cy = Math.min(s.lines.length - 1, s.top + row)
        s.cx = Math.max(0, Math.min(s.lines[s.cy].length, s.left + (x - ix) - 0))
      }
    }
  }

  // ----- rendering -----
  rgba(c: number): RGBA {
    let r = this.colors.get(c)
    if (!r) {
      r = RGBA.fromInts((c >> 16) & 255, (c >> 8) & 255, c & 255, 255)
      this.colors.set(c, r)
    }
    return r
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    const W = buffer.width
    const H = buffer.height
    const g = this.grid
    if (W !== g.w || H !== g.h) g.resize(W, H)
    this.W = W
    this.H = H
    if (W !== this.lastW || H !== this.lastH) {
      this.lastW = W
      this.lastH = H
      this.refit()
    }
    g.unclip()
    this.drawDesktop(g)
    const f = this.fw
    for (const w of this.wins) this.drawWindow(g, w, w === f)
    this.drawMenuBar(g)
    this.drawTaskbar(g)
    if (this.menuOpen >= 0) this.drawDropdown(g)
    if (this.about) this.drawAbout(g)
    // blit
    const ch = g.ch
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        buffer.setCell(x, y, ch[i], this.rgba(g.fg[i]), this.rgba(g.bg[i]), g.at[i])
      }
    this.rend.setCursorPosition(0, 0, false)
  }

  drawDesktop(g: Grid) {
    for (let y = 1; y < g.h - 1; y++)
      for (let x = 0; x < g.w; x++) g.set(x, y, (x + y) % 2 === 0 ? "░" : " ", C.deskFg, C.deskBg)
    g.fill(0, 0, g.w, 1, C.menuBg)
    g.fill(0, g.h - 1, g.w, 1, C.taskBg)
  }

  drawMenuBar(g: Grid) {
    g.unclip()
    g.fill(0, 0, g.w, 1, C.menuBg, " ", C.menuFg)
    MENUS.forEach((m, i) => {
      const sel = this.menuOpen === i
      const w = menuW(m)
      const bg = sel ? C.menuSelBg : C.menuBg
      const fg = sel ? C.menuSelFg : C.menuFg
      g.fill(m.x, 0, w, 1, bg, " ", fg)
      const lx = m.x + Math.floor((w - m.label.length) / 2)
      g.text(lx, 0, m.label, fg, bg, m.label === "≡" ? BOLD : 0)
    })
    const time = " 10:42 "
    g.text(g.w - time.length, 0, time, C.menuFg, C.menuBg, BOLD)
  }

  drawTaskbar(g: Grid) {
    g.unclip()
    const y = g.h - 1
    g.fill(0, y, g.w, 1, C.taskBg, " ", C.taskFg)
    const f = this.fw
    let x = 1
    for (const w of this.wins.slice().sort((a, b) => a.id - b.id)) {
      const label = ` ${w.title} `
      const foc = w === f
      const bg = foc ? C.taskFocus : C.taskEntry
      const fg = foc ? 0xffffff : C.taskFg
      const full = `[${label}]`
      const bcol = foc ? 0xffffff : 0x4a5c74
      g.text(x, y, "[", bcol, bg)
      g.text(x + 1, y, label, fg, bg, foc ? BOLD : 0)
      g.text(x + 1 + label.length, y, "]", bcol, bg)
      x += full.length + 1
    }
    const hint = "F10 Menu  F6 Next  Ctrl+Q Quit"
    if (x + hint.length + 2 < g.w) g.text(g.w - hint.length - 1, y, hint, 0x5d6f86, C.taskBg)
  }

  drawDropdown(g: Grid) {
    g.unclip()
    const m = MENUS[this.menuOpen]
    const dw = dropW(m)
    const dh = m.items.length + 2
    const x = Math.min(m.x, Math.max(0, g.w - dw))
    g.darken(x + 2, 2, dw, dh, 0.55)
    g.fill(x, 1, dw, dh, 0xdfe5ee, " ", C.menuFg)
    g.text(x, 1, "┌" + "─".repeat(dw - 2) + "┐", 0x56657a, 0xdfe5ee)
    g.text(x, dh, "└" + "─".repeat(dw - 2) + "┘", 0x56657a, 0xdfe5ee)
    m.items.forEach((it, i) => {
      const yy = 2 + i
      g.set(x, yy, "│", 0x56657a, 0xdfe5ee)
      g.set(x + dw - 1, yy, "│", 0x56657a, 0xdfe5ee)
      if (it.sep) {
        g.text(x, yy, "├" + "─".repeat(dw - 2) + "┤", 0x56657a, 0xdfe5ee)
        return
      }
      const sel = i === this.menuItem
      const bg = sel ? C.menuSelBg : 0xdfe5ee
      const fg = sel ? 0xffffff : C.menuFg
      g.fill(x + 1, yy, dw - 2, 1, bg, " ", fg)
      g.text(x + 2, yy, it.label, fg, bg)
      if (it.hint) g.text(x + dw - 2 - it.hint.length, yy, it.hint, sel ? 0xbcd6f5 : C.menuDim, bg)
    })
  }

  drawAbout(g: Grid) {
    g.unclip()
    g.darken(0, 1, g.w, g.h - 2, 0.5)
    const r = this.aboutRect()
    g.darken(r.x + 2, r.y + 1, r.w, r.h, 0.6)
    const p = PAL_FOCUS
    g.fill(r.x, r.y, r.w, r.h, p.body, " ", p.fg)
    this.frame(g, r.x, r.y, r.w, r.h, true, p)
    const t = " About "
    g.text(r.x + Math.floor((r.w - t.length) / 2), r.y, t, p.titleFg, p.titleBg, BOLD)
    const lines: [string, number, number][] = [
      ["Desktop with Windows", 0xffffff, BOLD],
      ["A text-mode desktop environment", p.fg, 0],
      ["in the spirit of Turbo Vision", p.dim, ITALIC],
    ]
    lines.forEach(([s, fg, at], i) => g.text(r.x + Math.floor((r.w - s.length) / 2), r.y + 2 + i, s, fg, p.body, at))
    const bx = r.x + Math.floor(r.w / 2) - 4
    g.fill(bx, r.y + r.h - 3, 8, 1, p.selBg, " ", p.selFg)
    g.text(bx, r.y + r.h - 3, "[  OK  ]", 0xffffff, p.selBg, BOLD)
  }

  frame(g: Grid, x: number, y: number, w: number, h: number, focused: boolean, p: Pal) {
    const s = focused ? ["╔", "═", "╗", "║", "╚", "╝"] : ["┌", "─", "┐", "│", "└", "┘"]
    const bg = p.body
    g.set(x, y + h - 1, s[4], p.frame, bg)
    for (let i = 1; i < w - 1; i++) g.set(x + i, y + h - 1, s[1], p.frame, bg)
    for (let j = 1; j < h - 1; j++) {
      g.set(x, y + j, s[3], p.frame, bg)
      g.set(x + w - 1, y + j, s[3], p.frame, bg)
    }
    g.set(x + w - 1, y + h - 1, s[5], p.frame, bg)
    // title row
    g.fill(x, y, w, 1, p.titleBg, s[1], p.frame)
    g.set(x, y, s[0], p.frame, p.titleBg)
    g.set(x + w - 1, y, s[2], p.frame, p.titleBg)
  }

  drawWindow(g: Grid, win: Win, focused: boolean) {
    g.unclip()
    const { x, y, w, h } = win
    const p = focused ? PAL_FOCUS : PAL_BLUR
    if (!win.max) g.darken(x + 2, y + 1, w, h, focused ? 0.62 : 0.5)
    g.fill(x, y, w, h, p.body, " ", p.fg)
    this.frame(g, x, y, w, h, focused, p)
    // buttons
    const bb = focused ? 0xffffff : p.titleFg
    g.text(x + 1, y, "[", bb, p.titleBg)
    g.text(x + 2, y, "×", p.closeFg, p.titleBg, BOLD)
    g.text(x + 3, y, "]", bb, p.titleBg)
    g.text(x + w - 4, y, "[", bb, p.titleBg)
    g.text(x + w - 3, y, "↑", focused ? 0x9dffb0 : p.titleFg, p.titleBg, BOLD)
    g.text(x + w - 2, y, "]", bb, p.titleBg)
    // title
    let t = ` ${win.title} `
    const maxT = Math.max(0, w - 10)
    if (t.length > maxT) t = t.slice(0, maxT)
    g.text(x + Math.floor((w - t.length) / 2), y, t, p.titleFg, p.titleBg, focused ? BOLD : 0)
    // resize handle
    if (w >= 2 && h >= 2) g.set(x + w - 1, y + h - 1, "◢", focused ? p.accent : p.frame, p.body)
    // content
    const ix = x + 1
    const iy = y + 1
    const iw = w - 2
    const ih = h - 2
    if (iw < 1 || ih < 1) return
    g.clip(ix, iy, iw, ih)
    if (win.kind === "notes") this.drawNotes(g, win, focused, p, ix, iy, iw, ih)
    else if (win.kind === "calc") this.drawCalc(g, win, focused, p, ix, iy, iw, ih)
    else this.drawFiles(g, win, focused, p, ix, iy, iw, ih)
    g.unclip()
  }

  drawNotes(g: Grid, win: Win, focused: boolean, p: Pal, ix: number, iy: number, iw: number, ih: number) {
    const s = win.state as NotesState
    const textH = Math.max(1, ih - 1)
    if (s.cy < s.top) s.top = s.cy
    if (s.cy >= s.top + textH) s.top = s.cy - textH + 1
    s.top = Math.max(0, Math.min(s.top, Math.max(0, s.lines.length - 1)))
    const tw = Math.max(1, iw - 0)
    if (s.cx < s.left) s.left = s.cx
    if (s.cx >= s.left + tw) s.left = s.cx - tw + 1
    for (let r = 0; r < textH; r++) {
      const li = s.top + r
      if (li >= s.lines.length) break
      const line = s.lines[li]
      const vis = line.slice(s.left, s.left + tw)
      const isBullet = line.trimStart().startsWith("-")
      const head = line.length > 0 && !isBullet
      g.text(ix, iy + r, vis, head ? p.accent : p.fg, p.body, head ? BOLD : 0)
    }
    if (focused) {
      const r = s.cy - s.top
      const c = s.cx - s.left
      const chr = s.lines[s.cy].charAt(s.cx) || " "
      g.set(ix + c, iy + r, chr, 0x101a28, 0xf2d675)
    }
    // status line
    const sy = iy + ih - 1
    g.fill(ix, sy, iw, 1, p.hdrBg, " ", p.dim)
    const st = ` Ln ${s.cy + 1}, Col ${s.cx + 1}`
    g.text(ix, sy, st, p.dim, p.hdrBg)
    const rt = `${s.lines.length} lines `
    if (iw > st.length + rt.length + 2) g.text(ix + iw - rt.length, sy, rt, p.dim, p.hdrBg)
  }

  drawCalc(g: Grid, win: Win, focused: boolean, p: Pal, ix: number, iy: number, iw: number, ih: number) {
    const c = win.state as Calc
    const { btns, dx, dw } = calcLayout(iw, ih)
    const dispBg = focused ? 0x070d15 : 0x0c121a
    g.fill(ix + dx, iy, dw, 3, dispBg, " ", p.fg)
    const expr = c.expr.length > dw - 2 ? c.expr.slice(c.expr.length - (dw - 2)) : c.expr
    g.text(ix + dx + dw - 1 - expr.length, iy, expr, p.dim, dispBg)
    let val = c.disp
    if (val.length > dw - 2) val = val.slice(val.length - (dw - 2))
    const valFg = c.err ? 0xff7a7a : focused ? 0x8dffb4 : 0x5e8a6e
    g.text(ix + dx + dw - 1 - val.length, iy + 1, val, valFg, dispBg, BOLD)
    g.text(ix + dx + dw - 1 - 0, iy + 2, "", valFg, dispBg)
    for (const b of btns) {
      let bg: number, fg: number
      const active = b.kind === "op" && c.op === b.label && c.fresh
      if (focused) {
        if (b.kind === "num") (bg = 0x2a3b52), (fg = 0xe6edf6)
        else if (b.kind === "op") (bg = active ? 0xf2d675 : 0x2f6db5), (fg = active ? 0x101a28 : 0xffffff)
        else if (b.kind === "eq") (bg = 0x2f8f5b), (fg = 0xffffff)
        else (bg = 0xa63d4a), (fg = 0xffffff)
      } else {
        if (b.kind === "num") (bg = 0x212c3b), (fg = 0x8c98aa)
        else if (b.kind === "op") (bg = 0x2a3a52), (fg = 0x8c98aa)
        else if (b.kind === "eq") (bg = 0x26493a), (fg = 0x8c98aa)
        else (bg = 0x4b2a30), (fg = 0x8c98aa)
      }
      g.fill(ix + b.x, iy + b.y, b.w, b.h, bg, " ", fg)
      const ly = iy + b.y + Math.floor((b.h - 1) / 2)
      g.text(ix + b.x + Math.floor((b.w - b.label.length) / 2), ly, b.label, fg, bg, BOLD)
    }
  }

  drawFiles(g: Grid, win: Win, focused: boolean, p: Pal, ix: number, iy: number, iw: number, ih: number) {
    const s = win.state as FilesState
    const listH = Math.max(1, ih - 2)
    const n = filesData.length
    s.sel = Math.max(0, Math.min(s.sel, n - 1))
    if (s.sel < s.top) s.top = s.sel
    if (s.sel >= s.top + listH) s.top = s.sel - listH + 1
    s.top = Math.max(0, Math.min(s.top, Math.max(0, n - listH)))
    const sizeW = 9
    const dateW = 16
    const nameW = Math.max(4, iw - 2 - 1 - sizeW - 2 - dateW - 1)
    // header
    g.fill(ix, iy, iw, 1, p.hdrBg, " ", p.dim)
    const hdr = ` ${"Name".padEnd(nameW + 2 - 1)} ${"Size".padStart(sizeW)}  ${"Modified".padEnd(dateW)}`
    g.text(ix, iy, hdr, focused ? p.accent : p.dim, p.hdrBg, BOLD)
    for (let r = 0; r < listH; r++) {
      const idx = s.top + r
      const yy = iy + 1 + r
      if (idx >= n) break
      const f = filesData[idx]
      const sel = idx === s.sel
      const bg = sel ? p.selBg : p.body
      const fg = sel ? p.selFg : f.type === "dir" ? (focused ? 0xf2d675 : 0x9a8f5e) : p.fg
      g.fill(ix, yy, iw, 1, bg, " ", fg)
      const marker = f.type === "dir" ? "▸" : " "
      let name = f.name
      if (f.type === "dir" && name !== "..") name += "/"
      if (name.length > nameW) name = name.slice(0, nameW - 1) + "…"
      const size = f.type === "dir" ? "<DIR>" : humanSize(f.size)
      g.text(ix + 1, yy, marker, sel ? p.selFg : focused ? 0xf2d675 : 0x9a8f5e, bg, BOLD)
      g.text(ix + 3, yy, name, fg, bg, f.type === "dir" ? BOLD : 0)
      g.text(ix + 3 + nameW + 1, yy, size.padStart(sizeW), sel ? p.selFg : p.dim, bg)
      g.text(ix + 3 + nameW + 1 + sizeW + 2, yy, f.modified, sel ? p.selFg : p.dim, bg)
    }
    // status
    const sy = iy + ih - 1
    g.fill(ix, sy, iw, 1, p.hdrBg, " ", p.dim)
    const dirs = filesData.filter((f) => f.type === "dir" && f.name !== "..").length
    const files = filesData.filter((f) => f.type === "file").length
    const total = filesData.reduce((a, f) => a + (f.type === "file" ? f.size : 0), 0)
    g.text(ix, sy, ` ${dirs} folders, ${files} files  ${humanSize(total)}`, p.dim, p.hdrBg)
  }
}

// ---------------------------------------------------------------- main -----
let renderer: CliRenderer
let quitting = false
function quit() {
  if (quitting) return
  quitting = true
  try {
    renderer.destroy()
  } catch {}
  setTimeout(() => process.exit(0), 30)
}

renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  enableMouseMovement: true,
})
renderer.setBackgroundColor("#14202e")
const desktop = new Desktop(renderer, { width: "100%", height: "100%", position: "absolute", left: 0, top: 0 } as any)
renderer.root.add(desktop)
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  try {
    desktop.onKey(key)
  } catch {}
})
renderer.on("resize", () => renderer.requestRender())
renderer.requestRender()
