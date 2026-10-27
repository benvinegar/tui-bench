import * as pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import { encodeKey } from "./keys.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";

const { Terminal } = xtermHeadless;

export interface SessionOptions {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/** asciicast v2 event: [seconds, code, data]. "o" output, "i" input, "r" resize, "m" marker. */
export type CastEvent = [number, "o" | "i" | "r" | "m", string];

export interface ExitInfo {
  exitCode: number;
  signal?: number;
  at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A program running inside a pseudo-terminal whose output is interpreted by a
 * headless xterm.js instance, so we can read back the exact screen grid
 * (characters + colors + attributes) a human would see.
 */
export class TerminalSession {
  readonly term: InstanceType<typeof Terminal>;
  readonly proc: pty.IPty;
  readonly events: CastEvent[] = [];
  readonly startedAt = Date.now();
  exit: ExitInfo | null = null;
  private lastOutputAt = 0;
  private lastActionAt = 0;
  private pendingWrites = 0;
  private sawOutput = false;
  private exitWaiters: Array<() => void> = [];

  constructor(readonly opts: SessionOptions) {
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    // Terminal → app: replies to capability / cursor-position queries (DA1, DSR, ...).
    this.term.onData((data) => {
      if (!this.exit) this.proc.write(data);
    });

    this.proc = pty.spawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TUIBENCH: "1",
        ...opts.env,
      },
    });
    this.proc.onData((data) => {
      this.sawOutput = true;
      this.lastOutputAt = Date.now();
      this.events.push([this.elapsed(), "o", data]);
      this.pendingWrites++;
      this.term.write(data, () => {
        this.pendingWrites--;
      });
    });
    this.proc.onExit(({ exitCode, signal }) => {
      this.exit = { exitCode, signal, at: Date.now() - this.startedAt };
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  elapsed(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** Wait until the app has produced output and then gone quiet. */
  async waitForStartup(timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.sawOutput && !this.exit && Date.now() < deadline) await sleep(20);
    // Short cap: animated apps never go quiet, and the scenario's own steps decide what happens next.
    await this.waitIdle(250, 1000);
    return this.sawOutput;
  }

  /**
   * Wait until no output has arrived for `quietMs`, all bytes are parsed, and the
   * app isn't mid synchronized-update. Gives up after `maxMs` (animated UIs never go quiet).
   */
  async waitIdle(quietMs = 250, maxMs = 3000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const quiet = Date.now() - Math.max(this.lastOutputAt, this.lastActionAt) >= quietMs;
      const synced = !(this.term.modes as { synchronizedOutputMode?: boolean }).synchronizedOutputMode;
      if (quiet && this.pendingWrites === 0 && synced) return;
      if (this.exit && this.pendingWrites === 0) return;
      await sleep(15);
    }
    // Make sure whatever arrived is at least parsed before reading the grid.
    while (this.pendingWrites > 0) await sleep(5);
  }

  write(data: string): void {
    if (this.exit) return;
    this.lastActionAt = Date.now();
    this.events.push([this.elapsed(), "i", data]);
    this.proc.write(data);
  }

  async press(keys: string[], delayMs = 60): Promise<void> {
    for (const k of keys) {
      this.write(encodeKey(k, this.term.modes.applicationCursorKeysMode));
      // A lone ESC is ambiguous with the start of an escape sequence; give parsers time.
      await sleep(k.toLowerCase().startsWith("esc") ? Math.max(delayMs, 120) : delayMs);
    }
  }

  async type(text: string, delayMs = 25): Promise<void> {
    for (const ch of text) {
      this.write(ch === "\n" ? "\r" : ch);
      await sleep(delayMs);
    }
  }

  paste(text: string): void {
    const bracketed = this.term.modes.bracketedPasteMode;
    this.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
  }

  /** Left click (0-based cell coordinates) using SGR mouse encoding. */
  async click(x: number, y: number, button = 0): Promise<void> {
    this.write(`\x1b[<${button};${x + 1};${y + 1}M`);
    await sleep(30);
    this.write(`\x1b[<${button};${x + 1};${y + 1}m`);
  }

  resize(cols: number, rows: number): void {
    this.lastActionAt = Date.now();
    this.events.push([this.elapsed(), "r", `${cols}x${rows}`]);
    this.term.resize(cols, rows);
    if (!this.exit) this.proc.resize(cols, rows);
  }

  snapshot(name: string): Snapshot {
    this.events.push([this.elapsed(), "m", name]);
    return takeSnapshot(this.term, name, Date.now() - this.startedAt);
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exit) return true;
    await Promise.race([new Promise<void>((r) => this.exitWaiters.push(r)), sleep(timeoutMs)]);
    return this.exit !== null;
  }

  /** Raw asciicast v2 document of everything that happened in this session. */
  toCast(title: string): string {
    const header = {
      version: 2,
      width: this.opts.cols,
      height: this.opts.rows,
      timestamp: Math.floor(this.startedAt / 1000),
      title,
      env: { TERM: "xterm-256color" },
    };
    return [JSON.stringify(header), ...this.events.map((e) => JSON.stringify([+e[0].toFixed(4), e[1], e[2]]))].join("\n") + "\n";
  }

  async kill(): Promise<void> {
    if (this.exit) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    if (!(await this.waitForExit(1500))) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      await this.waitForExit(1000);
    }
  }

  dispose(): void {
    this.term.dispose();
  }
}
