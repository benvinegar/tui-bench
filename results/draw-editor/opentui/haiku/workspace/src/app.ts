import {
  MouseButton,
  Renderable,
  TextAttributes,
  parseColor,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
  type RGBA,
} from "@opentui/core"
import {
  KIND_LABEL,
  PALETTE,
  TOOLS,
  arrowCells,
  boundsInside,
  boxCells,
  buildObject,
  hitTest,
  lineBetween,
  textCells,
  type Obj,
  type Pt,
  type Tool,
} from "./model.ts"

const BG = "#0D1117"
const BAR = "#161B22"
const PANEL = "#1C2330"
const MUTED = "#8B949E"
const TEXT = "#C9D1D9"
const ACCENT = "#58A6FF"
const SEL_BG = "#1F3550"
const ACTIVE_BG = "#30363D"
const MAX_HISTORY = 500

const colorCache = new Map<string, RGBA>()
function rgb(hex: string): RGBA {
  let c = colorCache.get(hex)
  if (!c) {
    c = parseColor(hex)
    colorCache.set(hex, c)
  }
  return c
}

type Action = { kind: "tool"; tool: Tool } | { kind: "color"; index: number }

interface Hit {
  x0: number
  x1: number
  text: string
  action: Action
}

type Drag =
  | { kind: "box" | "arrow"; before: Obj[]; id: number; color: number; sx: number; sy: number }
  | { kind: "pen"; before: Obj[]; id: number; color: number; cells: Map<string, Pt>; lx: number; ly: number }
  | { kind: "move"; before: Obj[]; sx: number; sy: number; origins: Map<number, Pt> }

interface TextEdit {
  x: number
  y: number
  text: string
  color: number
}

interface Paint {
  ch: string
  color: number
  sel: boolean
  cursor: boolean
}

const HELP: ReadonlyArray<[string, string]> = [
  ["", "TOOLS"],
  ["v", "Select   click or drag an object, del removes it"],
  ["b", "Box      drag from one corner to the opposite one"],
  ["a", "Arrow    drag; elbow connector when diagonal"],
  ["t", "Text     click a cell, type, enter or esc to finish"],
  ["p", "Pen      drag to paint blocks"],
  ["", ""],
  ["", "COLOR"],
  ["1-6", "white, red, yellow, green, cyan, magenta"],
  ["", ""],
  ["", "EDIT"],
  ["ctrl+z", "undo"],
  ["ctrl+y", "redo"],
  ["del", "delete the selected object"],
  ["esc", "clear the selection"],
  ["", ""],
  ["?", "toggle this help"],
  ["ctrl+q", "quit"],
]

/** The printable character a key press produces, or null. */
function printable(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null
  const s = key.sequence
  if (!s || Array.from(s).length !== 1) return null
  const code = s.charCodeAt(0)
  if (code < 32 || code === 127) return null
  return s
}

export class App extends Renderable {
  private objects: Obj[] = []
  private nextId = 1
  private tool: Tool = "select"
  private color = 0
  private selected: number | null = null
  private undoStack: Obj[][] = []
  private redoStack: Obj[][] = []
  private drag: Drag | null = null
  private textEdit: TextEdit | null = null
  private helpOpen = false
  private mouse: Pt | null = null
  private readonly onQuit: () => void

  constructor(ctx: RenderContext, onQuit: () => void) {
    super(ctx, { width: "100%", height: "100%" })
    this.onQuit = onQuit
    this.onMouseDown = (e: MouseEvent) => this.pointerDown(e)
    this.onMouseDrag = (e: MouseEvent) => this.pointerDrag(e)
    this.onMouseUp = (e: MouseEvent) => this.pointerUp(e)
    this.onMouseDragEnd = (e: MouseEvent) => this.pointerUp(e)
  }

  // ---------------------------------------------------------------- state helpers

  private changed(): void {
    this.requestRender()
  }

  private pushHistory(before: Obj[]): void {
    this.undoStack.push(before)
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack = []
  }

  private fixSelection(): void {
    if (this.selected !== null && !this.objects.some((o) => o.id === this.selected)) {
      this.selected = null
    }
  }

  private selectedObj(): Obj | undefined {
    if (this.selected === null) return undefined
    return this.objects.find((o) => o.id === this.selected)
  }

  private undo(): void {
    const prev = this.undoStack.pop()
    if (!prev) return
    this.redoStack.push(this.objects)
    this.objects = prev
    this.fixSelection()
  }

  private redo(): void {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push(this.objects)
    this.objects = next
    this.fixSelection()
  }

  /** Ends a mouse gesture; records one undo step if the document changed. */
  private finishDrag(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    if (this.objects !== d.before) this.pushHistory(d.before)
  }

  private commitText(): void {
    const t = this.textEdit
    if (!t) return
    this.textEdit = null
    const text = t.text.trimEnd()
    if (!text) return
    const obj = buildObject(this.nextId++, "text", t.color, textCells(t.x, t.y, text))
    if (!obj) return
    const before = this.objects
    this.objects = [...before, obj]
    this.pushHistory(before)
  }

  private setTool(tool: Tool): void {
    this.commitText()
    this.tool = tool
  }

  private setColor(index: number): void {
    this.color = index
    const sel = this.selectedObj()
    if (!sel || sel.color === index) return
    const before = this.objects
    this.objects = before.map((o) => (o.id === sel.id ? { ...o, color: index } : o))
    this.pushHistory(before)
  }

  private deleteSelected(): void {
    const sel = this.selectedObj()
    if (!sel) return
    const before = this.objects
    this.objects = before.filter((o) => o.id !== sel.id)
    this.selected = null
    this.pushHistory(before)
  }

  // ---------------------------------------------------------------- layout

  private canvasBottom(): number {
    return this.height - 2
  }

  private toolbarHits(): Hit[] {
    const hits: Hit[] = []
    let x = 1
    for (const t of TOOLS) {
      const text = ` ${t.key} ${t.label} `
      hits.push({ x0: x, x1: x + text.length - 1, text, action: { kind: "tool", tool: t.tool } })
      x += text.length + 1
    }
    x += 2 // separator bar
    PALETTE.forEach((_p, i) => {
      const text = ` ${i + 1}■ `
      hits.push({ x0: x, x1: x + text.length - 1, text, action: { kind: "color", index: i } })
      x += text.length + 1
    })
    return hits
  }

  // ---------------------------------------------------------------- mouse

  private pointerDown(e: MouseEvent): void {
    if (e.button !== MouseButton.LEFT) return
    if (this.helpOpen) return
    const x = e.x
    const y = e.y

    if (y === 0) {
      this.commitText()
      this.finishDrag()
      const hit = this.toolbarHits().find((h) => x >= h.x0 && x <= h.x1)
      if (hit) {
        if (hit.action.kind === "tool") this.setTool(hit.action.tool)
        else this.setColor(hit.action.index)
      }
      this.changed()
      return
    }
    if (y < 1 || y > this.canvasBottom()) return // status bar

    this.mouse = { x, y }
    this.commitText()
    const before = this.objects

    switch (this.tool) {
      case "select": {
        const hit = hitTest(this.objects, x, y)
        if (!hit) {
          this.selected = null
          break
        }
        this.selected = hit.id
        const origins = new Map<number, Pt>()
        origins.set(hit.id, { x: hit.x, y: hit.y })
        if (hit.kind === "box") {
          // A box carries the text objects that lie entirely inside it.
          for (const o of this.objects) {
            if (o.kind === "text" && boundsInside(o, hit)) origins.set(o.id, { x: o.x, y: o.y })
          }
        }
        this.drag = { kind: "move", before, sx: x, sy: y, origins }
        break
      }
      case "box":
      case "arrow": {
        const id = this.nextId++
        this.drag = { kind: this.tool, before, id, color: this.color, sx: x, sy: y }
        this.updateShapeDrag(x, y)
        break
      }
      case "pen": {
        const id = this.nextId++
        const cells = new Map<string, Pt>([[`${x},${y}`, { x, y }]])
        this.drag = { kind: "pen", before, id, color: this.color, cells, lx: x, ly: y }
        this.updatePenDrag()
        break
      }
      case "text": {
        this.textEdit = { x, y, text: "", color: this.color }
        break
      }
    }
    this.changed()
  }

  private pointerDrag(e: MouseEvent): void {
    const d = this.drag
    if (!d) return
    const x = e.x
    const y = e.y
    if (y >= 1 && y <= this.canvasBottom()) this.mouse = { x, y }

    switch (d.kind) {
      case "box":
      case "arrow":
        this.updateShapeDrag(x, y)
        break
      case "pen":
        for (const p of lineBetween(d.lx, d.ly, x, y)) d.cells.set(`${p.x},${p.y}`, p)
        d.lx = x
        d.ly = y
        this.updatePenDrag()
        break
      case "move": {
        const dx = x - d.sx
        const dy = y - d.sy
        if (dx === 0 && dy === 0) {
          this.objects = d.before
        } else {
          const origins = d.origins
          this.objects = d.before.map((o) => {
            const org = origins.get(o.id)
            return org ? { ...o, x: org.x + dx, y: org.y + dy } : o
          })
        }
        break
      }
    }
    this.changed()
  }

  private pointerUp(_e: MouseEvent): void {
    if (!this.drag) return
    this.finishDrag()
    this.changed()
  }

  /** Box or arrow preview from the press cell to the current cell. */
  private updateShapeDrag(x: number, y: number): void {
    const d = this.drag
    if (!d || (d.kind !== "box" && d.kind !== "arrow")) return
    const obj =
      d.kind === "box"
        ? buildObject(d.id, "box", d.color, boxCells(d.sx, d.sy, x, y))
        : buildObject(d.id, "arrow", d.color, arrowCells(d.sx, d.sy, x, y) ?? [])
    this.objects = obj ? [...d.before, obj] : d.before
  }

  private updatePenDrag(): void {
    const d = this.drag
    if (!d || d.kind !== "pen") return
    const abs = Array.from(d.cells.values()).map((p) => ({ x: p.x, y: p.y, ch: "█" }))
    const obj = buildObject(d.id, "pen", d.color, abs)
    this.objects = obj ? [...d.before, obj] : d.before
  }

  // ---------------------------------------------------------------- keyboard

  handleKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "q") {
      this.onQuit()
      return
    }
    if (key.ctrl && key.name === "z") {
      this.finishDrag()
      this.commitText()
      this.undo()
      this.changed()
      return
    }
    if (key.ctrl && key.name === "y") {
      this.finishDrag()
      this.commitText()
      this.redo()
      this.changed()
      return
    }
    if (this.textEdit) {
      this.editText(key)
      return
    }
    if (this.helpOpen) {
      if (printable(key) === "?" || key.name === "escape") this.helpOpen = false
      this.changed()
      return
    }
    if (key.name === "escape") {
      this.selected = null
      this.changed()
      return
    }
    if (key.name === "delete" || key.name === "backspace") {
      this.deleteSelected()
      this.changed()
      return
    }
    const ch = printable(key)
    if (!ch) return
    switch (ch.toLowerCase()) {
      case "v":
        this.setTool("select")
        break
      case "b":
        this.setTool("box")
        break
      case "a":
        this.setTool("arrow")
        break
      case "t":
        this.setTool("text")
        break
      case "p":
        this.setTool("pen")
        break
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
        this.setColor(Number(ch) - 1)
        break
      case "?":
        this.helpOpen = true
        break
      default:
        return
    }
    this.changed()
  }

  private editText(key: KeyEvent): void {
    const t = this.textEdit
    if (!t) return
    if (key.name === "return" || key.name === "enter" || key.name === "escape") {
      this.commitText()
    } else if (key.name === "backspace") {
      this.textEdit = { ...t, text: Array.from(t.text).slice(0, -1).join("") }
    } else {
      const ch = printable(key)
      if (ch) this.textEdit = { ...t, text: t.text + ch }
    }
    this.changed()
  }

  // ---------------------------------------------------------------- drawing

  protected renderSelf(buffer: OptimizedBuffer, _deltaTime: number): void {
    const W = this.width
    const H = this.height
    if (W <= 0 || H <= 0) return
    buffer.fillRect(this.x, this.y, W, H, rgb(BG))
    this.drawCanvas(buffer)
    this.drawToolbar(buffer)
    this.drawStatus(buffer)
    if (this.helpOpen) this.drawHelp(buffer)
  }

  private drawCanvas(buffer: OptimizedBuffer): void {
    const ox = this.x
    const oy = this.y
    const W = this.width
    const top = 1
    const bottom = this.canvasBottom()
    if (bottom < top) return

    // Paint into a grid in creation order so newer objects cover older ones.
    const grid: Array<Paint | undefined> = new Array(W * this.height)
    const put = (x: number, y: number, p: Paint) => {
      if (x < 0 || x >= W || y < top || y > bottom) return
      grid[y * W + x] = p
    }
    for (const obj of this.objects) {
      const sel = obj.id === this.selected
      for (const c of obj.cells) {
        if (c.ch === " ") continue
        put(obj.x + c.dx, obj.y + c.dy, { ch: c.ch, color: obj.color, sel, cursor: false })
      }
    }
    const t = this.textEdit
    if (t) {
      let x = t.x
      for (const ch of Array.from(t.text)) {
        if (ch !== " ") put(x, t.y, { ch, color: t.color, sel: false, cursor: false })
        x++
      }
      put(x, t.y, { ch: " ", color: t.color, sel: false, cursor: true })
    }

    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < W; x++) {
        const p = grid[y * W + x]
        if (!p) continue
        const fg = rgb(PALETTE[p.color]!.hex)
        if (p.cursor) {
          buffer.setCell(ox + x, oy + y, " ", rgb(BG), fg)
        } else {
          buffer.setCell(ox + x, oy + y, p.ch, fg, p.sel ? rgb(SEL_BG) : rgb(BG))
        }
      }
    }

    // Selection: corner handles just outside the bounds.
    const sel = this.selectedObj()
    if (sel) {
      const handles: Pt[] = [
        { x: sel.x - 1, y: sel.y - 1 },
        { x: sel.x + sel.w, y: sel.y - 1 },
        { x: sel.x - 1, y: sel.y + sel.h },
        { x: sel.x + sel.w, y: sel.y + sel.h },
      ]
      for (const h of handles) {
        if (h.x < 0 || h.x >= W || h.y < top || h.y > bottom) continue
        buffer.setCell(ox + h.x, oy + h.y, "■", rgb(ACCENT), rgb(BG), TextAttributes.BOLD)
      }
    }
  }

  /** Writes text on one row, clipped to maxX (exclusive). Returns the next x. */
  private write(buffer: OptimizedBuffer, x: number, y: number, text: string, fg: string, bg: string, maxX: number, bold = false): number {
    let cx = x
    for (const ch of Array.from(text)) {
      if (cx >= maxX) break
      if (cx >= 0) buffer.setCell(this.x + cx, this.y + y, ch, rgb(fg), rgb(bg), bold ? TextAttributes.BOLD : 0)
      cx++
    }
    return cx
  }

  private drawToolbar(buffer: OptimizedBuffer): void {
    const W = this.width
    buffer.fillRect(this.x, this.y, W, 1, rgb(BAR))
    for (const hit of this.toolbarHits()) {
      if (hit.action.kind === "tool") {
        const active = hit.action.tool === this.tool
        this.write(buffer, hit.x0, 0, hit.text, active ? BG : TEXT, active ? ACCENT : BAR, W, active)
      } else {
        const i = hit.action.index
        const active = i === this.color
        const text = active ? `[${i + 1}■]` : hit.text
        this.write(buffer, hit.x0, 0, text, PALETTE[i]!.hex, active ? ACTIVE_BG : BAR, W, active)
      }
    }
    // Separator between tools and palette.
    const tools = this.toolbarHits().filter((h) => h.action.kind === "tool")
    const sepX = (tools[tools.length - 1]?.x1 ?? 0) + 2
    this.write(buffer, sepX, 0, "│", MUTED, BAR, W)
    // Right-hand hint, shown only when it does not collide with the palette.
    const hint = "? help "
    const lastX1 = this.toolbarHits().reduce((m, h) => Math.max(m, h.x1), 0)
    if (lastX1 + 2 < W - hint.length) this.write(buffer, W - hint.length, 0, hint, MUTED, BAR, W)
  }

  private drawStatus(buffer: OptimizedBuffer): void {
    const W = this.width
    const y = this.height - 1
    if (y < 1) return
    buffer.fillRect(this.x, this.y + y, W, 1, rgb(BAR))
    const toolLabel = TOOLS.find((t) => t.tool === this.tool)?.label ?? ""
    let x = 1
    x = this.write(buffer, x, y, "Tool: ", MUTED, BAR, W)
    x = this.write(buffer, x, y, toolLabel, ACCENT, BAR, W, true)
    const mx = this.mouse ? String(this.mouse.x) : "-"
    const my = this.mouse ? String(this.mouse.y) : "-"
    x = this.write(buffer, x, y, `   │   x ${mx} y ${my}   │   Objects: ${this.objects.length}`, MUTED, BAR, W)
    const sel = this.selectedObj()
    if (sel) {
      x = this.write(buffer, x, y, "   │   ", MUTED, BAR, W)
      x = this.write(buffer, x, y, `${KIND_LABEL[sel.kind]} ${sel.w}×${sel.h} at ${sel.x},${sel.y}`, TEXT, BAR, W, true)
    }
    const right = "ctrl+q quit "
    if (W - right.length > x) this.write(buffer, W - right.length, y, right, MUTED, BAR, W)
  }

  private drawHelp(buffer: OptimizedBuffer): void {
    const W = this.width
    const H = this.height
    const longest = Math.max(...HELP.map(([, desc]) => desc.length))
    const w = Math.min(longest + 16, W)
    const h = Math.min(HELP.length + 4, H)
    if (w < 10 || h < 5) return
    const left = Math.floor((W - w) / 2)
    const top = Math.floor((H - h) / 2)
    const fill = rgb(PANEL)
    buffer.fillRect(this.x + left, this.y + top, w, h, fill)

    // Border.
    const bx0 = this.x + left
    const by0 = this.y + top
    for (let i = 1; i < w - 1; i++) {
      buffer.setCell(bx0 + i, by0, "─", rgb(ACCENT), fill)
      buffer.setCell(bx0 + i, by0 + h - 1, "─", rgb(ACCENT), fill)
    }
    for (let j = 1; j < h - 1; j++) {
      buffer.setCell(bx0, by0 + j, "│", rgb(ACCENT), fill)
      buffer.setCell(bx0 + w - 1, by0 + j, "│", rgb(ACCENT), fill)
    }
    buffer.setCell(bx0, by0, "╭", rgb(ACCENT), fill)
    buffer.setCell(bx0 + w - 1, by0, "╮", rgb(ACCENT), fill)
    buffer.setCell(bx0, by0 + h - 1, "╰", rgb(ACCENT), fill)
    buffer.setCell(bx0 + w - 1, by0 + h - 1, "╯", rgb(ACCENT), fill)
    const title = " Help "
    this.write(buffer, left + 2, top, title, ACCENT, PANEL, left + w - 1, true)

    const maxX = left + w - 2
    HELP.forEach(([k, desc], i) => {
      const row = top + 2 + i
      if (row >= top + h - 1) return
      if (k === "" && desc === "") return
      if (k === "") {
        this.write(buffer, left + 3, row, desc, ACCENT, PANEL, maxX, true)
        return
      }
      this.write(buffer, left + 3, row, k.padEnd(9), PALETTE[0]!.hex, PANEL, maxX, true)
      this.write(buffer, left + 12, row, desc, TEXT, PANEL, maxX)
    })
  }
}
