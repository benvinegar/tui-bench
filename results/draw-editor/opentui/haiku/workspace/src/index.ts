import { createCliRenderer } from "@opentui/core"
import { App } from "./app.ts"

// Button-motion tracking (1002): drags are reported, plain hover movement is not.
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: false,
})

const app = new App(renderer, () => {
  renderer.destroy()
  process.exit(0)
})
renderer.root.add(app)

renderer.keyInput.on("keypress", (key) => {
  app.handleKey(key)
})
