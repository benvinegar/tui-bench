You are building a terminal user interface (TUI) application. Your work is part of a benchmark: after you finish,
the app is built from the workspace, launched in a 110x34 terminal (xterm-256color, truecolor), driven
by a scripted sequence of key presses taken from the specification, and screenshots of it are compared side by side by
human judges against apps built by other developers. Judges look at visual design and polish, layout, correctness against
the specification, responsiveness to terminal resizes, and that the app never crashes.

## Stack: Rust + ratatui

- This is a Rust (edition 2024) binary crate named `app` at the workspace root. The entry point is `src/main.rs`.
- `Cargo.toml` already depends on `ratatui = "0.30"`, `crossterm = "0.29"`, `serde` and `serde_json`. You may add other crates from crates.io by editing `Cargo.toml`.
- It is built with `cargo build --release` and the binary is run with the workspace root as its working directory.
- The `build` tool (when you have one) runs the same build and returns compiler output.

## Workspace

- The workspace already contains a minimal "hello world" app for this stack; replace it with your implementation.
- Data files the app must read are in `data/` and are read relative to the working directory (e.g. `data/todos.json`).
  Do not modify them; they are restored before evaluation.
- The app must not use the network, the clock for content (other than as the specification says), or randomness, so
  that every run renders the same way. It must exit cleanly with status 0 and restore the terminal when asked to quit.

## How you work

You are running as a coding agent inside the workspace directory. Edit files there directly.
To see your app the way the benchmark will, run it in a 110x34 pseudo-terminal with scripted
input and get plain-text screenshots back (colors and styles are not shown):

    /home/user/terminal-ui-bench/bin/tuibench preview . --task draw-editor --stack ratatui --steps '[{press: "j j enter"}, {snapshot: after}, {type: "hi"}, {resize: {cols: 80, rows: 24}}]'

Steps: {press: "<keys>"}, {type: "<text>"}, {wait: <ms>}, {resize: {cols, rows}}, {snapshot: <name>}, and mouse input
with 0-based cells: {click: {x, y, button?, count?}}, {drag: {from: {x, y}, to: {x, y}}}, {scroll: {x, y, direction}},
{hover: {x, y}}. Mouse input only reaches the app if it enabled mouse reporting. A screenshot is always taken at the end. Key names: Single characters (j, G, /, ?), named keys (enter, tab, shift+tab, esc, backspace, space, up, down, left, right, home, end, pageup, pagedown, delete, f1-f12, shift+/ctrl+/alt+<arrow>, shift+/ctrl+home/end), and ctrl+<letter> / alt+<key> combos.

# Diagram editor

Build a diagram and ASCII-art editor for the terminal, in the spirit of termDRAW: you draw boxes, arrows, text and
freehand strokes with the mouse, and every shape stays an object you can select, move, recolor and delete.

## Layout (fixed, so scripted mouse input lands on the canvas)
- **Row 0: toolbar.** Shows every tool with its shortcut key (Select `v`, Box `b`, Arrow `a`, Text `t`, Pen `p`),
  the active tool clearly highlighted, and the color palette (`1`–`6`) with the active color marked.
- **Rows 1 to height−2: the canvas**, spanning the full width with no border. The canvas is in screen coordinates:
  the mouse at screen cell (x, y) is the canvas cell (x, y). It starts empty.
- **Last row: status bar.** Shows the active tool, the last mouse position on the canvas (e.g. `x 30 y 12`), the
  number of objects, and, when an object is selected, its type and bounds (e.g. `Box 26×9 at 5,4`).

The app must enable mouse reporting with button-motion tracking, so it receives drags.

## Tools
The active tool starts as Select. Tools are switched with their shortcut keys (or by clicking them in the toolbar).
- **Box (`b`)**: drag from one corner to the opposite corner. On release, a rectangle drawn with box-drawing
  characters (`┌─┐│└┘`) occupies exactly the cells between the press and release cells, inclusive. While dragging,
  show a live preview.
- **Arrow (`a`)**: drag from start to end. A straight line is drawn when the drag is horizontal or vertical;
  otherwise an elbow connector (horizontal first, then vertical). The end cell gets an arrowhead (`▶ ◀ ▲ ▼`)
  pointing in the direction of travel.
- **Text (`t`)**: click a cell to start a text object there with a visible cursor. Typed characters appear,
  `backspace` deletes, and `enter` or `esc` finishes it. Empty text objects are discarded.
- **Pen (`p`)**: drag to paint `█` blocks on every cell the mouse passes through; one drag is one object.
- **Select (`v`)**: click any drawn cell of an object to select it; the topmost object wins. The selection is
  clearly shown (e.g. highlighted bounds or corner handles). Dragging a selected object moves it by the drag
  offset. Moving a box also moves the text objects that lie entirely inside it. Clicking empty canvas or `esc`
  clears the selection, and `delete` or `backspace` deletes the selected object.

## Other keys
| Key | Action |
|---|---|
| `1`–`6` | Choose the color for new objects: white, red, yellow, green, cyan, magenta. With an object selected, also recolor it. |
| `ctrl+z` / `ctrl+y` | Undo / redo every change (draw, move, recolor, delete) |
| `?` | Toggle a help overlay with all tools and keys |
| `ctrl+q` | Quit |

Outside text editing, other letters do nothing. Objects are drawn in creation order, so newer objects cover older ones.
If the terminal shrinks, keep all objects and show the part of the canvas that fits.
