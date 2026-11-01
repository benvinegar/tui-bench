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

// ───────────────────────────── Model ─────────────────────────────

type Tool = "select" | "box" | "arrow" | "text" | "pen"

interface BoxObj { id: number; kind: "box"; color: number; x1: number; y1: number; x2: number; y2: number }
interface ArrowObj { id: number; kind: "arrow"; color: number; sx: number; sy: number; ex: number; ey: number }
interface TextObj { id: number; kind: "text"; color: number; x: number; y: number; text: string }
interface PenObj { id: number; kind: "pen"; color: number; pts: [number, number][] }
type Obj = BoxObj | ArrowObj | TextObj | PenObj

interface Cell { x: number; y: number; ch: string }
interface Bounds { x: number; y: number; w: number; h: number }

const TOOLS: { id: Tool; key: string; label: string }[] = [
  { id: "select", key: "v", label: "Select" },
  { id: "box", key: "b", label: "Box" },
  { id: "arrow", key: "a", label: "Arrow" },
  { id: "text", key: "t", label: "Text" },
  { id: "pen", key: "p", label: "Pen" },
]

const PALETTE: { name: string; hex: string }[] = [
  { name: "white", hex: "#E8E8EE" },
  { name: "red", hex: "#FF5F6D" },
  { name: "yellow", hex: "#FFD25F" },
  { name: "green", hex: "#5FE08A" },
  { name: "cyan", hex: "#5FD7FF" },
  { name: "magenta", hex: "#E07CFF" },
]

const KIND_NAME: Record<Obj["kind"], string> = { box: "Box", arrow: "Arrow", text: "Text", pen: "Pen" }

const C = {
  canvasBg: RGBA.fromHex("#15171F"),
  barBg: RGBA.fromHex("#232634"),
  barFg: RGBA.fromHex("#A9B1C6"),
  barDim: RGBA.fromHex("#646C85"),
  sep: RGBA.fromHex("#3A3F55"),
  accent: RGBA.fromHex("#7AA2F7"),
  accentFg: RGBA.fromHex("#11131A"),
  keyFg: RGBA.fromHex("#E0AF68"),
  brand: RGBA.fromHex("#BB9AF7"),
  selBg: RGBA.fromHex("#263052"),
  selObjBg: RGBA.fromHex("#34416E"),
  handle: RGBA.fromHex("#7AA2F7"),
  hoverBg: RGBA.fromHex("#22263A"),
  dot: RGBA.fromHex("#1E212C"),
  overlayBg: RGBA.fromHex("#1D2030"),
  overlayBorder: RGBA.fromHex("#7AA2F7"),
  white: RGBA.fromHex("#E8E8EE"),
  previewBg: RGBA.fromHex("#1B2236"),
  swatchBg: RGBA.fromHex("#3B4261"),
}
const COLORS = PALETTE.map((p) => RGBA.fromHex(p.hex))

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

function objCells(o: Obj): Cell[] {
  const out: Cell[] = []
  switch (o.kind) {
    case "box": {
      const { x1, y1, x2, y2 } = o
      if (x1 === x2 && y1 === y2) {
        out.push({ x: x1, y: y1, ch: "□" })
        break
      }
      if (y1 === y2) {
        for (let x = x1; x <= x2; x++) out.push({ x, y: y1, ch: x === x1 ? "[" : x === x2 ? "]" : "─" })
        break
      }
      if (x1 === x2) {
        for (let y = y1; y <= y2; y++) out.push({ x: x1, y, ch: y === y1 ? "┬" : y === y2 ? "┴" : "│" })
        break
      }
      for (let x = x1; x <= x2; x++) {
        const top = x === x1 ? "┌" : x === x2 ? "┐" : "─"
        const bot = x === x1 ? "└" : x === x2 ? "┘" : "─"
        out.push({ x, y: y1, ch: top })
        out.push({ x, y: y2, ch: bot })
      }
      for (let y = y1 + 1; y < y2; y++) {
        out.push({ x: x1, y, ch: "│" })
        out.push({ x: x2, y, ch: "│" })
      }
      break
    }
    case "arrow": {
      const { sx, sy, ex, ey } = o
      if (sx === ex && sy === ey) {
        out.push({ x: sx, y: sy, ch: "•" })
        break
      }
      if (sy === ey) {
        const d = ex > sx ? 1 : -1
        for (let x = sx; x !== ex; x += d) out.push({ x, y: sy, ch: "─" })
        out.push({ x: ex, y: ey, ch: d > 0 ? "▶" : "◀" })
        break
      }
      if (sx === ex) {
        const d = ey > sy ? 1 : -1
        for (let y = sy; y !== ey; y += d) out.push({ x: sx, y, ch: "│" })
        out.push({ x: ex, y: ey, ch: d > 0 ? "▼" : "▲" })
        break
      }
      const dx = ex > sx ? 1 : -1
      const dy = ey > sy ? 1 : -1
      for (let x = sx; x !== ex; x += dx) out.push({ x, y: sy, ch: "─" })
      let corner: string
      if (dx > 0) corner = dy > 0 ? "┐" : "┘"
      else corner = dy > 0 ? "┌" : "└"
      out.push({ x: ex, y: sy, ch: corner })
      for (let y = sy + dy; y !== ey; y += dy) out.push({ x: ex, y, ch: "│" })
      out.push({ x: ex, y: ey, ch: dy > 0 ? "▼" : "▲" })
      break
    }
    case "text": {
      const chars = Array.from(o.text)
      chars.forEach((ch, i) => out.push({ x: o.x + i, y: o.y, ch }))
      break
    }
    case "pen": {
      for (const [x, y] of o.pts) out.push({ x, y, ch: "█" })
      break
    }
  }
  return out
}

function objBounds(o: Obj): Bounds {
  if (o.kind === "box") return { x: o.x1, y: o.y1, w: o.x2 - o.x1 + 1, h: o.y2 - o.y1 + 1 }
  if (o.kind === "text") return { x: o.x, y: o.y, w: Math.max(1, Array.from(o.text).length), h: 1 }
  const cells = objCells(o)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of cells) {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x)
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y)
  }
  if (!cells.length) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function moveObj(o: Obj, dx: number, dy: number) {
  switch (o.kind) {
    case "box": o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; break
    case "arrow": o.sx += dx; o.ex += dx; o.sy += dy; o.ey += dy; break
    case "text": o.x += dx; o.y += dy; break
    case "pen": o.pts = o.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]); break
  }
}

function linePts(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = []
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0, y = y0
  for (;;) {
    pts.push([x, y])
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
  return pts
}

// ───────────────────────────── App ─────────────────────────────

type Drag =
  | { kind: "box" | "arrow"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "pen"; obj: PenObj; last: [number, number]; seen: Set<string> }
  | { kind: "move"; id: number; sx: number; sy: number; dx: number; dy: number; before: Obj[]; base: Obj[]; carry: number[] }

interface Hit { x0: number; x1: number; action: () => void }

class DrawApp extends Renderable {
  objects: Obj[] = []
  nextId = 1
  tool: Tool = "select"
  color = 0
  selected: number | null = null
  undoStack: { objs: Obj[]; nextId: number }[] = []
  redoStack: { objs: Obj[]; nextId: number }[] = []
  mouse: [number, number] | null = null
  drag: Drag | null = null
  editing: TextObj | null = null
  showHelp = false
  toolbarHits: Hit[] = []
  flash = ""

  constructor(ctx: RenderContext) {
    super(ctx, { id: "draw-app", width: "100%", height: "100%", position: "absolute", left: 0, top: 0 })
  }

  // ── geometry
  get W() { return this.width }
  get H() { return this.height }
  canvasTop() { return 1 }
  canvasBottom() { return this.H - 2 }
  clampCanvas(x: number, y: number): [number, number] {
    return [Math.max(0, Math.min(this.W - 1, x)), Math.max(this.canvasTop(), Math.min(Math.max(this.canvasTop(), this.canvasBottom()), y))]
  }

  // ── history
  snapshot() { return { objs: clone(this.objects), nextId: this.nextId } }
  pushHistory(before?: Obj[]) {
    this.undoStack.push(before ? { objs: before, nextId: this.nextId } : this.snapshot())
    if (this.undoStack.length > 500) this.undoStack.shift()
    this.redoStack = []
  }
  undo() {
    const s = this.undoStack.pop()
    if (!s) { this.flash = "Nothing to undo"; return }
    this.redoStack.push(this.snapshot())
    this.objects = s.objs
    this.nextId = Math.max(this.nextId, s.nextId)
    this.fixSelection()
    this.flash = "Undo"
  }
  redo() {
    const s = this.redoStack.pop()
    if (!s) { this.flash = "Nothing to redo"; return }
    this.undoStack.push(this.snapshot())
    this.objects = s.objs
    this.nextId = Math.max(this.nextId, s.nextId)
    this.fixSelection()
    this.flash = "Redo"
  }
  fixSelection() {
    if (this.selected !== null && !this.objects.some((o) => o.id === this.selected)) this.selected = null
  }
  getSelected(): Obj | undefined {
    return this.selected === null ? undefined : this.objects.find((o) => o.id === this.selected)
  }

  addObject(o: Obj) {
    this.pushHistory()
    this.objects.push(o)
  }

  // ── tools/colors
  setTool(t: Tool) {
    this.finishText()
    this.drag = null
    this.tool = t
    if (t !== "select") this.selected = null
    this.flash = ""
  }
  setColor(i: number) {
    this.color = i
    const sel = this.getSelected()
    if (sel && sel.color !== i) {
      this.pushHistory()
      sel.color = i
      this.flash = `Recolored ${KIND_NAME[sel.kind]} ${PALETTE[i]!.name}`
    } else this.flash = ""
  }

  // ── text editing
  finishText() {
    const t = this.editing
    if (!t) return
    this.editing = null
    if (t.text.length > 0) {
      this.addObject(t)
      this.flash = "Text added"
    }
  }

  hitTest(x: number, y: number): Obj | undefined {
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const o = this.objects[i]!
      if (objCells(o).some((c) => c.x === x && c.y === y)) return o
    }
    // fall back to the interior of a box
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const o = this.objects[i]!
      if (o.kind === "box" && x > o.x1 && x < o.x2 && y > o.y1 && y < o.y2) return o
    }
    return undefined
  }

  textsInside(b: BoxObj): number[] {
    return this.objects
      .filter((o): o is TextObj => o.kind === "text")
      .filter((t) => {
        const len = Array.from(t.text).length
        return t.y >= b.y1 && t.y <= b.y2 && t.x >= b.x1 && t.x + len - 1 <= b.x2
      })
      .map((t) => t.id)
  }

  // ── mouse
  handleMouse(e: MouseEvent) {
    const x = e.x, y = e.y
    const inCanvas = y >= this.canvasTop() && y <= this.canvasBottom()
    if (inCanvas || this.drag) {
      const [cx, cy] = this.clampCanvas(x, y)
      this.mouse = [cx, cy]
    }

    if (e.type === "scroll" || e.type === "over" || e.type === "out") { this.requestRender(); return }

    if (e.type === "down") {
      if (this.showHelp) { this.showHelp = false; this.requestRender(); return }
      if (e.button !== 0) { this.requestRender(); return }
      if (y === 0) {
        this.finishText()
        for (const h of this.toolbarHits) if (x >= h.x0 && x < h.x1) { h.action(); break }
        this.requestRender()
        return
      }
      if (!inCanvas) { this.requestRender(); return }
      this.onCanvasDown(x, y)
    } else if (e.type === "drag" || (e.type === "move" && this.drag)) {
      if (this.drag) {
        const [cx, cy] = this.clampCanvas(x, y)
        this.onCanvasDrag(cx, cy)
      }
    } else if (e.type === "up" || e.type === "drag-end" || e.type === "drop") {
      if (this.drag) {
        const [cx, cy] = this.clampCanvas(x, y)
        this.onCanvasDrag(cx, cy)
        this.onCanvasUp()
      }
    }
    this.requestRender()
  }

  onCanvasDown(x: number, y: number) {
    this.flash = ""
    switch (this.tool) {
      case "box":
      case "arrow":
        this.drag = { kind: this.tool, sx: x, sy: y, cx: x, cy: y }
        break
      case "pen": {
        const obj: PenObj = { id: 0, kind: "pen", color: this.color, pts: [[x, y]] }
        this.drag = { kind: "pen", obj, last: [x, y], seen: new Set([`${x},${y}`]) }
        break
      }
      case "text":
        this.finishText()
        this.editing = { id: this.nextId++, kind: "text", color: this.color, x, y, text: "" }
        break
      case "select": {
        const hit = this.hitTest(x, y)
        if (!hit) { this.selected = null; break }
        this.selected = hit.id
        const carry = hit.kind === "box" ? this.textsInside(hit) : []
        this.drag = { kind: "move", id: hit.id, sx: x, sy: y, dx: 0, dy: 0, before: clone(this.objects), base: clone(this.objects), carry }
        break
      }
    }
  }

  onCanvasDrag(x: number, y: number) {
    const d = this.drag
    if (!d) return
    if (d.kind === "box" || d.kind === "arrow") { d.cx = x; d.cy = y }
    else if (d.kind === "pen") {
      for (const p of linePts(d.last[0], d.last[1], x, y)) {
        const k = `${p[0]},${p[1]}`
        if (!d.seen.has(k)) { d.seen.add(k); d.obj.pts.push(p) }
      }
      d.last = [x, y]
    } else if (d.kind === "move") {
      const dx = x - d.sx, dy = y - d.sy
      if (dx === d.dx && dy === d.dy) return
      d.dx = dx; d.dy = dy
      const ids = new Set([d.id, ...d.carry])
      this.objects = d.base.map((o) => {
        const c = clone(o)
        if (ids.has(c.id)) moveObj(c, dx, dy)
        return c
      })
    }
  }

  onCanvasUp() {
    const d = this.drag
    this.drag = null
    if (!d) return
    if (d.kind === "box") {
      if (d.sx === d.cx && d.sy === d.cy) { this.flash = "Drag to draw a box"; return }
      this.addObject({
        id: this.nextId++, kind: "box", color: this.color,
        x1: Math.min(d.sx, d.cx), y1: Math.min(d.sy, d.cy), x2: Math.max(d.sx, d.cx), y2: Math.max(d.sy, d.cy),
      })
    } else if (d.kind === "arrow") {
      if (d.sx === d.cx && d.sy === d.cy) { this.flash = "Drag to draw an arrow"; return }
      this.addObject({ id: this.nextId++, kind: "arrow", color: this.color, sx: d.sx, sy: d.sy, ex: d.cx, ey: d.cy })
    } else if (d.kind === "pen") {
      d.obj.id = this.nextId++
      this.addObject(d.obj)
    } else if (d.kind === "move") {
      if (d.dx !== 0 || d.dy !== 0) {
        this.pushHistory(d.before)
        const sel = this.getSelected()
        const extra = d.carry.length ? ` (+${d.carry.length} text)` : ""
        if (sel) this.flash = `Moved ${KIND_NAME[sel.kind]} by ${d.dx},${d.dy}${extra}`
      }
    }
  }

  // ── keyboard
  handleKey(k: KeyEvent) {
    const name = k.name
    if (k.ctrl && (name === "q" || name === "c")) { quit(); return }

    if (this.editing) {
      const t = this.editing
      if (name === "return" || name === "enter" || name === "escape") { this.finishText() }
      else if (name === "backspace") { const a = Array.from(t.text); a.pop(); t.text = a.join("") }
      else if (k.ctrl && name === "z") { this.editing = null; this.flash = "Text discarded" }
      else if (!k.ctrl && !k.meta && k.sequence && Array.from(k.sequence).length === 1 && k.sequence >= " " && k.sequence !== "\x7f") {
        t.text += k.sequence
      }
      this.requestRender()
      return
    }

    if (k.ctrl) {
      if (name === "z") { this.drag = null; this.undo() }
      else if (name === "y") { this.drag = null; this.redo() }
      this.requestRender()
      return
    }
    if (k.meta) return

    const seq = k.sequence
    if (seq === "?") { this.showHelp = !this.showHelp; this.requestRender(); return }
    if (name === "escape") {
      if (this.showHelp) this.showHelp = false
      else if (this.drag) this.drag = null
      else this.selected = null
      this.flash = ""
      this.requestRender()
      return
    }
    if (name === "delete" || name === "backspace") {
      const sel = this.getSelected()
      if (sel) {
        this.pushHistory()
        this.objects = this.objects.filter((o) => o.id !== sel.id)
        this.selected = null
        this.flash = `Deleted ${KIND_NAME[sel.kind]}`
      }
      this.requestRender()
      return
    }
    if (seq && seq.length === 1 && seq >= "1" && seq <= "6") {
      this.setColor(seq.charCodeAt(0) - 49)
      this.requestRender()
      return
    }
    const tool = TOOLS.find((t) => t.key === seq)
    if (tool) { this.setTool(tool.id); this.requestRender() }
  }

  // ── rendering helpers
  put(buf: OptimizedBuffer, x: number, y: number, ch: string, fg: RGBA, bg: RGBA, attr = 0) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return
    buf.setCell(x, y, ch, fg, bg, attr)
  }
  text(buf: OptimizedBuffer, x: number, y: number, s: string, fg: RGBA, bg: RGBA, attr = 0): number {
    for (const ch of Array.from(s)) { this.put(buf, x, y, ch, fg, bg, attr); x++ }
    return x
  }

  protected renderSelf(buf: OptimizedBuffer): void {
    const W = this.W, H = this.H
    if (W <= 0 || H <= 0) return
    const top = this.canvasTop(), bottom = this.canvasBottom()

    // canvas background
    buf.fillRect(0, 0, W, H, C.canvasBg)

    // compose objects into a grid (later objects cover earlier ones)
    const gw = W, gh = H
    const gch: (string | null)[] = new Array(gw * gh).fill(null)
    const gcol: RGBA[] = new Array(gw * gh)
    const gid: number[] = new Array(gw * gh).fill(-1)
    const paint = (o: Obj, id: number) => {
      const col = COLORS[o.color] ?? C.white
      for (const c of objCells(o)) {
        if (c.x < 0 || c.x >= W || c.y < top || c.y > bottom) continue
        const i = c.y * gw + c.x
        gch[i] = c.ch; gcol[i] = col; gid[i] = id
      }
    }
    for (const o of this.objects) paint(o, o.id)

    // live previews
    const d = this.drag
    if (d && (d.kind === "box" || d.kind === "arrow")) {
      const prev: Obj = d.kind === "box"
        ? { id: -2, kind: "box", color: this.color, x1: Math.min(d.sx, d.cx), y1: Math.min(d.sy, d.cy), x2: Math.max(d.sx, d.cx), y2: Math.max(d.sy, d.cy) }
        : { id: -2, kind: "arrow", color: this.color, sx: d.sx, sy: d.sy, ex: d.cx, ey: d.cy }
      paint(prev, -2)
    } else if (d && d.kind === "pen") paint(d.obj, -2)
    if (this.editing) paint(this.editing, -3)

    // selection
    const sel = this.getSelected()
    const sb = sel ? objBounds(sel) : null
    const inSel = (x: number, y: number) => !!sb && x >= sb.x && x < sb.x + sb.w && y >= sb.y && y < sb.y + sb.h

    // hover cell under the mouse (only for drawing tools)
    const hover = this.mouse && !this.drag && this.tool !== "select" && !this.editing ? this.mouse : null

    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * gw + x
        const ch = gch[i]
        let bg = C.canvasBg
        if (inSel(x, y)) bg = C.selBg
        if (gid[i] === -2) bg = C.previewBg
        if (hover && hover[0] === x && hover[1] === y) bg = C.hoverBg
        if (ch) {
          const isSel = sel && gid[i] === sel.id
          this.put(buf, x, y, ch, gcol[i]!, isSel ? C.selObjBg : bg, isSel ? TextAttributes.BOLD : 0)
        } else {
          this.put(buf, x, y, " ", C.dot, bg)
        }
      }
    }

    // selection handles
    if (sb) {
      const hx0 = sb.x - 1, hx1 = sb.x + sb.w, hy0 = sb.y - 1, hy1 = sb.y + sb.h
      const corners: [number, number, string][] = [[hx0, hy0, "◤"], [hx1, hy0, "◥"], [hx0, hy1, "◣"], [hx1, hy1, "◢"]]
      for (const [hx, hy, ch] of corners) {
        if (hy < top || hy > bottom) continue
        this.put(buf, hx, hy, ch, C.handle, C.canvasBg)
      }
    }

    // text cursor
    if (this.editing) {
      const t = this.editing
      const cx = t.x + Array.from(t.text).length
      if (t.y >= top && t.y <= bottom) this.put(buf, cx, t.y, "▏", C.canvasBg, COLORS[t.color] ?? C.white)
    }

    this.renderToolbar(buf)
    this.renderStatus(buf)
    if (this.showHelp) this.renderHelp(buf)
  }

  renderToolbar(buf: OptimizedBuffer) {
    const W = this.W
    buf.fillRect(0, 0, W, 1, C.barBg)
    // pick the richest layout that fits the width
    const toolsW = (lvl: number) => TOOLS.reduce((a, t) => a + (lvl >= 2 ? 3 : 4 + t.label.length), 0)
    const need = (lvl: number) =>
      (lvl === 0 ? 12 : 3) + 1 + toolsW(lvl) + 1 + (lvl === 0 ? 7 : 0) + 24 + (lvl >= 2 ? 4 : 9)
    let lvl = 0
    while (lvl < 2 && need(lvl) > W) lvl++
    this.toolbarHits = []
    let x = 0
    x = this.text(buf, x, 0, " ✎ ", C.brand, C.barBg, TextAttributes.BOLD)
    if (lvl === 0) x = this.text(buf, x, 0, "termDRAW ", C.brand, C.barBg, TextAttributes.BOLD)
    x = this.text(buf, x, 0, "│", C.sep, C.barBg)
    for (const t of TOOLS) {
      const active = this.tool === t.id
      const bg = active ? C.accent : C.barBg
      const x0 = x
      x = this.text(buf, x, 0, " ", C.barFg, bg)
      x = this.text(buf, x, 0, t.key, active ? C.accentFg : C.keyFg, bg, TextAttributes.BOLD | (active ? 0 : TextAttributes.UNDERLINE))
      x = this.text(buf, x, 0, lvl >= 2 ? " " : " " + t.label + " ", active ? C.accentFg : C.barFg, bg, active ? TextAttributes.BOLD : 0)
      const id = t.id
      this.toolbarHits.push({ x0, x1: x, action: () => this.setTool(id) })
    }
    x = this.text(buf, x, 0, "│", C.sep, C.barBg)
    if (lvl === 0) x = this.text(buf, x, 0, " Color ", C.barDim, C.barBg)
    PALETTE.forEach((_p, i) => {
      const active = this.color === i
      const x0 = x
      const bg = active ? C.swatchBg : C.barBg
      x = this.text(buf, x, 0, active ? "[" : " ", active ? C.white : C.barBg, bg, TextAttributes.BOLD)
      x = this.text(buf, x, 0, String(i + 1), active ? C.white : C.barDim, bg, active ? TextAttributes.BOLD : 0)
      x = this.text(buf, x, 0, active ? "◆" : "■", COLORS[i]!, bg)
      x = this.text(buf, x, 0, active ? "]" : " ", active ? C.white : C.barBg, bg, TextAttributes.BOLD)
      this.toolbarHits.push({ x0, x1: x, action: () => this.setColor(i) })
    })
    const help = lvl >= 2 ? " ? " : " ? Help "
    const hx = W - help.length
    if (hx > x) {
      this.text(buf, hx - 1, 0, "│", C.sep, C.barBg)
      this.text(buf, hx + 1, 0, "?", C.keyFg, C.barBg, TextAttributes.BOLD)
      if (lvl < 2) this.text(buf, hx + 2, 0, " Help ", C.barFg, C.barBg)
      this.toolbarHits.push({ x0: hx, x1: W, action: () => { this.showHelp = !this.showHelp } })
    }
  }

  renderStatus(buf: OptimizedBuffer) {
    const W = this.W, y = this.H - 1
    if (y < 1) return
    buf.fillRect(0, y, W, 1, C.barBg)
    let x = 0
    const toolName = this.editing ? "TEXT ✎" : TOOLS.find((t) => t.id === this.tool)!.label.toUpperCase()
    x = this.text(buf, x, y, ` ${toolName} `, C.accentFg, C.accent, TextAttributes.BOLD)
    const sep = () => { x = this.text(buf, x, y, " │ ", C.sep, C.barBg) }
    x = this.text(buf, x, y, " ", C.barFg, C.barBg)
    const pos = this.mouse ? `x ${this.mouse[0]} y ${this.mouse[1]}` : "x – y –"
    x = this.text(buf, x, y, pos, C.barFg, C.barBg)
    sep()
    const n = this.objects.length
    x = this.text(buf, x, y, `${n} object${n === 1 ? "" : "s"}`, C.barFg, C.barBg)
    const sel = this.getSelected()
    if (sel) {
      sep()
      const b = objBounds(sel)
      x = this.text(buf, x, y, "◆ ", COLORS[sel.color]!, C.barBg)
      x = this.text(buf, x, y, `${KIND_NAME[sel.kind]} ${b.w}×${b.h} at ${b.x},${b.y}`, C.white, C.barBg, TextAttributes.BOLD)
    }
    let msg = this.flash
    if (this.editing) msg = "type text · enter/esc finish"
    else if (this.drag?.kind === "box") msg = `${Math.abs(this.drag.cx - this.drag.sx) + 1}×${Math.abs(this.drag.cy - this.drag.sy) + 1}`
    if (msg) {
      sep()
      x = this.text(buf, x, y, msg, C.keyFg, C.barBg)
    }
    for (const hints of ["^Z undo  ^Y redo  ? help  ^Q quit ", "? help  ^Q quit "]) {
      const hx = W - hints.length
      if (hx > x + 2) { this.text(buf, hx, y, hints, C.barDim, C.barBg); break }
    }
  }

  renderHelp(buf: OptimizedBuffer) {
    const lines: [string, string][] = [
      ["", "TOOLS"],
      ["v", "Select · click to select, drag to move"],
      ["b", "Box · drag corner to corner"],
      ["a", "Arrow · drag start to end (elbow if diagonal)"],
      ["t", "Text · click, type, enter/esc to finish"],
      ["p", "Pen · drag to paint freehand"],
      ["", ""],
      ["", "KEYS"],
      ["1-6", "Color: white red yellow green cyan magenta"],
      [" ", "(also recolors the selected object)"],
      ["del/bksp", "Delete selected object"],
      ["esc", "Clear selection / close help"],
      ["ctrl+z", "Undo"],
      ["ctrl+y", "Redo"],
      ["?", "Toggle this help"],
      ["ctrl+q", "Quit"],
    ]
    const bw = Math.min(this.W, 66)
    const bh = Math.min(this.H, lines.length + 4)
    const bx = Math.max(0, Math.floor((this.W - bw) / 2))
    const by = Math.max(0, Math.floor((this.H - bh) / 2))
    const bg = C.overlayBg
    buf.fillRect(bx, by, bw, bh, bg)
    for (let x = bx; x < bx + bw; x++) {
      this.put(buf, x, by, x === bx ? "╭" : x === bx + bw - 1 ? "╮" : "─", C.overlayBorder, bg)
      this.put(buf, x, by + bh - 1, x === bx ? "╰" : x === bx + bw - 1 ? "╯" : "─", C.overlayBorder, bg)
    }
    for (let y = by + 1; y < by + bh - 1; y++) {
      this.put(buf, bx, y, "│", C.overlayBorder, bg)
      this.put(buf, bx + bw - 1, y, "│", C.overlayBorder, bg)
    }
    const title = " Help · termDRAW "
    this.text(buf, bx + Math.floor((bw - title.length) / 2), by, title, C.brand, bg, TextAttributes.BOLD)
    const clipText = (x: number, y: number, s: string, fg: RGBA, attr = 0) => {
      const max = bx + bw - 2 - x
      if (max <= 0 || y >= by + bh - 1) return
      this.text(buf, x, y, Array.from(s).slice(0, max).join(""), fg, bg, attr)
    }
    lines.forEach(([k, desc], i) => {
      const y = by + 2 + i
      if (k === "") { clipText(bx + 3, y, desc, C.accent, TextAttributes.BOLD); return }
      clipText(bx + 3, y, k.padStart(8), C.keyFg, TextAttributes.BOLD)
      clipText(bx + 14, y, desc, C.white)
    })
    const foot = " press ? or esc to close "
    if (bw > foot.length + 2) this.text(buf, bx + Math.floor((bw - foot.length) / 2), by + bh - 1, foot, C.barDim, bg)
  }
}

// ───────────────────────────── Boot ─────────────────────────────

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  enableMouseMovement: true,
  backgroundColor: "#15171F",
})

const app = new DrawApp(renderer)
app.onMouse = (e) => {
  try { app.handleMouse(e) } catch { /* never crash on input */ }
}
renderer.root.add(app)

let quitting = false
function quit() {
  if (quitting) return
  quitting = true
  try { renderer.destroy() } catch { /* ignore */ }
  process.exit(0)
}

renderer.keyInput.on("keypress", (k: KeyEvent) => {
  try { app.handleKey(k) } catch { /* never crash on input */ }
})
renderer.on("resize", () => app.requestRender())
process.on("SIGTERM", quit)
process.on("SIGINT", quit)
