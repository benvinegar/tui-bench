You are building a terminal user interface (TUI) application. Your work is part of a benchmark: after you finish,
the app is built from the workspace, launched in a 120x36 terminal (xterm-256color, truecolor), driven
by a scripted sequence of key presses taken from the specification, and screenshots of it are compared side by side by
human judges against apps built by other developers. Judges look at visual design and polish, layout, correctness against
the specification, responsiveness to terminal resizes, and that the app never crashes.

## Stack: TypeScript + OpenTUI (Bun)

- This is a Bun + TypeScript project at the workspace root. The entry point is `src/index.ts`.
- `package.json` already depends on `@opentui/core` 0.7.0. You may add other npm packages (for example `@opentui/react` or `@opentui/solid`) by editing `package.json`; they are installed with `bun install`.
- The type declarations of installed packages are in `node_modules`, e.g. `node_modules/@opentui/core/index.d.ts` and `node_modules/@opentui/core/renderables/*.d.ts`.
- It is run with `bun run src/index.ts` from the workspace root.
- Building means `bun install` followed by `tsc --noEmit` (the `build` tool, when you have one, runs both). Type errors don't stop the app from running, but you should fix them.

## Workspace

- The workspace already contains a minimal "hello world" app for this stack; replace it with your implementation.
- Data files the app must read are in `data/` and are read relative to the working directory (e.g. `data/todos.json`).
  Do not modify them; they are restored before evaluation.
- The app must not use the network, the clock for content (other than as the specification says), or randomness, so
  that every run renders the same way. It must exit cleanly with status 0 and restore the terminal when asked to quit.

## How you work

You are running as a coding agent inside the workspace directory. Edit files there directly.
To see your app the way the benchmark will, run it in a 120x36 pseudo-terminal with scripted
input and get plain-text screenshots back (colors and styles are not shown):

    /home/user/terminal-ui-bench/bin/tuibench preview . --task desktop-windows --stack opentui --steps '[{press: "j j enter"}, {snapshot: after}, {type: "hi"}, {resize: {cols: 80, rows: 24}}]'

Steps: {press: "<keys>"}, {type: "<text>"}, {wait: <ms>}, {resize: {cols, rows}}, {snapshot: <name>}, and mouse input
with 0-based cells: {click: {x, y, button?, count?}}, {drag: {from: {x, y}, to: {x, y}}}, {scroll: {x, y, direction}},
{hover: {x, y}}. Mouse input only reaches the app if it enabled mouse reporting. A screenshot is always taken at the end. Key names: Single characters (j, G, /, ?), named keys (enter, tab, shift+tab, esc, backspace, space, up, down, left, right, home, end, pageup, pagedown, delete, f1-f12, shift+/ctrl+/alt+<arrow>, shift+/ctrl+home/end), and ctrl+<letter> / alt+<key> combos.

# Desktop with windows

Build a text-mode desktop environment in the spirit of Turbo Vision (Borland's DOS IDEs) or Midnight Commander's
dialogs: overlapping windows on a desktop that you manage with the mouse.

## Screen
- **Row 0: menu bar** with `≡`, `File`, `Window` and `Help`, and the time `10:42` at the right (a fixed value;
  do not read the clock).
- **Last row: taskbar** listing the open windows by title, the focused one highlighted. Clicking an entry
  focuses and raises that window.
- **Rows 1 to height−2: the desktop**, filled with a subtle background pattern, holding the windows.

## Windows
Each window has a bordered frame; its top border row is the **title bar** with the title centered. The focused
window is clearly distinguished (for example a double-line frame and a brighter title); others are dimmed. A
drop shadow is welcome but is not part of the window. Geometry is in screen cells: `x`, `y` is the top-left
corner of the frame and `w`, `h` its outer size.

At startup there are three windows, listed bottom to top (Files is on top and focused):
| Title | x | y | w | h | Content |
|---|---|---|---|---|---|
| Notes | 4 | 3 | 44 | 16 | The text of `data/notes.txt`, editable when focused (typing, `enter`, `backspace`, arrows) |
| Calculator | 72 | 4 | 28 | 17 | A display and a keypad (`7 8 9 ÷`, `4 5 6 ×`, `1 2 3 −`, `0 . = +`, plus `C`). When focused, digits, `+ - * /`, `=` or `enter`, `backspace` and `c` work from the keyboard; the keypad buttons can also be clicked. |
| Files | 8 | 14 | 56 | 14 | A list of `data/files.json` with name, size (human-readable) and modified date, folders first with a folder marker; `↑`/`↓` move the selection when focused |

These parts of the frame are fixed hit targets:
- **Close button** `[×]` in the title bar at columns x+1 to x+3. Clicking it closes the window.
- **Maximize button** `[↑]` at columns x+w−4 to x+w−2. Clicking it (or double-clicking the title bar)
  maximizes the window to fill the desktop; doing it again restores the previous geometry.
- **Resize handle**: the bottom-right corner cell (x+w−1, y+h−1). Dragging it resizes the window, keeping the
  top-left corner in place (minimum 20×7).
- The rest of the title bar is the **move handle**: dragging it moves the window by the drag offset.

Clicking anywhere in a window, or starting a drag on it, focuses it and raises it to the top. Only the window under
the mouse (the topmost one at that cell) receives the click. When a window closes, the topmost remaining window
gets the focus. Windows may not move above row 1, and their title bar must stay at least partly on the desktop.

The app must enable mouse reporting with button-motion tracking, so it receives drags.

## Keys
| Key | Action |
|---|---|
| `F5` | Maximize / restore the focused window |
| `F6` | Focus and raise the next window (cycling through the windows from the bottom of the stack) |
| `ctrl+w` | Close the focused window |
| `F10` | Open the menu bar (`←`/`→`/`↑`/`↓`, `enter`, `esc`). The Window menu has Tile, Cascade, Next (F6), Zoom (F5) and Close (ctrl+w); Help has About, which shows a small modal dialog. |
| `ctrl+q` | Quit |

When the terminal is resized, move windows so they stay fully on screen when they fit, shrinking them only when
they don't.
