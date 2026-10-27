// Validates every task and prints each scenario's checkpoints with the input that leads to them.
// Usage: npx tsx scripts/check-tasks.ts [task-id...]
import { encodeKey, splitKeys } from "../src/terminal/keys.ts";
import { listTasks } from "../src/tasks.ts";

const only = process.argv.slice(2);
for (const t of listTasks().filter((t) => !only.length || only.includes(t.id))) {
  let size = { ...t.size };
  const problems: string[] = [];
  const lines: string[] = [];
  let pending: string[] = [];
  for (const s of t.scenario) {
    const inBounds = (p: { x: number; y: number }, what: string) => {
      if (p.x >= size.cols || p.y >= size.rows) problems.push(`${what} at (${p.x},${p.y}) is outside ${size.cols}x${size.rows}`);
    };
    if ("press" in s) {
      for (const k of splitKeys(s.press)) {
        try {
          encodeKey(k);
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
      pending.push(splitKeys(s.press).join(" "));
    } else if ("type" in s) pending.push(`type "${s.type}"`);
    else if ("resize" in s) {
      size = { ...s.resize };
      pending.push(`resize ${size.cols}x${size.rows}`);
    } else if ("click" in s) {
      inBounds(s.click, "click");
      pending.push(`click (${s.click.x},${s.click.y})`);
    } else if ("drag" in s) {
      inBounds(s.drag.from, "drag start");
      inBounds(s.drag.to, "drag end");
      pending.push(`drag (${s.drag.from.x},${s.drag.from.y})→(${s.drag.to.x},${s.drag.to.y})`);
    } else if ("scroll" in s) {
      inBounds(s.scroll, "scroll");
      pending.push(`scroll ${s.scroll.direction}`);
    } else if ("wait" in s) pending.push(`wait ${s.wait}`);
    else if ("snapshot" in s) {
      lines.push(`  [${s.snapshot}] ${pending.join(", ")}\n      → ${s.note ?? ""}`);
      pending = [];
    }
  }
  console.log(`${t.id} (${t.size.cols}x${t.size.rows})${problems.length ? "  PROBLEMS:\n    " + problems.join("\n    ") : ""}`);
  console.log(lines.join("\n"));
}
