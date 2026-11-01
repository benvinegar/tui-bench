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

    /home/user/terminal-ui-bench/bin/tuibench preview . --task system-dashboard --stack opentui --steps '[{press: "j j enter"}, {snapshot: after}, {type: "hi"}, {resize: {cols: 80, rows: 24}}]'

Steps: {press: "<keys>"}, {type: "<text>"}, {wait: <ms>}, {resize: {cols, rows}}, {snapshot: <name>}. A screenshot is
always taken at the end. Key names: Single characters (j, G, /, ?), named keys (enter, tab, shift+tab, esc, backspace, space, up, down, left, right, home, end, pageup, pagedown, delete, f1-f12, shift+<arrow>, ctrl+<arrow>), and ctrl+<letter> / alt+<key> combos.

# System monitor dashboard

Build a system monitor dashboard in the spirit of htop or btop. It replays recorded metrics instead of reading
the real system, so it renders the same way every time.

## Data
`data/metrics.json` contains:
- `host`, `kernel`, `uptime` (strings), `cores` (number), `intervalMs` (number, 100)
- `samples`: 60 samples, each with `cpu` (array of per-core usage percentages), `mem` and `swap`
  (`usedGiB`, `totalGiB`), `net` (`rxKiBps`, `txKiBps`) and `load` (1, 5 and 15 minute load averages)
- `processes`: objects with `pid`, `name`, `user`, `cpu` (%), `mem` (%), `threads`, `state`, `started`, `command`

## Playback
Start at sample 0 and advance to the next sample every `intervalMs` milliseconds. After the last sample, stop
advancing and keep showing it, with a visible indication that the replay has finished. `p` pauses and resumes.

## Panels
- A header with the host name, kernel, uptime and the playback position (e.g. `sample 60/60`).
- **CPU**: per-core usage (bars or gauges with percentages) and the overall average.
- **CPU history**: a chart of the average CPU usage over the samples played so far.
- **Memory**: gauges for memory and swap with used/total values.
- **Network**: a chart of receive and transmit rates over time, with the current values.
- **Load average**: the three current values.
- **Processes**: a table with columns PID, NAME, USER, CPU%, MEM% and STATE, sorted by CPU% descending by default,
  with the sort column indicated in its header. One row is selected.

Use color purposefully (e.g. usage thresholds) and make the layout feel like a polished dashboard.

## Keys
| Key | Action |
|---|---|
| `j` / `↓`, `k` / `↑` | Move the selection in the process table |
| `s` | Cycle the sort column: CPU% → MEM% → PID → NAME → CPU%. Numbers sort descending, PID and NAME ascending. |
| `enter` | Open a detail popup for the selected process showing all its fields; `esc` closes it |
| `p` | Pause / resume playback |
| `q` | Quit |

The layout must adapt to the terminal size and redraw correctly when the terminal is resized.
