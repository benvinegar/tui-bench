// Content of the three windows: the notes editor, the calculator and the file list.
// Each app exposes its state, key handling and (for the calculator) its button layout.

import { readFileSync } from "fs"
import type { KeyEvent } from "@opentui/core"
import { clamp, type Rect } from "./desk"

export interface FileEntry {
  name: string
  type: "dir" | "file"
  size: number
  modified: string
}

export type Op = "+" | "-" | "*" | "/"

export const notes = { lines: [""] as string[], row: 0, col: 0, top: 0, left: 0 }
export const files = { entries: [] as FileEntry[], sel: 0, top: 0, vh: 1 } // vh: rows visible last frame
export const calc = {
  display: "0",
  acc: null as number | null,
  op: null as Op | null,
  fresh: true, // the next digit starts a new number
  error: false,
}

export function loadData(): void {
  try {
    const lines = readFileSync("data/notes.txt", "utf8").replace(/\r/g, "").split("\n")
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
    notes.lines = lines
  } catch {
    notes.lines = [""]
  }
  try {
    const raw = JSON.parse(readFileSync("data/files.json", "utf8")) as FileEntry[]
    files.entries = [...raw.filter((e) => e.type === "dir"), ...raw.filter((e) => e.type !== "dir")]
  } catch {
    files.entries = []
  }
}

// A printable character from a key press, or null for control keys and named keys.
export function printable(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null
  const s = key.sequence
  if (s.length === 1 && s >= " " && s !== "\x7f") return s
  return null
}

// ---------- Notes ----------

export function noteInsert(ch: string): void {
  const line = notes.lines[notes.row]
  notes.lines[notes.row] = line.slice(0, notes.col) + ch + line.slice(notes.col)
  notes.col += ch.length
}

export function noteNewline(): void {
  const line = notes.lines[notes.row]
  notes.lines[notes.row] = line.slice(0, notes.col)
  notes.lines.splice(notes.row + 1, 0, line.slice(notes.col))
  notes.row++
  notes.col = 0
}

export function noteBackspace(): void {
  if (notes.col > 0) {
    const line = notes.lines[notes.row]
    notes.lines[notes.row] = line.slice(0, notes.col - 1) + line.slice(notes.col)
    notes.col--
  } else if (notes.row > 0) {
    const prev = notes.lines[notes.row - 1]
    notes.lines[notes.row - 1] = prev + notes.lines[notes.row]
    notes.lines.splice(notes.row, 1)
    notes.row--
    notes.col = prev.length
  }
}

export function noteDelete(): void {
  const line = notes.lines[notes.row]
  if (notes.col < line.length) {
    notes.lines[notes.row] = line.slice(0, notes.col) + line.slice(notes.col + 1)
  } else if (notes.row < notes.lines.length - 1) {
    notes.lines[notes.row] = line + notes.lines[notes.row + 1]
    notes.lines.splice(notes.row + 1, 1)
  }
}

export function noteMove(dir: "left" | "right" | "up" | "down" | "home" | "end" | "pageup" | "pagedown"): void {
  const last = notes.lines.length - 1
  const len = () => notes.lines[notes.row].length
  switch (dir) {
    case "left":
      if (notes.col > 0) notes.col--
      else if (notes.row > 0) {
        notes.row--
        notes.col = len()
      }
      break
    case "right":
      if (notes.col < len()) notes.col++
      else if (notes.row < last) {
        notes.row++
        notes.col = 0
      }
      break
    case "up":
      if (notes.row > 0) notes.row--
      notes.col = Math.min(notes.col, len())
      break
    case "down":
      if (notes.row < last) notes.row++
      notes.col = Math.min(notes.col, len())
      break
    case "home":
      notes.col = 0
      break
    case "end":
      notes.col = len()
      break
    case "pageup":
      notes.row = Math.max(0, notes.row - 10)
      notes.col = Math.min(notes.col, len())
      break
    case "pagedown":
      notes.row = Math.min(last, notes.row + 10)
      notes.col = Math.min(notes.col, len())
      break
  }
}

export function noteEnsureVisible(vw: number, vh: number): void {
  if (notes.row < notes.top) notes.top = notes.row
  if (notes.row >= notes.top + vh) notes.top = notes.row - vh + 1
  if (notes.col < notes.left) notes.left = notes.col
  if (notes.col >= notes.left + vw) notes.left = notes.col - vw + 1
  notes.left = Math.max(0, notes.left)
  notes.top = Math.max(0, notes.top)
}

export function notesKey(key: KeyEvent): boolean {
  const ch = printable(key)
  if (ch !== null) {
    noteInsert(ch)
    return true
  }
  switch (key.name) {
    case "return":
      noteNewline()
      return true
    case "backspace":
      noteBackspace()
      return true
    case "delete":
      noteDelete()
      return true
    case "left":
    case "right":
    case "up":
    case "down":
    case "home":
    case "end":
    case "pageup":
    case "pagedown":
      noteMove(key.name)
      return true
    default:
      return false
  }
}

// ---------- Calculator ----------

const OPS: Op[] = ["+", "-", "*", "/"]
const OP_SYMBOL: Record<Op, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" }

function apply(a: number, op: Op, b: number): number | null {
  switch (op) {
    case "+":
      return a + b
    case "-":
      return a - b
    case "*":
      return a * b
    case "/":
      return b === 0 ? null : a / b
  }
}

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "Error"
  const s = String(Number(n.toPrecision(12)))
  return s.length > 12 ? n.toExponential(5) : s
}

function calcReset(): void {
  calc.display = "0"
  calc.acc = null
  calc.op = null
  calc.fresh = true
  calc.error = false
}

function calcError(): void {
  calc.display = "Error"
  calc.acc = null
  calc.op = null
  calc.fresh = true
  calc.error = true
}

// Button labels and keyboard tokens share this vocabulary: digits, ".", "+", "-", "*", "/", "=", "C", "BS".
export function calcPress(k: string): void {
  if (k === "C") return calcReset()

  if (/^[0-9]$/.test(k)) {
    if (calc.error || calc.fresh) {
      calc.display = k
      calc.error = false
      calc.fresh = false
    } else if (calc.display === "0") {
      calc.display = k
    } else if (calc.display.replace(/[^0-9]/g, "").length < 12) {
      calc.display += k
    }
    return
  }

  if (k === ".") {
    if (calc.error || calc.fresh) {
      calc.display = "0."
      calc.error = false
      calc.fresh = false
    } else if (!calc.display.includes(".")) {
      calc.display += "."
    }
    return
  }

  if (k === "BS") {
    if (calc.error) return calcReset()
    if (calc.fresh) return
    calc.display = calc.display.length > 1 ? calc.display.slice(0, -1) : "0"
    return
  }

  if (k === "=") {
    if (calc.error || calc.op === null || calc.acc === null) {
      calc.fresh = true
      return
    }
    const r = apply(calc.acc, calc.op, Number(calc.display))
    if (r === null || !Number.isFinite(r)) return calcError()
    calc.display = fmt(r)
    calc.acc = null
    calc.op = null
    calc.fresh = true
    return
  }

  if ((OPS as string[]).includes(k)) {
    if (calc.error) return
    const op = k as Op
    if (calc.op !== null && calc.acc !== null && !calc.fresh) {
      const r = apply(calc.acc, calc.op, Number(calc.display))
      if (r === null || !Number.isFinite(r)) return calcError()
      calc.acc = r
      calc.display = fmt(r)
    } else if (calc.acc === null) {
      calc.acc = Number(calc.display)
    }
    calc.op = op
    calc.fresh = true
  }
}

// The pending operation shown above the calculator value, e.g. "12 +".
export function calcPending(): string {
  if (calc.acc === null || calc.op === null || calc.error) return ""
  return `${fmt(calc.acc)} ${OP_SYMBOL[calc.op]}`
}

export function calcKey(key: KeyEvent): boolean {
  const ch = printable(key)
  if (ch !== null) {
    if (/^[0-9.]$/.test(ch) || (OPS as string[]).includes(ch) || ch === "=") {
      calcPress(ch)
      return true
    }
    if (ch === "c" || ch === "C") {
      calcPress("C")
      return true
    }
    return false
  }
  if (key.name === "return") {
    calcPress("=")
    return true
  }
  if (key.name === "backspace") {
    calcPress("BS")
    return true
  }
  return false
}

export interface CalcKey {
  label: string
  x: number
  y: number
  w: number
  h: number
}

export interface CalcLayout {
  display: Rect
  keys: CalcKey[]
}

// Layout of the calculator inside its content rectangle.
export function calcLayout(c: Rect): CalcLayout {
  const colW = Math.max(3, Math.floor((c.w - 2) / 4))
  const gridW = colW * 4 - 1
  const left = c.x + Math.max(0, Math.floor((c.w - gridW) / 2))
  const top = c.y + (c.h >= 15 ? 1 : 0)
  const dispH = c.h >= 12 ? 3 : 1
  const keyTop = top + dispH + 1
  const grid = [
    ["7", "8", "9", "÷"],
    ["4", "5", "6", "×"],
    ["1", "2", "3", "−"],
    ["0", ".", "=", "+"],
  ]
  const keys: CalcKey[] = []
  grid.forEach((row, r) =>
    row.forEach((label, col) =>
      keys.push({ label, x: left + col * colW, y: keyTop + r * 2, w: colW - 1, h: 1 }),
    ),
  )
  keys.push({ label: "C", x: left, y: keyTop + 8, w: gridW, h: 1 })
  return { display: { x: left, y: top, w: gridW, h: dispH }, keys }
}

// Maps a button label to the calculator token it presses.
export function calcTokenForLabel(label: string): string {
  if (label === "÷") return "/"
  if (label === "×") return "*"
  if (label === "−") return "-"
  return label
}

// ---------- Files ----------

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function filesMove(delta: number): void {
  files.sel = clamp(files.sel + delta, 0, files.entries.length - 1)
}

export function filesEnsure(vh: number): void {
  const n = files.entries.length
  files.vh = Math.max(1, vh)
  if (files.sel < files.top) files.top = files.sel
  if (files.sel >= files.top + vh) files.top = files.sel - vh + 1
  files.top = clamp(files.top, 0, Math.max(0, n - vh))
}

// Mouse wheel: scrolls the view and keeps the selection inside it.
export function filesScroll(delta: number): void {
  const n = files.entries.length
  const vh = Math.max(1, files.vh)
  files.top = clamp(files.top + delta, 0, Math.max(0, n - vh))
  files.sel = clamp(files.sel, files.top, Math.min(n - 1, files.top + vh - 1))
}

export function filesKey(key: KeyEvent): boolean {
  switch (key.name) {
    case "up":
      filesMove(-1)
      return true
    case "down":
      filesMove(1)
      return true
    case "pageup":
      filesMove(-8)
      return true
    case "pagedown":
      filesMove(8)
      return true
    case "home":
      files.sel = 0
      return true
    case "end":
      files.sel = Math.max(0, files.entries.length - 1)
      return true
    default:
      return false
  }
}
