# Terminal UI Bench

Benchmark for LLMs building terminal UIs in Rust + ratatui and TypeScript + OpenTUI. Models build the same
task in both stacks; a harness runs each app in a real PTY with scripted input, captures styled screens and
recordings, scores objective spec checks, and a report lets humans compare results side by side and vote blind.
The README is the user-facing documentation; this file is for working on the repo.

## Setup and commands

Needs Node 22+, Rust (cargo) and Bun ≥ 1.3.14. `npm install`, then `./bin/tuibench <command>` (runs `src/cli.ts`
via tsx). `./bin/tuibench doctor` builds both stack templates and runs them in the harness.

- `npm test`: unit tests plus full agent-loop tests against a mock LLM server (no API calls). `npm run typecheck`.
- `npx tsx scripts/check-tasks.ts [task]`: validates tasks, prints each checkpoint with its input, flags
  out-of-bounds mouse coordinates.
- `./bin/tuibench check -v`: evaluates every task's spec checks against the captured results in `results/`.
- `./bin/tuibench report --standalone -o <dir>`: single-file report. `./bin/tuibench serve`: report with
  votes saved to `judgments/judgments.jsonl`.
- `python3 scripts/gen_fixtures.py`: regenerates the deterministic fixtures (log, metrics, mailbox, chat, calendar).

## Layout

- `src/agent/`: the benchmark's own agent loop (system prompt, tools, Anthropic / OpenAI-compatible /
  external-command providers). `src/generate.ts` drives it; `src/capture.ts` replays scenarios.
- `src/terminal/`: PTY session (node-pty + @xterm/headless), key encoding, styled snapshots, scenario runner.
  Mouse input goes through xterm.js's own encoder (`_core.coreMouseService.triggerMouseEvent`), so apps get exactly
  what a real xterm sends, and nothing unless they enabled mouse reporting.
- `src/expect.ts`: spec-check assertions (`expect:` on snapshot steps).
- `src/report/`: report builder, server and the single-file UI (`ui.html`/`ui.css`/`ui.js`, plain browser JS).
- `src/judge/`: judgment store and Bradley–Terry ratings (`ratings.ts` is embedded into the UI via
  `Function.prototype.toString`, so it must stay self-contained).
- `tasks/<id>/task.yaml` (+ `data/`), `stacks/<id>/template/`, `examples/todo-app/` (hand-written reference apps).
- `results/<task>/<stack>/<model>/`: committed sample results (workspace source, `meta.json`, `capture/`).

## Running sample results without API keys (Claude Code subagents)

This is how every result in `results/` was produced. Each contestant is a Claude Code subagent given the exact
benchmark prompt:

1. `./bin/tuibench prepare <scratch>/runs/<task>--<model>-<stack> -t <task> -s <stack>` for each combination.
2. Spawn one background subagent per workspace with `model` set to `haiku`, `sonnet` or `opus`, all with the same
   brief: "You are a contestant in a benchmark. Your workspace is <dir>. Read PROMPT.md in that directory and follow
   it exactly: it fully specifies the app to build, the stack, and how to test it. Run every command with that
   directory as the working directory. Rules: work only inside your workspace. Do not read or modify any other
   directory under <scratch>, and do not read the terminal-ui-bench repository (you may only execute
   <repo>/bin/tuibench preview as PROMPT.md describes). Do not use session or task-management tools. Do not ask
   questions; make reasonable decisions yourself. When the app is complete and you have tested it, reply with a short
   summary of what you built and any known issues."
3. As each finishes, import it with the stats from its task notification:
   `./bin/tuibench import <dir> -t <task> -s <stack> -m <model> --name "Claude Opus (Claude Code subagent)"
   --harness "Claude Code subagent (Bash + file tools, tuibench preview)" --tokens <n> --tool-calls <n>
   --duration-ms <n> --no-capture`
4. When all are in, `./bin/tuibench capture -t <task> -j 1` (sequential, identical conditions), then
   `./bin/tuibench check -v`, then build the report.
5. Read the agents' reports: they surface harness bugs (several fixes came from them) and spec ambiguities.

## Writing tasks

- Specs must make the scenario deterministic: exact key bindings and initial state, no clock (data files carry a
  `now`), no randomness.
- For mouse-driven tasks, pin down the geometry of whatever the scenario clicks or drags (canvas origin, gutter
  width, grid columns, initial window positions, button cells) and leave the rest to the model.
- Checkpoint `note`s describe the expected outcome for judges; `expect:` asserts only what the spec makes
  mandatory (see README "Spec checks"). Before trusting new checks, run them against real implementations: wrong
  checks so far came from deleted fixture items, a sort rule the spec didn't state, and ordering on one row.
- YAML gotchas: quote any scalar containing `: `; a key list that starts with a quoted key must be a flow list
  (`press: ["1", "/"]`, not `press: "1" /`).
- Run `npx tsx scripts/check-tasks.ts <task>` and `npm test` after editing tasks.

## Publishing the report as a claude.ai artifact

Build with `--standalone`, then strip `<!doctype html>`, `<html>`, `<head>`, `<body>` and the charset/viewport
metas (the artifact host adds its own skeleton) and publish that file. The sample report so far is
https://claude.ai/artifact/1wwFA1SYAgeT2nFseT1xoi (republish to the same URL with `url`).

## Status (2026-11-01)

- 13 tasks. Sample results exist for `system-dashboard`, `draw-editor` and `desktop-windows` (Haiku / Sonnet /
  Opus × both stacks) and `todo-app` (hand-written references). All pass their spec checks except the two Sonnet
  dashboards (built before "selection follows the process" was added to the spec).
- The other 9 tasks (file-browser, log-viewer, kanban, signup-form, text-editor, spreadsheet, mail-client,
  chat-client, calendar) have never been implemented; their scenarios and checks are unvalidated.
- No human votes yet. The benchmark's own API agent loop has only run against the mock server in tests.
- GitHub: `origin` is https://github.com/benvinegar/tui-bench. Pushing needs the Claude GitHub App to have access
  to that repo.
