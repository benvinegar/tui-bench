import {
  Renderable,
  RGBA,
  TextAttributes,
  createCliRenderer,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"

// ---------------------------------------------------------------- model

type Kind = "box" | "arrow" | "text" | "pen"
type Tool = "select" | "box" | "arrow" | "text" | "pen"

interface Obj {
  id: number
  kind: Kind
  color: number // index into PALETTE
  x1: number
  y1: number
  x2: number
  y2: number
  x: number
  y: number
  text: string
  pts: [number, number][]
}

type Cell = [number, number, string]

const PALETTE = [
  { name: "white", hex: "#f2f2f2" },
  { name: "red", hex: "#ff5f5f" },
  { name: "yellow", hex: "#ffd75f" },
  { name: "green", hex: "#5fd787" },
  { name: "cyan", hex: "#5fd7ff" },
  { name: "magenta", hex: "#d787ff" },
]

const TOOLS: { tool: Tool; key: string; label: string; title: string }[] = [
  { tool: "select", key: "v", label: "Select", title: "Select" },
  { tool: "box", key: "b", label: "Box", title: "Box" },
  { tool: "arrow", key: "a", label: "Arrow", title: "Arrow" },
  { tool: "text", key: "t", label: "Text", title: "Text" },
  { tool: "pen", key: "p", label: "Pen", title: "Pen" },
]

const KIND_NAME: Record<Kind, string> = { box: "Box", arrow: "Arrow", text: "Text", pen: "Pen" }

let nextId = 1
function blank(kind: Kind, color: number): Obj {
  return { id: nextId++, kind, color, x1: 0, y1: 0, x2: 0, y2: 0, x: 0, y: 0, text: "", pts: [] }
}

function boxCells(x1: number, y1: number, x2: number, y2: number): Cell[] {
  const l = Math.min(x1, x2)
  const r = Math.max(x1, x2)
  const t = Math.min(y1, y2)
  const b = Math.max(y1, y2)
  const out: Cell[] = []
  for (let y = t; y <= b; y++) {
    for (let x = l; x <= r; x++) {
      const top = y === t
      const bot = y === b
      const left = x === l
      const right = x === r
      if (!(top || bot || left || right)) continue
      let ch = "─"
      if (top && left) ch = "┌"
      else if (top && right) ch = "┐"
      else if (bot && left) ch = "└"
      else if (bot && right) ch = "┘"
      else if (left || right) ch = "│"
      out.push([x, y, ch])
    }
  }
  return out
}

function arrowCells(x1: number, y1: number, x2: number, y2: number): Cell[] {
  const out: Cell[] = []
  const sx = Math.sign(x2 - x1)
  const sy = Math.sign(y2 - y1)
  if (x1 === x2 && y1 === y2) return [[x2, y2, "▶"]]
  if (y1 === y2) {
    for (let x = x1; x !== x2; x += sx) out.push([x, y1, "─"])
    out.push([x2, y2, sx > 0 ? "▶" : "◀"])
  } else if (x1 === x2) {
    for (let y = y1; y !== y2; y += sy) out.push([x1, y, "│"])
    out.push([x2, y2, sy > 0 ? "▼" : "▲"])
  } else {
    // horizontal first, then vertical
    for (let x = x1; x !== x2; x += sx) out.push([x, y1, "─"])
    const corner = sx > 0 ? (sy > 0 ? "┐" : "┘") : sy > 0 ? "┌" : "└"
    out.push([x2, y1, corner])
    for (let y = y1 + sy; y !== y2; y += sy) out.push([x2, y, "│"])
    out.push([x2, y2, sy > 0 ? "▼" : "▲"])
  }
  return out
}

const cellCache = new WeakMap<Obj, Cell[]>()
function cellsOf(o: Obj): Cell[] {
  let c = cellCache.get(o)
  if (c) return c
  switch (o.kind) {
    case "box":
      c = boxCells(o.x1, o.y1, o.x2, o.y2)
      break
    case "arrow":
      c = arrowCells(o.x1, o.y1, o.x2, o.y2)
      break
    case "text":
      c = [...o.text].map((ch, i) => [o.x + i, o.y, ch] as Cell)
      break
    case "pen":
      c = o.pts.map(([x, y]) => [x, y, "█"] as Cell)
      break
  }
  cellCache.set(o, c)
  return c
}

interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}
function boundsOf(o: Obj): Bounds {
  const cs = cellsOf(o)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of cs) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

function translate(o: Obj, dx: number, dy: number): Obj {
  if (dx === 0 && dy === 0) return o
  return {
    ...o,
    x1: o.x1 + dx,
    x2: o.x2 + dx,
    y1: o.y1 + dy,
    y2: o.y2 + dy,
    x: o.x + dx,
    y: o.y + dy,
    pts: o.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]),
  }
}

function line(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = []
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  for (;;) {
    out.push([x, y])
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
  return out
}

// ---------------------------------------------------------------- colors

const C = {
  canvas: RGBA.fromHex("#0f1117"),
  bar: RGBA.fromHex("#1b1f2a"),
  barText: RGBA.fromHex("#aab2c5"),
  barDim: RGBA.fromHex("#6b7389"),
  chipBg: RGBA.fromHex("#2a3040"),
  accent: RGBA.fromHex("#3b82f6"),
  accentText: RGBA.fromHex("#ffffff"),
  keyHint: RGBA.fromHex("#ffd75f"),
  brand: RGBA.fromHex("#7c3aed"),
  sel: RGBA.fromHex("#4da3ff"),
  selBg: RGBA.fromHex("#22344f"),
  helpBg: RGBA.fromHex("#161a24"),
  helpBorder: RGBA.fromHex("#4da3ff"),
  helpHead: RGBA.fromHex("#ffd75f"),
  white: RGBA.fromHex("#f2f2f2"),
}
const PAL = PALETTE.map((p) => RGBA.fromHex(p.hex))

const BOLD = TextAttributes.BOLD
const DIM = TextAttributes.DIM

// ---------------------------------------------------------------- editor

interface Region {
  x0: number
  x1: number // exclusive
  action: () => void
}

type Drag =
  | { mode: "shape"; kind: "box" | "arrow"; sx: number; sy: number; cx: number; cy: number }
  | { mode: "pen"; obj: Obj }
  | { mode: "move"; sx: number; sy: number; dx: number; dy: number; ids: number[] }

class Editor extends Renderable {
  objects: Obj[] = []
  undoStack: Obj[][] = []
  redoStack: Obj[][] = []
  tool: Tool = "select"
  color = 0
  selected: number | null = null
  editing: { x: number; y: number; text: string; color: number } | null = null
  drag: Drag | null = null
  mouseX = 0
  mouseY = 0
  help = false
  regions: Region[] = []
  quit: () => void

  constructor(ctx: RenderContext, quit: () => void) {
    super(ctx, { width: "100%", height: "100%", flexGrow: 1 })
    this.quit = quit
  }

  // ---- helpers
  get W() {
    return this.width
  }
  get H() {
    return this.height
  }
  redraw() {
    this.requestRender()
  }

  commit(next: Obj[]) {
    this.undoStack.push(this.objects)
    if (this.undoStack.length > 500) this.undoStack.shift()
    this.redoStack = []
    this.objects = next
    this.fixSelection()
  }
  fixSelection() {
    if (this.selected !== null && !this.objects.some((o) => o.id === this.selected)) this.selected = null
  }
  undo() {
    const prev = this.undoStack.pop()
    if (!prev) return
    this.redoStack.push(this.objects)
    this.objects = prev
    this.fixSelection()
  }
  redo() {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push(this.objects)
    this.objects = next
    this.fixSelection()
  }

  finishText() {
    const e = this.editing
    if (!e) return
    this.editing = null
    if (e.text.length === 0) return
    const o = blank("text", e.color)
    o.x = e.x
    o.y = e.y
    o.text = e.text
    this.commit([...this.objects, o])
  }

  setTool(t: Tool) {
    this.finishText()
    this.tool = t
    this.drag = null
    if (t !== "select") this.selected = null
  }

  setColor(i: number) {
    this.color = i
    if (this.selected !== null) {
      const next = this.objects.map((o) => (o.id === this.selected && o.color !== i ? { ...o, color: i } : o))
      if (next.some((o, k) => o !== this.objects[k])) this.commit(next)
    }
  }

  hitTest(x: number, y: number): Obj | null {
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const o = this.objects[i]!
      for (const c of cellsOf(o)) if (c[0] === x && c[1] === y) return o
    }
    return null
  }

  clampCanvas(x: number, y: number): [number, number] {
    return [Math.max(0, Math.min(this.W - 1, x)), Math.max(1, Math.min(this.H - 2, y))]
  }

  // ---- keyboard
  onKey(key: KeyEvent) {
    if (key.eventType === "release") return
    if (key.ctrl && key.name === "q") return this.quit()
    if (key.ctrl && (key.name === "z" || key.name === "y")) {
      this.finishText()
      if (key.name === "z") this.undo()
      else this.redo()
      return this.redraw()
    }
    if (key.ctrl || key.meta) return

    if (this.editing) {
      const e = this.editing
      if (key.name === "return" || key.name === "enter" || key.name === "escape") this.finishText()
      else if (key.name === "backspace") e.text = [...e.text].slice(0, -1).join("")
      else if (key.sequence && [...key.sequence].length === 1 && key.sequence >= " " && key.sequence !== "\x7f")
        e.text += key.sequence
      return this.redraw()
    }

    if (this.help) {
      if (key.sequence === "?" || key.name === "escape") this.help = false
      return this.redraw()
    }

    const n = key.name
    if (key.sequence === "?") {
      this.help = true
      this.drag = null
    } else if (n === "escape") {
      this.selected = null
    } else if (n === "delete" || n === "backspace") {
      if (this.selected !== null) this.commit(this.objects.filter((o) => o.id !== this.selected))
    } else if (key.sequence.length === 1 && key.sequence >= "1" && key.sequence <= "6") {
      this.setColor(Number(key.sequence) - 1)
    } else if (key.sequence.length === 1) {
      const t = TOOLS.find((t) => t.key === key.sequence)
      if (t) this.setTool(t.tool)
    }
    this.redraw()
  }

  // ---- mouse
  onMouseEvent(ev: MouseEvent) {
    const t = ev.type
    const x = ev.x
    const y = ev.y
    if (this.help) {
      return
    }
    const onCanvas = y >= 1 && y <= this.H - 2
    if (onCanvas && (t === "move" || t === "down" || t === "drag" || t === "up" || t === "drag-end")) {
      this.mouseX = Math.max(0, Math.min(this.W - 1, x))
      this.mouseY = y
    }

    if (t === "down") {
      if (ev.button !== 0) return
      if (y === 0) {
        this.finishText()
        for (const r of this.regions) if (x >= r.x0 && x < r.x1) r.action()
        return this.redraw()
      }
      if (y > this.H - 2) return
      this.finishText()
      const [cx, cy] = this.clampCanvas(x, y)
      switch (this.tool) {
        case "box":
        case "arrow":
          this.drag = { mode: "shape", kind: this.tool, sx: cx, sy: cy, cx, cy }
          break
        case "pen": {
          const o = blank("pen", this.color)
          o.pts = [[cx, cy]]
          this.drag = { mode: "pen", obj: o }
          break
        }
        case "text":
          this.editing = { x: cx, y: cy, text: "", color: this.color }
          this.selected = null
          break
        case "select": {
          const hit = this.hitTest(cx, cy)
          if (!hit) {
            this.selected = null
          } else {
            this.selected = hit.id
            const ids = [hit.id]
            if (hit.kind === "box") {
              const b = boundsOf(hit)
              for (const o of this.objects) {
                if (o.kind !== "text" || o.text.length === 0) continue
                const tb = boundsOf(o)
                if (tb.x0 >= b.x0 && tb.x1 <= b.x1 && tb.y0 >= b.y0 && tb.y1 <= b.y1) ids.push(o.id)
              }
            }
            this.drag = { mode: "move", sx: cx, sy: cy, dx: 0, dy: 0, ids }
          }
          break
        }
      }
      return this.redraw()
    }

    if (t === "drag" && this.drag) {
      const [cx, cy] = this.clampCanvas(x, y)
      const d = this.drag
      if (d.mode === "shape") {
        d.cx = cx
        d.cy = cy
      } else if (d.mode === "pen") {
        const last = d.obj.pts[d.obj.pts.length - 1]!
        if (last[0] !== cx || last[1] !== cy) {
          const seg = line(last[0], last[1], cx, cy).slice(1)
          const pts = d.obj.pts.slice()
          const seen = new Set(pts.map(([px, py]) => px + "," + py))
          for (const p of seg) {
            const k = p[0] + "," + p[1]
            if (!seen.has(k)) {
              seen.add(k)
              pts.push(p)
            }
          }
          d.obj = { ...d.obj, pts }
        }
      } else {
        let dx = cx - d.sx
        let dy = cy - d.sy
        let minX = Infinity
        let minY = Infinity
        for (const o of this.objects) {
          if (!d.ids.includes(o.id)) continue
          const b = boundsOf(o)
          minX = Math.min(minX, b.x0)
          minY = Math.min(minY, b.y0)
        }
        dx = Math.max(dx, -minX)
        dy = Math.max(dy, 1 - minY)
        d.dx = dx
        d.dy = dy
      }
      return this.redraw()
    }

    if ((t === "up" || t === "drag-end" || t === "drop") && this.drag) {
      const d = this.drag
      this.drag = null
      if (d.mode === "shape") {
        const [cx, cy] = this.clampCanvas(x, y)
        const o = blank(d.kind, this.color)
        o.x1 = d.sx
        o.y1 = d.sy
        o.x2 = cx
        o.y2 = cy
        this.commit([...this.objects, o])
      } else if (d.mode === "pen") {
        const [cx, cy] = this.clampCanvas(x, y)
        let obj = d.obj
        const last = obj.pts[obj.pts.length - 1]!
        if (last[0] !== cx || last[1] !== cy) {
          const seen = new Set(obj.pts.map(([px, py]) => px + "," + py))
          const pts = obj.pts.slice()
          for (const p of line(last[0], last[1], cx, cy).slice(1)) {
            const k = p[0] + "," + p[1]
            if (!seen.has(k)) {
              seen.add(k)
              pts.push(p)
            }
          }
          obj = { ...obj, pts }
        }
        this.commit([...this.objects, obj])
      } else if (d.dx !== 0 || d.dy !== 0) {
        this.commit(this.objects.map((o) => (d.ids.includes(o.id) ? translate(o, d.dx, d.dy) : o)))
      }
      return this.redraw()
    }

    if (t === "move") this.redraw()
  }

  // ---- rendering
  put(buf: OptimizedBuffer, x: number, y: number, ch: string, fg: RGBA, bg: RGBA, attr = 0) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return
    buf.setCell(x, y, ch, fg, bg, attr)
  }
  str(buf: OptimizedBuffer, x: number, y: number, s: string, fg: RGBA, bg: RGBA, attr = 0): number {
    let cx = x
    for (const ch of s) {
      this.put(buf, cx, y, ch, fg, bg, attr)
      cx++
    }
    return cx
  }

  protected renderSelf(buf: OptimizedBuffer): void {
    const W = this.W
    const H = this.H
    if (W <= 0 || H <= 0) return

    // effective objects (with live move offset) + draft
    const d = this.drag
    const objs: Obj[] = this.objects.map((o) =>
      d && d.mode === "move" && d.ids.includes(o.id) ? translate(o, d.dx, d.dy) : o,
    )
    if (d && d.mode === "shape") {
      const o = blank(d.kind, this.color)
      nextId--
      Object.assign(o, { x1: d.sx, y1: d.sy, x2: d.cx, y2: d.cy })
      objs.push(o)
    } else if (d && d.mode === "pen") {
      objs.push(d.obj)
    }

    // canvas background
    buf.fillRect(0, 0, W, H, C.canvas)

    // grid of cells
    const grid = new Map<number, { ch: string; color: number; sel: boolean }>()
    for (const o of objs) {
      const sel = o.id === this.selected || (d?.mode === "move" && d.ids.includes(o.id) && o.id === this.selected)
      for (const [x, y, ch] of cellsOf(o)) {
        if (x < 0 || x >= W || y < 1 || y > H - 2) continue
        grid.set(y * W + x, { ch, color: o.color, sel })
      }
    }
    let curKey = -1
    if (this.editing) {
      const e = this.editing
      for (let i = 0; i < e.text.length; i++) {
        const x = e.x + i
        if (x < 0 || x >= W || e.y < 1 || e.y > H - 2) continue
        grid.set(e.y * W + x, { ch: [...e.text][i]!, color: e.color, sel: false })
      }
      const cx = e.x + [...e.text].length
      if (cx >= 0 && cx < W && e.y >= 1 && e.y <= H - 2) {
        curKey = e.y * W + cx
        grid.set(curKey, { ch: "▌", color: e.color, sel: false })
      }
    }
    for (const [k, v] of grid) {
      const x = k % W
      const y = (k - x) / W
      const bg = v.sel ? C.selBg : C.canvas
      this.put(buf, x, y, v.ch, PAL[v.color]!, bg, v.sel || k === curKey ? BOLD : 0)
    }

    // selection frame
    const selObj = objs.find((o) => o.id === this.selected)
    if (selObj) {
      const b = boundsOf(selObj)
      const l = b.x0 - 1
      const r = b.x1 + 1
      const t = b.y0 - 1
      const bt = b.y1 + 1
      const inCanvas = (x: number, y: number) => x >= 0 && x < W && y >= 1 && y <= H - 2
      for (let x = l + 1; x < r; x++) {
        for (const y of [t, bt]) if (inCanvas(x, y) && !grid.has(y * W + x)) this.put(buf, x, y, "╌", C.sel, C.canvas)
      }
      for (let y = t + 1; y < bt; y++) {
        for (const x of [l, r]) if (inCanvas(x, y) && !grid.has(y * W + x)) this.put(buf, x, y, "╎", C.sel, C.canvas)
      }
      for (const [x, y] of [
        [l, t],
        [r, t],
        [l, bt],
        [r, bt],
      ] as [number, number][]) {
        if (inCanvas(x, y)) this.put(buf, x, y, "■", C.sel, C.canvas, BOLD)
      }
    }

    this.drawToolbar(buf)
    this.drawStatus(buf, selObj ?? null)
    if (this.help) this.drawHelp(buf)
  }

  drawToolbar(buf: OptimizedBuffer) {
    const W = this.W
    buf.fillRect(0, 0, W, 1, C.bar)
    this.regions = []
    let x = 0
    x = this.str(buf, x, 0, " DRAW ", C.accentText, C.brand, BOLD)
    x += 1
    for (const t of TOOLS) {
      const active = this.tool === t.tool
      const x0 = x
      const bg = active ? C.accent : C.chipBg
      const open = active ? "[" : " "
      const close = active ? "]" : " "
      x = this.str(buf, x, 0, open, active ? C.accentText : C.barDim, bg, BOLD)
      x = this.str(buf, x, 0, t.key, active ? C.accentText : C.keyHint, bg, BOLD)
      x = this.str(buf, x, 0, " " + t.label, active ? C.accentText : C.barText, bg, active ? BOLD : 0)
      x = this.str(buf, x, 0, close, active ? C.accentText : C.barDim, bg, BOLD)
      this.regions.push({ x0, x1: x, action: () => this.setTool(t.tool) })
      x += 1
    }
    x += 1
    x = this.str(buf, x, 0, "Color", C.barDim, C.bar)
    x += 1
    for (let i = 0; i < PALETTE.length; i++) {
      const active = this.color === i
      const x0 = x
      const bg = active ? C.chipBg : C.bar
      x = this.str(buf, x, 0, active ? "[" : " ", C.accentText, bg, BOLD)
      x = this.str(buf, x, 0, String(i + 1), active ? C.accentText : C.barText, bg, active ? BOLD : 0)
      x = this.str(buf, x, 0, "●", PAL[i]!, bg, BOLD)
      x = this.str(buf, x, 0, active ? "]" : " ", C.accentText, bg, BOLD)
      const idx = i
      this.regions.push({ x0, x1: x, action: () => this.setColor(idx) })
    }
    const hint = "? help  ctrl+q quit"
    const hx = W - hint.length - 1
    if (hx > x + 1) this.str(buf, hx, 0, hint, C.barDim, C.bar)
  }

  drawStatus(buf: OptimizedBuffer, sel: Obj | null) {
    const W = this.W
    const y = this.H - 1
    if (y < 1) return
    buf.fillRect(0, y, W, 1, C.bar)
    const tool = this.editing ? "Text" : TOOLS.find((t) => t.tool === this.tool)!.title
    let x = 0
    x = this.str(buf, x, y, ` Tool: ${tool} `, C.accentText, this.editing ? C.brand : C.accent, BOLD)
    const n = this.objects.length
    const sep = " │ "
    const put = (s: string, fg: RGBA, attr = 0) => {
      x = this.str(buf, x, y, sep, C.barDim, C.bar)
      x = this.str(buf, x, y, s, fg, C.bar, attr)
    }
    put(`x ${this.mouseX} y ${this.mouseY}`, C.barText)
    put(`${n} ${n === 1 ? "object" : "objects"}`, C.barText)
    if (sel) {
      const b = boundsOf(sel)
      put(`${KIND_NAME[sel.kind]} ${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1} at ${b.x0},${b.y0}`, C.sel, BOLD)
    }
    if (this.editing) {
      put("typing: enter/esc to finish", C.keyHint)
    } else if (!sel) {
      const hint = "? help"
      if (x + hint.length + 3 < W) this.str(buf, W - hint.length - 1, y, hint, C.barDim, C.bar)
    }
  }

  drawHelp(buf: OptimizedBuffer) {
    const W = this.W
    const H = this.H
    const rows: [string, string][] = [
      ["#", "Tools"],
      ["v", "Select  - click to select, drag to move (box takes its text)"],
      ["b", "Box     - drag corner to corner"],
      ["a", "Arrow   - drag; straight, or elbow (horizontal, then vertical)"],
      ["t", "Text    - click a cell, type; enter/esc finishes"],
      ["p", "Pen     - drag to paint █ blocks"],
      ["#", "Keys"],
      ["1-6", "Color: white red yellow green cyan magenta (+recolor)"],
      ["esc", "Clear selection / finish text"],
      ["del", "Delete selected object (delete or backspace)"],
      ["ctrl+z", "Undo"],
      ["ctrl+y", "Redo"],
      ["?", "Toggle this help"],
      ["ctrl+q", "Quit"],
    ]
    const pw = Math.min(W - 2, 74)
    const ph = Math.min(H - 2, rows.length + 4)
    if (pw < 10 || ph < 4) return
    const px = Math.floor((W - pw) / 2)
    const py = Math.floor((H - ph) / 2)
    buf.fillRect(px, py, pw, ph, C.helpBg)
    for (let x = px + 1; x < px + pw - 1; x++) {
      this.put(buf, x, py, "─", C.helpBorder, C.helpBg)
      this.put(buf, x, py + ph - 1, "─", C.helpBorder, C.helpBg)
    }
    for (let y = py + 1; y < py + ph - 1; y++) {
      this.put(buf, px, y, "│", C.helpBorder, C.helpBg)
      this.put(buf, px + pw - 1, y, "│", C.helpBorder, C.helpBg)
    }
    this.put(buf, px, py, "┌", C.helpBorder, C.helpBg)
    this.put(buf, px + pw - 1, py, "┐", C.helpBorder, C.helpBg)
    this.put(buf, px, py + ph - 1, "└", C.helpBorder, C.helpBg)
    this.put(buf, px + pw - 1, py + ph - 1, "┘", C.helpBorder, C.helpBg)
    this.str(buf, px + 2, py, " Help ", C.helpHead, C.helpBg, BOLD)
    const inner = pw - 4
    let y = py + 1
    for (const [k, v] of rows) {
      if (y >= py + ph - 2) break
      if (k === "#") {
        this.str(buf, px + 2, y, v, C.helpHead, C.helpBg, BOLD)
      } else {
        this.str(buf, px + 2, y, k.padEnd(7), C.keyHint, C.helpBg, BOLD)
        this.str(buf, px + 9, y, v.slice(0, Math.max(0, inner - 7)), C.barText, C.helpBg)
      }
      y++
    }
    const foot = "press ? or esc to close"
    this.str(buf, px + pw - foot.length - 4, py + ph - 1, " " + foot + " ", C.barDim, C.helpBg)
  }
}

// ---------------------------------------------------------------- main

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  enableMouseMovement: true,
  backgroundColor: "#0f1117",
})

let quitting = false
const quit = () => {
  if (quitting) return
  quitting = true
  renderer.destroy()
  process.exit(0)
}

const editor = new Editor(renderer, quit)
editor.onMouse = function (ev: MouseEvent) {
  editor.onMouseEvent(ev)
}
renderer.root.add(editor)

renderer.keyInput.on("keypress", (key: KeyEvent) => editor.onKey(key))
renderer.on("resize", () => renderer.requestRender())
process.on("SIGTERM", quit)
process.on("SIGHUP", quit)
renderer.requestRender()
