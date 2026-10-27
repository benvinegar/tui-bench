import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalSession } from "../src/terminal/session.ts";

// A tiny "app" that optionally enables mouse reporting and echoes every input byte it receives.
function echoApp(modes: string) {
  const script = `
    process.stdin.setRawMode(true);
    process.stdout.write(${JSON.stringify(modes)} + "ready");
    const got = [];
    process.stdin.on("data", (d) => { got.push(d.toString("latin1")); if (d.includes("q")) { process.stderr.write(JSON.stringify(got)); process.exit(0); } });
  `;
  return new TerminalSession({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), cols: 80, rows: 24 });
}

async function inputs(s: TerminalSession): Promise<string> {
  await new Promise((r) => setTimeout(r, 150));
  s.write("q");
  await s.waitForExit(3000);
  return s.events.filter((e) => e[1] === "i").map((e) => e[2]).join("");
}

test("mouse events use the protocol the app enabled (button-event tracking + SGR)", async () => {
  const s = echoApp("\x1b[?1002h\x1b[?1006h");
  await s.waitForStartup();
  await s.click(4, 2, { button: "right" });
  await s.click(10, 5, { count: 2 });
  await s.drag({ x: 1, y: 1 }, { x: 3, y: 2 });
  await s.scroll(0, 0, "down", 2);
  await s.hover(5, 5); // not delivered: 1002 doesn't report motion without a button
  const all = await inputs(s);
  assert.ok(all.includes("\x1b[<2;5;3M\x1b[<2;5;3m"), "right click, 1-based coordinates");
  assert.equal(all.split("\x1b[<0;11;6M").length - 1, 2, "double click = two presses");
  // (1,1) → (3,2): press, motion through (2,2) and (3,2) with the button held, release. SGR is 1-based.
  assert.ok(all.includes("\x1b[<0;2;2M\x1b[<32;3;3M\x1b[<32;4;3M\x1b[<0;4;3m"), "drag reports motion with the button held");
  assert.ok(all.includes("\x1b[<65;1;1M\x1b[<65;1;1M"), "wheel down twice");
  assert.ok(s.warnings.some((w) => w.includes("hover")));
  s.dispose();
});

test("no mouse bytes are sent to an app that never enabled mouse reporting", async () => {
  const s = echoApp("");
  await s.waitForStartup();
  await s.click(4, 2);
  await s.drag({ x: 1, y: 1 }, { x: 3, y: 2 });
  const all = await inputs(s);
  assert.equal(all, "q");
  assert.equal(s.warnings.length, 2);
  s.dispose();
});
