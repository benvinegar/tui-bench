import { BOLD, Grid, mix, padLeft, padRight, strLen, truncate, type Rect } from "./grid.ts"
import { T } from "./theme.ts"

export interface Key {
  name: string
  seq: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface ScrollInfo {
  total: number
  offset: number
  visible: number
}

export interface App {
  render(g: Grid, r: Rect, focused: boolean): void
  key(k: Key): boolean
  mouseDown(x: number, y: number, r: Rect): void
  scroll(dir: number, r: Rect): void
  footer(): string
  scrollInfo(r: Rect): ScrollInfo | null
}

function printable(k: Key): string | null {
  if (k.ctrl || k.meta) return null
  if (k.name === "space") return " "
  const s = k.seq
  if (!s) return null
  const a = Array.from(s)
  if (a.length !== 1) return null
  const cp = a[0]!.codePointAt(0)!
  if (cp < 32 || cp === 127) return null
  return a[0]!
}

const isEnter = (k: Key) => k.name === "return" || k.name === "enter" || k.name === "linefeed"

// ───────────────────────────────────────────────────────────── Notes

export class NotesApp implements App {
  lines: string[]
  cx = 0
  cy = 0
  wantX = 0
  sx = 0
  sy = 0
  modified = false

  constructor(text: string) {
    let t = text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    if (t.endsWith("\n")) t = t.slice(0, -1)
    this.lines = t.split("\n")
    if (this.lines.length === 0) this.lines = [""]
  }

  private line(i = this.cy): string[] {
    return Array.from(this.lines[i] ?? "")
  }

  private ensureVisible(r: Rect) {
    const iw = Math.max(1, r.w), ih = Math.max(1, r.h)
    if (this.cy < this.sy) this.sy = this.cy
    if (this.cy >= this.sy + ih) this.sy = this.cy - ih + 1
    if (this.cx < this.sx) this.sx = this.cx
    if (this.cx >= this.sx + iw) this.sx = this.cx - iw + 1
    const maxSy = Math.max(0, this.lines.length - ih)
    if (this.sy > maxSy && this.cy <= maxSy + ih - 1) this.sy = Math.max(0, Math.min(this.sy, maxSy))
    if (this.sy < 0) this.sy = 0
  }

  render(g: Grid, r: Rect, focused: boolean) {
    this.ensureVisible(r)
    const dim = (c: number) => (focused ? c : mix(c, T.winBg, 0.35))
    for (let row = 0; row < r.h; row++) {
      const li = this.sy + row
      if (li >= this.lines.length) break
      const raw = this.lines[li]!
      const a = Array.from(raw)
      const trimmed = raw.trim()
      const isBullet = /^\s*[-*•]\s/.test(raw)
      const isHeading = trimmed.length > 0 && !isBullet
      for (let col = 0; col < r.w; col++) {
        const ci = this.sx + col
        if (ci >= a.length) break
        const c = a[ci]!
        let fg = T.winFg
        let at = 0
        if (isHeading) {
          fg = 0xffffff
          at = BOLD
        } else if (isBullet && c !== " " && ci === raw.search(/[-*•]/)) {
          fg = T.dirMark
        }
        g.put(r.x + col, r.y + row, c, dim(fg), at)
      }
    }
    if (focused) {
      const x = r.x + this.cx - this.sx
      const y = r.y + this.cy - this.sy
      const c = this.line()[this.cx] ?? " "
      g.set(x, y, c, T.cursorFg, T.cursorBg)
    }
  }

  footer(): string {
    return `${this.modified ? "● " : ""}${this.cy + 1}:${this.cx + 1}`
  }

  scrollInfo(r: Rect): ScrollInfo | null {
    if (this.lines.length <= r.h) return null
    return { total: this.lines.length, offset: this.sy, visible: r.h }
  }

  private clampX() {
    this.cx = Math.min(this.wantX, this.line().length)
  }

  key(k: Key): boolean {
    const cur = this.line()
    const p = printable(k)
    if (p !== null) {
      cur.splice(this.cx, 0, p)
      this.lines[this.cy] = cur.join("")
      this.cx++
      this.wantX = this.cx
      this.modified = true
      return true
    }
    if (isEnter(k)) {
      const before = cur.slice(0, this.cx).join("")
      const after = cur.slice(this.cx).join("")
      this.lines[this.cy] = before
      this.lines.splice(this.cy + 1, 0, after)
      this.cy++
      this.cx = 0
      this.wantX = 0
      this.modified = true
      return true
    }
    switch (k.name) {
      case "backspace":
        if (this.cx > 0) {
          cur.splice(this.cx - 1, 1)
          this.lines[this.cy] = cur.join("")
          this.cx--
        } else if (this.cy > 0) {
          const prev = this.line(this.cy - 1)
          this.cx = prev.length
          this.lines[this.cy - 1] = prev.join("") + cur.join("")
          this.lines.splice(this.cy, 1)
          this.cy--
        }
        this.wantX = this.cx
        this.modified = true
        return true
      case "delete":
        if (this.cx < cur.length) {
          cur.splice(this.cx, 1)
          this.lines[this.cy] = cur.join("")
        } else if (this.cy < this.lines.length - 1) {
          this.lines[this.cy] = cur.join("") + this.lines[this.cy + 1]
          this.lines.splice(this.cy + 1, 1)
        }
        this.modified = true
        return true
      case "left":
        if (this.cx > 0) this.cx--
        else if (this.cy > 0) {
          this.cy--
          this.cx = this.line().length
        }
        this.wantX = this.cx
        return true
      case "right":
        if (this.cx < cur.length) this.cx++
        else if (this.cy < this.lines.length - 1) {
          this.cy++
          this.cx = 0
        }
        this.wantX = this.cx
        return true
      case "up":
        if (this.cy > 0) {
          this.cy--
          this.clampX()
        } else {
          this.cx = 0
          this.wantX = 0
        }
        return true
      case "down":
        if (this.cy < this.lines.length - 1) {
          this.cy++
          this.clampX()
        } else {
          this.cx = cur.length
          this.wantX = this.cx
        }
        return true
      case "home":
        this.cx = 0
        this.wantX = 0
        return true
      case "end":
        this.cx = cur.length
        this.wantX = this.cx
        return true
      case "pageup":
        this.cy = Math.max(0, this.cy - 10)
        this.clampX()
        return true
      case "pagedown":
        this.cy = Math.min(this.lines.length - 1, this.cy + 10)
        this.clampX()
        return true
      case "tab":
        cur.splice(this.cx, 0, " ", " ")
        this.lines[this.cy] = cur.join("")
        this.cx += 2
        this.wantX = this.cx
        this.modified = true
        return true
    }
    return false
  }

  mouseDown(x: number, y: number, r: Rect) {
    const row = this.sy + (y - r.y)
    this.cy = Math.max(0, Math.min(this.lines.length - 1, row))
    this.cx = Math.max(0, Math.min(this.line().length, this.sx + (x - r.x)))
    this.wantX = this.cx
  }

  scroll(dir: number, r: Rect) {
    const maxSy = Math.max(0, this.lines.length - r.h)
    this.sy = Math.max(0, Math.min(maxSy, this.sy + dir * 3))
    // keep cursor inside the view
    if (this.cy < this.sy) this.cy = this.sy
    if (this.cy >= this.sy + r.h) this.cy = this.sy + r.h - 1
    this.clampX()
  }
}

// ───────────────────────────────────────────────────────────── Calculator

type KeyKind = "digit" | "op" | "eq" | "clr" | "bs"
interface CalcButton {
  label: string
  key: string
  kind: KeyKind
  x: number
  y: number
  w: number
  h: number
}

const OPSYM: Record<string, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" }

export class CalcApp implements App {
  cur = "0"
  acc: number | null = null
  op: string | null = null
  fresh = true
  expr = ""
  error = false
  pressed: string | null = null
  private pressTimer: ReturnType<typeof setTimeout> | null = null
  onChange: () => void = () => {}

  private layout(r: Rect): { lcd: Rect; buttons: CalcButton[] } {
    const bw = Math.max(5, Math.min(11, Math.floor((r.w - 2) / 4) - 1))
    const bh = r.h >= 26 && r.w >= 40 ? 3 : 1
    const lcdH = bh === 3 ? 3 : 2
    const slotW = bw + 1
    const slotH = bh + 1
    const blockW = 4 * slotW
    const blockH = lcdH + 1 + 5 * slotH
    const left = r.x + Math.max(0, Math.floor((r.w - blockW) / 2))
    const top = r.y + Math.max(0, Math.floor((r.h - blockH) / 2))
    const lcd = { x: left, y: top, w: blockW - 1, h: lcdH }
    const rows: [string, string, KeyKind][][] = [
      [["7", "7", "digit"], ["8", "8", "digit"], ["9", "9", "digit"], ["÷", "/", "op"]],
      [["4", "4", "digit"], ["5", "5", "digit"], ["6", "6", "digit"], ["×", "*", "op"]],
      [["1", "1", "digit"], ["2", "2", "digit"], ["3", "3", "digit"], ["−", "-", "op"]],
      [["0", "0", "digit"], [".", ".", "digit"], ["=", "=", "eq"], ["+", "+", "op"]],
    ]
    const buttons: CalcButton[] = []
    const by = top + lcdH + 1
    buttons.push({ label: "C", key: "c", kind: "clr", x: left, y: by, w: 3 * slotW - 1, h: bh })
    buttons.push({ label: "←", key: "bs", kind: "bs", x: left + 3 * slotW, y: by, w: bw, h: bh })
    rows.forEach((row, ri) => {
      row.forEach(([label, key, kind], ci) => {
        buttons.push({ label, key, kind, x: left + ci * slotW, y: by + (ri + 1) * slotH, w: bw, h: bh })
      })
    })
    return { lcd, buttons }
  }

  private fmt(n: number): string {
    if (!isFinite(n)) return "Error"
    let s = String(parseFloat(n.toPrecision(12)))
    if (s.length > 14) s = n.toExponential(6).replace(/\.?0+e/, "e")
    return s
  }

  private apply(a: number, op: string, b: number): number {
    switch (op) {
      case "+": return a + b
      case "-": return a - b
      case "*": return a * b
      case "/": return b === 0 ? NaN : a / b
    }
    return b
  }

  private setError() {
    this.error = true
    this.cur = "Error"
    this.acc = null
    this.op = null
    this.fresh = true
  }

  press(key: string) {
    if (this.error && key !== "c") {
      this.clear()
      if (key === "bs") return
    }
    if (/^[0-9.]$/.test(key)) {
      if (this.fresh) {
        this.cur = key === "." ? "0." : key
        this.fresh = false
        if (this.op === null) this.expr = ""
      } else if (key === ".") {
        if (!this.cur.includes(".")) this.cur += "."
      } else if (this.cur === "0") {
        this.cur = key
      } else if (this.cur.replace(/[-.]/g, "").length < 14) {
        this.cur += key
      }
    } else if (key in OPSYM) {
      if (this.op !== null && !this.fresh) {
        const res = this.apply(this.acc ?? 0, this.op, parseFloat(this.cur))
        if (!isFinite(res)) return this.setError()
        this.acc = res
        this.cur = this.fmt(res)
      } else if (this.op === null) {
        this.acc = parseFloat(this.cur)
      }
      this.op = key
      this.fresh = true
      this.expr = `${this.fmt(this.acc ?? 0)} ${OPSYM[key]}`
    } else if (key === "=") {
      if (this.op !== null && this.acc !== null) {
        const b = parseFloat(this.cur)
        const res = this.apply(this.acc, this.op, b)
        this.expr = `${this.fmt(this.acc)} ${OPSYM[this.op]} ${this.fmt(b)} =`
        if (!isFinite(res)) {
          this.setError()
          return
        }
        this.cur = this.fmt(res)
        this.acc = null
        this.op = null
        this.fresh = true
      }
    } else if (key === "bs") {
      if (!this.fresh) {
        this.cur = this.cur.slice(0, -1)
        if (this.cur === "" || this.cur === "-") {
          this.cur = "0"
          this.fresh = true
        }
      }
    } else if (key === "c") {
      this.clear()
    }
  }

  private clear() {
    this.cur = "0"
    this.acc = null
    this.op = null
    this.fresh = true
    this.expr = ""
    this.error = false
  }

  private flash(key: string) {
    this.pressed = key
    if (this.pressTimer) clearTimeout(this.pressTimer)
    this.pressTimer = setTimeout(() => {
      this.pressed = null
      this.pressTimer = null
      this.onChange()
    }, 140)
  }

  render(g: Grid, r: Rect, focused: boolean) {
    const dim = (c: number) => (focused ? c : mix(c, T.winBg, 0.4))
    const { lcd, buttons } = this.layout(r)
    // display
    const lbg = dim(T.lcdBg)
    g.fill(lcd.x, lcd.y, lcd.w, lcd.h, lbg)
    const inner = lcd.w - 2
    const vy = lcd.y + lcd.h - 1
    g.text(lcd.x + 1, vy - 1, padLeft(this.expr, inner), dim(T.lcdDim), lbg)
    let v = this.cur
    if (strLen(v) > inner - 2) v = truncate(v, inner - 2)
    const opMark = this.op && this.fresh ? OPSYM[this.op]! : ""
    g.text(lcd.x + 1, vy, padRight(opMark, 2), dim(T.lcdDim), lbg, BOLD)
    g.text(lcd.x + 3, vy, padLeft(v, inner - 2), dim(this.error ? 0xff8080 : T.lcdFg), lbg, BOLD)
    // keypad
    for (const b of buttons) {
      let bg: number, fg: number
      switch (b.kind) {
        case "digit": bg = T.keyDigitBg; fg = T.keyDigitFg; break
        case "op": bg = T.keyOpBg; fg = T.keyOpFg; break
        case "eq": bg = T.keyEqBg; fg = T.keyEqFg; break
        case "clr": bg = T.keyClrBg; fg = T.keyClrFg; break
        default: bg = T.keyBsBg; fg = T.keyBsFg
      }
      const isPressed = this.pressed === b.key
      const bx = isPressed ? b.x + 1 : b.x
      const face = dim(isPressed ? mix(bg, 0xffffff, 0.25) : bg)
      g.fill(bx, b.y, b.w, b.h, face)
      const lpad = Math.floor((b.w - 1) / 2)
      g.text(bx + lpad, b.y + Math.floor(b.h / 2), b.label, dim(fg), face, BOLD)
      if (!isPressed) {
        g.put(b.x + b.w, b.y, "▄", T.keyShadow)
        for (let j = 1; j < b.h; j++) g.put(b.x + b.w, b.y + j, "█", T.keyShadow)
        for (let i = 1; i <= b.w; i++) g.put(b.x + i, b.y + b.h, "▀", T.keyShadow)
      }
    }
  }

  footer(): string {
    return ""
  }

  scrollInfo(): ScrollInfo | null {
    return null
  }

  key(k: Key): boolean {
    let key: string | null = null
    if (isEnter(k)) key = "="
    else if (k.name === "backspace") key = "bs"
    else if (k.name === "delete" || k.name === "escape") key = "c"
    else {
      const p = printable(k)
      if (p !== null) {
        if (/^[0-9.+\-*/=]$/.test(p)) key = p
        else if (p === "c" || p === "C") key = "c"
        else if (p === "x" || p === "X") key = "*"
        else if (p === ",") key = "."
      }
    }
    if (key === null) return false
    this.press(key)
    this.flash(key)
    return true
  }

  mouseDown(x: number, y: number, r: Rect) {
    const { buttons } = this.layout(r)
    for (const b of buttons) {
      if (y >= b.y && y < b.y + b.h && x >= b.x && x < b.x + b.w) {
        this.press(b.key)
        this.flash(b.key)
        return
      }
    }
  }

  scroll() {}
}

// ───────────────────────────────────────────────────────────── Files

export interface FileEntry {
  name: string
  type: "dir" | "file"
  size: number
  modified: string
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 1000 ? v.toFixed(1) : Math.round(v).toString()} ${units[u]}`
}

export class FilesApp implements App {
  entries: FileEntry[]
  sel = 0
  sy = 0

  constructor(entries: FileEntry[]) {
    const up = entries.filter((e) => e.name === "..")
    const dirs = entries.filter((e) => e.type === "dir" && e.name !== "..")
    const files = entries.filter((e) => e.type !== "dir")
    this.entries = [...up, ...dirs, ...files]
  }

  private listRect(r: Rect): Rect {
    // header row + separator
    return { x: r.x, y: r.y + 2, w: r.w, h: Math.max(0, r.h - 2) }
  }

  private ensureVisible(lr: Rect) {
    const vh = Math.max(1, lr.h)
    if (this.sel < this.sy) this.sy = this.sel
    if (this.sel >= this.sy + vh) this.sy = this.sel - vh + 1
    const maxSy = Math.max(0, this.entries.length - vh)
    if (this.sy > maxSy) this.sy = maxSy
    if (this.sy < 0) this.sy = 0
  }

  private columns(w: number) {
    const sizeW = 9
    const dateW = 16
    let showDate = true
    let showSize = true
    let nameW = w - (1 + 2 + 1 + sizeW + 2 + dateW + 1)
    if (nameW < 10) {
      showDate = false
      nameW = w - (1 + 2 + 1 + sizeW + 1)
    }
    if (nameW < 6) {
      showSize = false
      nameW = w - 4
    }
    return { nameW: Math.max(1, nameW), sizeW, dateW, showDate, showSize }
  }

  render(g: Grid, r: Rect, focused: boolean) {
    const dim = (c: number) => (focused ? c : mix(c, T.winBg, 0.35))
    const lr = this.listRect(r)
    this.ensureVisible(lr)
    const c = this.columns(r.w)
    const line = (name: string, size: string, date: string) => {
      let s = " " + padRight(name, c.nameW + 2)
      if (c.showSize) s += " " + padLeft(size, c.sizeW)
      if (c.showDate) s += "  " + padRight(date, c.dateW)
      return s
    }
    // header
    if (r.h > 0) g.text(r.x, r.y, padRight(line("Name", "Size", "Modified"), r.w), dim(T.headerFg), T.winBg, BOLD)
    if (r.h > 1) g.text(r.x, r.y + 1, "─".repeat(r.w), dim(T.sepFg), T.winBg)
    for (let row = 0; row < lr.h; row++) {
      const i = this.sy + row
      const e = this.entries[i]
      if (!e) break
      const y = lr.y + row
      const isSel = i === this.sel
      const bg = isSel ? (focused ? T.selBg : T.selBgInactive) : T.winBg
      const isDir = e.type === "dir"
      const size = e.name === ".." ? "UP--DIR" : isDir ? "<DIR>" : humanSize(e.size)
      const name = isDir && e.name !== ".." ? e.name + "/" : e.name
      g.fill(r.x, y, r.w, 1, bg)
      let x = r.x + 1
      g.set(x, y, isDir ? "▸" : "·", isSel ? (isDir ? T.dirMark : 0xffffff) : dim(isDir ? T.dirMark : T.dateFg), bg, BOLD)
      x += 2
      g.text(x, y, padRight(name, c.nameW), isSel ? 0xffffff : dim(isDir ? T.dirFg : T.winFg), bg, isDir ? BOLD : 0)
      x += c.nameW + 1
      if (c.showSize) {
        g.text(x, y, padLeft(size, c.sizeW), isSel ? 0xffffff : dim(T.sizeFg), bg)
        x += c.sizeW + 2
      }
      if (c.showDate) g.text(x, y, padRight(e.modified, c.dateW), isSel ? 0xffffff : dim(T.dateFg), bg)
    }
  }

  footer(): string {
    return `${this.sel + 1}/${this.entries.length}`
  }

  scrollInfo(r: Rect): ScrollInfo | null {
    const lr = this.listRect(r)
    if (this.entries.length <= lr.h) return null
    return { total: this.entries.length, offset: this.sy, visible: lr.h }
  }

  key(k: Key): boolean {
    const n = this.entries.length
    switch (k.name) {
      case "up": this.sel = Math.max(0, this.sel - 1); return true
      case "down": this.sel = Math.min(n - 1, this.sel + 1); return true
      case "home": this.sel = 0; return true
      case "end": this.sel = n - 1; return true
      case "pageup": this.sel = Math.max(0, this.sel - 8); return true
      case "pagedown": this.sel = Math.min(n - 1, this.sel + 8); return true
    }
    return false
  }

  mouseDown(_x: number, y: number, r: Rect) {
    const lr = this.listRect(r)
    if (y < lr.y || y >= lr.y + lr.h) return
    const i = this.sy + (y - lr.y)
    if (i >= 0 && i < this.entries.length) this.sel = i
  }

  scroll(dir: number, r: Rect) {
    const lr = this.listRect(r)
    const maxSy = Math.max(0, this.entries.length - lr.h)
    this.sy = Math.max(0, Math.min(maxSy, this.sy + dir * 3))
    if (this.sel < this.sy) this.sel = this.sy
    if (this.sel >= this.sy + lr.h) this.sel = this.sy + lr.h - 1
  }
}
