import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"

const renderer = await createCliRenderer({ exitOnCtrlC: true })

const box = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  border: true,
  borderStyle: "rounded",
  borderColor: "#00FFFF",
  title: " hello ",
  alignItems: "center",
  justifyContent: "center",
})
box.add(new TextRenderable(renderer, { content: "Hello, OpenTUI! Press q to quit." }))
renderer.root.add(box)

renderer.keyInput.on("keypress", (key) => {
  if (key.name === "q") {
    renderer.destroy()
    process.exit(0)
  }
})
