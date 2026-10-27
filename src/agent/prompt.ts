import type { Stack } from "../stacks.ts";
import type { Task } from "../tasks.ts";
import { KEY_NAMES_HELP } from "../terminal/keys.ts";

/**
 * The system prompt is identical for every model; only the stack section and the
 * task differ. Keep it neutral: describe the environment and the deliverable.
 */
export function systemPrompt(stack: Stack, task: Task, interactive: boolean): string {
  const tools = interactive
    ? `## Tools

You work through tools: \`list_files\`, \`read_file\`, \`write_file\`, \`edit_file\`, \`delete_file\`, \`build\` and \`run_app\`.
\`run_app\` builds the app, launches it in a ${task.size.cols}x${task.size.rows} pseudo-terminal, sends the key presses you list, and
returns plain-text screenshots of the screen (colors and styles are not shown). Key names: ${KEY_NAMES_HELP}
When the app is complete, call \`finish\` with a short summary. Your turn budget is limited, so batch your work.`
    : `## How you work

You are running as a coding agent inside the workspace directory. Edit files there directly.`;

  return `You are building a terminal user interface (TUI) application. Your work is part of a benchmark: after you finish,
the app is built from the workspace, launched in a ${task.size.cols}x${task.size.rows} terminal (xterm-256color, truecolor), driven
by a scripted sequence of key presses taken from the specification, and screenshots of it are compared side by side by
human judges against apps built by other developers. Judges look at visual design and polish, layout, correctness against
the specification, responsiveness to terminal resizes, and that the app never crashes.

${stack.promptNotes}

## Workspace

- The workspace already contains a minimal "hello world" app for this stack; replace it with your implementation.
- Data files the app must read are in \`data/\` and are read relative to the working directory (e.g. \`data/todos.json\`).
  Do not modify them; they are restored before evaluation.
- The app must not use the network, the clock for content (other than as the specification says), or randomness, so
  that every run renders the same way. It must exit cleanly with status 0 and restore the terminal when asked to quit.

${tools}`;
}

export function taskPrompt(task: Task): string {
  return `# ${task.title}

${task.prompt.trim()}
`;
}
