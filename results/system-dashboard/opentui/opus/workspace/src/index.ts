import { Renderable, createCliRenderer, type KeyEvent, type OptimizedBuffer, type RenderContext } from "@opentui/core"
import { loadMetrics } from "./data.ts"
import { AppState } from "./state.ts"
import { draw } from "./ui.ts"

const metrics = loadMetrics("data/metrics.json")
const state = new AppState(metrics)

class Dashboard extends Renderable {
  constructor(ctx: RenderContext) {
    super(ctx, { id: "dashboard", width: "100%", height: "100%" })
  }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    try {
      draw(buffer, state)
    } catch {
      // never crash the UI on a draw error
    }
  }
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: false,
  backgroundColor: "#0f111a",
})

const dash = new Dashboard(renderer)
renderer.root.add(dash)

const refresh = () => dash.requestRender()

let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
  if (state.tick()) refresh()
  if (state.finished && timer) {
    clearInterval(timer)
    timer = null
    refresh()
  }
}, metrics.intervalMs)

let quitting = false
async function quit() {
  if (quitting) return
  quitting = true
  if (timer) clearInterval(timer)
  try {
    renderer.destroy()
    await renderer.closed
  } catch {
    // ignore
  }
  process.exit(0)
}

renderer.on("resize", refresh)

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  const name = key.name
  if (name === "q" || (key.ctrl && name === "c")) {
    void quit()
    return
  }
  if (name === "p") {
    state.togglePause()
    refresh()
    return
  }
  if (state.detailOpen) {
    if (name === "escape" || name === "return" || name === "enter") {
      state.detailOpen = false
      refresh()
    }
    return
  }
  switch (name) {
    case "j":
    case "down":
      state.move(1)
      break
    case "k":
    case "up":
      state.move(-1)
      break
    case "pagedown":
      state.move(10)
      break
    case "pageup":
      state.move(-10)
      break
    case "home":
    case "g":
      state.moveTo(key.shift ? state.sorted.length - 1 : 0)
      break
    case "end":
      state.moveTo(state.sorted.length - 1)
      break
    case "s":
      state.cycleSort()
      break
    case "return":
    case "enter":
    case "linefeed":
      if (state.selectedProc) state.detailOpen = true
      break
    default:
      return
  }
  refresh()
})

process.on("SIGTERM", () => void quit())
process.on("SIGINT", () => void quit())

refresh()
