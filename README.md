# Terminal UI Bench

Benchmark how well LLMs build **terminal user interfaces** in **Rust + [ratatui](https://ratatui.rs)** and
**TypeScript + [OpenTUI](https://opentui.com)**, then judge the results **side by side**.

Every model gets the same task spec, the same starter project, and the same tools. Each app is then built and
launched in a real pseudo-terminal. The harness drives it with a scripted sequence of key presses and records the
exact screen (characters, truecolor, bold/dim/italic/underline/strike, cursor) at named checkpoints, plus a full
terminal recording. A local web report puts any two results next to each other, so humans can vote in a blind
arena. Votes become Bradley–Terry ratings.

```
 tasks/*.yaml ──► generate (agent loop per model × stack × task) ──► results/<task>/<stack>/<model>/workspace
                                                                         │
                       capture (build → PTY + headless xterm → scripted keys) ◄┘
                                                                         │
             snapshots.json + recording.cast ──► report (arena · compare · gallery · results · leaderboard)
                                                                         │
                                                     judgments/judgments.jsonl ──► ratings
```

## Quick start

Requirements: Node 22+, Rust (cargo), Bun ≥ 1.3.14.

```bash
npm install
./bin/tuibench doctor                 # builds both stack templates and runs them in the harness

cp models.example.yaml models.yaml    # pick the models to compare
export ANTHROPIC_API_KEY=...          # and/or OPENAI_API_KEY, OPENROUTER_API_KEY, ...

./bin/tuibench generate -t todo-app   # every configured model × both stacks, then capture
./bin/tuibench serve                  # http://127.0.0.1:4173 — judge in the Arena
./bin/tuibench leaderboard --by model
```

> ⚠️ Generated code is compiled and executed on your machine (builds, `run_app` self-tests, and capture). Run the
> benchmark in a container or VM you don't mind an LLM writing code into.

## Commands

| Command | What it does |
|---|---|
| `tuibench list` | Tasks, stacks, configured models |
| `tuibench generate [-t task] [-s stack] [-m model] [-j N] [--force]` | Run the agent for each combination, then capture. Existing results are skipped unless `--force`. |
| `tuibench capture [-t/-s/-m filters]` | Rebuild results and replay the task scenario (e.g. after editing a scenario) |
| `tuibench import <dir> -t task -s stack -m label` | Add an app built elsewhere: another agent, a human baseline, a past run |
| `tuibench show <task> <stack> <model>` | Print a result's captured screens as text |
| `tuibench check [-t/-s/-m filters] [-v]` | Evaluate the tasks' spec checks against captured results; `-v` lists failures |
| `tuibench preview <dir> -t task -s stack --steps '[{press: "j j"}]'` | Build an app and print text screenshots after scripted input; this is how CLI agents (the `command` provider) self-test |
| `tuibench serve [--host 0.0.0.0]` | Build and serve the report; votes are saved to `judgments/judgments.jsonl` |
| `tuibench report [--standalone]` | Build the report; `--standalone` makes one self-contained HTML file to share (votes then live in the browser and can be exported/imported) |
| `tuibench judgments import <file>` | Merge votes exported from a standalone report (Leaderboard → Export judgments) |
| `tuibench leaderboard [--by model\|stack\|model_stack]` | Ratings from the judgments |
| `tuibench doctor` | Toolchain check |

## Models

`models.yaml` maps an id (used in paths and reports) to a provider:

- **`anthropic`**: the Claude Messages API with a streaming tool-use loop, prompt caching, and optional `effort`.
- **`openai`**: any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Together, vLLM, Ollama, …).
  Pass provider-specific parameters through `extra`.
- **`command`**: hands the whole job to an external coding agent CLI (Claude Code, Codex, aider, …) run in the
  workspace. The prompt is in `$TUIBENCH_PROMPT_FILE`.

See `models.example.yaml`. Each model has a turn budget (`maxTurns`, default 60) and a wall-clock budget
(`timeoutMinutes`, default 45).

Server-side refusal fallbacks are deliberately **not** enabled. A fallback would let a different model write part of
an entry. A refusal is recorded as the run's stop reason instead.

## How a generation works

1. `results/<task>/<stack>/<model>/workspace` is created from `stacks/<stack>/template` (a hello-world app with
   pinned dependencies) plus the task's `data/` fixtures.
2. The model gets a shared system prompt (environment, stack notes, what judges look for) and the task spec. It works
   through these tools:
   `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `build` (cargo build / bun install + tsc),
   `run_app` (launches the app in a PTY, sends keys, returns plain-text screenshots), and `finish`.
3. The final workspace is built and recorded in `meta.json` along with turns, tokens, tool usage, build counts and
   wall time. `transcript.jsonl` has the full normalized transcript.

## How capture works

`src/terminal/` spawns the app with `node-pty` (`TERM=xterm-256color`, `COLORTERM=truecolor`) and feeds its output
into a headless xterm.js, which answers the app's terminal queries. Scenario steps:

```yaml
scenario:
  - snapshot: initial            # waits for the screen to settle, then records it
    note: What a judge should look for here.
  - press: j j space             # key names: j, G, enter, esc, tab, shift+tab, up, pagedown, f5, ctrl+d, alt+x, ...
  - type: Water the plants       # text, one character at a time
  - resize: { cols: 70, rows: 20 }
  - wait: 500
  - click: { x: 10, y: 3 }       # mouse, 0-based cells; also button: right, count: 2, mods: [shift]
  - drag: { from: { x: 5, y: 6 }, to: { x: 30, y: 12 } }
  - scroll: { x: 40, y: 10, direction: down, amount: 3 }
  - hover: { x: 12, y: 4 }       # only reaches apps that enabled all-motion tracking
  - paste: "some text"           # bracketed paste when the app enabled it
  - press: q
  - expectExit: 3000             # must exit with status 0 and leave the alternate screen
```

Mouse input goes through xterm.js's own encoder, so an app receives exactly what a real xterm would send:
nothing unless it enabled mouse reporting, motion only in the tracking modes that report it, and the protocol
it asked for. Undelivered input is recorded as a warning in `capture.json`.

### Spec checks

A snapshot step can declare `expect:`, objective assertions about that screen. They cover what the spec makes
mandatory (data that must appear, state changes, fixed hit targets, ordering), never style:

```yaml
  - snapshot: moved
    note: The first box and its label moved down 12 rows together.
    expect:
      - { at: { x: 5, y: 16 }, oneOf: "┌╭┏╔", label: box moved down 12 rows }
      - { at: { x: 8, y: 18 }, text: API server }
      - { contains: "26×9", in: { rows: [-1, -1] } }      # last row only
      - { notContains: Files, in: { rows: [-1, -1] } }
      - { matches: "60\\s*/\\s*60" }                      # regular expression
      - { inOrder: [rust-analyzer, chrome, containerd] }  # reading order
```

Coordinates are 0-based cells (wide glyphs take two), negative rows/columns count from the end, and text
comparisons ignore case unless `caseSensitive: true`. Checks are evaluated from the captured screens when the
report is built (or with `tuibench check -v`), so editing them never needs a recapture. The report shows a
`✓ 3/3 checks` chip per checkpoint (expand it to see each check) and a pass rate per model in Results. Checks are
objective, so they are shown in blind voting too.

Each capture writes `capture/snapshots.json` (styled cell runs), `capture/recording.cast` (asciicast v2 with input,
resize and checkpoint markers) and `capture/capture.json` (started / crashed / clean exit).

## The report

- **Arena**: blind pairwise judging. Pick *compare models* (same stack), *compare stacks* (same model) or *any
  pair*. Each checkpoint is shown side by side; recordings can be replayed in sync. Vote with `1` (A), `2` (tie),
  `3` (B) or `4` (both bad). `s` skips, `n` goes to the next pair, `u` undoes. Pairs you haven't judged and pairs
  with the fewest votes come first. Objective status (build failed, crashed, unclean exit) is shown without
  revealing who built what.
- **Compare**: any two named results with snapshots, synced replay, source code, and run details.
- **Gallery**: one checkpoint across every result for a task.
- **Results**: objective metrics such as build/run/clean-exit rates, turns, tokens, time and lines of code.
- **Leaderboard**: Bradley–Terry ratings by model × stack, model, or stack, filterable by task and judge.

## Tasks

| Task | Exercises |
|---|---|
| `todo-app` | list, selection, filter tabs, text input prompt, confirm dialog, help overlay |
| `file-browser` | tree with expand/collapse, split panes, focus switching, scrolling preview |
| `log-viewer` | large scrolling list, colorized levels, search highlighting, match navigation, filtering |
| `system-dashboard` | animated charts, gauges, sortable table, detail popup (replays fixed data) |
| `kanban` | multi-column layout, cards, moving items, modal, text input |
| `signup-form` | focus management, text inputs, masked password, radio/checkbox, validation, confirmation screen |

Desktop-style apps, several of them driven by the mouse:

| Task | Exercises |
|---|---|
| `draw-editor` | termDRAW-like diagram editor: drag to draw boxes, arrows and pen strokes, place text, select/move/recolor, undo |
| `text-editor` | menu bar, click-to-place cursor, shift selection, clipboard, find bar, wheel scrolling, unsaved-changes dialog |
| `spreadsheet` | formula bar, live recalculation, click and drag-select ranges, selection stats, relative copy/paste |
| `mail-client` | three panes, unread/star state, compose window, reply quoting, archive with undo, search |
| `chat-client` | Slack-style sidebar, unread dividers, grouped messages, emoji reactions, thread pane, quick switcher |
| `calendar` | week view with side-by-side overlapping events, all-day band, mini month, popover, month view, event form |
| `desktop-windows` | Turbo Vision-style overlapping windows: raise, move, resize, maximize and close with the mouse; taskbar |

Each task also checks resize handling and a clean quit.

### Adding a task

Create `tasks/<id>/task.yaml` (`id`, `title`, `summary`, `size`, `prompt`, `scenario`) and optionally
`tasks/<id>/data/`, which is copied into the workspace as `data/`. Write the spec so the scenario is deterministic:
define exact key bindings and initial state, and avoid randomness and wall-clock content. `npm test` validates every
task, and `npx tsx scripts/check-tasks.ts [task]` prints each checkpoint with the input that leads to it and flags
mouse coordinates outside the terminal. `scripts/gen_fixtures.py` regenerates the synthetic fixtures (log, metrics,
mailbox, chat, calendar).

For mouse-driven tasks, pin down the geometry of whatever the scenario clicks or drags on (canvas origin, gutter
width, grid columns, initial window positions, button cells) and leave everything else to the model, so that the
same scripted input hits the same target in every app.

### Adding a stack

Add a template under `stacks/<id>/template` and a `Stack` entry in `src/stacks.ts` (prompt notes, build, check, run
command).

## Reference apps

`examples/todo-app/{ratatui,opentui}` are hand-written solutions. Use them to sanity-check the harness, or import
them as a baseline:

```bash
./bin/tuibench import examples/todo-app/ratatui -t todo-app -s ratatui -m reference --name "Reference"
```

## Development

```bash
npm test            # unit tests + full agent-loop tests against a mock LLM server (no API calls)
npm run typecheck
```

Layout: `src/agent/` (prompt, tools, providers), `src/terminal/` (PTY session, key encoding, snapshots, scenario
runner), `src/report/` (report builder, server, single-file UI), `src/judge/` (judgment store, ratings).
