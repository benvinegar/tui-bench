// Entry point: a text-mode desktop with overlapping windows, driven by mouse and keyboard.
// The whole screen is painted by paint.ts into the renderer's buffer; this file wires input to state.

import { BoxRenderable, createCliRenderer, type KeyEvent, type MouseEvent } from "@opentui/core"
import {
  MENUS,
  aboutOkRect,
  cascade,
  closeWin,
  clamp,
  contentRect,
  cycleNext,
  dropdownRect,
  focused,
  hitTest,
  inRect,
  menuAt,
  moveTo,
  raise,
  refit,
  resizeTo,
  setScreen,
  shell,
  taskbarItems,
  tile,
  toggleMax,
  type Win,
} from "./desk"
import {
  calcKey,
  calcLayout,
  calcPress,
  calcTokenForLabel,
  filesKey,
  filesScroll,
  files,
  loadData,
  notes,
  notesKey,
} from "./apps"
import { paint } from "./paint"

loadData()

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: false, // button-motion tracking, so drags are reported
})

shell.wins = [
  { id: "notes", title: "Notes", rect: { x: 4, y: 3, w: 44, h: 16 }, restore: null },
  { id: "calc", title: "Calculator", rect: { x: 72, y: 4, w: 28, h: 17 }, restore: null },
  { id: "files", title: "Files", rect: { x: 8, y: 14, w: 56, h: 14 }, restore: null },
]
setScreen(renderer.width, renderer.height)
refit()

const redraw = () => renderer.requestRender()

function quit(): void {
  renderer.destroy()
  process.exit(0)
}

function endDrag(): void {
  shell.drag = null
  redraw()
}

function contentClick(win: Win, mx: number, my: number): void {
  const c = contentRect(win.rect)
  if (!inRect(mx, my, c)) return
  if (win.id === "calc") {
    const key = calcLayout(c).keys.find((k) => inRect(mx, my, k))
    if (key) calcPress(calcTokenForLabel(key.label))
  } else if (win.id === "files") {
    if (my < c.y + 2) return
    const idx = files.top + (my - (c.y + 2))
    if (idx < files.entries.length) files.sel = idx
  } else if (win.id === "notes") {
    const vx = c.x + 1
    if (mx < vx) return
    notes.row = clamp(notes.top + (my - c.y), 0, notes.lines.length - 1)
    notes.col = clamp(notes.left + (mx - vx), 0, notes.lines[notes.row].length)
  }
}

function runAction(action: string): void {
  switch (action) {
    case "zoom": {
      const f = focused()
      if (f) toggleMax(f)
      break
    }
    case "close": {
      const f = focused()
      if (f) closeWin(f)
      break
    }
    case "quit":
      quit()
      break
    case "next":
      cycleNext()
      break
    case "tile":
      tile()
      break
    case "cascade":
      cascade()
      break
    case "about":
      shell.about = true
      break
  }
}

function runMenuItem(menu: number, item: number): void {
  const action = MENUS[menu].items[item]?.action
  shell.menu = null
  if (action) runAction(action)
}

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return
  const mx = e.x
  const my = e.y

  if (shell.about) {
    if (inRect(mx, my, aboutOkRect())) shell.about = false
    return redraw()
  }

  if (shell.menu !== null) {
    const dr = dropdownRect(shell.menu)
    if (inRect(mx, my, dr)) {
      const j = my - dr.y - 1
      if (j >= 0 && j < MENUS[shell.menu].items.length) runMenuItem(shell.menu, j)
      return redraw()
    }
    shell.menu = null
  }

  if (my === 0) {
    const idx = menuAt(mx)
    if (idx !== null) {
      shell.menu = idx
      shell.menuItem = 0
    }
    return redraw()
  }

  if (my === shell.rows - 1) {
    const slot = taskbarItems().find((s) => mx >= s.x && mx < s.x + s.w)
    if (slot) raise(slot.win)
    return redraw()
  }

  const hit = hitTest(mx, my)
  if (!hit) return redraw()
  const win = hit.win
  switch (hit.kind) {
    case "close":
      closeWin(win)
      break
    case "max":
      raise(win)
      toggleMax(win)
      break
    case "title": {
      raise(win)
      const now = Date.now()
      const last = shell.lastTitle
      if (last && last.id === win.id && now - last.t < 500) {
        toggleMax(win)
        shell.lastTitle = null
      } else {
        shell.lastTitle = { id: win.id, t: now }
        if (!win.restore) shell.drag = { kind: "move", win, sx: mx, sy: my, r0: { ...win.rect } }
      }
      break
    }
    case "resize":
      raise(win)
      if (!win.restore) shell.drag = { kind: "resize", win, sx: mx, sy: my, r0: { ...win.rect } }
      break
    case "body":
      raise(win)
      contentClick(win, mx, my)
      break
  }
  redraw()
}

function onMouseDrag(e: MouseEvent): void {
  const d = shell.drag
  if (!d) return
  const dx = e.x - d.sx
  const dy = e.y - d.sy
  if (d.kind === "move") moveTo(d.win, d.r0, dx, dy)
  else resizeTo(d.win, d.r0, dx, dy)
  redraw()
}

function onMouseScroll(e: MouseEvent): void {
  const dir = e.scroll?.direction
  const hit = hitTest(e.x, e.y)
  if (hit && hit.win.id === "files") {
    if (dir === "up") filesScroll(-3)
    else if (dir === "down") filesScroll(3)
  }
  redraw()
}

function menuKey(key: KeyEvent): void {
  const m = shell.menu
  if (m === null) return
  const n = MENUS.length
  const items = MENUS[m].items
  switch (key.name) {
    case "left":
      shell.menu = (m + n - 1) % n
      shell.menuItem = 0
      break
    case "right":
      shell.menu = (m + 1) % n
      shell.menuItem = 0
      break
    case "up":
      shell.menuItem = (shell.menuItem + items.length - 1) % items.length
      break
    case "down":
      shell.menuItem = (shell.menuItem + 1) % items.length
      break
    case "return":
      runMenuItem(m, shell.menuItem)
      break
    case "escape":
      shell.menu = null
      break
  }
}

function onKey(key: KeyEvent): void {
  if (key.ctrl && key.name === "q") return quit()

  if (shell.about) {
    if (key.name === "return" || key.name === "escape" || key.name === "space") shell.about = false
    return redraw()
  }

  if (key.name === "f10") {
    shell.menu = shell.menu === null ? 0 : null
    shell.menuItem = 0
    return redraw()
  }

  if (shell.menu !== null) {
    menuKey(key)
    return redraw()
  }

  const f = focused()
  if (key.name === "f5") {
    if (f) toggleMax(f)
  } else if (key.name === "f6") {
    cycleNext()
  } else if (key.ctrl && key.name === "w") {
    if (f) closeWin(f)
  } else if (f) {
    switch (f.id) {
      case "notes":
        notesKey(key)
        break
      case "calc":
        calcKey(key)
        break
      case "files":
        filesKey(key)
        break
    }
  }
  redraw()
}

const desktop = new BoxRenderable(renderer, {
  id: "desktop",
  width: "100%",
  height: "100%",
  renderBefore(buffer) {
    paint(buffer)
  },
  onMouseDown,
  onMouseDrag,
  onMouseUp: endDrag,
  onMouseDragEnd: endDrag,
  onMouseScroll,
})
renderer.root.add(desktop)

renderer.keyInput.on("keypress", onKey)
renderer.on("resize", (cols: number, rows: number) => {
  setScreen(cols, rows)
  redraw()
})
