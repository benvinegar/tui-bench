// Pure document model for the diagram editor: shapes, their geometry and hit testing.
// Objects are immutable records; every change builds a new record and a new array,
// so undo/redo can keep whole snapshots of the object list.

export type Tool = "select" | "box" | "arrow" | "text" | "pen"

export const TOOLS: ReadonlyArray<{ tool: Tool; key: string; label: string }> = [
  { tool: "select", key: "v", label: "Select" },
  { tool: "box", key: "b", label: "Box" },
  { tool: "arrow", key: "a", label: "Arrow" },
  { tool: "text", key: "t", label: "Text" },
  { tool: "pen", key: "p", label: "Pen" },
]

export const PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "white", hex: "#E6EDF3" },
  { name: "red", hex: "#FF6B63" },
  { name: "yellow", hex: "#F2CC60" },
  { name: "green", hex: "#7EE787" },
  { name: "cyan", hex: "#56D4DD" },
  { name: "magenta", hex: "#FF7AD9" },
]

export type ObjKind = "box" | "arrow" | "text" | "pen"

export const KIND_LABEL: Record<ObjKind, string> = {
  box: "Box",
  arrow: "Arrow",
  text: "Text",
  pen: "Pen",
}

export interface Pt {
  x: number
  y: number
}

export interface AbsCell extends Pt {
  ch: string
}

export interface Cell {
  readonly dx: number
  readonly dy: number
  readonly ch: string
}

export interface Obj {
  readonly id: number
  readonly kind: ObjKind
  /** Top-left corner of the bounds, in canvas (= screen) coordinates. */
  readonly x: number
  readonly y: number
  /** Bounds size. */
  readonly w: number
  readonly h: number
  /** Drawn cells, relative to (x, y). */
  readonly cells: readonly Cell[]
  /** Index into PALETTE. */
  readonly color: number
}

/** Builds an object from absolute cells, normalising its origin to the top-left of the bounds. */
export function buildObject(id: number, kind: ObjKind, color: number, abs: readonly AbsCell[]): Obj | null {
  if (abs.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of abs) {
    if (c.x < minX) minX = c.x
    if (c.y < minY) minY = c.y
    if (c.x > maxX) maxX = c.x
    if (c.y > maxY) maxY = c.y
  }
  return {
    id,
    kind,
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    cells: abs.map((c) => ({ dx: c.x - minX, dy: c.y - minY, ch: c.ch })),
    color,
  }
}

/** Border of the rectangle spanned by two opposite corners (inclusive). */
export function boxCells(x0: number, y0: number, x1: number, y1: number): AbsCell[] {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const w = right - left + 1
  const h = bottom - top + 1
  const out: AbsCell[] = []
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const isTop = y === top
      const isBottom = y === bottom
      const isLeft = x === left
      const isRight = x === right
      let ch: string | null = null
      if (w === 1 && h === 1) ch = "┼"
      else if (w === 1) ch = "│"
      else if (h === 1) ch = "─"
      else if (isTop && isLeft) ch = "┌"
      else if (isTop && isRight) ch = "┐"
      else if (isBottom && isLeft) ch = "└"
      else if (isBottom && isRight) ch = "┘"
      else if (isTop || isBottom) ch = "─"
      else if (isLeft || isRight) ch = "│"
      if (ch) out.push({ x, y, ch })
    }
  }
  return out
}

function corner(fromWest: boolean, toSouth: boolean): string {
  if (fromWest) return toSouth ? "┐" : "┘"
  return toSouth ? "┌" : "└"
}

/**
 * Straight line for horizontal or vertical drags, otherwise an elbow that runs
 * horizontally from the start and then vertically into the end. The end cell
 * carries an arrowhead pointing in the direction of travel.
 */
export function arrowCells(sx: number, sy: number, ex: number, ey: number): AbsCell[] | null {
  if (sx === ex && sy === ey) return null
  const out: AbsCell[] = []
  const push = (x: number, y: number, ch: string) => out.push({ x, y, ch })
  if (sy === ey) {
    const d = ex > sx ? 1 : -1
    for (let x = sx; x !== ex; x += d) push(x, sy, "─")
    push(ex, ey, d > 0 ? "▶" : "◀")
  } else if (sx === ex) {
    const d = ey > sy ? 1 : -1
    for (let y = sy; y !== ey; y += d) push(sx, y, "│")
    push(ex, ey, d > 0 ? "▼" : "▲")
  } else {
    const hd = ex > sx ? 1 : -1
    const vd = ey > sy ? 1 : -1
    for (let x = sx; x !== ex; x += hd) push(x, sy, "─")
    push(ex, sy, corner(hd > 0, vd > 0))
    for (let y = sy + vd; y !== ey; y += vd) push(ex, y, "│")
    push(ex, ey, vd > 0 ? "▼" : "▲")
  }
  return out
}

export function textCells(x: number, y: number, text: string): AbsCell[] {
  return Array.from(text).map((ch, i) => ({ x: x + i, y, ch }))
}

/** Bresenham line, both ends included. */
export function lineBetween(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = []
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0
  let y = y0
  for (;;) {
    pts.push({ x, y })
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
  return pts
}

export function containsPoint(o: Obj, x: number, y: number): boolean {
  const rx = x - o.x
  const ry = y - o.y
  if (rx < 0 || ry < 0 || rx >= o.w || ry >= o.h) return false
  return o.cells.some((c) => c.dx === rx && c.dy === ry)
}

/** Topmost object (last in creation order) with a drawn cell at the point. */
export function hitTest(objs: readonly Obj[], x: number, y: number): Obj | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    if (containsPoint(objs[i]!, x, y)) return objs[i]
  }
  return undefined
}

/** True when the inner object's bounds lie entirely inside the outer object's bounds. */
export function boundsInside(inner: Obj, outer: Obj): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w - 1 <= outer.x + outer.w - 1 &&
    inner.y + inner.h - 1 <= outer.y + outer.h - 1
  )
}
