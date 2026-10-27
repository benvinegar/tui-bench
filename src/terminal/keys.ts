// Maps human-readable key names (as written in task scenarios and by agents in
// preview calls) to the byte sequences a real xterm-compatible terminal sends.

const NAMED: Record<string, string | ((appCursor: boolean) => string)> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  backtab: "\x1b[Z",
  "shift+tab": "\x1b[Z",
  esc: "\x1b",
  escape: "\x1b",
  backspace: "\x7f",
  space: " ",
  up: (app) => (app ? "\x1bOA" : "\x1b[A"),
  down: (app) => (app ? "\x1bOB" : "\x1b[B"),
  right: (app) => (app ? "\x1bOC" : "\x1b[C"),
  left: (app) => (app ? "\x1bOD" : "\x1b[D"),
  home: (app) => (app ? "\x1bOH" : "\x1b[H"),
  end: (app) => (app ? "\x1bOF" : "\x1b[F"),
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
  "shift+up": "\x1b[1;2A",
  "shift+down": "\x1b[1;2B",
  "shift+right": "\x1b[1;2C",
  "shift+left": "\x1b[1;2D",
  "ctrl+up": "\x1b[1;5A",
  "ctrl+down": "\x1b[1;5B",
  "ctrl+right": "\x1b[1;5C",
  "ctrl+left": "\x1b[1;5D",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

/**
 * Encode a single key name. Accepts:
 *   - a single printable character ("j", "G", "/", "?")
 *   - a named key ("enter", "down", "f5", "shift+tab")
 *   - ctrl+<char> / alt+<char> combos ("ctrl+c", "alt+x")
 */
export function encodeKey(name: string, appCursor = false): string {
  if (name.length === 1) return name;
  const lower = name.toLowerCase();
  const named = NAMED[lower];
  if (named !== undefined) return typeof named === "function" ? named(appCursor) : named;

  const ctrl = /^(?:ctrl|c)[+-](.)$/i.exec(name);
  if (ctrl) {
    const ch = ctrl[1]!.toLowerCase();
    if (ch >= "a" && ch <= "z") return String.fromCharCode(ch.charCodeAt(0) - 96);
    if (ch === " " || ch === "@") return "\x00";
    if (ch === "[") return "\x1b";
    throw new Error(`Unsupported ctrl combo: ${name}`);
  }
  const alt = /^(?:alt|meta|m)[+-](.+)$/i.exec(name);
  if (alt) return "\x1b" + encodeKey(alt[1]!, appCursor);

  throw new Error(`Unknown key name: "${name}"`);
}

/** Split "j j space" or ["j", "j", "space"] into individual key names. */
export function splitKeys(keys: string | string[]): string[] {
  if (Array.isArray(keys)) return keys;
  return keys.split(/\s+/).filter(Boolean);
}

export const KEY_NAMES_HELP =
  "Single characters (j, G, /, ?), named keys (enter, tab, shift+tab, esc, backspace, space, up, down, left, right, " +
  "home, end, pageup, pagedown, delete, f1-f12, shift+<arrow>, ctrl+<arrow>), and ctrl+<letter> / alt+<key> combos.";
