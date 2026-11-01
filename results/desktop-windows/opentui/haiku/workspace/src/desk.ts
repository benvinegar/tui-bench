// Desktop shell state: window stack, focus, geometry (move, resize, maximize, tile, cascade),
// menu definitions and hit testing. Painting lives in paint.ts; input wiring in index.ts.

export type WinId = "notes" | "calc" | "files"

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Win {
  id: WinId
  title: string
  rect: Rect
  // Geometry to return to when un-maximized; null when the window is not maximized.
  restore: Rect | null
}

export interface Drag {
  kind: "move" | "resize"
  win: Win
  sx: number
  sy: number
  r0: Rect
}

export interface MenuItem {
  text: string
  key?: string
  action: string
}

export interface Menu {
  label: string
  items: MenuItem[]
}

export const MENUS: Menu[] = [
  {
    label: "≡",
    items: [
      { text: "Zoom", key: "F5", action: "zoom" },
      { text: "Close", key: "ctrl+w", action: "close" },
    ],
  },
  { label: "File", items: [{ text: "Quit", key: "ctrl+q", action: "quit" }] },
  {
    label: "Window",
    items: [
      { text: "Tile", action: "tile" },
      { text: "Cascade", action: "cascade" },
      { text: "Next", key: "F6", action: "next" },
      { text: "Zoom", key: "F5", action: "zoom" },
      { text: "Close", key: "ctrl+w", action: "close" },
    ],
  },
  { label: "Help", items: [{ text: "About", action: "about" }] },
]

export const MIN_W = 20
export const MIN_H = 7
export const CLOCK = "10:42"

export const shell = {
  cols: 120,
  rows: 36,
  wins: [] as Win[], // bottom -> top; the last entry is the focused window
  menu: null as number | null,
  menuItem: 0,
  about: false,
  drag: null as Drag | null,
  lastTitle: null as { id: WinId; t: number } | null,
}

export function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(Math.max(v, lo), hi)
}

// Desktop rows are 1 .. deskH() inclusive (row 0 is the menu bar, the last row the taskbar).
export function deskH(): number {
  return Math.max(1, shell.rows - 2)
}

export function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

export function focused(): Win | undefined {
  return shell.wins[shell.wins.length - 1]
}

export function raise(win: Win): void {
  const i = shell.wins.indexOf(win)
  if (i >= 0 && i !== shell.wins.length - 1) {
    shell.wins.splice(i, 1)
    shell.wins.push(win)
  }
}

export function closeWin(win: Win): void {
  const i = shell.wins.indexOf(win)
  if (i >= 0) shell.wins.splice(i, 1)
  if (shell.drag?.win === win) shell.drag = null
}

// F6: the bottom window comes to the top and takes focus.
export function cycleNext(): void {
  const bottom = shell.wins.shift()
  if (bottom) shell.wins.push(bottom)
}

function maxRect(): Rect {
  return { x: 0, y: 1, w: shell.cols, h: deskH() }
}

// Keeps a rectangle fully on screen; it shrinks only when it cannot fit.
export function fit(r: Rect): Rect {
  const cols = Math.max(1, shell.cols)
  const h = Math.max(1, Math.min(r.h, deskH()))
  const w = Math.max(1, Math.min(r.w, cols))
  return {
    x: clamp(r.x, 0, cols - w),
    y: clamp(r.y, 1, 1 + deskH() - h),
    w,
    h,
  }
}

export function refit(): void {
  for (const win of shell.wins) {
    if (win.restore) {
      win.restore = fit(win.restore)
      win.rect = maxRect()
    } else {
      win.rect = fit(win.rect)
    }
  }
}

export function setScreen(cols: number, rows: number): void {
  if (cols === shell.cols && rows === shell.rows) return
  shell.cols = cols
  shell.rows = rows
  refit()
}

export function toggleMax(win: Win): void {
  if (win.restore) {
    win.rect = fit(win.restore)
    win.restore = null
  } else {
    win.restore = { ...win.rect }
    win.rect = maxRect()
  }
}

export function moveTo(win: Win, r0: Rect, dx: number, dy: number): void {
  // The title bar must stay at least partly on the desktop.
  const x = clamp(r0.x + dx, 4 - r0.w, shell.cols - 4)
  const y = clamp(r0.y + dy, 1, deskH())
  win.rect = { x, y, w: r0.w, h: r0.h }
}

export function resizeTo(win: Win, r0: Rect, dx: number, dy: number): void {
  const w = clamp(r0.w + dx, MIN_W, Math.max(MIN_W, shell.cols - r0.x))
  const h = clamp(r0.h + dy, MIN_H, Math.max(MIN_H, deskH() - r0.y + 1))
  win.rect = { x: r0.x, y: r0.y, w, h }
}

export function tile(): void {
  const n = shell.wins.length
  if (n === 0) return
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const W = shell.cols
  const H = deskH()
  const cw = Math.floor(W / cols)
  const ch = Math.floor(H / rows)
  shell.wins.forEach((win, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = col * cw
    const y = 1 + row * ch
    const w = col === cols - 1 ? W - x : cw
    const h = row === rows - 1 ? H - row * ch : ch
    win.restore = null
    win.rect = fit({ x, y, w, h })
  })
}

export function cascade(): void {
  const W = shell.cols
  const H = deskH()
  const w = Math.max(MIN_W, Math.floor(W * 0.6))
  const h = Math.max(MIN_H, Math.floor(H * 0.75))
  shell.wins.forEach((win, i) => {
    win.restore = null
    win.rect = fit({ x: i * 3, y: 1 + i * 2, w, h })
  })
}

export type HitKind = "close" | "max" | "title" | "resize" | "body"

export interface Hit {
  kind: HitKind
  win: Win
}

// Topmost window whose frame contains the cell; shadows are not part of the window.
export function hitTest(mx: number, my: number): Hit | null {
  if (my < 1 || my > deskH()) return null
  for (let i = shell.wins.length - 1; i >= 0; i--) {
    const win = shell.wins[i]
    const { x, y, w, h } = win.rect
    if (!inRect(mx, my, win.rect)) continue
    const lx = mx - x
    const ly = my - y
    if (ly === 0) {
      if (lx >= 1 && lx <= 3) return { kind: "close", win }
      if (lx >= w - 4 && lx <= w - 2) return { kind: "max", win }
      return { kind: "title", win }
    }
    if (lx === w - 1 && ly === h - 1) return { kind: "resize", win }
    return { kind: "body", win }
  }
  return null
}

export interface MenuSlot {
  index: number
  x: number
  w: number
}

// Menu labels on row 0; each label has one blank cell of padding on either side.
export function menuBarItems(): MenuSlot[] {
  const out: MenuSlot[] = []
  let x = 1
  MENUS.forEach((m, index) => {
    out.push({ index, x, w: m.label.length })
    x += m.label.length + 2
  })
  return out
}

export function menuAt(mx: number): number | null {
  const hit = menuBarItems().find((it) => mx >= it.x - 1 && mx <= it.x + it.w)
  return hit ? hit.index : null
}

export function dropdownRect(index: number): Rect {
  const menu = MENUS[index]
  const slot = menuBarItems()[index]
  const inner = Math.max(...menu.items.map((it) => it.text.length + (it.key ? it.key.length + 3 : 0)))
  const w = inner + 4
  const h = menu.items.length + 2
  const x = clamp(slot.x - 1, 0, shell.cols - w)
  return { x, y: 1, w, h }
}

export interface TaskSlot {
  win: Win
  x: number
  w: number
  label: string
}

export function taskbarItems(): TaskSlot[] {
  let x = 1
  const out: TaskSlot[] = []
  for (const win of shell.wins) {
    const label = ` ${win.title} `
    if (x + label.length > shell.cols) break
    out.push({ win, x, w: label.length, label })
    x += label.length + 1
  }
  return out
}

export function aboutRect(): Rect {
  const w = 46
  const h = 9
  return {
    x: Math.max(0, Math.floor((shell.cols - w) / 2)),
    y: 1 + Math.max(0, Math.floor((deskH() - h) / 2)),
    w,
    h,
  }
}

export function aboutOkRect(): Rect {
  const r = aboutRect()
  const w = 8
  return { x: r.x + Math.floor((r.w - w) / 2), y: r.y + r.h - 2, w, h: 1 }
}

export function contentRect(r: Rect): Rect {
  return { x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }
}
