import { BoxRenderable, StyledText, TextRenderable, bg, bold, createCliRenderer, fg, strikethrough, t, type KeyEvent } from "@opentui/core"

type Todo = { id: number; title: string; done: boolean; priority: "high" | "medium" | "low"; tags: string[] }
type Filter = "all" | "active" | "done"
type Mode = { kind: "normal" } | { kind: "adding"; text: string } | { kind: "confirm"; index: number } | { kind: "help" }

const ACCENT = "#7aa2f7"
const MUTED = "#6e768c"
const RED = "#f7768e"
const GREEN = "#9ece6a"
const PRIORITY = { high: ["▲ high", RED], medium: ["● med ", "#e0af68"], low: ["▼ low ", "#73daca"] } as const

const todos: Todo[] = JSON.parse(await Bun.file("data/todos.json").text())
let filter: Filter = "all"
let selected = 0
let mode: Mode = { kind: "normal" }

const renderer = await createCliRenderer({ exitOnCtrlC: true })

const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" })
const header = new TextRenderable(renderer, { content: "", height: 1 })
const tabs = new TextRenderable(renderer, { content: "", height: 1, marginTop: 1 })
const listBox = new BoxRenderable(renderer, {
  flexGrow: 1,
  border: true,
  borderStyle: "rounded",
  borderColor: MUTED,
  flexDirection: "column",
  paddingX: 1,
})
const footer = new TextRenderable(renderer, { content: "", height: 1 })
const overlay = new BoxRenderable(renderer, {
  position: "absolute",
  border: true,
  borderStyle: "rounded",
  borderColor: ACCENT,
  backgroundColor: "#1a1b26",
  paddingX: 1,
  flexDirection: "column",
  zIndex: 10,
  visible: false,
})
root.add(header)
root.add(tabs)
root.add(listBox)
root.add(footer)
renderer.root.add(root)
renderer.root.add(overlay)

const visible = () => todos.map((_, i) => i).filter((i) => (filter === "all" ? true : filter === "done" ? todos[i]!.done : !todos[i]!.done))
const clampSelection = () => {
  const n = visible().length
  selected = n === 0 ? 0 : Math.min(selected, n - 1)
}

function truncate(s: string, w: number) {
  return s.length <= w ? s.padEnd(w) : s.slice(0, Math.max(0, w - 1)) + "…"
}

function clearChildren(box: BoxRenderable) {
  for (const c of box.getChildren()) {
    box.remove(c)
    c.destroyRecursively()
  }
}

function render() {
  const active = todos.filter((x) => !x.done).length
  header.content = t`${bold(bg(ACCENT)(fg("#1a1b26")(" ✓ Todos ")))}  ${fg("#ffffff")(`${active} active`)}${fg(MUTED)("  ·  ")}${fg(MUTED)(`${todos.length - active} done`)}`
  const tab = (key: string, label: string, f: Filter) =>
    f === filter ? bold(fg(ACCENT)(` ${key} ${label} `)) : fg(MUTED)(` ${key} ${label} `)
  tabs.content = t`${tab("1", "All", "all")}${fg(MUTED)("│")}${tab("2", "Active", "active")}${fg(MUTED)("│")}${tab("3", "Done", "done")}`

  clearChildren(listBox)
  const rows = visible()
  const width = Math.max(10, renderer.width - 4)
  if (rows.length === 0) {
    const msg = filter === "done" ? "Nothing completed yet — press space on a todo to finish it." : filter === "active" ? "All done! Press a to add something new." : "No todos. Press a to add one."
    listBox.add(new TextRenderable(renderer, { content: t`${fg(MUTED)(msg)}`, marginTop: Math.max(0, Math.floor((renderer.height - 8) / 2)), alignSelf: "center" }))
  }
  const listHeight = Math.max(1, renderer.height - 6)
  const offset = Math.max(0, Math.min(selected - listHeight + 1, rows.length - listHeight))
  rows.slice(offset, offset + listHeight).forEach((i, n) => {
    const todo = todos[i]!
    const isSel = n + offset === selected
    const tags = todo.tags.map((g) => `#${g}`).join(" ")
    const [plabel, pcolor] = PRIORITY[todo.priority]
    const titleW = Math.max(4, width - 3 - 8 - tags.length - 1)
    const title = truncate(todo.title, titleW)
    const row = new BoxRenderable(renderer, { height: 1, flexDirection: "row", backgroundColor: isSel ? "#292e42" : "transparent" })
    row.add(
      new TextRenderable(renderer, {
        content: t`${todo.done ? fg(GREEN)(" ✔ ") : fg(MUTED)(" ○ ")}${todo.done ? strikethrough(fg(MUTED)(title)) : isSel ? bold(fg("#ffffff")(title)) : fg("#c0caf5")(title)} ${fg(pcolor)(plabel)} ${fg("#bb9af7")(tags)}`,
      }),
    )
    listBox.add(row)
  })

  const hints: [string, string][] = [["j/k", "move"], ["space", "toggle"], ["a", "add"], ["d", "delete"], ["1-3", "filter"], ["?", "help"], ["q", "quit"]]
  footer.content = new StyledText(hints.flatMap(([k, v]) => [bold(fg(ACCENT)(` ${k} `)), fg(MUTED)(`${v}  `)]))

  clearChildren(overlay)
  overlay.visible = mode.kind !== "normal"
  const place = (w: number, h: number) => {
    overlay.width = Math.min(w, renderer.width)
    overlay.height = h
    overlay.left = Math.max(0, Math.floor((renderer.width - w) / 2))
    overlay.top = Math.max(0, Math.floor((renderer.height - h) / 2))
  }
  if (mode.kind === "adding") {
    place(56, 5)
    overlay.borderColor = ACCENT
    overlay.title = " New todo "
    overlay.add(new TextRenderable(renderer, { content: t`${fg(ACCENT)("› ")}${mode.text}${fg(ACCENT)("▏")}`, marginTop: 1 }))
  } else if (mode.kind === "confirm") {
    place(50, 6)
    overlay.borderColor = RED
    overlay.title = " Delete todo? "
    overlay.add(new TextRenderable(renderer, { content: t`${bold(`“${todos[mode.index]!.title}”`)}` }))
    overlay.add(new TextRenderable(renderer, { content: t`${bold(fg(RED)(" y "))} delete   ${fg(MUTED)("any other key")} cancel`, marginTop: 1 }))
  } else if (mode.kind === "help") {
    const keys: [string, string][] = [["j / ↓", "move down"], ["k / ↑", "move up"], ["space", "toggle done"], ["a", "add a todo"], ["d", "delete (asks first)"], ["1 2 3", "all / active / done"], ["?", "toggle this help"], ["q", "quit"]]
    place(44, keys.length + 4)
    overlay.borderColor = ACCENT
    overlay.title = " Keys "
    for (const [k, v] of keys) overlay.add(new TextRenderable(renderer, { content: t`${bold(fg(ACCENT)(k.padStart(8)))}  ${v}` }))
    overlay.add(new TextRenderable(renderer, { content: t`${fg(MUTED)("? or esc to close")}`, marginTop: 1 }))
  }
  renderer.requestRender()
}

function quit() {
  renderer.destroy()
  process.exit(0)
}

function onKey(key: KeyEvent) {
  if (mode.kind === "adding") {
    if (key.name === "return" || key.name === "enter") {
      const title = mode.text.trim()
      if (title) {
        todos.push({ id: Math.max(0, ...todos.map((x) => x.id)) + 1, title, done: false, priority: "medium", tags: [] })
        if (filter !== "done") selected = visible().length - 1
      }
      mode = { kind: "normal" }
    } else if (key.name === "escape") mode = { kind: "normal" }
    else if (key.name === "backspace") mode.text = mode.text.slice(0, -1)
    else if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl) mode.text += key.sequence
    return render()
  }
  if (mode.kind === "confirm") {
    if (key.name === "y") todos.splice(mode.index, 1)
    mode = { kind: "normal" }
    clampSelection()
    return render()
  }
  if (mode.kind === "help") {
    if (key.sequence === "?" || key.name === "escape") mode = { kind: "normal" }
    return render()
  }
  const rows = visible()
  switch (key.sequence === "?" ? "?" : key.name) {
    case "q": return quit()
    case "j": case "down": selected = Math.min(selected + 1, Math.max(0, rows.length - 1)); break
    case "k": case "up": selected = Math.max(0, selected - 1); break
    case "space": if (rows[selected] !== undefined) { todos[rows[selected]!]!.done = !todos[rows[selected]!]!.done; clampSelection() } break
    case "a": mode = { kind: "adding", text: "" }; break
    case "d": if (rows[selected] !== undefined) mode = { kind: "confirm", index: rows[selected]! }; break
    case "1": filter = "all"; selected = 0; break
    case "2": filter = "active"; selected = 0; break
    case "3": filter = "done"; selected = 0; break
    case "?": mode = { kind: "help" }; break
  }
  render()
}

renderer.keyInput.on("keypress", onKey)
renderer.on("resize", render)
render()
